const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');

/**
 * @route   POST /api/v1/auth/register
 * @desc    Registrar nuevo usuario
 * @access  Public
 */
router.post('/register', async (req, res, next) => {
    try {
        const { email, phone, password, firstName, lastName } = req.body;
        
        // Validar campos requeridos
        if (!email || !phone || !password) {
            return res.status(400).json({
                error: 'Email, teléfono y contraseña son requeridos'
            });
        }
        
        // Hash password
        const passwordHash = await bcrypt.hash(password, 10);
        
        // Crear usuario
        const userResult = await query(
            `INSERT INTO users (email, phone, password_hash, role)
             VALUES ($1, $2, $3, 'customer')
             RETURNING id, email, phone, role`,
            [email, phone, passwordHash]
        );
        
        const user = userResult.rows[0];
        
        // Si se proporcionaron firstName y lastName, crear customer
        if (firstName && lastName) {
            await query(
                `INSERT INTO customers (user_id, first_name, last_name)
                 VALUES ($1, $2, $3)`,
                [user.id, firstName, lastName]
            );
        }
        
        // Generar JWT
        const token = jwt.sign(
            { userId: user.id },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
        );
        
        // Crear sesión
        await query(
            `INSERT INTO sessions (user_id, token, expires_at)
             VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
            [user.id, token]
        );
        
        res.status(201).json({
            success: true,
            message: 'Usuario registrado exitosamente',
            data: {
                user: {
                    id: user.id,
                    email: user.email,
                    phone: user.phone,
                    role: user.role
                },
                token
            }
        });
        
    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).json({
                error: 'Email o teléfono ya registrado'
            });
        }
        next(error);
    }
});

/**
 * @route   POST /api/v1/auth/login
 * @desc    Iniciar sesión
 * @access  Public
 */
router.post('/login', async (req, res, next) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({
                error: 'Email y contraseña son requeridos'
            });
        }
        
        // Buscar usuario
        const result = await query(
            `SELECT * FROM users WHERE email = $1 AND status = 'active'`,
            [email]
        );
        
        if (result.rows.length === 0) {
            return res.status(401).json({
                error: 'Credenciales inválidas'
            });
        }
        
        const user = result.rows[0];
        
        // Verificar password
        const validPassword = await bcrypt.compare(password, user.password_hash);
        
        if (!validPassword) {
            return res.status(401).json({
                error: 'Credenciales inválidas'
            });
        }
        
        // Generar JWT
        const token = jwt.sign(
            { userId: user.id },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
        );
        
        // Crear sesión
        await query(
            `INSERT INTO sessions (user_id, token, expires_at)
             VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
            [user.id, token]
        );
        
        // Actualizar last_login
        await query(
            `UPDATE users SET last_login_at = NOW() WHERE id = $1`,
            [user.id]
        );
        
        res.json({
            success: true,
            message: 'Login exitoso',
            data: {
                user: {
                    id: user.id,
                    email: user.email,
                    phone: user.phone,
                    role: user.role,
                    verified: user.verified
                },
                token
            }
        });
        
    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/auth/logout
 * @desc    Cerrar sesión
 * @access  Private
 */
router.post('/logout', authenticate, async (req, res, next) => {
    try {
        // Eliminar sesión
        await query(
            `DELETE FROM sessions WHERE token = $1`,
            [req.token]
        );
        
        res.json({
            success: true,
            message: 'Sesión cerrada exitosamente'
        });
        
    } catch (error) {
        next(error);
    }
});

/**
 * @route   GET /api/v1/auth/me
 * @desc    Obtener usuario actual
 * @access  Private
 */
router.get('/me', authenticate, async (req, res, next) => {
    try {
        const result = await query(
            `SELECT 
                u.*,
                c.first_name,
                c.last_name,
                c.company_name
             FROM users u
             LEFT JOIN customers c ON c.user_id = u.id
             WHERE u.id = $1`,
            [req.user.id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                error: 'Usuario no encontrado'
            });
        }
        
        const user = result.rows[0];
        delete user.password_hash;
        
        res.json({
            success: true,
            data: user
        });
        
    } catch (error) {
        next(error);
    }
});

module.exports = router;
