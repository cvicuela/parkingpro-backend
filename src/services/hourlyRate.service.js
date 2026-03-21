const { query } = require('../config/database');
const { differenceInMinutes, addMinutes } = require('date-fns');

/**
 * Servicio para calcular tarifas de parqueo por hora
 */
class HourlyRateService {
    
    /**
     * Obtener tarifas configuradas para un plan
     */
    async getHourlyRates(planId) {
        const result = await query(
            `SELECT * FROM hourly_rates 
             WHERE plan_id = $1 AND is_active = true 
             ORDER BY hour_number ASC`,
            [planId]
        );
        
        return result.rows;
    }
    
    /**
     * Calcular monto a pagar basado en duración
     * @param {UUID} planId - ID del plan de parqueo por hora
     * @param {Date} entryTime - Hora de entrada
     * @param {Date} exitTime - Hora de salida (opcional, default: ahora)
     * @returns {Object} { amount, breakdown, totalMinutes, totalHours }
     */
    async calculateAmount(planId, entryTime, exitTime = new Date()) {
        // Obtener tarifas configuradas
        const rates = await this.getHourlyRates(planId);
        
        if (!rates || rates.length === 0) {
            throw new Error('No hay tarifas configuradas para este plan');
        }
        
        // Obtener tolerancia de minutos y configuración fiscal
        const toleranceResult = await query(
            `SELECT tolerance_minutes, price_includes_tax, tax_rate FROM plans WHERE id = $1`,
            [planId]
        );
        
        const planConfig = toleranceResult.rows[0] || {};
        const toleranceMinutes = planConfig.tolerance_minutes || 5;
        const priceIncludesTax = planConfig.price_includes_tax !== false;
        const taxRate = parseFloat(planConfig.tax_rate) || 0.18;
        
        // Calcular minutos totales
        let totalMinutes = differenceInMinutes(exitTime, entryTime);
        
        // Aplicar tolerancia
        if (totalMinutes <= toleranceMinutes) {
            return {
                amount: 0,
                breakdown: [{
                    hour: 0,
                    rate: 0,
                    description: `Gratis (tolerancia de ${toleranceMinutes} minutos)`
                }],
                totalMinutes,
                totalHours: 0,
                isFree: true
            };
        }
        
        // Restar tolerancia
        totalMinutes -= toleranceMinutes;
        
        // Calcular horas (redondear hacia arriba)
        const totalHours = Math.ceil(totalMinutes / 60);
        
        // Calcular breakdown y monto total
        const breakdown = [];
        let totalAmount = 0;
        
        for (let hour = 1; hour <= totalHours; hour++) {
            // Buscar tarifa específica para esta hora
            let hourRate = rates.find(r => r.hour_number === hour);
            
            // Si no existe, usar la última tarifa configurada
            if (!hourRate) {
                hourRate = rates[rates.length - 1];
            }
            
            const rate = parseFloat(hourRate.rate);
            totalAmount += rate;
            
            breakdown.push({
                hour,
                rate,
                description: hourRate.description || `Hora ${hour}`
            });
        }
        
        // Calcular desglose fiscal
        let subtotal, taxAmount;
        if (priceIncludesTax) {
            subtotal = Math.round((totalAmount / (1 + taxRate)) * 100) / 100;
            taxAmount = Math.round((totalAmount - subtotal) * 100) / 100;
        } else {
            subtotal = totalAmount;
            taxAmount = Math.round((totalAmount * taxRate) * 100) / 100;
            totalAmount = subtotal + taxAmount;
        }

        return {
            amount: totalAmount,
            subtotal,
            taxAmount,
            taxRate,
            priceIncludesTax,
            breakdown,
            totalMinutes,
            totalHours,
            toleranceApplied: toleranceMinutes,
            isFree: false
        };
    }
    
