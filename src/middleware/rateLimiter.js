const rateLimit = require('express-rate-limit');

// General API rate limiter
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200, // 200 requests per window
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiadas solicitudes. Intenta de nuevo en unos minutos.' }
});

// Strict limiter for auth endpoints (login, register)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // 10 attempts per window
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiados intentos de autenticación. Intenta en 15 minutos.' }
});

// Device push endpoint limiter (higher limit for IoT devices)
const deviceLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 120, // 2 req/sec average for device heartbeats
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Rate limit exceeded for device endpoint' }
});

// Payment endpoint limiter (prevent payment spam)
const paymentLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiadas solicitudes de pago. Intenta de nuevo.' }
});

module.exports = { apiLimiter, authLimiter, deviceLimiter, paymentLimiter };
