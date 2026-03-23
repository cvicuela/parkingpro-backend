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

module.exports = router;
