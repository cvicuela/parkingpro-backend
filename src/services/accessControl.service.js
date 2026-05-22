const { query, transaction } = require('../config/database');
const { isWithinInterval, getHours, getMinutes, addHours } = require('date-fns');
const hourlyRateService = require('./hourlyRate.service');
const rfidService = require('./rfid.service');
const pushService = require('./push.service');

// ── Timezone helpers ────────────────────────────────────────
// Dominican Republic is America/Santo_Domingo (UTC-4, no DST). Plan-hour windows
// and overage must be evaluated in DR local time, not the server process timezone
// (a UTC-deployed process would otherwise shift every boundary by 4 hours).
const DR_TZ = 'America/Santo_Domingo';
const DR_OFFSET_MS = 4 * 60 * 60 * 1000; // UTC = DR + 4h

function drHourMinute(date) {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: DR_TZ, hour12: false, hour: '2-digit', minute: '2-digit' });
    let hour = 0, minute = 0;
    for (const p of f.formatToParts(date)) {
        if (p.type === 'hour') hour = parseInt(p.value, 10) % 24;
        else if (p.type === 'minute') minute = parseInt(p.value, 10);
    }
    return { hour, minute };
}

function drDateParts(date) {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: DR_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
    let y = 0, m = 0, d = 0;
    for (const p of f.formatToParts(date)) {
        if (p.type === 'year') y = parseInt(p.value, 10);
        else if (p.type === 'month') m = parseInt(p.value, 10);
        else if (p.type === 'day') d = parseInt(p.value, 10);
    }
    return { y, m, d };
}

