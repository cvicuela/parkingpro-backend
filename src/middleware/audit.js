const { query } = require('../config/database');

/**
 * Registra una acción en audit_logs.
 * Llamar directamente desde rutas/servicios cuando se necesita control explícito.
 */
async function logAudit({ userId, action, entityType, entityId, changes, req }) {
    try {
        const ipAddress = req
            ? (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null)
            : null;
        const userAgent = req ? (req.headers['user-agent'] || null) : null;

        await query(
            `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, changes, ip_address, user_agent)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                userId || null,
                action,
                entityType || null,
                entityId || null,
                changes ? JSON.stringify(changes) : null,
                ipAddress,
                userAgent
            ]
        );
    } catch (err) {
        // El audit nunca debe romper el flujo principal
        console.error('[Audit] Error registrando acción:', err.message);
    }
}

/**
 * Middleware Express que registra automáticamente mutaciones (POST, PATCH, PUT, DELETE).
 * Se puede montar por ruta o globalmente.
 */
function auditMiddleware(entityType) {
    return (req, res, next) => {
        if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
            return next();
        }

        const originalJson = res.json.bind(res);

        res.json = function (body) {
            // Solo auditar respuestas exitosas
            if (res.statusCode >= 200 && res.statusCode < 300 && req.user) {
                const entityId = body?.data?.id || req.params?.id || null;
                const action = `${req.method.toLowerCase()}_${entityType}`;

                logAudit({
                    userId: req.user.id,
                    action,
                    entityType,
                    entityId,
                    changes: {
                        method: req.method,
                        path: req.path,
                        body: req.body,
                        result: body?.data || null
                    },
                    req
                });
            }
            return originalJson(body);
        };

        next();
    };
}

module.exports = { logAudit, auditMiddleware };
