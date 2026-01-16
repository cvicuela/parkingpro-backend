# 🅿️ ParkingPro Backend API

Backend completo para sistema de gestión de parqueos con suscripciones y parqueo por hora.

## 📋 Características

✅ **Gestión de Clientes** - CRUD completo de clientes y vehículos
✅ **Planes Configurables** - Diurno, Nocturno, 24 Horas, Por Hora
✅ **Suscripciones** - Pagos recurrentes con Stripe
✅ **Control de Acceso** - Validación automática entrada/salida
✅ **Parqueo por Hora** - Sistema configurable (1ra hora: $50, 2da: $70, 3ra+: $100)
✅ **Pagos Automáticos** - Reintentos, grace period, suspensión
✅ **Reportes** - Dashboard, KPIs, análisis de ocupación
✅ **Notificaciones** - WhatsApp, Email, SMS
✅ **Audit Logs** - Trazabilidad completa
✅ **Multi-tenant Ready** - Preparado para múltiples parqueos

---

## 🚀 Instalación Rápida

### 1. Pre-requisitos

```bash
# Node.js 18+ y npm
node --version  # Debe ser >= 18
npm --version

# PostgreSQL (o cuenta Supabase)
# Stripe account (para pagos)
# Twilio account (para WhatsApp/SMS - opcional)
```

### 2. Clonar e Instalar

```bash
# Crear proyecto
mkdir parkingpro-backend
cd parkingpro-backend

# Copiar archivos del proyecto aquí

# Instalar dependencias
npm install
```

### 3. Configurar Variables de Entorno

```bash
# Copiar ejemplo
cp .env.example .env

# Editar .env con tus credenciales
nano .env
```

**Variables críticas a configurar:**

```bash
# Database (Supabase o PostgreSQL local)
SUPABASE_URL=https://tu-proyecto.supabase.co
SUPABASE_SERVICE_KEY=tu-service-key
DATABASE_URL=postgresql://postgres:password@db.tu-proyecto.supabase.co:5432/postgres

# JWT
JWT_SECRET=genera-un-secret-super-seguro-aqui

# Stripe
STRIPE_SECRET_KEY=sk_test_tu_key_aqui
STRIPE_WEBHOOK_SECRET=whsec_tu_webhook_secret

# Twilio (opcional)
TWILIO_ACCOUNT_SID=tu_sid
TWILIO_AUTH_TOKEN=tu_token
```

### 4. Crear Base de Datos

#### Opción A: Supabase (Recomendado - Gratis)