function drTodayStr(date = new Date()) {
    const { y, m, d } = drDateParts(date);
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Calendar date 'YYYY-MM-DD' of a pg DATE value (parsed as a Date at local
// midnight, or a string) — kept as-is, NOT timezone-shifted.
function calendarDateStr(value) {
    if (value instanceof Date) {
        const y = value.getFullYear();
        const m = String(value.getMonth() + 1).padStart(2, '0');
        const d = String(value.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    return String(value).slice(0, 10);
}

/**
 * Servicio de Control de Acceso
 * Maneja tanto suscripciones como parqueo por hora
 */
class AccessControlService {

    /**
     * Resolver método de acceso (RFID > QR > Manual)
     * Punto de entrada principal que determina qué método usar
     */
    async resolveAccessMethod({ rfidUid, qrData, vehiclePlate, type }) {
        // Priority 1: RFID
        if (rfidUid) {
            const resolution = await rfidService.resolveCardForAccess(rfidUid);
            if (!resolution.allowed && resolution.allowed !== undefined) {
                return resolution; // Card disabled/lost/not found
            }

            const plate = resolution.subscription?.vehicle_plate || vehiclePlate;
            if (!plate) {
                return { allowed: false, reason: 'NO_PLATE', message: 'No se pudo determinar la placa del vehículo' };
            }

            let result;
            if (type === 'entry') {
                result = await this.validateEntry(plate);
            } else {
                result = await this.validateExit(plate);
            }

            // Attach RFID info to result
            result.accessMethod = 'rfid';
            result.rfidCard = resolution.card;
            return result;
        }

        // Priority 2: QR
        if (qrData) {
            const plate = qrData.plate || vehiclePlate;
            let result;
            if (type === 'entry') {
                result = await this.validateEntry(plate);
            } else {
                result = await this.validateExit(plate);
            }
            result.accessMethod = 'qr';
            result.qrData = qrData;
            return result;
        }

        // Priority 3: Manual (plate only)
        if (vehiclePlate) {
            let result;
            if (type === 'entry') {
                result = await this.validateEntry(vehiclePlate);
            } else {
                result = await this.validateExit(vehiclePlate);
            }
            result.accessMethod = 'manual';
            return result;
        }

        return { allowed: false, reason: 'NO_IDENTIFICATION', message: 'Se requiere RFID, QR o placa del vehículo' };
    }

    /**
     * Validar acceso de entrada
     * Determina si el vehículo puede entrar y bajo qué modalidad
     */
    async validateEntry(vehiclePlate, timestamp = new Date()) {
        const plate = vehiclePlate.toUpperCase().trim();
        
        // 1. Buscar suscripción activa
        const subscription = await this.findActiveSubscription(plate);
        
        if (subscription) {
            // Validar suscripción
            return await this.validateSubscriptionEntry(subscription, timestamp);
        }
        
        // 2. No tiene suscripción - verificar si hay plan por hora disponible
        const hourlyPlan = await this.getAvailableHourlyPlan();
        
        if (!hourlyPlan) {
            return {
                allowed: false,
                reason: 'NO_SUBSCRIPTION_NO_HOURLY',
                message: 'No tienes suscripción activa y el parqueo por hora no está disponible',
                suggestedAction: 'Registra una suscripción o contacta a administración'
            };
        }
        
        // 3. Verificar si ya tiene sesión activa
        const activeSession = await hourlyRateService.findActiveSessionByPlate(plate);
        
        if (activeSession) {
            return {
                allowed: false,
                reason: 'ALREADY_INSIDE',
                message: 'Ya tienes una sesión activa. Debes salir primero.',
                session: activeSession
            };
        }
        
        // 4. Permitir entrada por hora
        return {
            allowed: true,
            accessType: 'hourly',
            plan: hourlyPlan,
            message: 'Acceso permitido - Parqueo por hora',
            rates: await hourlyRateService.getHourlyRates(hourlyPlan.id),
            nextStep: 'start_parking_session'
        };
    }
    
    /**
     * Validar entrada para suscripción
     */
    async validateSubscriptionEntry(subscription, timestamp) {
        const { hour: currentHour, minute: currentMinute } = drHourMinute(timestamp);

        // Validar vigencia — la suscripción es válida DURANTE todo el día de
        // next_billing_date (el cobro corre cuando next_billing_date <= CURRENT_DATE).
        // Comparar por fecha calendario (hora local RD) para no bloquear el último día.
        if (calendarDateStr(subscription.next_billing_date) < drTodayStr()) {
            return {
                allowed: false,
                reason: 'SUBSCRIPTION_EXPIRED',
                message: 'Tu suscripción ha vencido',
                expiryDate: subscription.next_billing_date,
                suggestedAction: 'Renueva tu plan'
            };
        }
        
        // Validar estado
        if (subscription.status !== 'active') {
            return {
                allowed: false,
                reason: 'SUBSCRIPTION_NOT_ACTIVE',
                message: `Suscripción ${subscription.status}`,
                status: subscription.status
            };
        }
        
        // Validar horario del plan
        if (subscription.plan_type !== '24h' && subscription.plan_type !== 'hourly') {
            const isAllowed = this.isWithinAllowedHours(
                currentHour,
                currentMinute,
                subscription.start_hour,
                subscription.end_hour,
                subscription.crosses_midnight,
                subscription.tolerance_minutes
            );
            
            if (!isAllowed) {
                return {
                    allowed: false,
                    reason: 'OUTSIDE_HOURS',
                    message: `Plan ${subscription.plan_name} no válido a esta hora`,
                    allowedHours: `${subscription.start_hour}:00 - ${subscription.end_hour}:00`,
                    currentHour: `${currentHour}:${currentMinute.toString().padStart(2, '0')}`
                };
            }
        }
        
        // Validar capacidad
        if (subscription.current_occupancy >= subscription.max_capacity) {
            return {
                allowed: false,
                reason: 'FULL_CAPACITY',
                message: `Parqueo lleno para plan ${subscription.plan_name}`,
                capacity: `${subscription.current_occupancy}/${subscription.max_capacity}`
            };
        }
        
        // Validar límite de entradas diarias
        const todayEntries = await this.getTodayEntries(subscription.subscription_id);
        
        if (todayEntries >= subscription.daily_entry_limit) {
            return {
                allowed: false,
                reason: 'DAILY_LIMIT_EXCEEDED',
                message: `Límite de ${subscription.daily_entry_limit} entradas/día alcanzado`,
                entriesCount: todayEntries
            };
        }
        
        // ✅ TODO VÁLIDO
        return {
            allowed: true,
            accessType: 'subscription',
            subscription: {
                id: subscription.subscription_id,
                customer_name: subscription.customer_name,
                plan_name: subscription.plan_name,
                vehicle_plate: subscription.vehicle_plate,
                valid_until: subscription.next_billing_date
            },
            message: '✅ ACCESO PERMITIDO',
            nextStep: 'register_entry_event'
        };
    }
    
    /**
     * Validar salida
     */
    async validateExit(vehiclePlate, timestamp = new Date()) {
        const plate = vehiclePlate.toUpperCase().trim();
        
        // 1. Buscar entrada sin salida (suscripción)
        const entryEvent = await this.findOpenEntry(plate);
        
        if (entryEvent) {
            return await this.validateSubscriptionExit(entryEvent, timestamp);
        }
        
        // 2. Buscar sesión activa de parqueo por hora
        const activeSession = await hourlyRateService.findActiveSessionByPlate(plate);
        
        if (activeSession) {
            return await this.validateHourlyExit(activeSession, timestamp);
        }
        
        // 3. No se encontró entrada
        return {
            allowed: false,
            reason: 'NO_ENTRY_FOUND',
            message: 'No se encontró entrada registrada para este vehículo',
            plate
        };
    }
    
    /**
     * Validar salida de suscripción
     */
    async validateSubscriptionExit(entryEvent, timestamp) {
        const durationMinutes = Math.floor((timestamp - new Date(entryEvent.timestamp)) / 60000);
        
        // Verificar si salió fuera de horario
        let additionalCharges = 0;
        let chargeReason = null;
        
        if (entryEvent.plan_type !== '24h') {
            const { hour: exitHour, minute: exitMinute } = drHourMinute(timestamp);

            const isWithinHours = this.isWithinAllowedHours(
                exitHour,
                exitMinute,
                entryEvent.start_hour,
                entryEvent.end_hour,
                entryEvent.crosses_midnight,
                entryEvent.tolerance_minutes
            );
            
            if (!isWithinHours) {
                // Calcular horas fuera de horario
                const overageHours = this.calculateOverageHours(
                    new Date(entryEvent.timestamp),
                    timestamp,
                    entryEvent.end_hour,
                    entryEvent.tolerance_minutes
                );
                
                additionalCharges = Math.ceil(overageHours) * parseFloat(entryEvent.overage_hourly_rate);
                chargeReason = `Salida fuera de horario (${overageHours.toFixed(1)} horas extra)`;
            }
        }
        
        return {
            allowed: true,
            accessType: 'subscription',
            entry: entryEvent,
            exit: {
                timestamp,
                duration_minutes: durationMinutes,
                additional_charges: additionalCharges,
                charge_reason: chargeReason
            },
            message: additionalCharges > 0 
                ? `⚠️ Cargo adicional: RD$ ${additionalCharges.toFixed(2)}`
                : '✅ SALIDA AUTORIZADA',
            nextStep: 'register_exit_event'
        };
    }
    
    /**
     * Validar salida de parqueo por hora
     */
    async validateHourlyExit(session, timestamp) {
        const calculation = await hourlyRateService.calculateAmount(
            session.plan_id,
            session.entry_time,
            timestamp
        );
        
        return {
            allowed: true,
            barrier_allowed: calculation.isFree,
            accessType: 'hourly',
            session: {
                id: session.id,
                vehicle_plate: session.vehicle_plate,
                entry_time: session.entry_time,
                exit_time: timestamp,
                duration_minutes: calculation.totalMinutes
            },
            payment: {
                amount: calculation.amount,
                breakdown: calculation.breakdown,
                is_free: calculation.isFree
            },
            payment_status: calculation.isFree ? 'not_required' : 'pending',
            message: calculation.isFree
                ? '✅ SALIDA GRATIS (tolerancia)'
                : `💰 Total a pagar: RD$ ${calculation.amount.toFixed(2)}`,
            nextStep: calculation.isFree ? 'end_session' : 'process_payment'
        };
    }
    
    /**
     * Registrar entrada
     */
    async registerEntry(vehiclePlate, validationResult, operatorId = null) {
        const accessMethod = validationResult.accessMethod || (operatorId ? 'manual' : 'qr');
        const rfidCard = validationResult.rfidCard || null;

        return await transaction(async (client) => {
            if (validationResult.accessType === 'subscription') {
                // Build metadata
                const metadata = {};
                if (accessMethod === 'rfid') {
                    metadata.internal_only_qr = true;
                }

                // Registrar evento de acceso
                const eventResult = await client.query(
                    `INSERT INTO access_events (
                        subscription_id, vehicle_id, vehicle_plate,
                        type, timestamp, validation_method, access_method,
                        rfid_card_id, operator_id, was_valid
                    ) VALUES ($1, $2, $3, 'entry', NOW(), $4, $5, $6, $7, true)
                    RETURNING *`,
                    [
                        validationResult.subscription.id,
                        null, // vehicle_id se puede obtener del subscription si es necesario
                        vehiclePlate,
                        accessMethod,
                        accessMethod,
                        rfidCard?.id || null,
                        operatorId
                    ]
                );

                // If RFID permanent card, activate it
                if (accessMethod === 'rfid' && rfidCard) {
                    await rfidService.activateCard(rfidCard.id);
                }

                const result = {
                    type: 'subscription',
                    event: eventResult.rows[0],
                    metadata,
                    plan_name: validationResult.subscription?.plan_name || null,
                    plan_type: validationResult.subscription?.plan_type || null,
                    subscription_id: validationResult.subscription?.id || null,
                    customer_name: validationResult.subscription?.customer_name || null,
                };

                // Fire-and-forget push notification to admins
                try { pushService.sendToRole('admin', { title: 'Entrada registrada', body: `Vehiculo ${vehiclePlate} ha ingresado`, tag: 'access-event', data: { url: '/control-acceso' } }); } catch {}

                return result;

            } else if (validationResult.accessType === 'hourly') {
                // Iniciar sesión de parqueo por hora
                const session = await hourlyRateService.startParkingSession(
                    vehiclePlate,
                    validationResult.plan.id,
                    {
                        accessMethod: validationResult.accessMethod || 'qr',
                        rfidCardId: validationResult.rfidCard?.id || null
                    }
                );

                // Fire-and-forget push notification to admins
                try { pushService.sendToRole('admin', { title: 'Entrada registrada', body: `Vehiculo ${vehiclePlate} ha ingresado (por hora)`, tag: 'access-event', data: { url: '/control-acceso' } }); } catch {}

                return {
                    type: 'hourly',
                    session,
                    plan_name: validationResult.plan?.name || 'Por Hora',
                    plan_type: validationResult.plan?.type || 'hourly',
                    base_price: validationResult.plan?.base_price || null,
                };
            }
        });
    }

    /**
     * Registrar salida
     */
    async registerExit(vehiclePlate, validationResult, operatorId = null) {
        const accessMethod = validationResult.accessMethod || (operatorId ? 'manual' : 'qr');
        const rfidCard = validationResult.rfidCard || null;

        return await transaction(async (client) => {
            if (validationResult.accessType === 'subscription') {
                // Registrar evento de salida
                const eventResult = await client.query(
                    `INSERT INTO access_events (
                        subscription_id, vehicle_id, vehicle_plate,
                        type, timestamp, validation_method, access_method,
                        rfid_card_id, operator_id, was_valid, duration_minutes,
                        additional_charges, charge_reason
                    ) VALUES ($1, $2, $3, 'exit', NOW(), $4, $5, $6, $7, true, $8, $9, $10)
                    RETURNING *`,
                    [
                        validationResult.entry.subscription_id,
                        null,
                        vehiclePlate,
                        accessMethod,
                        accessMethod,
                        rfidCard?.id || null,
                        operatorId,
                        validationResult.exit.duration_minutes,
                        validationResult.exit.additional_charges,
                        validationResult.exit.charge_reason
                    ]
                );

                // Fire-and-forget push notification to admins
                try { pushService.sendToRole('admin', { title: 'Salida registrada', body: `Vehiculo ${vehiclePlate} ha salido`, tag: 'access-event', data: { url: '/control-acceso' } }); } catch {}

                return {
                    type: 'subscription',
                    event: eventResult.rows[0],
                    additionalCharges: validationResult.exit.additional_charges
                };

            } else if (validationResult.accessType === 'hourly') {
                // Finalizar sesión
                const result = await hourlyRateService.endParkingSession(
                    validationResult.session.id,
                    validationResult.session.exit_time
                );

                const exitResult = {
                    type: 'hourly',
                    session: result.session,
                    calculation: result.calculation
                };

                // If RFID temporary card, flag for return after payment
                if (accessMethod === 'rfid' && rfidCard) {
                    exitResult.rfidPendingReturn = true;
                }

                // Fire-and-forget push notification to admins
                try { pushService.sendToRole('admin', { title: 'Salida registrada', body: `Vehiculo ${vehiclePlate} ha salido (por hora)`, tag: 'access-event', data: { url: '/control-acceso' } }); } catch {}

                return exitResult;
            }
        });
    }
    
    // ==================== HELPERS ====================
    
    async findActiveSubscription(plate) {
        const result = await query(
            `SELECT 
                s.id as subscription_id,
                s.status,
                s.next_billing_date,
                c.first_name || ' ' || c.last_name as customer_name,
                v.plate as vehicle_plate,
                p.id as plan_id,
                p.name as plan_name,
                p.type as plan_type,
                p.start_hour,
                p.end_hour,
                p.crosses_midnight,
                p.tolerance_minutes,
                p.current_occupancy,
                p.max_capacity,
                p.daily_entry_limit,
                p.overage_hourly_rate
             FROM subscriptions s
             JOIN customers c ON s.customer_id = c.id
             JOIN vehicles v ON s.vehicle_id = v.id
             JOIN plans p ON s.plan_id = p.id
             WHERE v.plate = $1 AND s.status = 'active'
             LIMIT 1`,
            [plate]
        );
        
        return result.rows[0] || null;
    }
    
    async getAvailableHourlyPlan() {
        const result = await query(
            `SELECT * FROM plans 
             WHERE type = 'hourly' 
               AND is_active = true 
               AND current_occupancy < max_capacity
             LIMIT 1`
        );
        
        return result.rows[0] || null;
    }
    
    async getTodayEntries(subscriptionId) {
        const result = await query(
            `SELECT COUNT(*) as count
             FROM access_events
             WHERE subscription_id = $1 
               AND type = 'entry'
               AND DATE(timestamp) = CURRENT_DATE`,
            [subscriptionId]
        );
        
        return parseInt(result.rows[0].count);
    }
    
    async findOpenEntry(plate) {
        const result = await query(
            `SELECT 
                ae.*,
                p.type as plan_type,
                p.start_hour,
                p.end_hour,
                p.crosses_midnight,
                p.tolerance_minutes,
                p.overage_hourly_rate
             FROM access_events ae
             JOIN subscriptions s ON ae.subscription_id = s.id
             JOIN plans p ON s.plan_id = p.id
             WHERE ae.vehicle_plate = $1 
               AND ae.type = 'entry'
               AND NOT EXISTS (
                   SELECT 1 FROM access_events ae2 
                   WHERE ae2.vehicle_plate = $1 
                     AND ae2.type = 'exit' 
                     AND ae2.timestamp > ae.timestamp
               )
             ORDER BY ae.timestamp DESC
             LIMIT 1`,
            [plate]
        );
        
        return result.rows[0] || null;
    }
    
    isWithinAllowedHours(currentHour, currentMinute, startHour, endHour, crossesMidnight, toleranceMinutes) {
        const currentTime = currentHour + (currentMinute / 60);
        const tolerance = toleranceMinutes / 60;
        
        if (crossesMidnight) {
            // Ej: 18:00 - 06:00
            return currentTime >= (startHour - tolerance) || 
                   currentTime <= (endHour + tolerance);
        } else {
            // Ej: 06:00 - 18:00
            return currentTime >= (startHour - tolerance) && 
                   currentTime <= (endHour + tolerance);
        }
    }
    
    calculateOverageHours(entryTime, exitTime, endHour, toleranceMinutes) {
        // Build the allowed-end boundary (endHour + tolerance, DR local) on the
        // entry's calendar day as an absolute UTC instant. If that boundary is at or
        // before entry (night plans, or entry after endHour), roll it forward a day.
        // Overage = real elapsed time past the boundary, so overstays that cross
        // midnight or span multiple days are billed correctly (the old wall-clock
        // hour-of-day math returned 0 for any exit past midnight).
        const { y, m, d } = drDateParts(entryTime);
        let boundaryMs = Date.UTC(y, m - 1, d, endHour, 0, 0)
            + DR_OFFSET_MS
            + (toleranceMinutes || 0) * 60000;
        const entryMs = entryTime.getTime();
        while (boundaryMs <= entryMs) {
            boundaryMs += 24 * 60 * 60 * 1000;
        }
        const overageMs = exitTime.getTime() - boundaryMs;
        return overageMs > 0 ? overageMs / (60 * 60 * 1000) : 0;
    }
    
    /**
     * Obtener historial de acceso
     */
    async getAccessHistory(filters = {}) {
        let query_text = `
            SELECT 
                ae.*,
                c.first_name || ' ' || c.last_name as customer_name,
                p.name as plan_name
            FROM access_events ae
            LEFT JOIN subscriptions s ON ae.subscription_id = s.id
            LEFT JOIN customers c ON s.customer_id = c.id
            LEFT JOIN plans p ON s.plan_id = p.id
            WHERE 1=1
        `;
        
        const params = [];
        let paramCount = 1;
        
        if (filters.vehiclePlate) {
            query_text += ` AND ae.vehicle_plate = $${paramCount}`;
            params.push(filters.vehiclePlate);
            paramCount++;
        }
        
        if (filters.startDate) {
            query_text += ` AND ae.timestamp >= $${paramCount}`;
            params.push(filters.startDate);
            paramCount++;
        }
        
        if (filters.endDate) {
            query_text += ` AND ae.timestamp <= $${paramCount}`;
            params.push(filters.endDate);
            paramCount++;
        }
        
        query_text += ` ORDER BY ae.timestamp DESC LIMIT 100`;
        
        const result = await query(query_text, params);
        return result.rows;
    }
}

module.exports = new AccessControlService();
