const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { query } = require('../config/database');
const { isValidPlate, sanitizePlate } = require('../middleware/validators');

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
 * @route   GET /api/v1/vehicles/:id
 * @desc    Obtener vehículo por ID
 * @access  Private
 */
router.get('/:id', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const result = await query(
            `SELECT v.*, c.first_name || ' ' || c.last_name as customer_name
             FROM vehicles v
             JOIN customers c ON v.customer_id = c.id
             WHERE v.id = $1`,
            [req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Vehículo no encontrado' });
        }

        res.json({ success: true, data: result.rows[0] });
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

        if (!customerId || !plate) {
            return res.status(400).json({ error: 'Cliente y placa son requeridos' });
        }

        const cleanPlate = sanitizePlate(plate);
        if (!isValidPlate(cleanPlate)) {
            return res.status(400).json({ error: 'Formato de placa inválido (ej: A123456)' });
        }

        if (year && (year < 1980 || year > new Date().getFullYear() + 1)) {
            return res.status(400).json({ error: `Año debe estar entre 1980 y ${new Date().getFullYear() + 1}` });
        }

        // Check duplicate plate
        const existing = await query('SELECT id FROM vehicles WHERE plate = $1', [cleanPlate]);
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: `Ya existe un vehículo con placa ${cleanPlate}` });
        }

        const result = await query(
            `INSERT INTO vehicles (customer_id, plate, make, model, color, year)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [customerId, cleanPlate, make, model, color, year]
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
 * @route   PATCH /api/v1/vehicles/:id
 * @desc    Actualizar vehículo
 * @access  Private
 */
router.patch('/:id', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        const fields = [];
        const values = [];
        let paramCount = 1;

        const allowedFields = ['plate', 'make', 'model', 'color', 'year', 'customer_id', 'is_primary'];

        // Validate plate if updating
        if (updates.plate) {
            const cleanPlate = sanitizePlate(updates.plate);
            if (!isValidPlate(cleanPlate)) {
                return res.status(400).json({ error: 'Formato de placa inválido (ej: A123456)' });
            }
            // Check duplicate plate (excluding current vehicle)
            const existing = await query('SELECT id FROM vehicles WHERE plate = $1 AND id != $2', [cleanPlate, id]);
            if (existing.rows.length > 0) {
                return res.status(409).json({ error: `Ya existe un vehículo con placa ${cleanPlate}` });
            }
            updates.plate = cleanPlate;
        }

        if (updates.year && (updates.year < 1980 || updates.year > new Date().getFullYear() + 1)) {
            return res.status(400).json({ error: `Año debe estar entre 1980 y ${new Date().getFullYear() + 1}` });
        }

        for (const [key, value] of Object.entries(updates)) {
            const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
            if (allowedFields.includes(snakeKey)) {
                fields.push(`${snakeKey} = $${paramCount}`);
                values.push(value);
                paramCount++;
            }
        }

        if (fields.length === 0) {
            return res.status(400).json({ error: 'No hay campos válidos para actualizar' });
        }

        values.push(id);

        const result = await query(
            `UPDATE vehicles
             SET ${fields.join(', ')}, updated_at = NOW()
             WHERE id = $${paramCount}
             RETURNING *`,
            values
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Vehículo no encontrado' });
        }

        res.json({
            success: true,
            message: 'Vehículo actualizado exitosamente',
            data: result.rows[0]
        });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   DELETE /api/v1/vehicles/:id
 * @desc    Eliminar vehículo (solo si no tiene suscripciones activas)
 * @access  Private (Admin)
 */
router.delete('/:id', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const { id } = req.params;

        // Check for active subscriptions
        const activeSubs = await query(
            `SELECT id FROM subscriptions WHERE vehicle_id = $1 AND status IN ('active', 'pending', 'past_due')`,
            [id]
        );
        if (activeSubs.rows.length > 0) {
            return res.status(409).json({
                error: 'No se puede eliminar: el vehículo tiene suscripciones activas. Cancélalas primero.'
            });
        }

        const result = await query('DELETE FROM vehicles WHERE id = $1 RETURNING plate', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Vehículo no encontrado' });
        }

        res.json({
            success: true,
            message: `Vehículo ${result.rows[0].plate} eliminado exitosamente`
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
