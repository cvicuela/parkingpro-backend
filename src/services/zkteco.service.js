/**
 * ZKTeco Hardware Integration Service
 *
 * Soporta comunicacion con equipos ZKTeco para control de acceso vehicular:
 *   - Barreras vehiculares: PB3000, PB4000, PROBG3060, BGM-P060
 *   - Camaras LPR: LPR6500, LPRS2000
 *   - Controladores de acceso: C3-100, C3-200, C3-400, inBio160/260/460
 *   - Lectores biometricos/RFID: SpeedFace, ProFace, ZK-RFID101
 *
 * Protocolo de comunicacion:
 *   - PUSH Protocol (HTTP POST desde el dispositivo al servidor)
 *   - TCP/IP directo para comandos al dispositivo
 *   - Wiegand 26/34 para lectores de tarjetas
 *   - RS-485 para control de barrera
 *
 * Flujo tipico:
 *   1. Dispositivo ZKTeco se registra via PUSH al backend
 *   2. Camara LPR detecta placa -> POST /api/v1/zkteco/event
 *   3. Backend valida acceso y responde con comando (abrir/cerrar barrera)
 *   4. Controlador C3 ejecuta relay para abrir barrera
 *   5. Dispositivo confirma accion completada
 */

const net = require('net');

class ZKTecoService {
    constructor() {
        this.devices = new Map();
        this.eventLog = [];
        this.maxEventLog = 500;
    }

    // ─── Device Registration ─────────────────────────

    registerDevice(serialNumber, config) {
        const device = {
            serial_number: serialNumber,
            name: config.name || `ZKTeco ${serialNumber}`,
            type: config.type || 'barrier',       // barrier | lpr_camera | controller | reader
            model: config.model || 'PB4000',
            ip_address: config.ip_address || null,
            port: config.port || 4370,             // Puerto por defecto ZKTeco
            location: config.location || 'entrada_principal',  // entrada_principal | salida_principal | entrada_vip | salida_vip
            direction: config.direction || 'entry', // entry | exit | bidirectional
            protocol: config.protocol || 'push',    // push | tcp | wiegand
            status: 'online',
            connected_devices: config.connected_devices || [], // dispositivos conectados (barrera a controlador)
            last_seen: new Date(),
            last_event: null,
            firmware_version: config.firmware_version || null,
            registered_at: new Date(),
            config: {
                barrier_open_time: config.barrier_open_time || 5,     // segundos
                barrier_auto_close: config.barrier_auto_close !== false,
                lpr_sensitivity: config.lpr_sensitivity || 'high',    // low | medium | high
                relay_number: config.relay_number || 1,               // relay 1 o 2 del controlador
                wiegand_format: config.wiegand_format || 26,          // 26 o 34 bits
                aux_input_enabled: config.aux_input_enabled || false,  // sensor de loop detector
                heartbeat_interval: config.heartbeat_interval || 30,   // segundos
                ...config.extra || {}
            }
        };

        this.devices.set(serialNumber, device);
        this._logEvent(serialNumber, 'device_registered', { model: device.model, type: device.type });
        return device;
    }

    updateDevice(serialNumber, updates) {
        const device = this.devices.get(serialNumber);
        if (!device) return null;

        if (updates.name) device.name = updates.name;
        if (updates.location) device.location = updates.location;
        if (updates.direction) device.direction = updates.direction;
        if (updates.ip_address) device.ip_address = updates.ip_address;
        if (updates.port) device.port = updates.port;
        if (updates.connected_devices) device.connected_devices = updates.connected_devices;
        if (updates.config) {
            device.config = { ...device.config, ...updates.config };
        }

        return device;
    }

    removeDevice(serialNumber) {
        return this.devices.delete(serialNumber);
    }

    // ─── Heartbeat ───────────────────────────────────

    heartbeat(serialNumber, info = {}) {
        const device = this.devices.get(serialNumber);
        if (!device) return null;

        device.last_seen = new Date();
        device.status = 'online';
        if (info.firmware_version) device.firmware_version = info.firmware_version;

        return device;
    }

