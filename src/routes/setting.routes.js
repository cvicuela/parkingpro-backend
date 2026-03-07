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

/**
 * @route   PATCH /api/v1/settings/:key
 * @desc    Actualizar configuración específica
 * @access  Private (Admin)
 */
router.patch('/:key', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const { key } = req.params;
        const { value } = req.body;

        if (value === undefined || value === null) {
            return res.status(400).json({ error: 'El campo value es requerido' });
        }

        const jsonValue = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(String(value));

        const result = await query(
            `UPDATE settings SET value = $1::jsonb, updated_by = $2, updated_at = NOW() WHERE key = $3 RETURNING *`,
            [jsonValue, req.user.id, key]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Configuración no encontrada' });
        }

        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/settings
 * @desc    Crear nueva configuración
 * @access  Private (Super Admin)
 */
router.post('/', authenticate, authorize(['super_admin']), async (req, res, next) => {
    try {
        const { key, value, description, category } = req.body;

        if (!key || value === undefined) {
            return res.status(400).json({ error: 'key y value son requeridos' });
        }

        const jsonValue = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(String(value));

        const result = await query(
            `INSERT INTO settings (key, value, description, category, updated_by)
             VALUES ($1, $2::jsonb, $3, $4, $5)
             ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, description = COALESCE($3, settings.description), category = COALESCE($4, settings.category), updated_by = $5, updated_at = NOW()
             RETURNING *`,
            [key, jsonValue, description || null, category || 'general', req.user.id]
        );

        res.status(201).json({ success: true, data: result.rows[0] });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
