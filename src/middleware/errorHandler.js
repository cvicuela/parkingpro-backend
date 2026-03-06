/**
 * Middleware centralizado de manejo de errores
 */

class AppError extends Error {
    constructor(message, statusCode = 500, code = null) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.isOperational = true;
        
        Error.captureStackTrace(this, this.constructor);
    }
}

function errorHandler(err, req, res, next) {
    let error = { ...err };
    error.message = err.message;
    error.stack = err.stack;
    
    // Log del error
    if (process.env.NODE_ENV === 'development') {
        console.error('❌ Error:', {
            message: error.message,
            stack: error.stack,
            url: req.originalUrl,
            method: req.method,
            body: req.body
        });
    } else {
        console.error('❌ Error:', error.message);
    }
    
    // PostgreSQL errores
    if (err.code === '23505') {
        // Violación de unique constraint
        const field = err.detail?.match(/Key \((.*?)\)/)?.[1] || 'campo';
        error = new AppError(
            `Ya existe un registro con ese ${field}`,
            409,
            'DUPLICATE_ENTRY'
        );
    }
    
    if (err.code === '23503') {
        // Violación de foreign key
        error = new AppError(
            'El registro referenciado no existe',
            400,
            'INVALID_REFERENCE'
        );
    }
    
    if (err.code === '23502') {
        // Violación de not null
        const column = err.column || 'campo requerido';
        error = new AppError(
            `${column} es requerido`,
            400,
            'MISSING_REQUIRED_FIELD'
        );
    }
    
    if (err.code === '22P02') {
        // Invalid input syntax
        error = new AppError(
            'Formato de datos inválido',
            400,
            'INVALID_FORMAT'
        );
    }
    
    // JWT errores
    if (err.name === 'JsonWebTokenError') {
        error = new AppError(
            'Token inválido',
            401,
            'INVALID_TOKEN'
        );
    }
    
    if (err.name === 'TokenExpiredError') {
        error = new AppError(
            'Token expirado',
            401,
            'TOKEN_EXPIRED'
        );
    }
    
    // Validation errores (de express-validator)
    if (err.array && typeof err.array === 'function') {
        const errors = err.array();
        const messages = errors.map(e => e.msg).join(', ');
        error = new AppError(
            messages,
            400,
            'VALIDATION_ERROR'
        );
    }
    
    // Stripe errores
    if (err.type && err.type.startsWith('Stripe')) {
        error = new AppError(
            'Error en procesamiento de pago: ' + err.message,
            400,
            'PAYMENT_ERROR'
        );
    }
    
    // Respuesta de error
    const statusCode = error.statusCode || 500;
    const response = {
        error: error.message || 'Error interno del servidor',
        code: error.code || 'INTERNAL_ERROR'
    };
    
    // En desarrollo, incluir stack trace
    if (process.env.NODE_ENV === 'development') {
        response.stack = error.stack;
        response.details = error;
    }
    
    res.status(statusCode).json(response);
}

// Middleware para rutas no encontradas
function notFound(req, res, next) {
    const error = new AppError(
        `Ruta no encontrada: ${req.originalUrl}`,
        404,
        'NOT_FOUND'
    );
    next(error);
}

// Wrapper para async route handlers
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

module.exports = errorHandler;
module.exports.AppError = AppError;
module.exports.notFound = notFound;
module.exports.asyncHandler = asyncHandler;
