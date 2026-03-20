const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { query } = require('../config/database');
const paymentService = require('../services/payment.service');

router.get('/', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const { status, startDate, endDate, search, limit, offset } = req.query;
        const params = [];
        let where = 'WHERE 1=1';

        if (status)    { params.push(status);       where += ` AND p.status = $${params.length}`; }
        if (startDate) { params.push(startDate);    where += ` AND p.created_at >= $${params.length}`; }
        if (endDate)   { params.push(endDate);      where += ` AND p.created_at <= $${params.length}`; }
        if (search)    { params.push(`%${search}%`); where += ` AND (c.first_name || ' ' || c.last_name ILIKE $${params.length} OR p.payment_method ILIKE $${params.length})`; }

        params.push(parseInt(limit) || 100, parseInt(offset) || 0);

        const result = await query(
            `SELECT p.*,
                COALESCE(c.first_name || ' ' || c.last_name, 'Sin cliente') as customer_name,
                i.invoice_number, i.ncf
             FROM payments p
             LEFT JOIN customers c ON p.customer_id = c.id
             LEFT JOIN invoices i ON i.payment_id = p.id
             ${where}
             ORDER BY p.created_at DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        next(error);
    }
});

router.get('/:id', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const result = await query(
            `SELECT p.*, COALESCE(c.first_name || ' ' || c.last_name, 'Sin cliente') as customer_name,
                i.invoice_number, i.ncf
             FROM payments p
             LEFT JOIN customers c ON p.customer_id = c.id
             LEFT JOIN invoices i ON i.payment_id = p.id
             WHERE p.id = $1`,
            [req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Pago no encontrado' });
        }
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        next(error);
    }
});

router.post('/:id/refund', authenticate, authorize(['operator', 'admin', 'super_admin']), auditMiddleware('payment_refund'), async (req, res, next) => {
    try {
        const { reason } = req.body;
        const paymentId = req.params.id;

        if (!reason || reason.trim().length < 3) {
            return res.status(400).json({ error: 'Se requiere un motivo de reembolso (mínimo 3 caracteres)' });
        }

        // Verify payment exists and is refundable
        const payment = await query('SELECT id, status, total_amount FROM payments WHERE id = $1', [paymentId]);
        if (payment.rows.length === 0) {
            return res.status(404).json({ error: 'Pago no encontrado' });
        }
        if (payment.rows[0].status === 'refunded') {
            return res.status(409).json({ error: 'Este pago ya fue reembolsado' });
        }
        if (payment.rows[0].status !== 'paid') {
            return res.status(400).json({ error: 'Solo se pueden reembolsar pagos completados' });
        }

        // Operators can only refund payments from their own active cash register
        if (req.user.role === 'operator') {
            const activeRegister = await query(
                `SELECT cr.id FROM cash_registers cr WHERE cr.operator_id = $1 AND cr.status = 'open'`,
                [req.user.id]
            );
            if (activeRegister.rows.length === 0) {
                return res.status(403).json({ error: 'Debes tener una caja abierta para realizar reembolsos' });
            }

            // Check if payment was recorded in this register or has no register (hourly)
            const txnCheck = await query(
                `SELECT 1 FROM cash_register_transactions
                 WHERE cash_register_id = $1 AND reference_id = $2 AND transaction_type = 'payment'`,
                [activeRegister.rows[0].id, paymentId]
            );
            // Admin/super_admin can refund any payment; operators only their own register's payments
            if (txnCheck.rows.length === 0) {
                // Also allow if payment has no register txn (e.g. card payments, legacy)
                const anyTxn = await query(
                    `SELECT 1 FROM cash_register_transactions WHERE reference_id = $1 AND transaction_type = 'payment'`,
                    [paymentId]
                );
                if (anyTxn.rows.length > 0) {
                    return res.status(403).json({ error: 'Solo puedes reembolsar pagos registrados en tu caja' });
                }
            }
        }

        const refunded = await paymentService.refundPayment(paymentId, {
            requestingUser: req.user,
            reason: reason.trim(),
            req
        });
        res.json({ success: true, data: refunded });

        // Emit real-time update after refund
        try {
            const io = req.app.get('io');
            if (io) {
                io.to('dashboard').emit('payment_received', {
                    amount: -(refunded.total_amount || refunded.amount || 0),
                    provider: refunded.payment_method || 'unknown',
                    type: 'refund',
                    time: new Date().toISOString()
                });
            }
        } catch (e) { /* non-critical */ }
    } catch (error) {
        next(error);
    }
});

module.exports = router;
