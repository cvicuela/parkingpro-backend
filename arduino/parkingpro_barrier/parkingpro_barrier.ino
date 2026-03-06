/*
 * ParkingPro - Control de Barrera con Arduino
 *
 * Hardware requerido (arduino.cc):
 *   - Arduino UNO R4 WiFi (ABX00087)
 *   - Servo Motor SG90 (barrera) -> Pin 9
 *   - Sensor Ultrasonico HC-SR04 -> Trigger Pin 7, Echo Pin 8
 *   - LCD 16x2 con modulo I2C -> SDA/SCL
 *   - LED Rojo -> Pin 3
 *   - LED Verde -> Pin 4
 *   - Buzzer Piezoelectrico -> Pin 5
 *   - Teclado matricial 4x4 (para placa) -> Pins 22-29 (opcional)
 *
 * Conexiones:
 *   Servo:     Signal -> D9, VCC -> 5V, GND -> GND
 *   HC-SR04:   Trigger -> D7, Echo -> D8, VCC -> 5V, GND -> GND
 *   LCD I2C:   SDA -> SDA, SCL -> SCL, VCC -> 5V, GND -> GND
 *   LED Rojo:  Anodo -> D3 (con resistencia 220ohm), Catodo -> GND
 *   LED Verde: Anodo -> D4 (con resistencia 220ohm), Catodo -> GND
 *   Buzzer:    + -> D5, - -> GND
 */

#include <WiFiS3.h>
#include <ArduinoHttpClient.h>
#include <ArduinoJson.h>
#include <Servo.h>
#include <LiquidCrystal_I2C.h>

// ==================== CONFIGURACION ====================

// WiFi
const char* WIFI_SSID = "TU_RED_WIFI";
const char* WIFI_PASS = "TU_PASSWORD";

// ParkingPro Server
const char* SERVER_HOST = "192.168.1.100";  // IP del servidor backend
const int SERVER_PORT = 3000;
const char* API_KEY = "parkingpro-arduino-2024";
const char* DEVICE_ID = "barrier-entrada-01";

// Pines
#define SERVO_PIN     9
#define TRIGGER_PIN   7
#define ECHO_PIN      8
#define LED_RED_PIN   3
#define LED_GREEN_PIN 4
#define BUZZER_PIN    5

// Constantes
#define VEHICLE_DISTANCE_CM  50   // Distancia para detectar vehiculo
#define BARRIER_OPEN_ANGLE   90   // Angulo barrera abierta
#define BARRIER_CLOSED_ANGLE 0    // Angulo barrera cerrada
#define DETECTION_COOLDOWN   10000 // Cooldown entre detecciones (ms)

// ==================== OBJETOS ====================

WiFiClient wifi;
HttpClient http(wifi, SERVER_HOST, SERVER_PORT);
Servo barrier;
LiquidCrystal_I2C lcd(0x27, 16, 2);

// ==================== VARIABLES ====================

unsigned long lastDetection = 0;
bool barrierOpen = false;
String currentPlate = "";

// ==================== SETUP ====================

void setup() {
    Serial.begin(115200);
    delay(1000);

    // Pines
    pinMode(TRIGGER_PIN, OUTPUT);
    pinMode(ECHO_PIN, INPUT);
    pinMode(LED_RED_PIN, OUTPUT);
    pinMode(LED_GREEN_PIN, OUTPUT);
    pinMode(BUZZER_PIN, OUTPUT);

    // Inicializar servo
    barrier.attach(SERVO_PIN);
    barrier.write(BARRIER_CLOSED_ANGLE);

    // Inicializar LCD
    lcd.init();
    lcd.backlight();
    lcd.setCursor(0, 0);
    lcd.print("ParkingPro");
    lcd.setCursor(0, 1);
    lcd.print("Iniciando...");

    // LED rojo encendido por defecto
    digitalWrite(LED_RED_PIN, HIGH);
    digitalWrite(LED_GREEN_PIN, LOW);

    // Conectar WiFi
    connectWiFi();

    // Registrar dispositivo
    registerDevice();

    // Pantalla lista
    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print("ParkingPro");
    lcd.setCursor(0, 1);
    lcd.print("Listo");

    Serial.println("[ParkingPro] Sistema listo");
}

// ==================== LOOP ====================

