const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { query } = require('../config/database');

/**
 * @route   GET /api/v1/settings
 * @desc    Obtener todas las configuraciones
 * @access  Private (Admin)
 */
router.get('/', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const result = await query(
            `SELECT * FROM settings ORDER BY category, key`
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
 * @route   GET /api/v1/settings/:key
 * @desc    Obtener configuración específica
 * @access  Private
 */
router.get('/:key', authenticate, async (req, res, next) => {
    try {
        const { key } = req.params;
        
        const result = await query(
            `SELECT * FROM settings WHERE key = $1`,
            [key]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                error: 'Configuración no encontrada'
            });
        }
        
        res.json({
            success: true,
            data: result.rows[0]
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
