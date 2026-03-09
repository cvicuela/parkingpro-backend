-- Migration 006: Report-optimized indexes and views
-- Optimizes queries for the reporting system

-- ==================== INDEXES ====================

-- Payments: for revenue reports by period, method, and status
CREATE INDEX IF NOT EXISTS idx_payments_paid_created
    ON payments (created_at) WHERE status = 'paid';

CREATE INDEX IF NOT EXISTS idx_payments_method_status
    ON payments (payment_method, status);

CREATE INDEX IF NOT EXISTS idx_payments_refunded_at
    ON payments (refunded_at) WHERE status = 'refunded';

-- Cash registers: for reconciliation reports
CREATE INDEX IF NOT EXISTS idx_cash_registers_closed_at
    ON cash_registers (closed_at) WHERE status = 'closed';

CREATE INDEX IF NOT EXISTS idx_cash_register_txn_direction
    ON cash_register_transactions (cash_register_id, direction, type);

-- Subscriptions: for customer reports
CREATE INDEX IF NOT EXISTS idx_subscriptions_activated_at
    ON subscriptions (activated_at);

CREATE INDEX IF NOT EXISTS idx_subscriptions_cancelled_at
    ON subscriptions (cancelled_at) WHERE cancelled_at IS NOT NULL;

-- Parking sessions: for session reports
CREATE INDEX IF NOT EXISTS idx_parking_sessions_entry_status
    ON parking_sessions (entry_time, status);

CREATE INDEX IF NOT EXISTS idx_parking_sessions_payment_status
    ON parking_sessions (payment_status, entry_time);

-- Access events: for occupancy reports
CREATE INDEX IF NOT EXISTS idx_access_events_type_timestamp
    ON access_events (type, timestamp);

CREATE INDEX IF NOT EXISTS idx_access_events_hour
    ON access_events (EXTRACT(HOUR FROM timestamp)) WHERE type = 'entry';

-- Invoices: for billing reports
CREATE INDEX IF NOT EXISTS idx_invoices_created_at
    ON invoices (created_at);

-- Customers: for customer analytics
CREATE INDEX IF NOT EXISTS idx_customers_created_at
    ON customers (created_at);

-- ==================== VIEWS ====================

-- Revenue summary view (materialized for performance on large datasets)
CREATE OR REPLACE VIEW revenue_daily_summary AS
SELECT
    DATE_TRUNC('day', created_at)::date as date,
    COUNT(*) as transaction_count,
    COALESCE(SUM(total_amount), 0) as gross_revenue,
    COALESCE(SUM(amount), 0) as net_revenue,
    COALESCE(SUM(tax_amount), 0) as tax_total,
    COALESCE(AVG(total_amount), 0) as avg_ticket,
    payment_method
FROM payments
WHERE status = 'paid'
GROUP BY DATE_TRUNC('day', created_at)::date, payment_method;

-- Cash register performance view
CREATE OR REPLACE VIEW cash_register_performance AS
SELECT
    u.id as operator_id,
    u.email as operator_email,
    COALESCE(c.first_name || ' ' || c.last_name, u.email) as operator_name,
    COUNT(*) as total_closures,
    COUNT(*) FILTER (WHERE cr.difference = 0) as exact_closures,
    COUNT(*) FILTER (WHERE cr.requires_approval = true) as flagged_closures,
    COALESCE(AVG(ABS(cr.difference)), 0) as avg_difference,
    COALESCE(SUM(ABS(cr.difference)), 0) as total_abs_difference,
    MAX(cr.closed_at) as last_closure
FROM cash_registers cr
JOIN users u ON cr.operator_id = u.id
LEFT JOIN customers c ON c.user_id = u.id
WHERE cr.status = 'closed'
GROUP BY u.id, u.email, c.first_name, c.last_name;

-- Session analytics view
CREATE OR REPLACE VIEW session_analytics AS
SELECT
    DATE_TRUNC('day', entry_time)::date as date,
    COUNT(*) as total_sessions,
    COUNT(*) FILTER (WHERE status = 'active') as active_sessions,
    COUNT(*) FILTER (WHERE status = 'paid') as paid_sessions,
    COUNT(*) FILTER (WHERE status = 'abandoned') as abandoned_sessions,
    COALESCE(SUM(paid_amount) FILTER (WHERE payment_status = 'paid'), 0) as revenue,
    COALESCE(AVG(duration_minutes) FILTER (WHERE exit_time IS NOT NULL), 0) as avg_duration
FROM parking_sessions
GROUP BY DATE_TRUNC('day', entry_time)::date;
