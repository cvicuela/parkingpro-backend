const express = require('express');
const router = express.Router();
const zktecoService = require('../services/zkteco.service');
const accessControlService = require('../services/accessControl.service');
const qrcodeService = require('../services/qrcode.service');
const { authenticate } = require('../middleware/auth');

/**
 * Middleware de autenticacion para dispositivos ZKTeco
 * Acepta API key en header X-ZKTeco-Key o X-Device-Key
 */
const authenticateDevice = (req, res, next) => {
    const apiKey = req.headers['x-zkteco-key'] || req.headers['x-device-key'];
    const expectedKey = process.env.ZKTECO_API_KEY || 'parkingpro-zkteco-2024';

    if (!apiKey || apiKey !== expectedKey) {
        return res.status(401).json({ error: 'API key de dispositivo invalida' });
    }
    next();
};

// ─── Device Management (requiere auth de usuario admin) ───

/**
 * @route   GET /api/v1/zkteco/devices
 * @desc    Listar todos los dispositivos registrados
 */
router.get('/devices', authenticate, (req, res) => {
    const { type, location, status, direction } = req.query;
    const devices = zktecoService.getDevices({ type, location, status, direction });
    res.json({ success: true, data: devices });
});

/**
 * @route   GET /api/v1/zkteco/devices/:serial
 * @desc    Obtener un dispositivo por numero de serie
 */
router.get('/devices/:serial', authenticate, (req, res) => {
    const device = zktecoService.getDevice(req.params.serial);
    if (!device) return res.status(404).json({ error: 'Dispositivo no encontrado' });
    res.json({ success: true, data: device });
});

/**
 * @route   POST /api/v1/zkteco/devices
 * @desc    Registrar un nuevo dispositivo ZKTeco
 */
router.post('/devices', authenticate, (req, res) => {
    const { serial_number, name, type, model, ip_address, port, location, direction, protocol, connected_devices, firmware_version, ...config } = req.body;

    if (!serial_number) {
        return res.status(400).json({ error: 'serial_number es requerido' });
    }

    const existing = zktecoService.getDevice(serial_number);
    if (existing) {
        return res.status(409).json({ error: 'Dispositivo ya registrado con ese numero de serie' });
    }

    const device = zktecoService.registerDevice(serial_number, {
        name, type, model, ip_address, port, location, direction, protocol,
        connected_devices, firmware_version, extra: config
    });

    const io = req.app.get('io');
    if (io) io.to('dashboard').emit('device_registered', { serial_number, type, model });

    res.status(201).json({ success: true, data: device });
});

/**
 * @route   PUT /api/v1/zkteco/devices/:serial
 * @desc    Actualizar configuracion de un dispositivo
 */
router.put('/devices/:serial', authenticate, (req, res) => {
    const device = zktecoService.updateDevice(req.params.serial, req.body);
    if (!device) return res.status(404).json({ error: 'Dispositivo no encontrado' });
    res.json({ success: true, data: device });
});

/**
 * @route   DELETE /api/v1/zkteco/devices/:serial
 * @desc    Eliminar un dispositivo
 */
router.delete('/devices/:serial', authenticate, (req, res) => {
    const removed = zktecoService.removeDevice(req.params.serial);
    if (!removed) return res.status(404).json({ error: 'Dispositivo no encontrado' });
    res.json({ success: true, message: 'Dispositivo eliminado' });
});

// ─── Device Actions (control remoto desde dashboard) ─────

/**
 * @route   POST /api/v1/zkteco/devices/:serial/open
 * @desc    Abrir barrera de forma remota desde el dashboard
 */
