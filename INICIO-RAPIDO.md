# 🚀 Inicio Rápido - ParkingPro Backend

## ✅ Archivos Incluidos

```
parkingpro-backend/
├── .env.example          ✅ Variables de entorno
├── .gitignore           ✅ Archivos a ignorar
├── package.json         ✅ Dependencias
├── README.md            ✅ Documentación
├── Dockerfile           ✅ Para Docker (opcional)
├── .dockerignore        ✅ Para Docker
│
├── database/
│   ├── schema.sql       ✅ Schema de base de datos (CORREGIDO)
│   └── seed.sql         ✅ Datos de prueba
│
└── src/
    ├── server.js                      ✅ Servidor principal
    │
    ├── config/
    │   └── database.js                ✅ Conexión Supabase/PostgreSQL
    │
    ├── middleware/
    │   ├── auth.js                    ✅ Autenticación JWT
    │   └── errorHandler.js            ✅ Manejo de errores
    │
    ├── services/
    │   ├── hourlyRate.service.js      ✅ Sistema de tarifas por hora
    │   └── accessControl.service.js   ✅ Control de acceso dual
    │
    └── routes/
        ├── auth.routes.js             ✅ Login/Register
        ├── customer.routes.js         ✅ CRUD Clientes
        ├── vehicle.routes.js          ✅ CRUD Vehículos
        ├── plan.routes.js             ✅ Planes y tarifas
        ├── subscription.routes.js     ✅ Suscripciones
        ├── payment.routes.js          ✅ Pagos
        ├── access.routes.js           ✅ Control de acceso ⭐
        ├── report.routes.js           ✅ Reportes/Dashboard
        ├── setting.routes.js          ✅ Configuración
        └── webhook.routes.js          ✅ Webhooks (Stripe/Twilio)
```

---

## 🚂 Deploy en Railway (RECOMENDADO)

### PASO 1: Subir a GitHub

```bash
# 1. Abrir terminal en carpeta parkingpro-backend
cd parkingpro-backend

# 2. Inicializar Git
git init

# 3. Agregar archivos
git add .

# 4. Commit
git commit -m "ParkingPro Backend Completo"

# 5. Crear repo en GitHub
# Ve a: https://github.com/new
# Nombre: parkingpro-backend
# NO marques "Add README"

# 6. Conectar y subir (reemplaza TU_USUARIO)
git remote add origin https://github.com/TU_USUARIO/parkingpro-backend.git
git branch -M main
git push -u origin main
```

### PASO 2: Deploy en Railway

1. Ve a: **https://railway.app**
2. Sign up con GitHub
3. Click **"Deploy from GitHub repo"**
4. Selecciona **`parkingpro-backend`**
5. Railway detectará Node.js automáticamente
6. ⏳ Espera el build (va a fallar - normal)

### PASO 3: Configurar Variables

1. Click en tu servicio
2. Tab **"Variables"**
3. **"RAW Editor"**
4. Copia y pega (REEMPLAZA valores):

```bash
NODE_ENV=production
PORT=3000

# Supabase (de tu proyecto Supabase)
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGc...
SUPABASE_SERVICE_KEY=eyJhbGc...
DATABASE_URL=postgresql://postgres.xxxxx:[PASSWORD]@aws-0-sa-east-1.pooler.supabase.com:6543/postgres

# JWT (genera un string aleatorio de 32+ caracteres)
JWT_SECRET=tu-super-secreto-aleatorio-minimo-32-caracteres
JWT_EXPIRES_IN=7d
JWT_REFRESH_EXPIRES_IN=30d

# Stripe (por ahora provisional)
STRIPE_SECRET_KEY=sk_test_provisional
STRIPE_WEBHOOK_SECRET=whsec_provisional
STRIPE_PUBLISHABLE_KEY=pk_test_provisional

# Twilio (opcional)
TWILIO_ACCOUNT_SID=ACxxxx
TWILIO_AUTH_TOKEN=xxxx
TWILIO_PHONE_NUMBER=+18095551234
TWILIO_WHATSAPP_NUMBER=whatsapp:+18095551234

# Email (configurar después)
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=email@gmail.com
EMAIL_PASSWORD=app-password
EMAIL_FROM=ParkingPro <noreply@parkingpro.com>

# Frontend (configurar después)
FRONTEND_URL=http://localhost:8080

# Settings
TAX_RATE=0.18
PARKING_NAME=ParkingPro
TOTAL_SPACES=170
GRACE_PERIOD_HOURS=72
PAYMENT_RETRY_ATTEMPTS=3
LATE_FEE=200
TOLERANCE_MINUTES=15
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100
```

