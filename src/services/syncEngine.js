/**
 * Hybrid Sync Engine
 *
 * Only active when DEPLOYMENT_MODE=hybrid.
 * Handles bidirectional sync between local PostgreSQL and cloud Supabase.
 *
 * Architecture:
 *   - Local DB is ALWAYS the primary (writes go here first)
 *   - Cloud is the backup/secondary (synced periodically)
 *   - If internet is down, local continues to work; changes queue up
 *   - When internet returns, queued changes sync to cloud
 *
 * This module is a foundation — sync logic for each table can be
 * extended incrementally without touching existing code.
 */

const deployment = require('../config/deploymentMode');

// Tables to sync (ordered by dependency)
const SYNC_TABLES = [
    'users',
    'customers',
    'vehicles',
    'plans',
    'subscriptions',
    'parking_sessions',
    'payments',
    'invoices',
    'access_events',
    'settings',
];

// Sync status tracking
const syncState = {
    lastSyncAt: null,
    isSyncing: false,
    pendingChanges: 0,
    errors: [],
    isOnline: true,
    intervalId: null,
};

/**
 * Check if cloud is reachable
 */
async function checkConnectivity() {
    if (!deployment.syncEnabled) return false;

    try {
        const { supabase } = require('../config/database');
        if (!supabase || typeof supabase.rpc !== 'function') return false;

        // Simple connectivity check
        const { error } = await supabase.rpc('get_server_time');
        syncState.isOnline = !error;
        return syncState.isOnline;
    } catch {
        syncState.isOnline = false;
        return false;
    }
}

/**
 * Record a local change that needs to be synced to cloud.
 * Called by the database wrapper when in hybrid mode.
 */
async function recordChange(tableName, operation, recordId, data) {
    if (!deployment.syncEnabled) return;

    try {
        const { query } = require('../config/database');
        await query(
            `INSERT INTO sync_queue (table_name, operation, record_id, data, status)
             VALUES ($1, $2, $3, $4, 'pending')`,
            [tableName, operation, recordId, JSON.stringify(data)]
        );
        syncState.pendingChanges++;
    } catch (error) {
        console.error('[SyncEngine] Error recording change:', error.message);
        syncState.errors.push({ timestamp: new Date(), error: error.message });
    }
}

/**
 * Process pending sync queue — push local changes to cloud
 */
async function processSyncQueue() {
    if (!deployment.syncEnabled || syncState.isSyncing) return;

    const isOnline = await checkConnectivity();
    if (!isOnline) {
        console.log('[SyncEngine] Offline — skipping sync');
        return;
    }

    syncState.isSyncing = true;

    try {
        const { query, supabase } = require('../config/database');

        // Get pending changes
        const { rows: pending } = await query(
            `SELECT * FROM sync_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 100`
        );

        if (pending.length === 0) {
            syncState.isSyncing = false;
            return;
        }

        console.log(`[SyncEngine] Processing ${pending.length} pending changes...`);

        for (const change of pending) {
            try {
                // Push to cloud via Supabase
                const { error } = await supabase
                    .from(change.table_name)
                    [change.operation === 'DELETE' ? 'delete' : 'upsert'](
                        change.operation === 'DELETE'
                            ? { id: change.record_id }
                            : JSON.parse(change.data)
                    );

                if (error) throw error;

                // Mark as synced
                await query(
                    `UPDATE sync_queue SET status = 'synced', synced_at = NOW() WHERE id = $1`,
                    [change.id]
                );
                syncState.pendingChanges = Math.max(0, syncState.pendingChanges - 1);
            } catch (err) {
                // Mark as failed, will retry
                await query(
                    `UPDATE sync_queue SET status = 'failed', error = $2, retries = retries + 1 WHERE id = $1`,
                    [change.id, err.message]
                );
                syncState.errors.push({ timestamp: new Date(), error: err.message });
            }
        }

        syncState.lastSyncAt = new Date();
        console.log(`[SyncEngine] Sync completed at ${syncState.lastSyncAt.toISOString()}`);
    } catch (error) {
        console.error('[SyncEngine] Sync failed:', error.message);
    } finally {
        syncState.isSyncing = false;
    }
}

/**
 * Clean up old synced records (older than 7 days)
 */
async function cleanupSyncQueue() {
    if (!deployment.syncEnabled) return;

    try {
        const { query } = require('../config/database');
        await query(
            `DELETE FROM sync_queue WHERE status = 'synced' AND synced_at < NOW() - INTERVAL '7 days'`
        );
    } catch (error) {
        console.error('[SyncEngine] Cleanup error:', error.message);
    }
}

/**
 * Get sync status for monitoring
 */
function getStatus() {
    return {
        enabled: deployment.syncEnabled,
        mode: deployment.mode,
        ...syncState,
        errors: syncState.errors.slice(-10), // Last 10 errors
    };
}

/**
 * Start the sync engine (call from server.js startup)
 */
function start(intervalMs = 60000) {
    if (!deployment.syncEnabled) {
        console.log('[SyncEngine] Sync disabled (not in hybrid mode)');
        return;
    }

    console.log(`[SyncEngine] Starting hybrid sync engine (interval: ${intervalMs / 1000}s)`);

    // Ensure sync_queue table exists
    ensureSyncTable();

    // Process queue periodically
    syncState.intervalId = setInterval(async () => {
        await processSyncQueue();
    }, intervalMs);

    // Cleanup old records daily
    setInterval(cleanupSyncQueue, 24 * 60 * 60 * 1000);

    // Initial sync after 5 seconds
    setTimeout(processSyncQueue, 5000);
}

/**
 * Stop the sync engine
 */
function stop() {
    if (syncState.intervalId) {
        clearInterval(syncState.intervalId);
        syncState.intervalId = null;
        console.log('[SyncEngine] Stopped');
    }
}

/**
 * Create sync_queue table if it doesn't exist (for hybrid mode)
 */
async function ensureSyncTable() {
    try {
        const { query } = require('../config/database');
        await query(`
            CREATE TABLE IF NOT EXISTS sync_queue (
                id SERIAL PRIMARY KEY,
                table_name VARCHAR(100) NOT NULL,
                operation VARCHAR(10) NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
                record_id UUID,
                data JSONB,
                status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'syncing', 'synced', 'failed')),
                error TEXT,
                retries INT DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                synced_at TIMESTAMPTZ
            );
            CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status);
            CREATE INDEX IF NOT EXISTS idx_sync_queue_created ON sync_queue(created_at);
        `);
    } catch (error) {
        console.error('[SyncEngine] Could not create sync_queue table:', error.message);
    }
}

module.exports = {
    recordChange,
    processSyncQueue,
    getStatus,
    start,
    stop,
    checkConnectivity,
};
