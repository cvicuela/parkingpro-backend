const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { query } = require('../config/database');
const hourlyRateService = require('../services/hourlyRate.service');

/**
 * @route   GET /api/v1/plans
 * @desc    Obtener todos los planes activos
 * @access  Public
 */
router.get('/', async (req, res, next) => {
    try {
        const result = await query(
            `SELECT * FROM plans 
             WHERE is_active = true 
             ORDER BY display_order ASC`
        );
        
        // Obtener tarifas por hora para planes hourly
        const plans = await Promise.all(result.rows.map(async (plan) => {
            if (plan.type === 'hourly') {
                const rates = await hourlyRateService.getHourlyRates(plan.id);
                return { ...plan, hourly_rates: rates };
            }
            return plan;
        }));
        
        res.json({
            success: true,
            data: plans
        });
        
    } catch (error) {
        next(error);
    }
});

/**
 * @route   GET /api/v1/plans/:id
 * @desc    Obtener plan por ID
 * @access  Public
 */
router.get('/:id', async (req, res, next) => {
    try {
        const { id } = req.params;
        
        const result = await query(
            `SELECT * FROM plans WHERE id = $1`,
            [id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                error: 'Plan no encontrado'
            });
        }
        
        let plan = result.rows[0];
        
        // Si es plan hourly, obtener tarifas
        if (plan.type === 'hourly') {
            const rates = await hourlyRateService.getHourlyRates(plan.id);
            plan = { ...plan, hourly_rates: rates };
        }
        
        res.json({
            success: true,
            data: plan
        });
        
    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/plans
 * @desc    Crear nuevo plan
 * @access  Private (Admin)
 */
router.post('/', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const {
            name,
            type,
            description,
            basePrice,
            weeklyPrice,
            startHour,
            endHour,
            crossesMidnight,
            toleranceMinutes,
            maxCapacity,
            dailyEntryLimit,
            hourlyRates // Para planes tipo hourly: [{ hour_number, rate, description }]
        } = req.body;
        
        // Validaciones
        if (!name || !type || !basePrice || !maxCapacity) {
            return res.status(400).json({
                error: 'name, type, basePrice y maxCapacity son requeridos'
            });
        }
        
        // Insertar plan
        const result = await query(
            `INSERT INTO plans (
                name, type, description, base_price, weekly_price,
                start_hour, end_hour, crosses_midnight, tolerance_minutes,
                max_capacity, daily_entry_limit
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING *`,
            [
                name, type, description, basePrice, weeklyPrice,
                startHour, endHour, crossesMidnight, toleranceMinutes || 15,
                maxCapacity, dailyEntryLimit || 5
            ]
        );
        
        let plan = result.rows[0];
        
        // Si es plan hourly, crear tarifas
        if (type === 'hourly' && hourlyRates && hourlyRates.length > 0) {
            const rates = await hourlyRateService.updateHourlyRates(plan.id, hourlyRates);
            plan = { ...plan, hourly_rates: rates };
        }
        
        res.status(201).json({
            success: true,
            message: 'Plan creado exitosamente',
            data: plan
        });
        
    } catch (error) {
        next(error);
    }
});

/**
 * @route   PATCH /api/v1/plans/:id
 * @desc    Actualizar plan
 * @access  Private (Admin)
 */
