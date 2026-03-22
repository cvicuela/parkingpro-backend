/**
 * Deployment Mode Configuration
 *
 * Three modes supported:
 *   - remote:  Everything in the cloud (Supabase + Railway/Vercel) — DEFAULT
 *   - local:   Everything on-premise (local PostgreSQL + Express)
 *   - hybrid:  Local primary with cloud sync/backup
 *
 * If DEPLOYMENT_MODE is not set, defaults to 'remote' so existing
 * installations continue to work without any changes.
 */

const VALID_MODES = ['remote', 'local', 'hybrid'];

const mode = (process.env.DEPLOYMENT_MODE || 'remote').toLowerCase();

if (!VALID_MODES.includes(mode)) {
    console.warn(`[DeploymentMode] Invalid mode "${mode}". Falling back to "remote".`);
}

const deploymentMode = VALID_MODES.includes(mode) ? mode : 'remote';

const config = {
    mode: deploymentMode,

    // Does this mode need Supabase credentials?
    requiresSupabase: deploymentMode === 'remote' || deploymentMode === 'hybrid',

    // Does this mode use a local PostgreSQL instance?
    usesLocalDB: deploymentMode === 'local' || deploymentMode === 'hybrid',

    // Should we sync local data to cloud?
    syncEnabled: deploymentMode === 'hybrid',

    // Feature flags per mode
    features: {
        // Cloud-based RPC calls (Supabase .rpc())
        supabaseRPC: deploymentMode !== 'local',

        // Real-time subscriptions via Supabase
        supabaseRealtime: deploymentMode === 'remote',

        // Local file-based backups
        localBackups: deploymentMode !== 'remote',

        // Background cloud sync
        cloudSync: deploymentMode === 'hybrid',

        // Socket.IO (always available — runs on Express)
        socketIO: true,
    },

    // Human-readable labels
    labels: {
        remote: 'Remoto (Cloud)',
        local: 'Local (On-Premise)',
        hybrid: 'Híbrido (Local + Cloud)',
    },

    getLabel() {
        return this.labels[this.mode];
    },

    toJSON() {
        return {
            mode: this.mode,
            label: this.getLabel(),
            requiresSupabase: this.requiresSupabase,
            usesLocalDB: this.usesLocalDB,
            syncEnabled: this.syncEnabled,
            features: this.features,
        };
    }
};

module.exports = config;
