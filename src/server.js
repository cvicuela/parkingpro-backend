require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

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

// Middleware de error
const errorHandler = require('./middleware/errorHandler');

// Inicializar app
const app = express();
const PORT = process.env.PORT || 3000;

// ==================== MIDDLEWARE GLOBAL ====================

// Seguridad
app.use(helmet());

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

// Rate limiting general
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000, // 1 minuto
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
    message: {
        error: 'Demasiadas solicitudes, por favor intenta de nuevo más tarde'
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
        error: 'Demasiados intentos de autenticación, intenta en 15 minutos'
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

app.get('/', (req, res) => {
    res.json({
        message: 'ParkingPro API v1.0',
        docs: '/api/v1/docs',
        health: '/health'
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

// ==================== 404 HANDLER ====================

app.use('*', (req, res) => {
    res.status(404).json({
        error: 'Ruta no encontrada',
        path: req.originalUrl
    });
});

// ==================== ERROR HANDLER ====================

app.use(errorHandler);

// ==================== INICIAR SERVIDOR ====================

const server = app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════╗
║                                                   ║
║     🅿️  PARKINGPRO API SERVER                    ║
║                                                   ║
║     Environment: ${process.env.NODE_ENV?.padEnd(26) || 'development'.padEnd(26)}║
║     Port:        ${PORT.toString().padEnd(26)}             ║
║     URL:         http://localhost:${PORT.toString().padEnd(14)}     ║
║                                                   ║
║     Status:      ✅ Running                      ║
║     Time:        ${new Date().toLocaleString('es-DO').padEnd(26)}║
║                                                   ║
╚═══════════════════════════════════════════════════╝
    `);
    
    console.log('\n📚 Available endpoints:');
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
    console.log('\n🛑 Cerrando servidor...');
    
    server.close(() => {
        console.log('✅ Servidor cerrado correctamente');
        process.exit(0);
    });
    
    // Forzar cierre después de 10 segundos
    setTimeout(() => {
        console.error('⚠️ Cierre forzado del servidor');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// ==================== MANEJO DE ERRORES NO CAPTURADOS ====================

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection:', reason);
    console.error('Promise:', promise);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    gracefulShutdown();
});

module.exports = app;
