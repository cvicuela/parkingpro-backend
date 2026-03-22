const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');
const deployment = require('./deploymentMode');

// ── Supabase client ─────────────────────────────────────────
// Only created when mode requires it. In 'local' mode a stub is
// provided so existing code that references `supabase` won't crash
// at import time — calls will throw a clear error instead.
let supabase;
if (deployment.requiresSupabase && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
    );
} else if (deployment.mode === 'local') {
    // Stub: any .rpc() call in local mode gets routed to direct SQL
    supabase = {
        rpc: async (fnName, params) => {
            // In local mode, call the PostgreSQL function directly via pool
            const paramKeys = Object.keys(params || {});
            const placeholders = paramKeys.map((_, i) => `$${i + 1}`).join(', ');
            const values = paramKeys.map(k => params[k]);
            const sql = `SELECT * FROM ${fnName}(${placeholders})`;
            const res = await pool.query(sql, values);
            return { data: res.rows.length === 1 ? res.rows[0] : res.rows, error: null };
        },
        from: () => {
            throw new Error('[ParkingPro] Supabase .from() is not available in local mode. Use direct SQL queries.');
        }
    };
    console.log('[DeploymentMode] Local mode — Supabase stub active, RPC calls routed to local PostgreSQL');
} else {
    // Remote/hybrid but missing env vars — create normally (will fail at runtime with clear error)
    supabase = createClient(
        process.env.SUPABASE_URL || 'https://missing-url.supabase.co',
        process.env.SUPABASE_SERVICE_KEY || 'missing-key'
    );
    if (!process.env.SUPABASE_URL) {
        console.warn('[DeploymentMode] WARNING: SUPABASE_URL not set but mode requires Supabase.');
    }
}

// ── PostgreSQL pool ─────────────────────────────────────────
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: process.env.NODE_ENV === 'production' } : false
});

console.log(`[DeploymentMode] Mode: ${deployment.getLabel()}`);

async function query(text, params) {
    // Warn in dev mode if query appears to have string interpolation
    if (process.env.NODE_ENV === 'development' && (text.includes("' +") || text.includes("' ||"))) {
        console.warn('[Security] Potential SQL injection pattern detected in query');
    }
    const res = await pool.query(text, params);
    return res;
}

async function transaction(callback) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function testConnection() {
    try {
        await pool.query('SELECT NOW()');
        return true;
    } catch (error) {
        console.error('Database connection failed:', error);
        throw error;
    }
}

module.exports = {
    supabase,
    pool,
    query,
    transaction,
    testConnection
};
