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
const { query, transaction } = require('../config/database');

// Short-lived in-memory cache for device lookups during high-frequency access events
// TTL: 5 seconds — avoids repeated DB hits for the same device within a single request burst
const DEVICE_CACHE_TTL_MS = 5000;
const _deviceCache = new Map(); // serialNumber -> { device, expiresAt }

function _cacheGet(serialNumber) {
    const entry = _deviceCache.get(serialNumber);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        _deviceCache.delete(serialNumber);
        return null;
    }
    return entry.device;
}

function _cacheSet(serialNumber, device) {
    _deviceCache.set(serialNumber, { device, expiresAt: Date.now() + DEVICE_CACHE_TTL_MS });
}

function _cacheDelete(serialNumber) {
    _deviceCache.delete(serialNumber);
}

class ZKTecoService {

    // ─── Device Registration ─────────────────────────

    async registerDevice(serialNumber, config) {
        const deviceConfig = {
            barrier_open_time: config.barrier_open_time || 5,
            barrier_auto_close: config.barrier_auto_close !== false,
            lpr_sensitivity: config.lpr_sensitivity || 'high',
            relay_number: config.relay_number || 1,
            wiegand_format: config.wiegand_format || 26,
            aux_input_enabled: config.aux_input_enabled || false,
            heartbeat_interval: config.heartbeat_interval || 30,
            ...config.extra || {}
        };

        const result = await query(
            `INSERT INTO zkteco_devices (
                serial_number, name, type, model, ip_address, port,
                location, direction, protocol, status, firmware_version,
                config, connected_devices, last_seen
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'online', $10, $11, $12, NOW())
            ON CONFLICT (serial_number) DO UPDATE SET
                name = EXCLUDED.name,
                type = EXCLUDED.type,
                model = EXCLUDED.model,
                ip_address = EXCLUDED.ip_address,
                port = EXCLUDED.port,
                location = EXCLUDED.location,
                direction = EXCLUDED.direction,
                protocol = EXCLUDED.protocol,
                status = 'online',
                firmware_version = EXCLUDED.firmware_version,
                config = EXCLUDED.config,
                connected_devices = EXCLUDED.connected_devices,
                last_seen = NOW(),
                updated_at = NOW()
            RETURNING *`,
            [
                serialNumber,
                config.name || `ZKTeco ${serialNumber}`,
                config.type || 'barrier',
                config.model || 'PB4000',
                config.ip_address || null,
                config.port || 4370,
                config.location || 'entrada_principal',
                config.direction || 'entry',
                config.protocol || 'push',
                config.firmware_version || null,
                JSON.stringify(deviceConfig),
                JSON.stringify(config.connected_devices || [])
            ]
        );

        const device = result.rows[0];
        _cacheSet(serialNumber, device);
        await this._logEvent(serialNumber, 'device_registered', { model: device.model, type: device.type });
        return device;
    }

    async updateDevice(serialNumber, updates) {
        // Build SET clauses dynamically for only the provided fields
        const setClauses = ['updated_at = NOW()'];
        const params = [serialNumber];
        let paramIdx = 2;

        if (updates.name !== undefined) {
            setClauses.push(`name = $${paramIdx++}`);
            params.push(updates.name);
        }
        if (updates.location !== undefined) {
            setClauses.push(`location = $${paramIdx++}`);
            params.push(updates.location);
        }
        if (updates.direction !== undefined) {
            setClauses.push(`direction = $${paramIdx++}`);
            params.push(updates.direction);
        }
        if (updates.ip_address !== undefined) {
            setClauses.push(`ip_address = $${paramIdx++}`);
            params.push(updates.ip_address);
        }
        if (updates.port !== undefined) {
            setClauses.push(`port = $${paramIdx++}`);
            params.push(updates.port);
        }
        if (updates.connected_devices !== undefined) {
            setClauses.push(`connected_devices = $${paramIdx++}`);
            params.push(JSON.stringify(updates.connected_devices));
        }
        if (updates.config !== undefined) {
            // Merge existing config with the provided partial config
            setClauses.push(`config = config || $${paramIdx++}::jsonb`);
            params.push(JSON.stringify(updates.config));
        }

        const result = await query(
            `UPDATE zkteco_devices SET ${setClauses.join(', ')}
             WHERE serial_number = $1
             RETURNING *`,
            params
        );

        if (result.rows.length === 0) return null;

        const device = result.rows[0];
        _cacheSet(serialNumber, device);
        return device;
    }

