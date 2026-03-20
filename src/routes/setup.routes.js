const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// GET /api/v1/setup/status - Check if system needs first-time setup
// Public endpoint (no auth required) - returns only boolean flags
router.get('/status', async (req, res) => {
    try {
        // Check all setup requirements in parallel
        const [settingsResult, plansResult, terminalsResult, usersResult] = await Promise.all([
            query(`SELECT key, value FROM settings WHERE key IN ('business_name', 'business_rnc', 'business_address', 'business_phone', 'tax_rate', 'currency')`),
            query(`SELECT COUNT(*)::int as count FROM plans WHERE is_active = true`),
            query(`SELECT COUNT(*)::int as count FROM terminals WHERE is_active = true`),
            query(`SELECT COUNT(*)::int as count FROM users WHERE role IN ('admin', 'super_admin') AND status = 'active'`),
        ]);

        const settings = {};
        settingsResult.rows.forEach(row => {
            settings[row.key] = typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
        });

        const businessConfigured = !!(
            settings.business_name &&
            settings.business_name !== '"ParkingPro"' &&
            settings.business_name !== 'ParkingPro' &&
            settings.business_rnc &&
            settings.business_rnc !== '""' &&
            settings.business_rnc !== ''
        );

        const plansConfigured = plansResult.rows[0].count > 0;
        const terminalsConfigured = terminalsResult.rows[0].count > 0;
        const adminExists = usersResult.rows[0].count > 0;

        const isSetupComplete = businessConfigured && plansConfigured && terminalsConfigured && adminExists;

        res.json({
            isSetupComplete,
            steps: {
                adminCreated: adminExists,
                businessConfigured,
                plansConfigured,
                terminalsConfigured,
            }
        });
    } catch (error) {
        console.error('Error checking setup status:', error);
        res.status(500).json({ error: 'Error verificando estado de configuración' });
    }
});

// POST /api/v1/setup/complete - Mark setup as complete (stores flag)
router.post('/complete', authenticate, authorize(['admin', 'super_admin']), async (req, res) => {
    try {
        await query(
            `INSERT INTO settings (key, value, description, category, updated_by)
             VALUES ('setup_completed', $1, 'Setup wizard completed', 'system', $2)
             ON CONFLICT (key) DO UPDATE SET value = $1, updated_by = $2, updated_at = NOW()`,
            [JSON.stringify(true), req.user.id]
        );
        res.json({ success: true });
    } catch (error) {
        console.error('Error marking setup complete:', error);
        res.status(500).json({ error: 'Error al completar configuración' });
    }
});

module.exports = router;
