const express = require('express');
const router = express.Router();
const arduinoService = require('../services/arduino.service');
const accessControlService = require('../services/accessControl.service');
const qrcodeService = require('../services/qrcode.service');
const hourlyRateService = require('../services/hourlyRate.service');

/**
 * Middleware de autenticacion para Arduino
 * Usa un API key simple en el header X-Arduino-Key
 */
const authenticateArduino = (req, res, next) => {
    const apiKey = req.headers['x-arduino-key'];
    const expectedKey = process.env.ARDUINO_API_KEY || 'parkingpro-arduino-2024';

    if (!apiKey || apiKey !== expectedKey) {
        return res.status(401).json({
            error: 'API key de Arduino invalida'
        });
    }
    next();
};

/**
 * @route   POST /api/v1/arduino/register
 * @desc    Registrar dispositivo Arduino
 */
router.post('/register', authenticateArduino, (req, res) => {
    const { deviceId, type, location, firmware, capabilities } = req.body;

    if (!deviceId) {
        return res.status(400).json({ error: 'deviceId es requerido' });
    }

    const device = arduinoService.registerDevice(deviceId, {
        type, location, firmware, capabilities
    });

    res.json({ success: true, data: device });
});

/**
 * @route   POST /api/v1/arduino/heartbeat
 * @desc    Heartbeat del dispositivo Arduino
 */
router.post('/heartbeat', authenticateArduino, (req, res) => {
    const { deviceId } = req.body;
    const device = arduinoService.heartbeat(deviceId);

    if (!device) {
        return res.status(404).json({ error: 'Dispositivo no registrado' });
    }

    res.json({ success: true, status: 'ok' });
});

/**
 * @route   POST /api/v1/arduino/vehicle-detected
 * @desc    Arduino reporta que detecto un vehiculo (sensor ultrasonico)
 *          El backend valida y responde con comandos para la barrera
 */
