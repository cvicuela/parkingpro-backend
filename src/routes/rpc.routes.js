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
const { authenticate } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');

// Valid PostgreSQL identifier pattern (prevents SQL injection via param keys)
const VALID_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/i;

// RPC functions that DON'T require authentication (public endpoints)
const PUBLIC_FUNCTIONS = new Set([
    'authenticate',
    'register_user',
    'get_server_time',
]);

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
    'get_plan_occupancy',
    'get_hourly_rates',
    'update_hourly_rates',
    'calculate_hourly',
    'calculate_parking_fee',
    // Subscriptions
    'list_subscriptions',
    'get_subscription',
    'create_subscription',
    'update_subscription',
    'cancel_subscription',
    'suspend_subscription',
    'reactivate_subscription',
    'generate_subscription_qr',
    'get_subscription_qr',
    // Access
    'quick_entry',
    'lost_ticket_charge',
    'nfc_replacement_charge',
    'register_entry',
    'register_exit',
    'validate_access',
    'validate_exit',
    'list_active_sessions',
    'get_session',
    'end_session',
    'session_by_plate',
    'session_payment',
    'process_parking_payment',
    'access_history',
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
    'report_revenue',
    'report_occupancy',
    'report_sessions',
    'report_customers',
    'report_invoices',
    'report_cash_reconciliation',
    'report_revenue_by_operator',
    'report_executive_summary',
    'report_export_csv',
    // Cash Registers
    'open_cash_register',
    'safe_open_cash_register',
    'close_cash_register',
    'list_cash_registers',
    'get_cash_register',
    'get_active_register',
    'approve_cash_register',
    'get_register_transactions',
    'cash_register_history',
    'get_cash_limits',
    // Invoices
    'list_invoices',
    'get_invoice',
    'create_invoice_from_payment',
    'invoice_stats',
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
    'list_settings',
    // Users
    'list_users',
    'get_user',
    'create_user',
    'update_user',
    'list_system_users',
    'create_system_user',
    'update_system_user',
    'reset_user_password',
    // Audit
    'list_audit_logs',
    'list_audit_actions',
    // DGII / Fiscal
    'dgii_validate_rnc',
    'dgii_search_rnc',
    'dgii_rnc_stats',
    'dgii_import_rnc_batch',
    'dgii_log_import',
    'generate_606_report',
    'generate_607_report',
    // NCF
    'list_ncf_sequences',
    'update_ncf_sequence',
    'assign_ncf_to_invoice',
    // Notifications
    'list_notifications',
    'send_notification',
    'notification_stats',
    // Expenses
    'list_expenses',
    'create_expense',
    'update_expense',
    'delete_expense',
    'expense_stats',
    // Incidents
    'list_incidents',
    'create_incident',
    'update_incident',
    'resolve_incident',
    // Data Management
    'reset_data_preview',
    'reset_operational_data',
    // Billing
    'run_billing_cycle',
    'generate_subscription_invoice',
    'list_billing_runs',
    // Access Control (gate)
    'gate_verify',
    // Setup
    'get_server_time',
]);

// POST /api/v1/rpc/:functionName
// Auth middleware conditionally applied: public functions skip auth
router.post('/:functionName', (req, res, next) => {
    if (PUBLIC_FUNCTIONS.has(req.params.functionName)) {
        return authLimiter(req, res, next);
    }
    authenticate(req, res, next);
}, async (req, res) => {
    const { functionName } = req.params;

    // Security: only allow whitelisted functions
    if (!ALLOWED_FUNCTIONS.has(functionName)) {
        return res.status(403).json({
            error: `Función "${functionName}" no permitida`,
        });
    }

    try {
        const params = req.body || {};

        // For authenticated requests, inject the verified server-side token
        // so PG functions always receive a valid token from the sessions table
        if (req.token) {
            params.p_token = req.token;
        }

        const paramKeys = Object.keys(params);

        // Security: validate all parameter key names against valid SQL identifier pattern
        for (const key of paramKeys) {
            if (!VALID_IDENTIFIER.test(key)) {
                return res.status(400).json({
                    error: `Nombre de parámetro inválido: "${key}"`,
                });
            }
        }

        if (paramKeys.length === 0) {
            // No parameters
            const result = await pool.query(`SELECT * FROM ${functionName}()`);
            return res.json(result.rows.length === 1 ? result.rows[0] : result.rows);
        }

        // Build parameterized call: SELECT * FROM fn(key := $1, ...)
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
        const isDev = process.env.NODE_ENV === 'development';
        res.status(400).json({
            error: isDev ? error.message : 'Error ejecutando la operación',
            hint: isDev ? (error.hint || null) : null,
            details: isDev ? (error.detail || null) : null,
        });
    }
});

module.exports = router;