router.patch('/:id', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        
        // Construir query dinámico
        const fields = [];
        const values = [];
        let paramCount = 1;
        
        const allowedFields = [
            'name', 'description', 'base_price', 'weekly_price',
            'start_hour', 'end_hour', 'crosses_midnight', 'tolerance_minutes',
            'max_capacity', 'daily_entry_limit', 'overage_hourly_rate',
            'additional_vehicle_monthly', 'is_active'
        ];
        
        for (const [key, value] of Object.entries(updates)) {
            const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
            
            if (allowedFields.includes(snakeKey) && value !== undefined) {
                fields.push(`${snakeKey} = $${paramCount}`);
                values.push(value);
                paramCount++;
            }
        }
        
        if (fields.length === 0) {
            return res.status(400).json({
                error: 'No hay campos válidos para actualizar'
            });
        }
        
        fields.push(`updated_at = NOW()`);
        values.push(id);
        
        const result = await query(
            `UPDATE plans SET ${fields.join(', ')} 
             WHERE id = $${paramCount}
             RETURNING *`,
            values
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                error: 'Plan no encontrado'
            });
        }
        
        let plan = result.rows[0];
        
        // Si se actualizaron hourlyRates
        if (updates.hourlyRates && plan.type === 'hourly') {
            const rates = await hourlyRateService.updateHourlyRates(plan.id, updates.hourlyRates);
            plan = { ...plan, hourly_rates: rates };
        }
        
        res.json({
            success: true,
            message: 'Plan actualizado exitosamente',
            data: plan
        });
        
    } catch (error) {
        next(error);
    }
});

/**
 * @route   DELETE /api/v1/plans/:id
 * @desc    Eliminar (desactivar) plan
 * @access  Private (Admin)
 */
router.delete('/:id', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const { id } = req.params;
        
        // No eliminar físicamente, solo desactivar
        const result = await query(
            `UPDATE plans 
             SET is_active = false, updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                error: 'Plan no encontrado'
            });
        }
        
        res.json({
            success: true,
            message: 'Plan desactivado exitosamente',
            data: result.rows[0]
        });
        
    } catch (error) {
        next(error);
    }
});

/**
 * @route   GET /api/v1/plans/:id/occupancy
 * @desc    Obtener ocupación actual del plan
 * @access  Public
 */
router.get('/:id/occupancy', async (req, res, next) => {
    try {
        const { id } = req.params;
        
        const result = await query(
            `SELECT 
                id,
                name,
                type,
                current_occupancy,
                max_capacity,
                ROUND((current_occupancy::DECIMAL / max_capacity) * 100, 2) as occupancy_percentage,
                max_capacity - current_occupancy as available_spots
             FROM plans
             WHERE id = $1`,
            [id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                error: 'Plan no encontrado'
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
 * @route   GET /api/v1/plans/hourly/rates/:planId
 * @desc    Obtener tarifas por hora de un plan
 * @access  Public
 */
router.get('/hourly/rates/:planId', async (req, res, next) => {
    try {
        const { planId } = req.params;
        
        const rates = await hourlyRateService.getHourlyRates(planId);
        
        res.json({
            success: true,
            data: rates
        });
        
    } catch (error) {
        next(error);
    }
});

/**
 * @route   PUT /api/v1/plans/hourly/rates/:planId
 * @desc    Actualizar tarifas por hora
 * @access  Private (Admin)
 */
router.put('/hourly/rates/:planId', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const { planId } = req.params;
        const { rates } = req.body;
        
        if (!rates || !Array.isArray(rates)) {
            return res.status(400).json({
                error: 'rates debe ser un array de tarifas'
            });
        }
        
        // Validar formato
        for (const rate of rates) {
            if (!rate.hour_number || !rate.rate) {
                return res.status(400).json({
                    error: 'Cada tarifa debe tener hour_number y rate'
                });
            }
        }
        
        const updatedRates = await hourlyRateService.updateHourlyRates(planId, rates);
        
        res.json({
            success: true,
            message: 'Tarifas actualizadas exitosamente',
            data: updatedRates
        });
        
    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/plans/hourly/calculate
 * @desc    Calcular costo de parqueo por hora (simulación)
 * @access  Public
 */
router.post('/hourly/calculate', async (req, res, next) => {
    try {
        const { planId, entryTime, exitTime } = req.body;
        
        if (!planId || !entryTime) {
            return res.status(400).json({
                error: 'planId y entryTime son requeridos'
            });
        }
        
        const entry = new Date(entryTime);
        const exit = exitTime ? new Date(exitTime) : new Date();
        
        const calculation = await hourlyRateService.calculateAmount(planId, entry, exit);
        
        res.json({
            success: true,
            data: calculation
        });
        
    } catch (error) {
        next(error);
    }
});

module.exports = router;