router.post('/vehicle-detected', authenticateArduino, async (req, res, next) => {
    try {
        const { deviceId, vehiclePlate, type } = req.body;
        // type: 'entry' | 'exit'

        if (!vehiclePlate || !type) {
            return res.json({
                success: false,
                command: arduinoService.generateBarrierCommand(null)
            });
        }

        let validationResult;
        if (type === 'entry') {
            validationResult = await accessControlService.validateEntry(vehiclePlate);
        } else {
            validationResult = await accessControlService.validateExit(vehiclePlate);
        }

        const command = type === 'entry'
            ? arduinoService.generateBarrierCommand(validationResult)
            : arduinoService.generateExitCommand(validationResult);

        // Si la entrada es permitida, registrarla automaticamente
        if (type === 'entry' && validationResult.allowed) {
            const entry = await accessControlService.registerEntry(vehiclePlate, validationResult);

            const ticketId = entry.event?.id || entry.session?.id || Date.now().toString();
            const qrCode = await qrcodeService.generateEntryQR({
                ticketId,
                plate: vehiclePlate,
                accessType: validationResult.accessType,
                entryTime: new Date().toISOString(),
                planName: validationResult.subscription?.plan_name || validationResult.plan?.name,
                customerName: validationResult.subscription?.customer_name || null
            });

            // Emitir evento Socket.IO para actualizar dashboard
            const io = req.app.get('io');
            if (io) {
                io.to('dashboard').emit('vehicle_entry', {
                    plate: vehiclePlate,
                    type: validationResult.accessType,
                    time: new Date().toISOString()
                });
            }

            return res.json({
                success: true,
                command,
                entry: entry,
                qrCode,
                validationResult
            });
        }

        // Si la salida es permitida y es gratis, registrarla automaticamente
        if (type === 'exit' && validationResult.allowed && validationResult.payment?.is_free) {
            await accessControlService.registerExit(vehiclePlate, validationResult);

            const io = req.app.get('io');
            if (io) {
                io.to('dashboard').emit('vehicle_exit', {
                    plate: vehiclePlate,
                    time: new Date().toISOString()
                });
            }
        }

        res.json({
            success: true,
            command,
            validationResult
        });

    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/arduino/action-completed
 * @desc    Arduino confirma que ejecuto una accion (barrera abierta/cerrada)
 */
router.post('/action-completed', authenticateArduino, (req, res) => {
    const { deviceId, action, vehiclePlate, timestamp } = req.body;

    // Log la accion completada
    console.log(`[Arduino ${deviceId}] Action completed: ${action} for ${vehiclePlate} at ${timestamp}`);

    // Emitir via Socket.IO
    const io = req.app.get('io');
    if (io) {
        io.to('dashboard').emit('arduino_action', {
            deviceId, action, vehiclePlate, timestamp
        });
    }

    res.json({ success: true });
});

/**
 * @route   GET /api/v1/arduino/devices
 * @desc    Listar dispositivos Arduino registrados
 */
router.get('/devices', authenticateArduino, (req, res) => {
    res.json({
        success: true,
        data: arduinoService.getDevices()
    });
});

/**
 * @route   GET /api/v1/arduino/status
 * @desc    Estado del sistema Arduino (health check para dispositivos)
 */
router.get('/status', (req, res) => {
    res.json({
        success: true,
        server: 'online',
        timestamp: new Date().toISOString(),
        devices: arduinoService.getDevices().length
    });
});

/**
 * @route   POST /api/v1/arduino/rfid-scan
 * @desc    Arduino reports RFID card scan at entry/exit barrier
 *          The backend resolves the card, validates access, and responds with barrier commands
 */
router.post('/rfid-scan', authenticateArduino, async (req, res, next) => {
    try {
        const { deviceId, cardUid, location } = req.body;
        // location: 'entry' | 'exit'

        if (!cardUid || !location) {
            return res.json({
                success: false,
                command: arduinoService.generateBarrierCommand(null)
            });
        }

        // Use the unified access resolution with RFID priority
        const validationResult = await accessControlService.resolveAccessMethod({
            rfidUid: cardUid,
            type: location
        });

        const command = location === 'entry'
            ? arduinoService.generateBarrierCommand(validationResult)
            : arduinoService.generateExitCommand(validationResult);

        // If entry is allowed, register it automatically
        if (location === 'entry' && validationResult.allowed) {
            const entry = await accessControlService.registerEntry(
                validationResult.subscription?.vehicle_plate || validationResult.rfidCard?.metadata?.vehicle_plate || 'RFID-TEMP',
                validationResult
            );

            // For RFID subscriptions, generate internal QR but don't print
            let qrCode = null;
            if (!validationResult.rfidCard || validationResult.accessType === 'hourly') {
                const ticketId = entry.event?.id || entry.session?.id || Date.now().toString();
                qrCode = await qrcodeService.generateEntryQR({
                    ticketId,
                    plate: validationResult.subscription?.vehicle_plate || 'RFID',
                    accessType: validationResult.accessType,
                    entryTime: new Date().toISOString(),
                    planName: validationResult.subscription?.plan_name || validationResult.plan?.name,
                    customerName: validationResult.subscription?.customer_name || null
                });
            }

            // Emit socket event
            const io = req.app.get('io');
            if (io) {
                io.to('dashboard').emit('vehicle_entry', {
                    plate: validationResult.subscription?.vehicle_plate || 'RFID',
                    type: validationResult.accessType,
                    method: 'rfid',
                    time: new Date().toISOString()
                });
            }

            return res.json({
                success: true,
                command,
                entry,
                qrCode,
                validationResult,
                internalOnlyQr: validationResult.accessType === 'subscription'
            });
        }

        // If exit is allowed and free, register automatically
        if (location === 'exit' && validationResult.allowed && validationResult.payment?.is_free) {
            await accessControlService.registerExit(
                validationResult.session?.vehicle_plate || 'RFID',
                validationResult
            );

            const io = req.app.get('io');
            if (io) {
                io.to('dashboard').emit('vehicle_exit', {
                    plate: validationResult.session?.vehicle_plate || 'RFID',
                    method: 'rfid',
                    time: new Date().toISOString()
                });
            }
        }

        res.json({
            success: true,
            command,
            validationResult
        });

    } catch (error) {
        next(error);
    }
});

module.exports = router;
