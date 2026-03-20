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
        const refunded = await paymentService.refundPayment(req.params.id, {
            requestingUser: req.user,
            reason: reason || null,
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
