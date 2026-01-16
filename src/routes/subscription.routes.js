const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { query } = require('../config/database');

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

module.exports = router;
