const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { query, supabase } = require('../config/database');

/**
 * @route   GET /api/v1/subscriptions
 * @desc    Listar suscripciones
 * @access  Private
 */
router.get('/', authenticate, async (req, res, next) => {
    try {
        const result = await query(
            `SELECT 
                s.*,
                c.first_name || ' ' || c.last_name as customer_name,
                v.plate,
                p.name as plan_name
             FROM subscriptions s
             JOIN customers c ON s.customer_id = c.id
             JOIN vehicles v ON s.vehicle_id = v.id
             JOIN plans p ON s.plan_id = p.id
             ORDER BY s.created_at DESC`
        );
        
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
router.post('/', authenticate, async (req, res, next) => {
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
router.post('/:id/cancel', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;

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

        // Call the Supabase RPC cancel_subscription with p_reason parameter
        const token = process.env.SUPABASE_SERVICE_KEY;
        const { data: rpcResult, error: rpcError } = await supabase.rpc('cancel_subscription', {
            p_token: token,
            p_id: id,
            p_reason: reason || null
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
