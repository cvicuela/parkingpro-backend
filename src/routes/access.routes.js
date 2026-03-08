const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { supabase } = require('../config/database');
const accessControlService = require('../services/accessControl.service');
const hourlyRateService = require('../services/hourlyRate.service');
const qrcodeService = require('../services/qrcode.service');

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
        const { paymentId, amount } = req.body;
        
        const session = await hourlyRateService.recordSessionPayment(id, paymentId, amount);
// After line: const session = await hourlyRateService.recordSessionPayment(id, paymentId, amount);
// Add cash register integration

        // Registrar cobro en la caja abierta del operador (si existe)
        try {
            const cashRegisterService = require('../services/cashRegister.service');
            const activeRegister = await cashRegisterService.getActiveRegister(req.user.id);
            if (activeRegister) {
                await cashRegisterService.recordPayment({
                    registerId: activeRegister.id,
                    paymentId: paymentId || null,
                    amount: parseFloat(amount),
                    sessionId: id,
                    operatorId: req.user.id,
                    description: `Cobro sesión estacionamiento`,
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

module.exports = router;