    async removeDevice(serialNumber) {
        const result = await query(
            'DELETE FROM zkteco_devices WHERE serial_number = $1 RETURNING serial_number',
            [serialNumber]
        );
        _cacheDelete(serialNumber);
        return result.rows.length > 0;
    }

    // ─── Heartbeat ───────────────────────────────────

    async heartbeat(serialNumber, info = {}) {
        const setClauses = ['last_seen = NOW()', "status = 'online'", 'updated_at = NOW()'];
        const params = [serialNumber];
        let paramIdx = 2;

        if (info.firmware_version) {
            setClauses.push(`firmware_version = $${paramIdx++}`);
            params.push(info.firmware_version);
        }

        const result = await query(
            `UPDATE zkteco_devices SET ${setClauses.join(', ')}
             WHERE serial_number = $1
             RETURNING *`,
            params
        );

        if (result.rows.length === 0) return null;

        const device = result.rows[0];
        _cacheSet(serialNumber, device);
        return device;
    }

    // ─── Device Queries ──────────────────────────────

    async getDevices(filters = {}) {
        const conditions = [];
        const params = [];
        let paramIdx = 1;

        // Auto-mark offline if no heartbeat in configured interval * 3.
        // Uses the stored heartbeat_interval from config JSONB field.
        // Devices without a last_seen are also considered offline.
        conditions.push(`(
            last_seen IS NULL
            OR last_seen < NOW() - (
                COALESCE((config->>'heartbeat_interval')::int, 30) * 3
            ) * INTERVAL '1 second'
            OR status = 'offline'
        ) AND status != 'maintenance'`);

        // Apply the offline update as a side effect — but to keep getDevices read-like,
        // we run the UPDATE separately and then SELECT with filters.
        // (The SELECT below already reflects current DB truth after the UPDATE.)
        await query(`
            UPDATE zkteco_devices
            SET status = 'offline', updated_at = NOW()
            WHERE status = 'online'
              AND (
                last_seen IS NULL
                OR last_seen < NOW() - (
                    COALESCE((config->>'heartbeat_interval')::int, 30) * 3
                ) * INTERVAL '1 second'
              )
        `);

        // Now SELECT with caller-supplied filters
        const filterConditions = [];
        const filterParams = [];
        let fidx = 1;

        if (filters.type) {
            filterConditions.push(`type = $${fidx++}`);
            filterParams.push(filters.type);
        }
        if (filters.location) {
            filterConditions.push(`location = $${fidx++}`);
            filterParams.push(filters.location);
        }
        if (filters.status) {
            filterConditions.push(`status = $${fidx++}`);
            filterParams.push(filters.status);
        }
        if (filters.direction) {
            filterConditions.push(`direction = $${fidx++}`);
            filterParams.push(filters.direction);
        }

        const whereClause = filterConditions.length > 0
            ? `WHERE ${filterConditions.join(' AND ')}`
            : '';

        const result = await query(
            `SELECT * FROM zkteco_devices ${whereClause} ORDER BY created_at ASC`,
            filterParams
        );

        return result.rows;
    }

    async getDevice(serialNumber) {
        const cached = _cacheGet(serialNumber);
        if (cached) return cached;

        const result = await query(
            'SELECT * FROM zkteco_devices WHERE serial_number = $1',
            [serialNumber]
        );

        if (result.rows.length === 0) return null;

        const device = result.rows[0];
        _cacheSet(serialNumber, device);
        return device;
    }

    // ─── Barrier Commands ────────────────────────────

