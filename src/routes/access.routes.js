const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { supabase } = require('../config/database');
const accessControlService = require('../services/accessControl.service');
const hourlyRateService = require('../services/hourlyRate.service');
const qrcodeService = require('../services/qrcode.service');
const { query: dbQuery } = require('../config/database');

/**
 * Helper: emit occupancy and session updates via Socket.IO
 * Fire-and-forget, never blocks the response
 */
async function emitOccupancyAndSessionUpdates(io) {
    if (!io) return;
    try {
        const occResult = await dbQuery('SELECT * FROM current_occupancy_by_plan');
        io.to('dashboard').emit('occupancy_update', { plans: occResult.rows });
    } catch (e) { /* non-critical */ }
    try {
        const sessResult = await dbQuery('SELECT * FROM active_parking_sessions LIMIT 20');
        io.to('dashboard').emit('session_update', { sessions: sessResult.rows });
    } catch (e) { /* non-critical */ }
}

/**
 * @route   POST /api/v1/access/validate
 * @desc    Validar entrada o salida de vehículo
 * @access  Private (Operator, Admin)
 */
router.post('/validate', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const { vehiclePlate, type } = req.body; // type: 'entry' | 'exit'
        
        if (!vehiclePlate || !type) {
            return res.status(400).json({
                error: 'vehiclePlate y type son requeridos'
            });
        }
        
        let validationResult;
        
        if (type === 'entry') {
            validationResult = await accessControlService.validateEntry(vehiclePlate);
        } else if (type === 'exit') {
            validationResult = await accessControlService.validateExit(vehiclePlate);
        } else {
            return res.status(400).json({
                error: 'type debe ser "entry" o "exit"'
            });
        }
        
        res.json({
            success: true,
            data: validationResult
        });

        // Emit real-time updates after successful validation
        try {
            const io = req.app.get('io');
            if (io) {
                io.to('dashboard').emit(type === 'entry' ? 'vehicle_entry' : 'vehicle_exit', {
                    plate: vehiclePlate,
                    type: validationResult.accessType || 'hourly',
                    time: new Date().toISOString()
                });
                emitOccupancyAndSessionUpdates(io);
            }
        } catch (e) { /* non-critical */ }

    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/access/quick-entry
 * @desc    Validar + registrar entrada en un solo paso (usado por el frontend)
 * @access  Private (Operator, Admin)
 */
router.post('/quick-entry', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const { plateNumber } = req.body;
        if (!plateNumber) {
            return res.status(400).json({ error: 'plateNumber es requerido' });
        }

        // 1. Validate
        const validationResult = await accessControlService.validateEntry(plateNumber);
        if (!validationResult.allowed) {
            return res.status(403).json({
                success: false,
                error: validationResult.message || 'Acceso no permitido',
                reason: validationResult.reason
            });
        }

        // 2. Register entry
        const entry = await accessControlService.registerEntry(plateNumber, validationResult, req.user.id);

        // 3. Generate QR
        const ticketId = entry.event?.id || entry.session?.id || Date.now().toString();
        const qrCode = await qrcodeService.generateEntryQR({
            ticketId,
            plate: plateNumber,
            accessType: validationResult.accessType,
            entryTime: new Date().toISOString(),
            planName: entry.plan_name || validationResult.subscription?.plan_name || validationResult.plan?.name,
            customerName: entry.customer_name || validationResult.subscription?.customer_name || null
        });

        // Build unified response with plan info
        const sessionData = entry.session || {};
        const responseData = {
            id: sessionData.id || entry.event?.id,
            entry_time: sessionData.entry_time || entry.event?.timestamp || new Date().toISOString(),
            vehicle_plate: plateNumber,
            subscription_id: entry.subscription_id || (validationResult.accessType === 'subscription' ? validationResult.subscription?.id : null),
            plan_name: entry.plan_name || validationResult.subscription?.plan_name || validationResult.plan?.name || null,
            plan_type: entry.plan_type || validationResult.subscription?.plan_type || validationResult.plan?.type || null,
            base_price: entry.base_price || validationResult.plan?.base_price || null,
            customer_name: entry.customer_name || validationResult.subscription?.customer_name || null,
            verification_code: sessionData.verification_code || null,
        };

        res.json({ success: true, data: responseData, qrCode });

        // Emit real-time updates
        try {
            const io = req.app.get('io');
            if (io) {
                io.to('dashboard').emit('vehicle_entry', { plate: plateNumber, type: validationResult.accessType || 'hourly', time: new Date().toISOString() });
                io.to('access_control').emit('vehicle_entry', { plate: plateNumber, type: validationResult.accessType || 'hourly', time: new Date().toISOString() });
                emitOccupancyAndSessionUpdates(io);
            }
        } catch {}

    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/access/entry
 * @desc    Registrar entrada de vehículo
 * @access  Private (Operator, Admin)
 */
router.post('/entry', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const { vehiclePlate, validationResult } = req.body;
        
        if (!vehiclePlate || !validationResult) {
            return res.status(400).json({
                error: 'vehiclePlate y validationResult son requeridos'
            });
        }
        
        if (!validationResult.allowed) {
            return res.status(403).json({
                error: 'Acceso no permitido',
                reason: validationResult.reason
            });
        }
        
        const entry = await accessControlService.registerEntry(
            vehiclePlate,
            validationResult,
            req.user.id
        );

        // Generar QR code para el ticket de entrada
        const ticketId = entry.event?.id || entry.session?.id || Date.now().toString();
        const qrCode = await qrcodeService.generateEntryQR({
            ticketId,
            plate: vehiclePlate,
            accessType: validationResult.accessType,
            entryTime: new Date().toISOString(),
            planName: validationResult.subscription?.plan_name || validationResult.plan?.name,
            customerName: validationResult.subscription?.customer_name || null
        });

        res.json({
            success: true,
            message: 'Entrada registrada exitosamente',
            data: entry,
            qrCode
        });

        // Emit real-time updates after successful entry
        try {
            const io = req.app.get('io');
            if (io) {
                io.to('dashboard').emit('vehicle_entry', {
                    plate: vehiclePlate,
                    type: validationResult.accessType || 'hourly',
                    time: new Date().toISOString()
                });
                io.to('access_control').emit('vehicle_entry', {
                    plate: vehiclePlate,
                    type: validationResult.accessType || 'hourly',
                    time: new Date().toISOString()
                });
                emitOccupancyAndSessionUpdates(io);
            }
        } catch (e) { /* non-critical */ }

    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/access/exit
 * @desc    Registrar salida de vehículo
 * @access  Private (Operator, Admin)
 */
router.post('/exit', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const { vehiclePlate, validationResult } = req.body;
        
        if (!vehiclePlate || !validationResult) {
            return res.status(400).json({
                error: 'vehiclePlate y validationResult son requeridos'
            });
        }
        
        if (!validationResult.allowed) {
            return res.status(403).json({
                error: 'Salida no permitida',
                reason: validationResult.reason
            });
        }
        
        const exit = await accessControlService.registerExit(
            vehiclePlate,
            validationResult,
            req.user.id
        );
        
        res.json({
            success: true,
            message: 'Salida registrada exitosamente',
            data: exit
        });

        // Emit real-time updates after successful exit
        try {
            const io = req.app.get('io');
            if (io) {
                io.to('dashboard').emit('vehicle_exit', {
                    plate: vehiclePlate,
                    type: validationResult.accessType || 'hourly',
                    time: new Date().toISOString()
                });
                io.to('access_control').emit('vehicle_exit', {
                    plate: vehiclePlate,
                    type: validationResult.accessType || 'hourly',
                    time: new Date().toISOString()
                });
                emitOccupancyAndSessionUpdates(io);
            }
        } catch (e) { /* non-critical */ }

    } catch (error) {
        next(error);
    }
});

/**
 * @route   GET /api/v1/access/history
 * @desc    Obtener historial de accesos
 * @access  Private (Admin)
 */
router.get('/history', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const { vehiclePlate, startDate, endDate } = req.query;
        
        const history = await accessControlService.getAccessHistory({
            vehiclePlate,
            startDate,
            endDate
        });
        
        res.json({
            success: true,
            data: history,
            count: history.length
        });
        
    } catch (error) {
        next(error);
    }
});

