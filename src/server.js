require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// Importar rutas
const authRoutes = require('./routes/auth.routes');
const customerRoutes = require('./routes/customer.routes');
const vehicleRoutes = require('./routes/vehicle.routes');
const planRoutes = require('./routes/plan.routes');
const subscriptionRoutes = require('./routes/subscription.routes');
const paymentRoutes = require('./routes/payment.routes');
const accessRoutes = require('./routes/access.routes');
const reportRoutes = require('./routes/report.routes');
const settingRoutes = require('./routes/setting.routes');
const webhookRoutes = require('./routes/webhook.routes');
const arduinoRoutes = require('./routes/arduino.routes');
const cashRegisterRoutes = require('./routes/cashRegister.routes');
const invoiceRoutes = require('./routes/invoice.routes');
const auditRoutes = require('./routes/audit.routes');
const rfidRoutes = require('./routes/rfid.routes');
const userRoutes = require('./routes/user.routes');
const zktecoRoutes = require('./routes/zkteco.routes');
const expenseRoutes = require('./routes/expense.routes');
const incidentRoutes = require('./routes/incident.routes');
const notificationRoutes = require('./routes/notification.routes');

// Middleware de error
const errorHandler = require('./middleware/errorHandler');

// Inicializar app
const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// ==================== SOCKET.IO ====================

const io = new Server(server, {
    cors: {
        origin: process.env.FRONTEND_URL || '*',
        methods: ['GET', 'POST'],
        credentials: true
    }
});

// Hacer io accesible desde las rutas
app.set('io', io);

io.on('connection', (socket) => {
    console.log(`[Socket.IO] Client connected: ${socket.id}`);

    socket.on('join_dashboard', () => {
        socket.join('dashboard');
    });

    socket.on('disconnect', () => {
        console.log(`[Socket.IO] Client disconnected: ${socket.id}`);
    });
});

// ==================== MIDDLEWARE GLOBAL ====================

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

// Comprimir respuestas
app.use(compression());

// Logging
if (process.env.NODE_ENV === 'development') {
    app.use(morgan('dev'));
} else {
    app.use(morgan('combined'));
}

// Body parser (IMPORTANTE: antes de webhooks)
// Webhooks de Stripe necesitan raw body
app.use('/api/v1/webhooks', express.raw({ type: 'application/json' }));

// JSON parser para el resto de rutas
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Servir frontend estático (build de React)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Rate limiting general
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000, // 1 minuto
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
    message: {
        error: 'Demasiadas solicitudes, por favor intenta de nuevo mas tarde'
    },
    standardHeaders: true,
    legacyHeaders: false
});

app.use('/api/', limiter);

// Rate limiting estricto para auth
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 5,
    skipSuccessfulRequests: true,
    message: {
        error: 'Demasiados intentos de autenticacion, intenta en 15 minutos'
    }
});

// ==================== HEALTH CHECK ====================

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV
    });
});

// ==================== RUTAS API ====================

app.use('/api/v1/auth', authLimiter, authRoutes);
app.use('/api/v1/customers', customerRoutes);
app.use('/api/v1/vehicles', vehicleRoutes);
app.use('/api/v1/plans', planRoutes);
app.use('/api/v1/subscriptions', subscriptionRoutes);
app.use('/api/v1/payments', paymentRoutes);
app.use('/api/v1/access', accessRoutes);
app.use('/api/v1/reports', reportRoutes);
app.use('/api/v1/settings', settingRoutes);
app.use('/api/v1/webhooks', webhookRoutes);
app.use('/api/v1/arduino', arduinoRoutes);
app.use('/api/v1/cash-registers', cashRegisterRoutes);
app.use('/api/v1/invoices', invoiceRoutes);
app.use('/api/v1/audit', auditRoutes);
app.use('/api/v1/rfid', rfidRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/zkteco', zktecoRoutes);
app.use('/api/v1/expenses', expenseRoutes);
app.use('/api/v1/incidents', incidentRoutes);
app.use('/api/v1/notifications', notificationRoutes);

// ==================== SPA FALLBACK ====================

app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
        return next();
    }
    const indexPath = path.join(__dirname, '..', 'public', 'index.html');
    res.sendFile(indexPath, (err) => {
        if (err) {
            res.status(404).json({
                error: 'Ruta no encontrada',
                path: req.originalUrl
            });
        }
    });
});

// ==================== ERROR HANDLER ====================

app.use(errorHandler);

// ==================== INICIAR SERVIDOR ====================

server.listen(PORT, () => {
    console.log(`
=============================================
  ParkingPro API Server
  Environment: ${process.env.NODE_ENV || 'development'}
  Port:        ${PORT}
  URL:         http://localhost:${PORT}
  Socket.IO:   Enabled
  Status:      Running
  Time:        ${new Date().toLocaleString('es-DO')}
=============================================
    `);

    console.log('\nAvailable endpoints:');
    console.log('   GET  /health');
    console.log('   POST /api/v1/auth/register');
    console.log('   POST /api/v1/auth/login');
    console.log('   GET  /api/v1/plans');
    console.log('   POST /api/v1/subscriptions');
    console.log('   POST /api/v1/access/validate');
    console.log('   GET  /api/v1/reports/dashboard\n');
});

// ==================== GRACEFUL SHUTDOWN ====================

const gracefulShutdown = () => {
    console.log('\nCerrando servidor...');

    io.close();
    server.close(() => {
        console.log('Servidor cerrado correctamente');
        process.exit(0);
    });

    // Forzar cierre despues de 10 segundos
    setTimeout(() => {
        console.error('Cierre forzado del servidor');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// ==================== MANEJO DE ERRORES NO CAPTURADOS ====================

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    gracefulShutdown();
});

module.exports = app;
module.exports.app = app;
module.exports.server = server;
module.exports.io = io;
