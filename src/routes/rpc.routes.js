/**
 * RPC Proxy Router
 *
 * Exposes PostgreSQL functions via REST: POST /api/v1/rpc/:functionName
 *
 * This enables the PWA to call the same stored procedures in local mode
 * (without Supabase) by routing through Express → PostgreSQL directly.
 *
 * In remote mode this route still works but is typically unused since
 * the PWA calls Supabase RPC directly.
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');

// Whitelist of allowed RPC functions to prevent arbitrary SQL execution
const ALLOWED_FUNCTIONS = new Set([
    // Auth
    'authenticate',
    'register_user',
    'get_current_user_info',
    'do_logout',
    // Customers
    'list_customers',
    'get_customer',
    'create_customer',
    'update_customer',
    'delete_customer',
    'get_customer_history',
    // Vehicles
    'list_vehicles',
    'get_vehicle',
    'create_vehicle',
    'update_vehicle',
    'delete_vehicle',
    'find_vehicle_by_plate',
    // Plans
    'list_plans',
    'get_plan',
    'create_plan',
    'update_plan',
    'delete_plan',
    'get_occupancy',
    'get_hourly_rates',
    // Subscriptions
    'list_subscriptions',
    'get_subscription',
    'create_subscription',
    'update_subscription',
    'cancel_subscription',
    'suspend_subscription',
    'reactivate_subscription',
    'generate_subscription_qr',
    // Access
    'register_entry',
    'register_exit',
    'validate_access',
    'list_active_sessions',
    'get_session',
    // Payments
    'list_payments',
    'get_payment',
    'create_payment',
    'refund_payment',
    // Reports
    'get_dashboard_stats',
    'get_revenue_report',
    'get_occupancy_report',
    'get_customer_report',
    // Cash Registers
    'open_cash_register',
    'close_cash_register',
    'list_cash_registers',
    'get_cash_register',
    // Invoices
    'list_invoices',
    'get_invoice',
    'create_invoice_from_payment',
    // RFID
    'register_rfid_card',
    'assign_rfid_card',
    'return_rfid_card',
    'list_rfid_cards',
    // Terminals
    'list_terminals',
    'get_terminal',
    'create_terminal',
    'update_terminal',
    'terminal_heartbeat',
    // Settings
    'get_settings',
    'update_settings',
    'get_setting',
    'update_setting',
    // Users
    'list_users',
    'get_user',
    'create_user',
    'update_user',
    // Audit
    'list_audit_logs',
    // DGII
    'dgii_validate_rnc',
    'dgii_search_rnc',
    'dgii_rnc_stats',
    'dgii_import_rnc_batch',
    // Notifications
    'list_notifications',
    'send_notification',
    // Expenses
    'list_expenses',
    'create_expense',
    'update_expense',
    'delete_expense',
    // Incidents
    'list_incidents',
    'create_incident',
    'update_incident',
    // Setup
    'get_server_time',
    'require_role',
]);

// POST /api/v1/rpc/:functionName
router.post('/:functionName', async (req, res) => {
    const { functionName } = req.params;

    // Security: only allow whitelisted functions
    if (!ALLOWED_FUNCTIONS.has(functionName)) {
        return res.status(403).json({
            error: `Función "${functionName}" no permitida`,
        });
    }

    try {
        const params = req.body || {};
        const paramKeys = Object.keys(params);

        if (paramKeys.length === 0) {
            // No parameters
            const result = await pool.query(`SELECT * FROM ${functionName}()`);
            return res.json(result.rows.length === 1 ? result.rows[0] : result.rows);
        }

        // Build parameterized call: SELECT * FROM fn($1, $2, ...)
        const placeholders = paramKeys.map((_, i) => `$${i + 1}`).join(', ');
        const namedPlaceholders = paramKeys.map((key, i) => `${key} := $${i + 1}`).join(', ');
        const values = paramKeys.map(k => {
            const v = params[k];
            // Convert JS objects to JSON strings for JSONB params
            if (v !== null && typeof v === 'object') return JSON.stringify(v);
            return v;
        });

        const sql = `SELECT * FROM ${functionName}(${namedPlaceholders})`;
        const result = await pool.query(sql, values);

        res.json(result.rows.length === 1 ? result.rows[0] : result.rows);
    } catch (error) {
        console.error(`[RPC Proxy] Error calling ${functionName}:`, error.message);

        // Return structured error matching Supabase format
        res.status(400).json({
            error: error.message,
            hint: error.hint || null,
            details: error.detail || null,
        });
    }
});

module.exports = router;