    // ─── Device Queries ──────────────────────────────

    getDevices(filters = {}) {
        const devices = [];
        this.devices.forEach((device) => {
            // Auto-mark offline if no heartbeat in configured interval * 3
            const timeout = (device.config.heartbeat_interval || 30) * 3 * 1000;
            if (Date.now() - device.last_seen.getTime() > timeout) {
                device.status = 'offline';
            }

            if (filters.type && device.type !== filters.type) return;
            if (filters.location && device.location !== filters.location) return;
            if (filters.status && device.status !== filters.status) return;
            if (filters.direction && device.direction !== filters.direction) return;

            devices.push(device);
        });
        return devices;
    }

    getDevice(serialNumber) {
        return this.devices.get(serialNumber) || null;
    }

    // ─── Barrier Commands ────────────────────────────

    /**
     * Generar comando para abrir barrera ZKTeco
     * Compatible con controladores C3-x00 e inBio
     */
    generateOpenCommand(serialNumber) {
        const device = this.devices.get(serialNumber);
        if (!device) return null;

        return {
            action: 'open_barrier',
            serial_number: serialNumber,
            relay: device.config.relay_number || 1,
            duration: device.config.barrier_open_time || 5,
            auto_close: device.config.barrier_auto_close
        };
    }

    /**
     * Generar comando para cerrar barrera
     */
    generateCloseCommand(serialNumber) {
        const device = this.devices.get(serialNumber);
        if (!device) return null;

        return {
            action: 'close_barrier',
            serial_number: serialNumber,
            relay: device.config.relay_number || 1
        };
    }

    /**
     * Generar respuesta de acceso para el controlador ZKTeco
     * Formato compatible con PUSH protocol
     */
    generateAccessResponse(validationResult, device) {
        if (!validationResult) {
            return {
                granted: false,
                relay_action: 'none',
                display_message: 'ACCESO DENEGADO',
                led: 'red',
                buzzer: 2 // 2 beeps = denied
            };
        }

        if (validationResult.allowed) {
            return {
                granted: true,
                relay_action: 'trigger',
                relay_number: device?.config?.relay_number || 1,
                relay_duration: device?.config?.barrier_open_time || 5,
                display_message: validationResult.accessType === 'subscription'
                    ? (validationResult.subscription?.customer_name || 'BIENVENIDO')
                    : 'PARQUEO POR HORA',
                sub_message: validationResult.subscription?.plan_name
                    || validationResult.plan?.name
                    || 'Acceso permitido',
                led: 'green',
                buzzer: 1 // 1 beep = granted
            };
        }

        return {
            granted: false,
            relay_action: 'none',
            display_message: 'ACCESO DENEGADO',
            sub_message: (validationResult.message || 'No autorizado').substring(0, 32),
            led: 'red',
            buzzer: 2
        };
    }

    /**
     * Generar respuesta de salida
     */
    generateExitResponse(validationResult, device) {
        if (validationResult?.allowed) {
            const hasPayment = validationResult.payment && !validationResult.payment.is_free;
            return {
                granted: true,
                relay_action: 'trigger',
                relay_number: device?.config?.relay_number || 1,
                relay_duration: device?.config?.barrier_open_time || 5,
                display_message: hasPayment
                    ? `RD$ ${validationResult.payment.amount?.toFixed(2)}`
                    : 'HASTA PRONTO',
                sub_message: hasPayment ? 'PAGO REQUERIDO' : 'Salida autorizada',
                led: 'green',
                buzzer: 1
            };
        }

        return {
            granted: false,
            relay_action: 'none',
            display_message: 'SALIDA DENEGADA',
            sub_message: 'Consulte operador',
            led: 'red',
            buzzer: 2
        };
    }

