/**
 * Arduino Hardware Integration Service
 *
 * Soporta comunicacion con dispositivos Arduino para control de acceso fisico.
 *
 * Hardware recomendado (arduino.cc):
 *   - Arduino UNO R4 WiFi (ABX00087) - Controlador principal con WiFi integrado
 *   - Arduino MKR WiFi 1010 (ABX00023) - Alternativa compacta con WiFi
 *   - Servo Motor (para barrera fisica)
 *   - Sensor ultrasonico HC-SR04 (deteccion de vehiculo)
 *   - LCD 16x2 con I2C (pantalla de estado)
 *   - LED RGB (indicador visual rojo/verde)
 *   - Buzzer piezoelectrico (alerta sonora)
 *   - Lector RFID RC522 (lectura de tarjetas NFC) - opcional
 *
 * Flujo de operacion:
 *   1. Sensor ultrasonico detecta vehiculo en la entrada
 *   2. Arduino envia POST /api/v1/arduino/vehicle-detected a ParkingPro
 *   3. Backend responde con instrucciones (abrir barrera, mostrar mensaje, etc.)
 *   4. Arduino ejecuta las instrucciones (servo, LCD, LED, buzzer)
 *   5. Arduino confirma accion completada via POST /api/v1/arduino/action-completed
 */

class ArduinoService {
    constructor() {
        this.registeredDevices = new Map();
    }

    /**
     * Registrar un dispositivo Arduino
     */
    registerDevice(deviceId, config) {
        this.registeredDevices.set(deviceId, {
            id: deviceId,
            type: config.type || 'barrier_controller',
            location: config.location || 'entrada_principal',
            lastSeen: new Date(),
            status: 'online',
            firmware: config.firmware || '1.0.0',
            capabilities: config.capabilities || ['barrier', 'lcd', 'led', 'buzzer']
        });

        return this.registeredDevices.get(deviceId);
    }

    /**
     * Heartbeat - Arduino reporta que sigue vivo
     */
    heartbeat(deviceId) {
        const device = this.registeredDevices.get(deviceId);
        if (device) {
            device.lastSeen = new Date();
            device.status = 'online';
        }
        return device;
    }

    /**
     * Generar comando para Arduino cuando detecta un vehiculo
     * El Arduino llama a este metodo via la API REST
     */
    generateBarrierCommand(validationResult) {
        if (!validationResult) {
            return {
                action: 'deny',
                barrier: 'closed',
                led: 'red',
                buzzer: 'error',
                lcd_line1: 'ACCESO DENEGADO',
                lcd_line2: 'Sin validacion'
            };
        }

        if (validationResult.allowed) {
            return {
                action: 'allow',
                barrier: 'open',
                barrier_delay_ms: 5000,
                led: 'green',
                buzzer: 'success',
                lcd_line1: validationResult.accessType === 'subscription'
                    ? (validationResult.subscription?.customer_name || 'BIENVENIDO').substring(0, 16)
                    : 'PARQUEO POR HORA',
                lcd_line2: validationResult.subscription?.plan_name?.substring(0, 16)
                    || validationResult.plan?.name?.substring(0, 16)
                    || 'Acceso permitido'
            };
        }

        return {
            action: 'deny',
            barrier: 'closed',
            led: 'red',
            buzzer: 'error',
            lcd_line1: 'ACCESO DENEGADO',
            lcd_line2: (validationResult.message || 'No autorizado').substring(0, 16)
        };
    }

    /**
     * Generar comando de salida para Arduino
     */
    generateExitCommand(validationResult) {
        if (validationResult?.allowed) {
            const hasPayment = validationResult.payment && !validationResult.payment.is_free;
            return {
                action: 'allow',
                barrier: 'open',
                barrier_delay_ms: 5000,
                led: 'green',
                buzzer: 'success',
                lcd_line1: hasPayment
                    ? `RD$ ${validationResult.payment.amount?.toFixed(2)}`
                    : 'HASTA PRONTO',
                lcd_line2: hasPayment ? 'PAGO REQUERIDO' : 'Salida libre'
            };
        }

        return {
            action: 'deny',
            barrier: 'closed',
            led: 'red',
            buzzer: 'error',
            lcd_line1: 'SALIDA DENEGADA',
            lcd_line2: 'Consulte operador'
        };
    }

    /**
     * Obtener todos los dispositivos registrados
     */
    getDevices() {
        const devices = [];
        this.registeredDevices.forEach((device) => {
            // Marcar offline si no ha reportado en 60 segundos
            if (Date.now() - device.lastSeen.getTime() > 60000) {
                device.status = 'offline';
            }
            devices.push(device);
        });
        return devices;
    }

    /**
     * Obtener estado de un dispositivo
     */
    getDevice(deviceId) {
        return this.registeredDevices.get(deviceId) || null;
    }
}

module.exports = new ArduinoService();