    /**
     * Generar comando para abrir barrera ZKTeco
     * Compatible con controladores C3-x00 e inBio
     */
    async generateOpenCommand(serialNumber) {
        const device = await this.getDevice(serialNumber);
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
    async generateCloseCommand(serialNumber) {
        const device = await this.getDevice(serialNumber);
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
            const hasUnpaidFee = validationResult.payment &&
                !validationResult.payment.is_free &&
                !validationResult.payment.paid;

            // Payment is pending — hold the barrier until payment is confirmed
            if (hasUnpaidFee) {
                return {
                    granted: false,
                    relay_action: 'none',
                    display_message: 'PAGO PENDIENTE',
                    sub_message: `RD$ ${validationResult.payment.amount?.toFixed(2)}`,
                    led: 'yellow',
                    buzzer: 0,
                    payment_required: {
                        amount: validationResult.payment.amount
                    }
                };
            }

            // Free exit (grace period) or payment already confirmed
            return {
                granted: true,
                relay_action: 'trigger',
                relay_number: device?.config?.relay_number || 1,
                relay_duration: device?.config?.barrier_open_time || 5,
                display_message: 'HASTA PRONTO',
                sub_message: 'Salida autorizada',
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
        const device = await this.getDevice(serialNumber);
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
    async processLPREvent(serialNumber, eventData) {
        const lastEvent = {
            type: 'lpr_read',
            plate: eventData.plate,
            confidence: eventData.confidence,
            timestamp: new Date()
        };

        // Update device last_seen and last_event; fetch fresh row for direction/location
        const result = await query(
            `UPDATE zkteco_devices
             SET last_seen = NOW(), last_event = $2, updated_at = NOW()
             WHERE serial_number = $1
             RETURNING direction, location`,
            [serialNumber, JSON.stringify(lastEvent)]
        );

        _cacheDelete(serialNumber); // Invalidate cache after mutation

        const deviceRow = result.rows[0] || {};

        await this._logEvent(serialNumber, 'lpr_plate_detected', {
            plate: eventData.plate,
            confidence: eventData.confidence,
            image_url: eventData.image_url || null
        });

        return {
            plate: eventData.plate?.toUpperCase()?.trim(),
            confidence: eventData.confidence || 0,
            direction: deviceRow.direction || 'entry',
            device_location: deviceRow.location || 'unknown'
        };
    }

    // ─── Event Logging ───────────────────────────────

    async _logEvent(serialNumber, eventType, data = {}) {
        await query(
            `INSERT INTO zkteco_device_events (serial_number, event_type, data)
             VALUES ($1, $2, $3)`,
            [serialNumber, eventType, JSON.stringify(data)]
        );
    }

    async getEventLog(filters = {}) {
        const conditions = [];
        const params = [];
        let paramIdx = 1;

        if (filters.serial_number) {
            conditions.push(`serial_number = $${paramIdx++}`);
            params.push(filters.serial_number);
        }
        if (filters.event_type) {
            conditions.push(`event_type = $${paramIdx++}`);
            params.push(filters.event_type);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const limit = filters.limit || 50;
        params.push(limit);

        const result = await query(
            `SELECT * FROM zkteco_device_events
             ${whereClause}
             ORDER BY created_at DESC
             LIMIT $${paramIdx}`,
            params
        );

        return result.rows;
    }

    // ─── System Stats ────────────────────────────────

    async getStats() {
        const [devicesResult, recentEventsResult] = await Promise.all([
            query(`
                SELECT
                    COUNT(*)::int                                               AS total_devices,
                    COUNT(*) FILTER (WHERE status = 'online')::int             AS online,
                    COUNT(*) FILTER (WHERE status = 'offline')::int            AS offline,
                    COUNT(*) FILTER (WHERE type = 'barrier')::int              AS barriers,
                    COUNT(*) FILTER (WHERE type = 'lpr_camera')::int           AS lpr_cameras,
                    COUNT(*) FILTER (WHERE type = 'controller')::int           AS controllers,
                    COUNT(*) FILTER (WHERE type = 'reader')::int               AS readers
                FROM zkteco_devices
            `),
            query(`
                SELECT * FROM zkteco_device_events
                ORDER BY created_at DESC
                LIMIT 10
            `)
        ]);

        const counts = devicesResult.rows[0] || {};

        return {
            total_devices: counts.total_devices || 0,
            online: counts.online || 0,
            offline: counts.offline || 0,
            by_type: {
                barriers: counts.barriers || 0,
                lpr_cameras: counts.lpr_cameras || 0,
                controllers: counts.controllers || 0,
                readers: counts.readers || 0,
            },
            recent_events: recentEventsResult.rows
        };
    }
}

module.exports = new ZKTecoService();