void loop() {
    // Medir distancia
    float distance = measureDistance();

    // Detectar vehiculo
    if (distance > 0 && distance < VEHICLE_DISTANCE_CM) {
        unsigned long now = millis();
        if (now - lastDetection > DETECTION_COOLDOWN) {
            lastDetection = now;
            Serial.println("[ParkingPro] Vehiculo detectado!");

            lcd.clear();
            lcd.setCursor(0, 0);
            lcd.print("Vehiculo");
            lcd.setCursor(0, 1);
            lcd.print("detectado...");

            // En produccion, aqui se leeria la placa con camara IP
            // o el operador la ingresa desde el sistema web.
            // Para demo, se puede recibir por Serial
            if (Serial.available()) {
                currentPlate = Serial.readStringUntil('\n');
                currentPlate.trim();
                currentPlate.toUpperCase();
            }

            if (currentPlate.length() > 0) {
                processVehicle(currentPlate, "entry");
                currentPlate = "";
            } else {
                // Sin placa, mostrar mensaje para operador
                lcd.clear();
                lcd.setCursor(0, 0);
                lcd.print("Ingrese placa");
                lcd.setCursor(0, 1);
                lcd.print("en el sistema");
            }
        }
    }

    // Verificar si hay placa por Serial (operador ingresa placa manualmente)
    if (Serial.available()) {
        String input = Serial.readStringUntil('\n');
        input.trim();

        if (input.startsWith("ENTRY:")) {
            String plate = input.substring(6);
            plate.toUpperCase();
            processVehicle(plate, "entry");
        } else if (input.startsWith("EXIT:")) {
            String plate = input.substring(5);
            plate.toUpperCase();
            processVehicle(plate, "exit");
        }
    }

    // Heartbeat cada 30 segundos
    static unsigned long lastHeartbeat = 0;
    if (millis() - lastHeartbeat > 30000) {
        lastHeartbeat = millis();
        sendHeartbeat();
    }

    delay(100);
}

// ==================== FUNCIONES ====================

void connectWiFi() {
    Serial.print("[WiFi] Conectando a ");
    Serial.println(WIFI_SSID);

    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print("Conectando WiFi");

    WiFi.begin(WIFI_SSID, WIFI_PASS);

    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 20) {
        delay(500);
        Serial.print(".");
        attempts++;
    }

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("\n[WiFi] Conectado!");
        Serial.print("[WiFi] IP: ");
        Serial.println(WiFi.localIP());

        lcd.setCursor(0, 1);
        lcd.print(WiFi.localIP());
        delay(2000);
    } else {
        Serial.println("\n[WiFi] Error de conexion");
        lcd.setCursor(0, 1);
        lcd.print("Error WiFi!");
    }
}

void registerDevice() {
    StaticJsonDocument<256> doc;
    doc["deviceId"] = DEVICE_ID;
    doc["type"] = "barrier_controller";
    doc["location"] = "entrada_principal";
    doc["firmware"] = "1.0.0";

    JsonArray caps = doc.createNestedArray("capabilities");
    caps.add("barrier");
    caps.add("lcd");
    caps.add("led");
    caps.add("buzzer");
    caps.add("ultrasonic");

    String body;
    serializeJson(doc, body);

    http.beginRequest();
    http.post("/api/v1/arduino/register");
    http.sendHeader("Content-Type", "application/json");
    http.sendHeader("X-Arduino-Key", API_KEY);
    http.sendHeader("Content-Length", body.length());
    http.beginBody();
    http.print(body);
    http.endRequest();

    int statusCode = http.responseStatusCode();
    Serial.print("[Arduino] Registro: ");
    Serial.println(statusCode);
}

