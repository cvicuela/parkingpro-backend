-- =====================================================
-- MIGRACIÓN: Sistema de Cuadre de Caja
-- Parámetros: umbral diferencia RD$200, 1 caja por operador
-- =====================================================

CREATE TABLE IF NOT EXISTS cash_registers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL DEFAULT 'Caja Principal',
    operator_id UUID REFERENCES users(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'closed' CHECK (status IN ('open', 'closed')),
    opened_at TIMESTAMP,
    opening_balance DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    opened_by UUID REFERENCES users(id) ON DELETE SET NULL,
    closed_at TIMESTAMP,
    expected_balance DECIMAL(10,2),
    counted_balance DECIMAL(10,2),
    difference DECIMAL(10,2),
    requires_approval BOOLEAN DEFAULT FALSE,
    approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_at TIMESTAMP,
    approval_notes TEXT,
    notes TEXT,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cash_registers_operator ON cash_registers(operator_id);
CREATE INDEX IF NOT EXISTS idx_cash_registers_status ON cash_registers(status);
CREATE INDEX IF NOT EXISTS idx_cash_registers_opened_at ON cash_registers(opened_at);

CREATE TABLE IF NOT EXISTS cash_register_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cash_register_id UUID NOT NULL REFERENCES cash_registers(id) ON DELETE CASCADE,
    type VARCHAR(30) NOT NULL CHECK (type IN ('payment','refund','opening_float','manual_in','manual_out','adjustment')),
    amount DECIMAL(10,2) NOT NULL,
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('in', 'out')),
    payment_id UUID REFERENCES payments(id) ON DELETE SET NULL,
    parking_session_id UUID REFERENCES parking_sessions(id) ON DELETE SET NULL,
    operator_id UUID REFERENCES users(id) ON DELETE SET NULL,
    description TEXT,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cash_txn_register ON cash_register_transactions(cash_register_id);
CREATE INDEX IF NOT EXISTS idx_cash_txn_type ON cash_register_transactions(type);
CREATE INDEX IF NOT EXISTS idx_cash_txn_payment ON cash_register_transactions(payment_id);
CREATE INDEX IF NOT EXISTS idx_cash_txn_created ON cash_register_transactions(created_at);

CREATE TABLE IF NOT EXISTS denomination_counts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cash_register_id UUID NOT NULL REFERENCES cash_registers(id) ON DELETE CASCADE,
    denomination DECIMAL(10,2) NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    subtotal DECIMAL(10,2) GENERATED ALWAYS AS (denomination * quantity) STORED,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_denomination_register ON denomination_counts(cash_register_id);

CREATE OR REPLACE VIEW cash_register_summary AS
SELECT
    cr.id,
    cr.name,
    cr.status,
    cr.opened_at,
    cr.closed_at,
    cr.opening_balance,
    cr.expected_balance,
    cr.counted_balance,
    cr.difference,
    cr.requires_approval,
    cr.approved_by,
    u_op.email as operator_email,
    COALESCE(u_op.first_name || ' ' || u_op.last_name, u_op.email) as operator_name,
    COALESCE(u_ap.first_name || ' ' || u_ap.last_name, u_ap.email) as approver_name,
    COALESCE(SUM(CASE WHEN crt.direction = 'in' AND crt.type = 'payment' THEN crt.amount ELSE 0 END), 0) as total_payments,
    COALESCE(SUM(CASE WHEN crt.direction = 'out' AND crt.type = 'refund' THEN crt.amount ELSE 0 END), 0) as total_refunds,
    COUNT(CASE WHEN crt.type = 'payment' THEN 1 END) as payment_count,
    COUNT(CASE WHEN crt.type = 'refund' THEN 1 END) as refund_count
FROM cash_registers cr
LEFT JOIN users u_op ON cr.operator_id = u_op.id
LEFT JOIN users u_ap ON cr.approved_by = u_ap.id
LEFT JOIN cash_register_transactions crt ON crt.cash_register_id = cr.id
GROUP BY cr.id, u_op.email, u_op.first_name, u_op.last_name, u_ap.first_name, u_ap.last_name, u_ap.email;