router.post('/devices/:serial/open', authenticate, async (req, res, next) => {
    try {
        const device = zktecoService.getDevice(req.params.serial);
        if (!device) return res.status(404).json({ error: 'Dispositivo no encontrado' });
        if (device.type !== 'barrier' && device.type !== 'controller') {
            return res.status(400).json({ error: 'Este dispositivo no controla una barrera' });
        }

        const command = zktecoService.generateOpenCommand(req.params.serial);

        // Intentar enviar via TCP si tiene IP
        let tcpResult = null;
        if (device.ip_address) {
            try {
                tcpResult = await zktecoService.sendTCPCommand(req.params.serial, command);
            } catch (err) {
                // TCP fallo, el comando se retorna para PUSH polling
                console.log(`[ZKTeco] TCP command failed for ${req.params.serial}: ${err.message}`);
            }
        }

        const io = req.app.get('io');
        if (io) io.to('dashboard').emit('barrier_opened', { serial: req.params.serial, location: device.location });

        res.json({
            success: true,
            command,
            tcp_sent: !!tcpResult,
            message: tcpResult ? 'Barrera abierta via TCP' : 'Comando encolado (PUSH)'
        });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/zkteco/devices/:serial/close
 * @desc    Cerrar barrera de forma remota
 */
router.post('/devices/:serial/close', authenticate, async (req, res, next) => {
    try {
        const device = zktecoService.getDevice(req.params.serial);
        if (!device) return res.status(404).json({ error: 'Dispositivo no encontrado' });

        const command = zktecoService.generateCloseCommand(req.params.serial);

        let tcpResult = null;
        if (device.ip_address) {
            try {
                tcpResult = await zktecoService.sendTCPCommand(req.params.serial, command);
            } catch (err) {
                console.log(`[ZKTeco] TCP close failed for ${req.params.serial}: ${err.message}`);
            }
        }

        res.json({ success: true, command, tcp_sent: !!tcpResult });
    } catch (error) {
        next(error);
    }
});

// ─── Device PUSH Endpoints (llamados por los dispositivos) ──

/**
 * @route   POST /api/v1/zkteco/push/heartbeat
 * @desc    Heartbeat del dispositivo ZKTeco
 */
router.post('/push/heartbeat', authenticateDevice, (req, res) => {
    const { serial_number, firmware_version } = req.body;
    const device = zktecoService.heartbeat(serial_number, { firmware_version });

    if (!device) {
        return res.status(404).json({ error: 'Dispositivo no registrado' });
    }

    res.json({ success: true, status: 'ok', server_time: new Date().toISOString() });
});

/**
 * @route   POST /api/v1/zkteco/push/register
 * @desc    Auto-registro de dispositivo ZKTeco via PUSH
 */
router.post('/push/register', authenticateDevice, (req, res) => {
    const { serial_number, type, model, firmware_version, ip_address, port } = req.body;

    if (!serial_number) {
        return res.status(400).json({ error: 'serial_number es requerido' });
    }

    const existing = zktecoService.getDevice(serial_number);
    if (existing) {
        // Re-register = update last_seen
        zktecoService.heartbeat(serial_number, { firmware_version });
        return res.json({ success: true, data: existing, message: 'Dispositivo ya registrado' });
    }

    const device = zktecoService.registerDevice(serial_number, {
        type, model, firmware_version, ip_address, port
    });

    res.json({ success: true, data: device });
});

/**
 * @route   POST /api/v1/zkteco/push/lpr-event
 * @desc    Camara LPR ZKTeco reporta placa detectada
 */
router.post('/push/lpr-event', authenticateDevice, async (req, res, next) => {
    try {
        const { serial_number, plate, confidence, image_url, direction } = req.body;

        if (!plate) {
            return res.status(400).json({ error: 'plate es requerido' });
        }

        const lprResult = zktecoService.processLPREvent(serial_number, {
            plate, confidence, image_url
        });

        // Determinar tipo basado en la direccion del dispositivo
        const type = direction || lprResult.direction || 'entry';

        // Validar acceso
        let validationResult;
        if (type === 'entry') {
            validationResult = await accessControlService.validateEntry(lprResult.plate);
        } else {
            validationResult = await accessControlService.validateExit(lprResult.plate);
        }

        const device = zktecoService.getDevice(serial_number);
        const response = type === 'entry'
            ? zktecoService.generateAccessResponse(validationResult, device)
            : zktecoService.generateExitResponse(validationResult, device);

        // Registrar entrada automatica si permitida
        if (type === 'entry' && validationResult.allowed) {
            const entry = await accessControlService.registerEntry(lprResult.plate, validationResult);

            const ticketId = entry.event?.id || entry.session?.id || Date.now().toString();
            const qrCode = await qrcodeService.generateEntryQR({
                ticketId,
                plate: lprResult.plate,
                accessType: validationResult.accessType,
                entryTime: new Date().toISOString(),
                planName: validationResult.subscription?.plan_name || validationResult.plan?.name,
                customerName: validationResult.subscription?.customer_name || null
            });

            const io = req.app.get('io');
            if (io) {
                io.to('dashboard').emit('vehicle_entry', {
                    plate: lprResult.plate,
                    type: validationResult.accessType,
                    method: 'lpr',
                    device: serial_number,
                    time: new Date().toISOString()
                });
            }

            return res.json({
                success: true,
                response,
                entry,
                qrCode,
                validationResult
            });
        }

        // Registrar salida si permitida y gratuita
        if (type === 'exit' && validationResult.allowed && validationResult.payment?.is_free) {
            await accessControlService.registerExit(lprResult.plate, validationResult);

            const io = req.app.get('io');
            if (io) {
                io.to('dashboard').emit('vehicle_exit', {
                    plate: lprResult.plate,
                    method: 'lpr',
                    device: serial_number,
                    time: new Date().toISOString()
                });
            }
        }

        res.json({ success: true, response, validationResult });

    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/zkteco/push/access-event
 * @desc    Controlador ZKTeco reporta evento de acceso (tarjeta, pin, biometrico)
 */
router.post('/push/access-event', authenticateDevice, async (req, res, next) => {
    try {
        const { serial_number, card_uid, pin, vehicle_plate, direction } = req.body;

        const type = direction || 'entry';

        // Si tiene card_uid, resolver via RFID
        if (card_uid) {
            const validationResult = await accessControlService.resolveAccessMethod({
                rfidUid: card_uid,
                vehiclePlate: vehicle_plate,
                type
            });

            const device = zktecoService.getDevice(serial_number);
            const response = type === 'entry'
                ? zktecoService.generateAccessResponse(validationResult, device)
                : zktecoService.generateExitResponse(validationResult, device);

            if (type === 'entry' && validationResult.allowed) {
                const plate = validationResult.subscription?.vehicle_plate || vehicle_plate || 'ZKTECO';
                await accessControlService.registerEntry(plate, validationResult);

                const io = req.app.get('io');
                if (io) {
                    io.to('dashboard').emit('vehicle_entry', {
                        plate,
                        type: validationResult.accessType,
                        method: 'rfid_zkteco',
                        device: serial_number,
                        time: new Date().toISOString()
                    });
                }
            }

            return res.json({ success: true, response, validationResult });
        }

        // Si solo tiene placa
        if (vehicle_plate) {
            let validationResult;
            if (type === 'entry') {
                validationResult = await accessControlService.validateEntry(vehicle_plate);
            } else {
                validationResult = await accessControlService.validateExit(vehicle_plate);
            }

            const device = zktecoService.getDevice(serial_number);
            const response = type === 'entry'
                ? zktecoService.generateAccessResponse(validationResult, device)
                : zktecoService.generateExitResponse(validationResult, device);

            return res.json({ success: true, response, validationResult });
        }

        res.status(400).json({ error: 'Se requiere card_uid o vehicle_plate' });

    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/zkteco/push/action-completed
 * @desc    Dispositivo confirma que ejecuto una accion
 */
router.post('/push/action-completed', authenticateDevice, (req, res) => {
    const { serial_number, action, vehicle_plate, timestamp } = req.body;

    console.log(`[ZKTeco ${serial_number}] Action completed: ${action} for ${vehicle_plate} at ${timestamp}`);

    const io = req.app.get('io');
    if (io) {
        io.to('dashboard').emit('zkteco_action', {
            serial_number, action, vehicle_plate, timestamp
        });
    }

    res.json({ success: true });
});

// ─── Stats & Logs ────────────────────────────────────

/**
 * @route   GET /api/v1/zkteco/stats
 * @desc    Estadisticas del sistema de dispositivos
 */
router.get('/stats', authenticate, (req, res) => {
    res.json({ success: true, data: zktecoService.getStats() });
});

/**
 * @route   GET /api/v1/zkteco/events
 * @desc    Log de eventos de dispositivos
 */
router.get('/events', authenticate, (req, res) => {
    const { serial_number, event_type, limit } = req.query;
    const events = zktecoService.getEventLog({
        serial_number,
        event_type,
        limit: limit ? parseInt(limit) : 50
    });
    res.json({ success: true, data: events });
});

/**
 * @route   GET /api/v1/zkteco/status
 * @desc    Health check publico (para dispositivos)
 */
router.get('/status', (req, res) => {
    const stats = zktecoService.getStats();
    res.json({
        success: true,
        server: 'online',
        timestamp: new Date().toISOString(),
        devices: stats.total_devices,
        online: stats.online
    });
});

module.exports = router;
