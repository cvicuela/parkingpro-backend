require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

// Importar rutas (synced with src/server.js)
const authRoutes = require('../src/routes/auth.routes');
const customerRoutes = require('../src/routes/customer.routes');
const vehicleRoutes = require('../src/routes/vehicle.routes');
const planRoutes = require('../src/routes/plan.routes');
const subscriptionRoutes = require('../src/routes/subscription.routes');
const paymentRoutes = require('../src/routes/payment.routes');
const accessRoutes = require('../src/routes/access.routes');
const reportRoutes = require('../src/routes/report.routes');
const settingRoutes = require('../src/routes/setting.routes');
const cashRegisterRoutes = require('../src/routes/cashRegister.routes');
const invoiceRoutes = require('../src/routes/invoice.routes');
const auditRoutes = require('../src/routes/audit.routes');
const notificationRoutes = require('../src/routes/notification.routes');
const rfidRoutes = require('../src/routes/rfid.routes');
const userRoutes = require('../src/routes/user.routes');
const expenseRoutes = require('../src/routes/expense.routes');
const incidentRoutes = require('../src/routes/incident.routes');
const terminalRoutes = require('../src/routes/terminal.routes');
const dgiiRoutes = require('../src/routes/dgii.routes');
const setupRoutes = require('../src/routes/setup.routes');
const rpcRoutes = require('../src/routes/rpc.routes');

// Middleware
const errorHandler = require('../src/middleware/errorHandler');
const sanitizer = require('../src/middleware/sanitizer');

const app = express();

// Seguridad
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// CORS
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));

app.use(compression());

// Body parser
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Input sanitization
app.use(sanitizer);

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: { error: 'Demasiadas solicitudes, intenta de nuevo mas tarde' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/', limiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  message: { error: 'Demasiados intentos, intenta en 15 minutos' }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'ParkingPro API' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Rutas API (synced with src/server.js)
app.use('/api/v1/auth', authLimiter, authRoutes);
app.use('/api/v1/customers', customerRoutes);
app.use('/api/v1/vehicles', vehicleRoutes);
app.use('/api/v1/plans', planRoutes);
app.use('/api/v1/subscriptions', subscriptionRoutes);
app.use('/api/v1/payments', paymentRoutes);
app.use('/api/v1/access', accessRoutes);
app.use('/api/v1/reports', reportRoutes);
app.use('/api/v1/settings', settingRoutes);
app.use('/api/v1/cash-registers', cashRegisterRoutes);
app.use('/api/v1/invoices', invoiceRoutes);
app.use('/api/v1/audit', auditRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/rfid', rfidRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/expenses', expenseRoutes);
app.use('/api/v1/incidents', incidentRoutes);
app.use('/api/v1/terminals', terminalRoutes);
app.use('/api/v1/dgii', dgiiRoutes);
app.use('/api/v1/setup', setupRoutes);
app.use('/api/v1/rpc', rpcRoutes);

// Error handler
app.use(errorHandler);

module.exports = app;
