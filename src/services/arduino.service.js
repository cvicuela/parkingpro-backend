/**
 * Arduino/ESP32 Hardware Integration Service
 *
 * Soporta comunicacion con dispositivos Arduino/ESP32 para control de acceso fisico.
 *
 * Controladores recomendados (por orden de preferencia):
 *   - ESP32 WT32-ETH01 (Ethernet nativo, recomendado para produccion)
 *   - ESP32 + modulo W5500 SPI (Ethernet via SPI)
 *   - Arduino UNO R4 WiFi + Shield Ethernet W5500 (alternativa Arduino)
 *   - ESP32 DevKit V1 (WiFi, solo para desarrollo/pruebas)
 *
 * Conectividad:
 *   - PREFERIDO: Ethernet cableado (latencia ~1-5ms, 100% confiable)
 *   - ALTERNATIVA: WiFi (latencia ~50-200ms, sujeto a interferencia)
 *   - El backend es agnostico al transporte: recibe HTTP igual en ambos casos
 *
 * Perifericos:
 *   - Modulo Relay (1 o 2 canales) - Contacto seco para activar la barrera
 *   - Sensor ultrasonico HC-SR04 (deteccion de vehiculo)
 *   - LCD 16x2 con I2C (pantalla de estado)
 *   - LED RGB (indicador visual rojo/verde)
 *   - Buzzer piezoelectrico (alerta sonora)
 *   - Lector RFID RC522 (lectura de tarjetas NFC) - opcional
 *
 * Flujo de operacion:
 *   1. Sensor ultrasonico detecta vehiculo en la entrada
 *   2. Controlador envia POST /api/v1/arduino/vehicle-detected a ParkingPro
 *   3. Backend responde con instrucciones (activar relay/barrera, mostrar mensaje, etc.)
 *   4. Controlador ejecuta las instrucciones (relay, LCD, LED, buzzer)
 *   5. Controlador confirma accion completada via POST /api/v1/arduino/action-completed
 *
 * Nota sobre la barrera:
 *   La barrera se controla via relay con CONTACTO SECO (dry contact).
 *   El relay cierra el circuito entre los terminales OPEN y COM de la barrera
 *   por el tiempo indicado en relay_duration_ms. No pasa voltaje del controlador
 *   a la barrera — el relay aisla electricamente ambos lados.
 *   Al desactivar el relay, la barrera cierra por gravedad o resorte.
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
            capabilities: config.capabilities || ['relay', 'lcd', 'led', 'buzzer']
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
                relay: 'off',
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
                relay: 'on',
                relay_duration_ms: 5000,
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
            relay: 'off',
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
                relay: 'on',
                relay_duration_ms: 5000,
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
            relay: 'off',
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
