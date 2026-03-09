const jwt = require('jsonwebtoken');
const { query } = require('../config/database');

async function authenticate(req, res, next) {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({ error: 'Token no proporcionado' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // Validate session is still active
        const sessionResult = await query(
            'SELECT 1 FROM sessions WHERE token = $1 AND expires_at > NOW()',
            [token]
        );

        if (sessionResult.rows.length === 0) {
            return res.status(401).json({ error: 'Sesión expirada o inválida' });
        }

        const result = await query(
            'SELECT * FROM users WHERE id = $1 AND status = $2',
            [decoded.userId, 'active']
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Usuario no encontrado' });
        }

        req.user = result.rows[0];
        req.token = token;
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Token inválido' });
    }
}

function authorize(roles) {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Acceso denegado' });
        }
        next();
    };
}

module.exports = {
    authenticate,
    authorize
};