    /**
     * Enviar comando TCP directo a dispositivo ZKTeco
     * Usado para control remoto de barreras desde el dashboard
     */
    async sendTCPCommand(serialNumber, command) {
        const device = this.devices.get(serialNumber);
        if (!device || !device.ip_address) {
            throw new Error('Dispositivo no encontrado o sin IP configurada');
        }

        return new Promise((resolve, reject) => {
            const socket = new net.Socket();
            const timeout = setTimeout(() => {
                socket.destroy();
                reject(new Error('Timeout de conexion al dispositivo'));
            }, 5000);

            socket.connect(device.port, device.ip_address, () => {
                // Formato de comando ZKTeco simplificado
                const cmdBuffer = this._buildZKCommand(command);
                socket.write(cmdBuffer);
            });

            socket.on('data', (data) => {
                clearTimeout(timeout);
                socket.destroy();
                resolve({ success: true, response: data.toString('hex') });
            });

            socket.on('error', (err) => {
                clearTimeout(timeout);
                socket.destroy();
                reject(new Error(`Error de comunicacion: ${err.message}`));
            });
        });
    }

    _buildZKCommand(command) {
        // Protocolo simplificado - en produccion usar SDK ZKTeco completo
        const cmd = Buffer.alloc(16);
        switch (command.action) {
            case 'open_barrier':
                cmd.writeUInt16LE(0x05, 0);  // CMD_UNLOCK
                cmd.writeUInt8(command.relay || 1, 2);
                cmd.writeUInt8(command.duration || 5, 3);
                break;
            case 'close_barrier':
                cmd.writeUInt16LE(0x06, 0);  // CMD_LOCK
                cmd.writeUInt8(command.relay || 1, 2);
                break;
            case 'read_card':
                cmd.writeUInt16LE(0x0A, 0);  // CMD_READ_CARD
                cmd.writeUInt8(command.timeout || 30, 2);
                break;
            case 'reboot':
                cmd.writeUInt16LE(0x0B, 0);  // CMD_RESTART
                break;
        }
        return cmd;
    }

    // ─── LPR Event Processing ────────────────────────

    /**
     * Procesar evento de camara LPR ZKTeco
     * Las camaras LPR envian un POST con la placa detectada
     */
    processLPREvent(serialNumber, eventData) {
        const device = this.devices.get(serialNumber);
        if (device) {
            device.last_seen = new Date();
            device.last_event = {
                type: 'lpr_read',
                plate: eventData.plate,
                confidence: eventData.confidence,
                timestamp: new Date()
            };
        }

        this._logEvent(serialNumber, 'lpr_plate_detected', {
            plate: eventData.plate,
            confidence: eventData.confidence,
            image_url: eventData.image_url || null
        });

        return {
            plate: eventData.plate?.toUpperCase()?.trim(),
            confidence: eventData.confidence || 0,
            direction: device?.direction || 'entry',
            device_location: device?.location || 'unknown'
        };
    }

    // ─── Event Logging ───────────────────────────────

    _logEvent(serialNumber, eventType, data = {}) {
        this.eventLog.unshift({
            serial_number: serialNumber,
            event_type: eventType,
            data,
            timestamp: new Date()
        });

        if (this.eventLog.length > this.maxEventLog) {
            this.eventLog = this.eventLog.slice(0, this.maxEventLog);
        }
    }

    getEventLog(filters = {}) {
        let events = this.eventLog;

        if (filters.serial_number) {
            events = events.filter(e => e.serial_number === filters.serial_number);
        }
        if (filters.event_type) {
            events = events.filter(e => e.event_type === filters.event_type);
        }

        const limit = filters.limit || 50;
        return events.slice(0, limit);
    }

    // ─── System Stats ────────────────────────────────

    getStats() {
        const devices = this.getDevices();
        return {
            total_devices: devices.length,
            online: devices.filter(d => d.status === 'online').length,
            offline: devices.filter(d => d.status === 'offline').length,
            by_type: {
                barriers: devices.filter(d => d.type === 'barrier').length,
                lpr_cameras: devices.filter(d => d.type === 'lpr_camera').length,
                controllers: devices.filter(d => d.type === 'controller').length,
                readers: devices.filter(d => d.type === 'reader').length,
            },
            recent_events: this.eventLog.slice(0, 10)
        };
    }
}

module.exports = new ZKTecoService();
