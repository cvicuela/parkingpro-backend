-- =====================================================
-- MIGRACIÓN: Agregar método de pago a transacciones de caja
-- Permite separar efectivo, tarjeta y transferencia en el cuadre
-- =====================================================

-- Agregar columna payment_method a cash_register_transactions
ALTER TABLE cash_register_transactions
ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20) DEFAULT 'cash';

-- Agregar columnas de desglose por método de pago al cierre de caja
ALTER TABLE cash_registers
ADD COLUMN IF NOT EXISTS expected_cash DECIMAL(10,2),
ADD COLUMN IF NOT EXISTS total_card DECIMAL(10,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_transfer DECIMAL(10,2) DEFAULT 0;

-- Índice para filtrar por método de pago
CREATE INDEX IF NOT EXISTS idx_cash_txn_payment_method ON cash_register_transactions(payment_method);

-- Actualizar vista resumen para incluir desglose por método de pago
CREATE OR REPLACE VIEW cash_register_summary AS
SELECT
    cr.id,
    cr.name,
    cr.status,
    cr.opened_at,
    cr.closed_at,
    cr.opening_balance,
    cr.expected_balance,
    cr.expected_cash,
    cr.counted_balance,
    cr.difference,
    cr.total_card,
    cr.total_transfer,
    cr.requires_approval,
    cr.approved_by,
    cr.operator_id,
    u_op.email as operator_email,
    COALESCE(u_op.first_name || ' ' || u_op.last_name, u_op.email) as operator_name,
    COALESCE(u_ap.first_name || ' ' || u_ap.last_name, u_ap.email) as approver_name,
    cr.approval_notes,
    COALESCE(SUM(CASE WHEN crt.direction = 'in' AND crt.type = 'payment' THEN crt.amount ELSE 0 END), 0) as total_payments,
    COALESCE(SUM(CASE WHEN crt.direction = 'out' AND crt.type = 'refund' THEN crt.amount ELSE 0 END), 0) as total_refunds,
    COALESCE(SUM(CASE WHEN crt.direction = 'in' AND crt.type = 'payment' AND crt.payment_method = 'cash' THEN crt.amount ELSE 0 END), 0) as cash_payments,
    COALESCE(SUM(CASE WHEN crt.direction = 'in' AND crt.type = 'payment' AND crt.payment_method = 'cardnet' THEN crt.amount ELSE 0 END), 0) as card_payments,
    COALESCE(SUM(CASE WHEN crt.direction = 'in' AND crt.type = 'payment' AND crt.payment_method = 'transfer' THEN crt.amount ELSE 0 END), 0) as transfer_payments,
    COUNT(CASE WHEN crt.type = 'payment' THEN 1 END) as payment_count,
    COUNT(CASE WHEN crt.type = 'refund' THEN 1 END) as refund_count
FROM cash_registers cr
LEFT JOIN users u_op ON cr.operator_id = u_op.id
LEFT JOIN users u_ap ON cr.approved_by = u_ap.id
LEFT JOIN cash_register_transactions crt ON crt.cash_register_id = cr.id
GROUP BY cr.id, u_op.email, u_op.first_name, u_op.last_name, u_ap.first_name, u_ap.last_name, u_ap.email;
