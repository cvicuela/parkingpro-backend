const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { query } = require('../config/database');

/**
 * @route   GET /api/v1/payments
 * @desc    Listar pagos
 * @access  Private
 */
router.get('/', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const result = await query(
            `SELECT 
                p.*,
                c.first_name || ' ' || c.last_name as customer_name
             FROM payments p
             LEFT JOIN customers c ON p.customer_id = c.id
             ORDER BY p.created_at DESC
             LIMIT 100`
        );
        
        res.json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
