const jwt = require('jsonwebtoken');
const { query } = require('../config/database');

/**
 * Middleware de autenticación
 * Verifica JWT y carga información del usuario
 */
async function authenticate(req, res, next) {
    try {
        // Obtener token del header
        const authHeader = req.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                error: 'No se proporcionó token de autenticación'
            });
        }
        
        const token = authHeader.substring(7); // Remover 'Bearer '
        
        // Verificar token
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch (error) {
            if (error.name === 'TokenExpiredError') {
                return res.status(401).json({
                    error: 'Token expirado',
                    code: 'TOKEN_EXPIRED'
                });
            }
            return res.status(401).json({
                error: 'Token inválido'
            });
        }
        
        // Verificar sesión activa
        const sessionResult = await query(
            `SELECT * FROM sessions 
             WHERE token = $1 
               AND user_id = $2 
               AND expires_at > NOW()`,
            [token, decoded.userId]
        );
        
        if (sessionResult.rows.length === 0) {
            return res.status(401).json({
                error: 'Sesión inválida o expirada'
            });
        }
        
        // Cargar usuario
        const userResult = await query(
            `SELECT id, email, phone, role, verified, status 
             FROM users 
             WHERE id = $1`,
            [decoded.userId]
        );
        
        if (userResult.rows.length === 0) {
            return res.status(401).json({
                error: 'Usuario no encontrado'
            });
        }
        
        const user = userResult.rows[0];
        
        // Verificar estado del usuario
        if (user.status !== 'active') {
            return res.status(403).json({
                error: 'Usuario inactivo o suspendido'
            });
        }
        
        // Actualizar última actividad de la sesión
        await query(
            `UPDATE sessions 
             SET last_activity_at = NOW() 
             WHERE id = $1`,
            [sessionResult.rows[0].id]
        );
        
        // Adjuntar usuario a request
        req.user = {
            id: user.id,
            email: user.email,
            phone: user.phone,
            role: user.role,
            verified: user.verified
        };
        
        // Adjuntar token a request
        req.token = token;
        
        next();
        
    } catch (error) {
        console.error('Error en autenticación:', error);
        res.status(500).json({
            error: 'Error en autenticación'
        });
    }
}

/**
 * Middleware de autorización por roles
 * Verifica que el usuario tenga uno de los roles permitidos
 */
function authorize(allowedRoles = []) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                error: 'No autenticado'
            });
        }
        
        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({
                error: 'No tienes permisos para esta acción',
                requiredRoles: allowedRoles,
                yourRole: req.user.role
            });
        }
        
        next();
    };
}

/**
 * Middleware opcional de autenticación
 * Carga el usuario si hay token, pero no falla si no lo hay
 */
async function optionalAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return next();
    }
    
    try {
        const token = authHeader.substring(7);
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        const userResult = await query(
            `SELECT id, email, phone, role, verified 
             FROM users 
             WHERE id = $1 AND status = 'active'`,
            [decoded.userId]
        );
        
        if (userResult.rows.length > 0) {
            req.user = userResult.rows[0];
        }
    } catch (error) {
        // Silenciosamente continuar si hay error
    }
    
    next();
}

/**
 * Middleware para verificar que el usuario esté verificado
 */
function requireVerified(req, res, next) {
    if (!req.user) {
        return res.status(401).json({
            error: 'No autenticado'
        });
    }
    
    if (!req.user.verified) {
        return res.status(403).json({
            error: 'Debes verificar tu cuenta antes de continuar',
            code: 'NOT_VERIFIED'
        });
    }
    
    next();
}

/**
 * Middleware para verificar que el usuario sea el dueño del recurso
 * o sea admin
 */
function requireOwnershipOrAdmin(resourceUserIdGetter) {
    return async (req, res, next) => {
        try {
            const resourceUserId = await resourceUserIdGetter(req);
            
            if (req.user.id === resourceUserId || 
                ['admin', 'super_admin'].includes(req.user.role)) {
                return next();
            }
            
            return res.status(403).json({
                error: 'No tienes permiso para acceder a este recurso'
            });
        } catch (error) {
            next(error);
        }
    };
}

module.exports = {
    authenticate,
    authorize,
    optionalAuth,
    requireVerified,
    requireOwnershipOrAdmin
};