1. Ve a [supabase.com](https://supabase.com)
2. Crea un nuevo proyecto
3. Ve a SQL Editor
4. Copia y ejecuta `database/schema.sql`
5. Copia y ejecuta `database/seed.sql`

#### Opción B: PostgreSQL Local

```bash
# Crear database
createdb parkingpro

# Ejecutar schema
psql parkingpro < database/schema.sql

# Ejecutar seed data
psql parkingpro < database/seed.sql
```

### 5. Iniciar Servidor

```bash
# Desarrollo (con auto-reload)
npm run dev

# Producción
npm start
```

El servidor iniciará en `http://localhost:3000`

---

## 📚 API Endpoints

### Autenticación

```
POST   /api/v1/auth/register          - Registrar nuevo usuario
POST   /api/v1/auth/send-otp          - Enviar código OTP
POST   /api/v1/auth/verify-otp        - Verificar código OTP
POST   /api/v1/auth/login             - Login
POST   /api/v1/auth/refresh-token     - Renovar token
POST   /api/v1/auth/logout            - Cerrar sesión
GET    /api/v1/auth/me                - Obtener usuario actual
```

### Clientes

```
POST   /api/v1/customers              - Crear cliente
GET    /api/v1/customers              - Listar clientes
GET    /api/v1/customers/:id          - Obtener cliente
PATCH  /api/v1/customers/:id          - Actualizar cliente
DELETE /api/v1/customers/:id          - Eliminar cliente
```

### Vehículos

```
POST   /api/v1/vehicles               - Registrar vehículo
GET    /api/v1/vehicles               - Listar vehículos
GET    /api/v1/vehicles/:id           - Obtener vehículo
GET    /api/v1/vehicles/plate/:plate  - Buscar por placa
PATCH  /api/v1/vehicles/:id           - Actualizar vehículo
DELETE /api/v1/vehicles/:id           - Eliminar vehículo
```

### Planes

```
GET    /api/v1/plans                  - Listar planes activos
GET    /api/v1/plans/:id              - Obtener plan
POST   /api/v1/plans                  - Crear plan (Admin)
PATCH  /api/v1/plans/:id              - Actualizar plan (Admin)
DELETE /api/v1/plans/:id              - Desactivar plan (Admin)
GET    /api/v1/plans/:id/occupancy    - Ver ocupación

# Tarifas por hora
GET    /api/v1/plans/hourly/rates/:planId           - Ver tarifas
PUT    /api/v1/plans/hourly/rates/:planId           - Actualizar tarifas (Admin)
POST   /api/v1/plans/hourly/calculate               - Calcular costo (simulación)
```

### Suscripciones

```
POST   /api/v1/subscriptions          - Crear suscripción
GET    /api/v1/subscriptions          - Listar suscripciones
GET    /api/v1/subscriptions/:id      - Obtener suscripción
PATCH  /api/v1/subscriptions/:id      - Actualizar suscripción
DELETE /api/v1/subscriptions/:id      - Cancelar suscripción
POST   /api/v1/subscriptions/:id/suspend    - Suspender (Admin)
POST   /api/v1/subscriptions/:id/reactivate - Reactivar
GET    /api/v1/subscriptions/:id/qr   - Obtener QR
```

### Control de Acceso ⭐

```
POST   /api/v1/access/validate        - Validar entrada/salida
POST   /api/v1/access/entry           - Registrar entrada
POST   /api/v1/access/exit            - Registrar salida
GET    /api/v1/access/history         - Historial de accesos

# Sesiones de parqueo por hora
GET    /api/v1/access/sessions/active        - Ver sesiones activas
GET    /api/v1/access/sessions/:plate        - Buscar por placa
POST   /api/v1/access/sessions/:id/end       - Finalizar sesión
POST   /api/v1/access/sessions/:id/payment   - Registrar pago
```

### Pagos

```
POST   /api/v1/payments               - Crear pago
GET    /api/v1/payments               - Listar pagos
GET    /api/v1/payments/:id           - Obtener pago
POST   /api/v1/payments/:id/refund    - Reembolsar (Admin)
```

### Reportes

```
GET    /api/v1/reports/dashboard      - Dashboard con KPIs
GET    /api/v1/reports/financial      - Reporte financiero
GET    /api/v1/reports/occupancy      - Reporte de ocupación
GET    /api/v1/reports/customers      - Reporte de clientes
GET    /api/v1/reports/overdue        - Clientes morosos
```

### Configuración

```
GET    /api/v1/settings               - Ver configuración
GET    /api/v1/settings/:key          - Ver configuración específica
PATCH  /api/v1/settings/:key          - Actualizar configuración (Admin)
```

### Webhooks

```
POST   /api/v1/webhooks/stripe        - Webhook de Stripe
POST   /api/v1/webhooks/cardnet       - Webhook de CardNet
```

---

## 🎯 Ejemplos de Uso

### 1. Validar Entrada de Vehículo

```bash
curl -X POST http://localhost:3000/api/v1/access/validate \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "vehiclePlate": "A123456",
    "type": "entry"
  }'
```

**Respuesta - Suscripción Activa:**

```json
{
  "success": true,
  "data": {
    "allowed": true,
    "accessType": "subscription",
    "subscription": {
      "id": "uuid-here",
      "customer_name": "Carlos Fernández",
      "plan_name": "24 Horas",
      "vehicle_plate": "A123456",
      "valid_until": "2024-02-15"
    },
    "message": "✅ ACCESO PERMITIDO",
    "nextStep": "register_entry_event"
  }
}
```

**Respuesta - Sin Suscripción (Parqueo por Hora):**

```json
{
  "success": true,
  "data": {
    "allowed": true,
    "accessType": "hourly",
    "plan": {
      "id": "uuid-here",
      "name": "Por Hora",
      "type": "hourly"
    },
    "message": "Acceso permitido - Parqueo por hora",
    "rates": [
      { "hour_number": 1, "rate": 50, "description": "Primera hora" },
      { "hour_number": 2, "rate": 70, "description": "Segunda hora" },
      { "hour_number": 3, "rate": 100, "description": "Tercera hora en adelante" }
    ],
    "nextStep": "start_parking_session"
  }
}
```

### 2. Validar Salida y Calcular Pago

```bash
curl -X POST http://localhost:3000/api/v1/access/validate \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "vehiclePlate": "X999888",
    "type": "exit"
  }'
```

**Respuesta:**

```json
{
  "success": true,
  "data": {
    "allowed": true,
    "accessType": "hourly",
    "session": {
      "id": "uuid-here",
      "vehicle_plate": "X999888",
      "entry_time": "2024-01-15T10:00:00Z",
      "exit_time": "2024-01-15T13:30:00Z",
      "duration_minutes": 210
    },
    "payment": {
      "amount": 220,
      "breakdown": [
        { "hour": 1, "rate": 50, "description": "Primera hora" },
        { "hour": 2, "rate": 70, "description": "Segunda hora" },
        { "hour": 3, "rate": 100, "description": "Tercera hora en adelante" },
        { "hour": 4, "rate": 100, "description": "Tercera hora en adelante" }
      ],
      "is_free": false
    },
    "message": "💰 Total a pagar: RD$ 220.00",
    "nextStep": "process_payment"
  }
}
```

### 3. Configurar Tarifas por Hora

```bash
curl -X PUT http://localhost:3000/api/v1/plans/hourly/rates/PLAN_ID \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "rates": [
      { "hour_number": 1, "rate": 50, "description": "Primera hora" },
      { "hour_number": 2, "rate": 70, "description": "Segunda hora" },
      { "hour_number": 3, "rate": 100, "description": "Tercera hora y siguientes" }
    ]
  }'
```

### 4. Ver Sesiones Activas

```bash
curl http://localhost:3000/api/v1/access/sessions/active \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Respuesta:**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid-1",
      "vehicle_plate": "X999888",
      "plan_name": "Por Hora",
      "entry_time": "2024-01-15T10:00:00Z",
      "minutes_elapsed": 90,
      "current_amount": 120,
      "current_breakdown": [
        { "hour": 1, "rate": 50 },
        { "hour": 2, "rate": 70 }
      ]
    },
    {
      "id": "uuid-2",
      "vehicle_plate": "Y777666",
      "entry_time": "2024-01-15T11:30:00Z",
      "minutes_elapsed": 30,
      "current_amount": 50
    }
  ],
  "count": 2
}
```

---

## 🔐 Autenticación

Todos los endpoints (excepto públicos) requieren autenticación JWT.

```bash
# Header requerido
Authorization: Bearer YOUR_JWT_TOKEN
```

### Obtener Token

```bash
# 1. Registrar
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "phone": "+18095551234",
    "password": "SecurePass123"
  }'

# 2. Login
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "SecurePass123"
  }'

# Respuesta
{
  "success": true,
  "data": {
    "user": { ... },
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "..."
  }
}
```

---

## 🎛️ Configuración de Planes

### Plan Por Hora - Configuración Completa

```javascript
// Crear plan por hora
const hourlyPlan = {
  name: "Por Hora",
  type: "hourly",
  description: "Pago por hora de uso",
  basePrice: 50,
  maxCapacity: 40,
  toleranceMinutes: 5,
  hourlyRates: [
    {
      hour_number: 1,
      rate: 50,
      description: "Primera hora"
    },
    {
      hour_number: 2,
      rate: 70,
      description: "Segunda hora"
    },
    {
      hour_number: 3,
      rate: 100,
      description: "Tercera hora en adelante"
    }
  ]
};
```

**Lógica de Cálculo:**

- **0-5 minutos**: Gratis (tolerancia)
- **6-60 minutos**: RD$ 50
- **61-120 minutos**: RD$ 50 + RD$ 70 = RD$ 120
- **121-180 minutos**: RD$ 50 + RD$ 70 + RD$ 100 = RD$ 220
- **181-240 minutos**: RD$ 50 + RD$ 70 + RD$ 100 + RD$ 100 = RD$ 320
- Y así sucesivamente...

---

## 📊 Base de Datos

### Tablas Principales

```
users               - Usuarios del sistema
customers           - Clientes
vehicles            - Vehículos
plans               - Planes de parqueo
hourly_rates        - Tarifas por hora (configurable)
subscriptions       - Suscripciones activas
parking_sessions    - Sesiones de parqueo por hora
payments            - Pagos realizados
invoices            - Facturas generadas
access_events       - Historial de entradas/salidas
settings            - Configuración del sistema
audit_logs          - Logs de auditoría
```

### Vistas

```
active_subscriptions_detail  - Suscripciones activas con detalles
overdue_subscriptions        - Clientes morosos
current_occupancy_by_plan    - Ocupación actual
active_parking_sessions      - Sesiones activas de parqueo por hora
```

---

## 🧪 Testing

```bash
# Ejecutar tests
npm test

# Test con coverage
npm run test:coverage
```

---

## 🚀 Deployment

### Opción 1: Railway (Recomendado)

```bash
# 1. Instalar Railway CLI
npm i -g @railway/cli

# 2. Login
railway login

# 3. Iniciar proyecto
railway init

# 4. Link a base de datos
railway link

# 5. Añadir variables de entorno
railway variables set NODE_ENV=production
railway variables set JWT_SECRET=your-secret

# 6. Deploy
railway up
```

### Opción 2: Render

1. Conecta tu repo de GitHub
2. Crea nuevo "Web Service"
3. Configura variables de entorno
4. Deploy automático

### Opción 3: Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

```bash
docker build -t parkingpro-api .
docker run -p 3000:3000 parkingpro-api
```

---

## 📝 Notas Importantes

### Configuración de Tarifas

Las tarifas por hora son 100% configurables desde la API. Puedes cambiarlas en cualquier momento sin tocar código:

```bash
PUT /api/v1/plans/hourly/rates/:planId
```

### Tolerancia

El sistema incluye tolerancia configurable (default: 5 minutos). Si un vehículo sale dentro de la tolerancia, NO se cobra.

### Redondeo

El sistema redondea hacia arriba. Ejemplo:
- 61 minutos = 2 horas
- 121 minutos = 3 horas

### Múltiples Planes

Un vehículo puede tener:
- 1 suscripción activa (Diurno/Nocturno/24h)
- O usar parqueo por hora (sin suscripción)

No pueden estar en ambos simultáneamente.

---

## 🆘 Solución de Problemas

### Error: "Cannot connect to database"

```bash
# Verificar conexión
psql $DATABASE_URL -c "SELECT NOW()"

# Ver logs
npm run dev
```

### Error: "JWT malformed"

- Verifica que JWT_SECRET esté configurado
- Token debe estar en formato: `Bearer token_aqui`

### Tarifas no se aplican

- Verifica que las tarifas estén activas: `is_active = true`
- El plan debe ser tipo `hourly`

---

## 📞 Soporte

- Documentación: Ver `/docs` (próximamente)
- Issues: GitHub Issues
- Email: support@parkingpro.com

---

## 📄 Licencia

MIT License - Ver `LICENSE` file

---

**Hecho con ❤️ para ParkingPro**