    /**
     * Crear o actualizar tarifas por hora
     */
    async updateHourlyRates(planId, rates) {
        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');
            
            // Desactivar todas las tarifas existentes
            await client.query(
                `UPDATE hourly_rates SET is_active = false WHERE plan_id = $1`,
                [planId]
            );
            
            // Insertar nuevas tarifas
            for (const rate of rates) {
                await client.query(
                    `INSERT INTO hourly_rates (plan_id, hour_number, rate, description)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT (plan_id, hour_number) 
                     DO UPDATE SET 
                         rate = EXCLUDED.rate,
                         description = EXCLUDED.description,
                         is_active = true,
                         updated_at = NOW()`,
                    [planId, rate.hour_number, rate.rate, rate.description]
                );
            }
            
            await client.query('COMMIT');
            
            return await this.getHourlyRates(planId);
            
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
    
    /**
     * Iniciar sesión de parqueo por hora
     */
    async startParkingSession(vehiclePlate, planId, assignedSpot = null, customerId = null) {
        const result = await query(
            `INSERT INTO parking_sessions (
                vehicle_plate, plan_id, customer_id, assigned_spot,
                entry_time, status
            ) VALUES ($1, $2, $3, $4, NOW(), 'active')
            RETURNING *`,
            [vehiclePlate, planId, customerId, assignedSpot]
        );
        
        return result.rows[0];
    }
    
    /**
     * Finalizar sesión y calcular pago
     */
    async endParkingSession(sessionId, exitTime = new Date()) {
        // Obtener sesión
        const sessionResult = await query(
            `SELECT * FROM parking_sessions WHERE id = $1 AND status = 'active'`,
            [sessionId]
        );
        
        if (sessionResult.rows.length === 0) {
            throw new Error('Sesión no encontrada o ya finalizada');
        }
        
        const session = sessionResult.rows[0];
        
        // Calcular monto
        const calculation = await this.calculateAmount(
            session.plan_id,
            session.entry_time,
            exitTime
        );
        
        // Calcular duración en minutos
        const durationMinutes = differenceInMinutes(exitTime, session.entry_time);
        
        // Actualizar sesión
        const updateResult = await query(
            `UPDATE parking_sessions 
             SET exit_time = $1,
                 duration_minutes = $2,
                 calculated_amount = $3,
                 status = 'closed',
                 updated_at = NOW()
             WHERE id = $4
             RETURNING *`,
            [exitTime, durationMinutes, calculation.amount, sessionId]
        );
        
        return {
            session: updateResult.rows[0],
            calculation
        };
    }
    
    /**
     * Obtener sesiones activas
     */
    async getActiveSessions() {
        const result = await query(
            `SELECT
                ps.id, ps.vehicle_plate, ps.plan_id, ps.customer_id,
                ps.entry_time, ps.status, ps.assigned_spot,
                p.name as plan_name,
                COALESCE(c.first_name || ' ' || c.last_name, 'Visitante') as customer_name,
                EXTRACT(EPOCH FROM (NOW() - ps.entry_time))/60 as minutes_elapsed
             FROM parking_sessions ps
             JOIN plans p ON ps.plan_id = p.id
             LEFT JOIN customers c ON ps.customer_id = c.id
             WHERE ps.status = 'active'
             ORDER BY ps.entry_time DESC`
        );
        
        // Calcular monto actual para cada sesión activa
        const sessions = await Promise.all(result.rows.map(async (session) => {
            const calculation = await this.calculateAmount(
                session.plan_id,
                session.entry_time
            );
            
            return {
                ...session,
                current_amount: calculation.amount,
                current_breakdown: calculation.breakdown
            };
        }));
        
        return sessions;
    }
    
    /**
     * Buscar sesión por placa
     */
    async findActiveSessionByPlate(vehiclePlate) {
        const result = await query(
            `SELECT * FROM parking_sessions 
             WHERE vehicle_plate = $1 AND status = 'active'
             ORDER BY entry_time DESC
             LIMIT 1`,
            [vehiclePlate]
        );
        
        if (result.rows.length === 0) {
            return null;
        }
        
        const session = result.rows[0];
        
        // Calcular monto actual
        const calculation = await this.calculateAmount(
            session.plan_id,
            session.entry_time
        );
        
        return {
            ...session,
            current_amount: calculation.amount,
            current_breakdown: calculation.breakdown,
            minutes_elapsed: differenceInMinutes(new Date(), session.entry_time)
        };
    }
    
    /**
     * Registrar pago de sesión
     */
    async recordSessionPayment(sessionId, paymentId, amount) {
        const result = await query(
            `UPDATE parking_sessions 
             SET payment_id = $1,
                 paid_amount = $2,
                 payment_status = 'paid',
                 status = 'paid',
                 updated_at = NOW()
             WHERE id = $3
             RETURNING *`,
            [paymentId, amount, sessionId]
        );
        
        return result.rows[0];
    }
    
    /**
     * Obtener estadísticas de parqueo por hora
     */
    async getHourlyParkingStats(startDate, endDate) {
        const result = await query(
            `SELECT 
                COUNT(*) as total_sessions,
                SUM(calculated_amount) as total_revenue,
                AVG(duration_minutes) as avg_duration_minutes,
                MAX(duration_minutes) as max_duration_minutes,
                MIN(duration_minutes) as min_duration_minutes,
                COUNT(DISTINCT vehicle_plate) as unique_vehicles
             FROM parking_sessions
             WHERE entry_time >= $1 
               AND entry_time <= $2
               AND status IN ('paid', 'closed')`,
            [startDate, endDate]
        );
        
        return result.rows[0];
    }
}

module.exports = new HourlyRateService();