/**
 * @route   GET /api/v1/access/sessions/active
 * @desc    Obtener sesiones activas de parqueo por hora
 * @access  Private (Operator, Admin)
 */
router.get('/sessions/active', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const sessions = await hourlyRateService.getActiveSessions();
        
        res.json({
            success: true,
            data: sessions,
            count: sessions.length
        });
        
    } catch (error) {
        next(error);
    }
});

/**
 * @route   GET /api/v1/access/sessions/:plate
 * @desc    Buscar sesión activa por placa
 * @access  Private (Operator, Admin)
 */
router.get('/sessions/:plate', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const { plate } = req.params;
        
        const session = await hourlyRateService.findActiveSessionByPlate(plate);
        
        if (!session) {
            return res.status(404).json({
                error: 'No se encontró sesión activa para esta placa'
            });
        }
        
        res.json({
            success: true,
            data: session
        });
        
    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/access/sessions/:id/end
 * @desc    Finalizar sesión de parqueo por hora
 * @access  Private (Operator, Admin)
 */
router.post('/sessions/:id/end', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const { id } = req.params;
        
        const result = await hourlyRateService.endParkingSession(id);
        
        res.json({
            success: true,
            message: 'Sesión finalizada',
            data: result
        });
        
    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/access/sessions/:id/payment
 * @desc    Registrar pago de sesión
 * @access  Private (Operator, Admin)
 */
router.post('/sessions/:id/payment', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const { id } = req.params;
        const { paymentId, amount, paymentMethod } = req.body;

        const session = await hourlyRateService.recordSessionPayment(id, paymentId, amount);

        // Registrar cobro en la caja abierta del operador (si existe)
        try {
            const cashRegisterService = require('../services/cashRegister.service');
            const activeRegister = await cashRegisterService.getActiveRegister(req.user.id);
            if (activeRegister) {
                // Determinar método de pago: del body, o buscar en la tabla payments
                let method = paymentMethod || 'cash';
                if (!paymentMethod && paymentId) {
                    try {
                        const { query: dbQuery } = require('../config/database');
                        const paymentRes = await dbQuery('SELECT payment_method FROM payments WHERE id = $1', [paymentId]);
                        if (paymentRes.rows.length > 0) {
                            method = paymentRes.rows[0].payment_method || 'cash';
                        }
                    } catch {}
                }
                await cashRegisterService.recordPayment({
                    registerId: activeRegister.id,
                    paymentId: paymentId || null,
                    amount: parseFloat(amount),
                    sessionId: id,
                    operatorId: req.user.id,
                    description: `Cobro sesión estacionamiento`,
                    paymentMethod: method,
                    req
                });
            }
        } catch (cashErr) {
            console.error('[Access] Error registrando en caja:', cashErr.message);
        }
        
        res.json({
            success: true,
            message: 'Pago registrado',
            data: session
        });

        // Emit real-time updates after session payment
        try {
            const io = req.app.get('io');
            if (io) {
                io.to('dashboard').emit('payment_received', {
                    amount: parseFloat(amount),
                    provider: paymentMethod || 'cash',
                    time: new Date().toISOString()
                });
                emitOccupancyAndSessionUpdates(io);
            }
        } catch (e) { /* non-critical */ }

    } catch (error) {
        next(error);
    }
});

