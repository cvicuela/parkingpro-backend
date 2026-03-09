const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { query } = require('../config/database');

/**
 * @route   GET /api/v1/vehicles
 * @desc    Listar vehículos
 * @access  Private
 */
router.get('/', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const result = await query(
            `SELECT v.*, c.first_name || ' ' || c.last_name as customer_name
             FROM vehicles v
             JOIN customers c ON v.customer_id = c.id
             ORDER BY v.created_at DESC`
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
 * @route   POST /api/v1/vehicles
 * @desc    Crear vehículo
 * @access  Private
 */
router.post('/', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const { customerId, plate, make, model, color, year } = req.body;
        
        const result = await query(
            `INSERT INTO vehicles (customer_id, plate, make, model, color, year)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [customerId, plate, make, model, color, year]
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