void processVehicle(String plate, String type) {
    Serial.print("[ParkingPro] Procesando ");
    Serial.print(type);
    Serial.print(": ");
    Serial.println(plate);

    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print(plate);
    lcd.setCursor(0, 1);
    lcd.print("Validando...");

    // Llamar al backend
    StaticJsonDocument<256> doc;
    doc["deviceId"] = DEVICE_ID;
    doc["vehiclePlate"] = plate;
    doc["type"] = type;

    String body;
    serializeJson(doc, body);

    http.beginRequest();
    http.post("/api/v1/arduino/vehicle-detected");
    http.sendHeader("Content-Type", "application/json");
    http.sendHeader("X-Arduino-Key", API_KEY);
    http.sendHeader("Content-Length", body.length());
    http.beginBody();
    http.print(body);
    http.endRequest();

    int statusCode = http.responseStatusCode();
    String response = http.responseBody();

    if (statusCode == 200) {
        // Parsear respuesta
        StaticJsonDocument<1024> responseDoc;
        DeserializationError error = deserializeJson(responseDoc, response);

        if (!error && responseDoc.containsKey("command")) {
            String action = responseDoc["command"]["action"].as<String>();
            String lcd1 = responseDoc["command"]["lcd_line1"].as<String>();
            String lcd2 = responseDoc["command"]["lcd_line2"].as<String>();
            String ledColor = responseDoc["command"]["led"].as<String>();
            String buzzerType = responseDoc["command"]["buzzer"].as<String>();
            int barrierDelay = responseDoc["command"]["barrier_delay_ms"] | 5000;

            // Actualizar LCD
            lcd.clear();
            lcd.setCursor(0, 0);
            lcd.print(lcd1.substring(0, 16));
            lcd.setCursor(0, 1);
            lcd.print(lcd2.substring(0, 16));

            // LED
            if (ledColor == "green") {
                digitalWrite(LED_GREEN_PIN, HIGH);
                digitalWrite(LED_RED_PIN, LOW);
            } else {
                digitalWrite(LED_GREEN_PIN, LOW);
                digitalWrite(LED_RED_PIN, HIGH);
            }

            // Buzzer
            if (buzzerType == "success") {
                tone(BUZZER_PIN, 1000, 200);
                delay(250);
                tone(BUZZER_PIN, 1500, 200);
            } else if (buzzerType == "error") {
                tone(BUZZER_PIN, 400, 500);
            }

            // Barrera
            if (action == "allow") {
                openBarrier();
                delay(barrierDelay);
                closeBarrier();
            }

            // Confirmar accion
            confirmAction(action, plate);

        } else {
            lcd.clear();
            lcd.setCursor(0, 0);
            lcd.print("Error respuesta");
        }
    } else {
        lcd.clear();
        lcd.setCursor(0, 0);
        lcd.print("Error servidor");
        lcd.setCursor(0, 1);
        lcd.print("Cod: " + String(statusCode));

        digitalWrite(LED_RED_PIN, HIGH);
        digitalWrite(LED_GREEN_PIN, LOW);
        tone(BUZZER_PIN, 300, 1000);
    }

    // Despues de 5 segundos, volver a pantalla de espera
    delay(5000);
    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print("ParkingPro");
    lcd.setCursor(0, 1);
    lcd.print("Listo");
    digitalWrite(LED_RED_PIN, HIGH);
    digitalWrite(LED_GREEN_PIN, LOW);
}

void openBarrier() {
    Serial.println("[Barrier] Abriendo...");
    barrier.write(BARRIER_OPEN_ANGLE);
    barrierOpen = true;
}

void closeBarrier() {
    Serial.println("[Barrier] Cerrando...");
    barrier.write(BARRIER_CLOSED_ANGLE);
    barrierOpen = false;
}

float measureDistance() {
    digitalWrite(TRIGGER_PIN, LOW);
    delayMicroseconds(2);
    digitalWrite(TRIGGER_PIN, HIGH);
    delayMicroseconds(10);
    digitalWrite(TRIGGER_PIN, LOW);

    long duration = pulseIn(ECHO_PIN, HIGH, 30000);
    if (duration == 0) return -1;

    return duration * 0.034 / 2.0;
}

void sendHeartbeat() {
    StaticJsonDocument<64> doc;
    doc["deviceId"] = DEVICE_ID;

    String body;
    serializeJson(doc, body);

    http.beginRequest();
    http.post("/api/v1/arduino/heartbeat");
    http.sendHeader("Content-Type", "application/json");
    http.sendHeader("X-Arduino-Key", API_KEY);
    http.sendHeader("Content-Length", body.length());
    http.beginBody();
    http.print(body);
    http.endRequest();

    http.responseStatusCode();
    http.responseBody();
}

void confirmAction(String action, String plate) {
    StaticJsonDocument<256> doc;
    doc["deviceId"] = DEVICE_ID;
    doc["action"] = action;
    doc["vehiclePlate"] = plate;
    doc["timestamp"] = millis();

    String body;
    serializeJson(doc, body);

    http.beginRequest();
    http.post("/api/v1/arduino/action-completed");
    http.sendHeader("Content-Type", "application/json");
    http.sendHeader("X-Arduino-Key", API_KEY);
    http.sendHeader("Content-Length", body.length());
    http.beginBody();
    http.print(body);
    http.endRequest();

    http.responseStatusCode();
    http.responseBody();
}
