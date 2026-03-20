const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { query, supabase } = require('../config/database');

/**
 * @route   GET /api/v1/subscriptions
 * @desc    Listar suscripciones
 * @access  Private
 */
router.get('/', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const { search, status } = req.query;
        let sql = `SELECT
                s.*,
                c.first_name || ' ' || c.last_name as customer_name,
                c.phone as customer_phone,
                c.email as customer_email,
                c.id_document as customer_document,
                v.plate as vehicle_plate,
                v.make as vehicle_make,
                v.model as vehicle_model,
                p.name as plan_name,
                p.base_price as plan_price
             FROM subscriptions s
             JOIN customers c ON s.customer_id = c.id
             LEFT JOIN vehicles v ON s.vehicle_id = v.id
             JOIN plans p ON s.plan_id = p.id`;

        const params = [];
        const conditions = [];

        if (search) {
            params.push(`%${search}%`);
            conditions.push(`(c.first_name || ' ' || c.last_name ILIKE $${params.length} OR v.plate ILIKE $${params.length})`);
        }
        if (status) {
            params.push(status);
            conditions.push(`s.status = $${params.length}`);
        }

        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }
        sql += ' ORDER BY s.created_at DESC';

        const result = await query(sql, params);

        res.json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/subscriptions
 * @desc    Crear suscripción
 * @access  Private
 */
router.post('/', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const { customerId, vehicleId, planId, pricePerPeriod } = req.body;
        
        const result = await query(
            `INSERT INTO subscriptions (
                customer_id, vehicle_id, plan_id, 
                price_per_period, status, started_at
            ) VALUES ($1, $2, $3, $4, 'pending', NOW())
            RETURNING *`,
            [customerId, vehicleId, planId, pricePerPeriod]
        );
        
        res.status(201).json({
            success: true,
            data: result.rows[0]
        });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/subscriptions/:id/cancel
 * @desc    Cancelar suscripción con motivo opcional
 * @access  Private (Admin)
 */
router.post('/:id/cancel', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;

        if (!reason || reason.trim().length < 3) {
            return res.status(400).json({
                success: false,
                error: 'Se requiere un motivo de cancelación (mínimo 3 caracteres)'
            });
        }

        // Verify subscription exists
        const existing = await query(
            'SELECT * FROM subscriptions WHERE id = $1',
            [id]
        );

        if (existing.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Suscripción no encontrada'
            });
        }

        if (existing.rows[0].status === 'cancelled') {
            return res.status(400).json({
                success: false,
                error: 'La suscripción ya está cancelada'
            });
        }

        // Use the authenticated user's token (not service key)
        const token = req.headers.authorization?.split(' ')[1];
        const { data: rpcResult, error: rpcError } = await supabase.rpc('cancel_subscription', {
            p_token: token,
            p_id: id,
            p_reason: reason.trim()
        });

        if (rpcError) {
            throw new Error(`Error al cancelar suscripción: ${rpcError.message}`);
        }

        // Re-fetch the updated subscription
        const result = await query(
            'SELECT * FROM subscriptions WHERE id = $1',
            [id]
        );

        res.json({
            success: true,
            message: 'Suscripción cancelada',
            data: result.rows[0]
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