/**
 * @route   GET /api/v1/access/sessions/suspicious/list
 * @desc    Listar sesiones sospechosas (duración excesiva o sin pago)
 * @access  Private (Admin)
 */
router.get('/sessions/suspicious/list', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const { thresholdHours } = req.query;
        const threshold = parseInt(thresholdHours) || 24;

        const token = process.env.SUPABASE_SERVICE_KEY;
        const { data, error } = await supabase.rpc('list_suspicious_sessions', {
            p_token: token,
            p_threshold_hours: threshold
        });

        if (error) {
            throw new Error(`Error al listar sesiones sospechosas: ${error.message}`);
        }

        res.json({
            success: true,
            data: data || [],
            count: (data || []).length
        });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/access/sessions/auto-close-stale
 * @desc    Cerrar automáticamente sesiones inactivas por más de X horas
 * @access  Private (Admin)
 */
router.post('/sessions/auto-close-stale', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const { thresholdHours } = req.body;
        const threshold = parseInt(thresholdHours) || 48;

        const token = process.env.SUPABASE_SERVICE_KEY;
        const { data, error } = await supabase.rpc('auto_close_stale_sessions', {
            p_token: token,
            p_threshold_hours: threshold
        });

        if (error) {
            throw new Error(`Error al cerrar sesiones inactivas: ${error.message}`);
        }

        const closedSessions = data || [];

        // Emit socket event for dashboard
        const io = req.app.get('io');
        if (io && closedSessions.length > 0) {
            io.to('dashboard').emit('stale_sessions_closed', {
                count: closedSessions.length,
                time: new Date().toISOString()
            });
        }

        res.json({
            success: true,
            message: `${closedSessions.length} sesiones cerradas automáticamente`,
            data: closedSessions,
            count: closedSessions.length
        });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/access/cleanup-stale
 * @desc    Trigger auto_close_stale_sessions() manually (closes sessions active > 48 hours)
 * @access  Private (Admin only)
 */
router.post('/cleanup-stale', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const { data, error } = await supabase.rpc('auto_close_stale_sessions');

        if (error) {
            throw new Error(`Error al cerrar sesiones estancadas: ${error.message}`);
        }

        const sessionsClosed = data?.sessions_closed ?? 0;

        // Emit socket event so dashboard reflects the change
        try {
            const io = req.app.get('io');
            if (io && sessionsClosed > 0) {
                io.to('dashboard').emit('stale_sessions_closed', {
                    count: sessionsClosed,
                    time: new Date().toISOString()
                });
                emitOccupancyAndSessionUpdates(io);
            }
        } catch (e) { /* non-critical */ }

        res.json({
            success: true,
            message: `${sessionsClosed} sesión(es) estancada(s) cerrada(s) automáticamente`,
            data: data,
            sessions_closed: sessionsClosed
        });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/access/lost-ticket-charge
 * @desc    Procesar cobro por ticket perdido — busca sesión por placa y aplica penalidad
 * @access  Private (Operator, Admin)
 */
router.post('/lost-ticket-charge', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const { plateNumber, ticketNumber, paymentMethod } = req.body;
        if (!plateNumber && !ticketNumber) {
            return res.status(400).json({ error: 'plateNumber o ticketNumber es requerido' });
        }

        // 1. Find active session by plate or verification_code (ticket #)
        let sessionResult;
        if (ticketNumber) {
            sessionResult = await dbQuery(
                `SELECT ps.*, p.name as plan_name, p.type as plan_type, p.lost_ticket_fee, p.base_price
                 FROM parking_sessions ps
                 JOIN plans p ON ps.plan_id = p.id
                 WHERE ps.verification_code = $1 AND ps.status = 'active'
                 ORDER BY ps.entry_time DESC LIMIT 1`,
                [ticketNumber.toUpperCase()]
            );
        } else {
            sessionResult = await dbQuery(
                `SELECT ps.*, p.name as plan_name, p.type as plan_type, p.lost_ticket_fee, p.base_price
                 FROM parking_sessions ps
                 JOIN plans p ON ps.plan_id = p.id
                 WHERE ps.vehicle_plate = $1 AND ps.status = 'active'
                 ORDER BY ps.entry_time DESC LIMIT 1`,
                [plateNumber.toUpperCase()]
            );
        }

        // 2. If no session, check settings for default fee
        let lostTicketFee, planName, sessionId, entryTime;

        if (sessionResult.rows.length > 0) {
            const session = sessionResult.rows[0];
            lostTicketFee = parseFloat(session.lost_ticket_fee) || 500;
            planName = session.plan_name;
            sessionId = session.id;
            entryTime = session.entry_time;
        } else {
            // No active session — use global setting
            const settingResult = await dbQuery(
                `SELECT value FROM settings WHERE key = 'charges.lost_ticket'`
            );
            lostTicketFee = settingResult.rows.length > 0
                ? parseFloat(JSON.parse(settingResult.rows[0].value))
                : 500;
            planName = null;
            sessionId = null;
            entryTime = null;
        }

        // 3. Calculate total with tax
        const subtotal = lostTicketFee;
        const tax = Math.round(subtotal * 0.18 * 100) / 100;
        const total = subtotal + tax;

        res.json({
            success: true,
            data: {
                type: 'lost_ticket',
                plateNumber: (plateNumber || '').toUpperCase(),
                sessionId,
                entryTime,
                planName,
                subtotal,
                tax,
                total,
                lost_ticket_fee: lostTicketFee,
                charge_reason: 'Cargo por ticket perdido',
                payment_status: 'pending',
                barrier_allowed: false,
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/access/nfc-replacement-charge
 * @desc    Calcular cobro por reposición de tarjeta NFC/RFID perdida
 * @access  Private (Operator, Admin)
 */
router.post('/nfc-replacement-charge', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const { cardId, customerId, plateNumber } = req.body;

        // 1. Get replacement fee from plan or settings
        let nfcFee;

        if (customerId) {
            // Try to get fee from customer's active plan
            const planResult = await dbQuery(
                `SELECT p.nfc_replacement_fee, p.name as plan_name
                 FROM subscriptions s
                 JOIN plans p ON s.plan_id = p.id
                 WHERE s.customer_id = $1 AND s.status = 'active'
                 LIMIT 1`,
                [customerId]
            );
            if (planResult.rows.length > 0) {
                nfcFee = parseFloat(planResult.rows[0].nfc_replacement_fee) || 150;
            }
        }

        if (!nfcFee) {
            // Use global setting
            const settingResult = await dbQuery(
                `SELECT value FROM settings WHERE key = 'charges.nfc_replacement'`
            );
            nfcFee = settingResult.rows.length > 0
                ? parseFloat(JSON.parse(settingResult.rows[0].value))
                : 150;
        }

        // 2. Mark card as lost if cardId provided
        if (cardId) {
            await dbQuery(
                `UPDATE rfid_cards SET status = 'lost', metadata = jsonb_set(COALESCE(metadata, '{}'), '{lost_at}', to_jsonb(NOW()::text))
                 WHERE id = $1`,
                [cardId]
            );
        }

        // 3. Calculate total with tax
        const subtotal = nfcFee;
        const tax = Math.round(subtotal * 0.18 * 100) / 100;
        const total = subtotal + tax;

        res.json({
            success: true,
            data: {
                type: 'nfc_replacement',
                cardId,
                customerId,
                plateNumber: plateNumber || null,
                subtotal,
                tax,
                total,
                nfc_replacement_fee: nfcFee,
                charge_reason: 'Cargo por reposición de tarjeta NFC/RFID',
                payment_status: 'pending',
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/access/lost-ticket-replacement
 * @desc    Generate a replacement ticket after lost ticket payment.
 *          The replacement ticket has the SAME session data but a new verification code.
 *          User must use this replacement ticket (QR) to exit.
 * @access  Private (Operator, Admin)
 */
router.post('/lost-ticket-replacement', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const { sessionId, plateNumber } = req.body;
        if (!sessionId && !plateNumber) {
            return res.status(400).json({ error: 'sessionId o plateNumber es requerido' });
        }

        // Find session
        let session;
        if (sessionId) {
            const result = await dbQuery(
                `SELECT ps.*, p.name as plan_name FROM parking_sessions ps
                 JOIN plans p ON ps.plan_id = p.id
                 WHERE ps.id = $1`,
                [sessionId]
            );
            session = result.rows[0];
        } else {
            const result = await dbQuery(
                `SELECT ps.*, p.name as plan_name FROM parking_sessions ps
                 JOIN plans p ON ps.plan_id = p.id
                 WHERE ps.vehicle_plate = $1 AND ps.status IN ('active', 'paid')
                 ORDER BY ps.entry_time DESC LIMIT 1`,
                [plateNumber.toUpperCase()]
            );
            session = result.rows[0];
        }

        if (!session) {
            return res.status(404).json({ error: 'Sesión no encontrada' });
        }

        // Generate new verification code for replacement
        const newCode = Math.random().toString(36).substring(2, 10).toUpperCase();

        // Update session with new verification code and mark as replacement
        await dbQuery(
            `UPDATE parking_sessions
             SET verification_code = $1,
                 metadata = jsonb_set(
                     COALESCE(metadata, '{}'),
                     '{replacement_ticket}',
                     to_jsonb(jsonb_build_object(
                         'issued_at', NOW()::text,
                         'issued_by', $2::text,
                         'original_code', verification_code,
                         'reason', 'lost_ticket'
                     ))
                 ),
                 updated_at = NOW()
             WHERE id = $3`,
            [newCode, req.user.id, session.id]
        );

        // Generate QR for replacement ticket
        const qrCode = await qrcodeService.generateEntryQR({
            ticketId: session.id,
            plate: session.vehicle_plate,
            accessType: 'hourly',
            entryTime: session.entry_time,
            planName: session.plan_name,
            customerName: null
        });

        res.json({
            success: true,
            data: {
                sessionId: session.id,
                vehiclePlate: session.vehicle_plate,
                entryTime: session.entry_time,
                verificationCode: newCode,
                planName: session.plan_name,
                isReplacement: true,
            },
            qrCode
        });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/access/nfc-lost-replacement
 * @desc    After paying NFC replacement fee, generate a temporary QR ticket for exit.
 *          The RFID session gets a verification_code so user can exit with printed ticket.
 * @access  Private (Operator, Admin)
 */
router.post('/nfc-lost-replacement', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const { plateNumber, cardId } = req.body;
        if (!plateNumber) {
            return res.status(400).json({ error: 'plateNumber es requerido' });
        }

        // Find active session for this plate
        const sessionResult = await dbQuery(
            `SELECT ps.*, p.name as plan_name FROM parking_sessions ps
             JOIN plans p ON ps.plan_id = p.id
             WHERE ps.vehicle_plate = $1 AND ps.status IN ('active', 'paid')
             ORDER BY ps.entry_time DESC LIMIT 1`,
            [plateNumber.toUpperCase()]
        );

        // Also check subscription access_events (for subscription entries with RFID)
        const accessResult = await dbQuery(
            `SELECT ae.*, p.name as plan_name, s.id as subscription_id
             FROM access_events ae
             JOIN subscriptions s ON ae.subscription_id = s.id
             JOIN plans p ON s.plan_id = p.id
             WHERE ae.vehicle_plate = $1
               AND ae.type = 'entry'
               AND ae.access_method = 'rfid'
               AND NOT EXISTS (
                   SELECT 1 FROM access_events ae2
                   WHERE ae2.vehicle_plate = $1 AND ae2.type = 'exit' AND ae2.timestamp > ae.timestamp
               )
             ORDER BY ae.timestamp DESC LIMIT 1`,
            [plateNumber.toUpperCase()]
        );

        const session = sessionResult.rows[0];
        const accessEvent = accessResult.rows[0];

        if (!session && !accessEvent) {
            return res.status(404).json({ error: 'No se encontró sesión activa para esta placa' });
        }

        const newCode = Math.random().toString(36).substring(2, 10).toUpperCase();
        const entryTime = session?.entry_time || accessEvent?.timestamp;
        const planName = session?.plan_name || accessEvent?.plan_name;

        // If it's a parking_session, update verification code
        if (session) {
            await dbQuery(
                `UPDATE parking_sessions
                 SET verification_code = $1,
                     access_method = 'qr',
                     metadata = jsonb_set(
                         COALESCE(metadata, '{}'),
                         '{nfc_replacement}',
                         to_jsonb(jsonb_build_object(
                             'issued_at', NOW()::text,
                             'original_card_id', $2::text,
                             'reason', 'lost_nfc_card'
                         ))
                     ),
                     updated_at = NOW()
                 WHERE id = $3`,
                [newCode, cardId || null, session.id]
            );
        }

        // Generate QR for the replacement ticket
        const qrCode = await qrcodeService.generateEntryQR({
            ticketId: session?.id || accessEvent?.id,
            plate: plateNumber.toUpperCase(),
            accessType: session ? 'hourly' : 'subscription',
            entryTime: entryTime,
            planName: planName,
            customerName: null
        });

        res.json({
            success: true,
            data: {
                sessionId: session?.id || null,
                accessEventId: accessEvent?.id || null,
                vehiclePlate: plateNumber.toUpperCase(),
                entryTime,
                verificationCode: newCode,
                planName,
                isReplacement: true,
                replacementReason: 'lost_nfc_card',
            },
            qrCode
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