5. Click **"Add Variables"**
6. ⏳ Railway redesplegará automáticamente

### PASO 4: Generar URL

1. **Settings** → **Networking**
2. **"Generate Domain"**
3. Copiar URL: `https://parkingpro-backend-production.up.railway.app`

### PASO 5: Verificar

```bash
# Health check
curl https://TU-APP.up.railway.app/health

# Ver planes
curl https://TU-APP.up.railway.app/api/v1/plans
```

✅ Debería responder con JSON

---

## 💻 Testing Local (Opcional)

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar .env
cp .env.example .env
# Editar .env con tus credenciales

# 3. Iniciar servidor
npm run dev

# 4. Probar
curl http://localhost:3000/health
```

---

## 🐳 Deploy con Docker (Alternativa)

```bash
# Build
docker build -t parkingpro-backend .

# Run
docker run -p 3000:3000 --env-file .env parkingpro-backend

# Test
curl http://localhost:3000/health
```

---

## 📊 Endpoints Principales

```
✅ Autenticación
POST /api/v1/auth/register
POST /api/v1/auth/login
GET  /api/v1/auth/me

✅ Clientes
GET  /api/v1/customers
POST /api/v1/customers

✅ Vehículos
GET  /api/v1/vehicles
POST /api/v1/vehicles

✅ Planes
GET  /api/v1/plans
GET  /api/v1/plans/hourly/rates/:planId
PUT  /api/v1/plans/hourly/rates/:planId

✅ Control de Acceso ⭐
POST /api/v1/access/validate
POST /api/v1/access/entry
POST /api/v1/access/exit
GET  /api/v1/access/sessions/active

✅ Reportes
GET  /api/v1/reports/dashboard

✅ Configuración
GET  /api/v1/settings
```

---

## 🎯 Características Implementadas

✅ **Sistema Dual de Acceso**
- Suscripciones (Diurno/Nocturno/24h)
- Parqueo por hora (50/70/100)

✅ **Autenticación JWT**
- Login/Register
- Roles (customer, operator, admin)

✅ **Base de Datos**
- 18 tablas
- Triggers automáticos
- Vistas optimizadas

✅ **API REST Completa**
- 35+ endpoints
- Validación de datos
- Manejo de errores

✅ **Seguridad**
- CORS configurado
- Rate limiting
- Helmet
- JWT tokens

---

## 🚨 Troubleshooting

### Error: Cannot connect to database
```
Verifica DATABASE_URL en variables
Debe tener la contraseña correcta
Puerto debe ser 6543
```

### Error: Module not found
```
Verifica que ejecutaste: npm install
Railway: Settings → Build Command → npm install
```

### Error: 500 en /health
```
Railway → View Logs
Busca el error específico
Usualmente es DATABASE_URL incorrecto
```

---

## ✅ Checklist de Verificación

- [ ] Código en GitHub
- [ ] Railway conectado
- [ ] Variables configuradas
- [ ] Domain generado
- [ ] `/health` responde
- [ ] `/api/v1/plans` devuelve 4 planes
- [ ] Logs sin errores

---

## 📞 Siguiente Paso

Una vez que todo funcione:

1. ✅ Backend LIVE
2. ➡️ Deploy Frontend PWA (Netlify - 5 min)
3. ➡️ Configurar Stripe
4. ➡️ Testing completo

---

**¿Backend funcionando?** → Continúa con frontend en **DEPLOYMENT-CHECKLIST.md** Fase 3

**¿Problemas?** → Revisa logs en Railway o pregunta!
