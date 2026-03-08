const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// All routes require authentication and admin/super_admin role
router.use(authenticate);
router.use(authorize(['admin', 'super_admin']));

/**
 * @route   GET /api/v1/users
 * @desc    Listar todos los usuarios del sistema
 * @access  Private (Admin)
 */
router.get('/', async (req, res, next) => {
    try {
        const result = await query(
            `SELECT
                u.id,
                u.email,
                u.phone,
                u.role,
                u.status,
                u.created_at,
                u.last_login_at,
                c.first_name,
                c.last_name
             FROM users u
             LEFT JOIN customers c ON c.user_id = u.id
             ORDER BY u.created_at DESC`
        );

        res.json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/users
 * @desc    Crear nuevo usuario del sistema
 * @access  Private (Admin)
 */
router.post('/', async (req, res, next) => {
    try {
        const { email, phone, password, role, firstName, lastName } = req.body;

        // Validar campos requeridos
        if (!email || !phone || !password || !role) {
            return res.status(400).json({
                error: 'Email, teléfono, contraseña y rol son requeridos'
            });
        }

        // Validar rol permitido
        const allowedRoles = ['operator', 'admin', 'super_admin'];
        if (!allowedRoles.includes(role)) {
            return res.status(400).json({
                error: `Rol inválido. Roles permitidos: ${allowedRoles.join(', ')}`
            });
        }

        // Solo super_admin puede crear otros super_admin
        if (role === 'super_admin' && req.user.role !== 'super_admin') {
            return res.status(403).json({
                error: 'Solo super_admin puede crear usuarios super_admin'
            });
        }

        // Hash password
        const passwordHash = await bcrypt.hash(password, 10);

        // Crear usuario
        const userResult = await query(
            `INSERT INTO users (email, phone, password_hash, role)
             VALUES ($1, $2, $3, $4)
             RETURNING id, email, phone, role, status, created_at`,
            [email, phone, passwordHash, role]
        );

        const user = userResult.rows[0];

        // Crear registro en customers si se proporcionaron nombre y apellido
        if (firstName || lastName) {
            await query(
                `INSERT INTO customers (user_id, first_name, last_name)
                 VALUES ($1, $2, $3)`,
                [user.id, firstName || null, lastName || null]
            );
        }

        res.status(201).json({
            success: true,
            message: 'Usuario creado exitosamente',
            data: {
                ...user,
                first_name: firstName || null,
                last_name: lastName || null
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
 * @route   PUT /api/v1/users/:id
 * @desc    Actualizar usuario
 * @access  Private (Admin)
 */
router.put('/:id', async (req, res, next) => {
    try {
        const { id } = req.params;
        const { email, phone, role, firstName, lastName, status, password } = req.body;

        // Validar que el usuario existe
        const existingUser = await query(
            `SELECT * FROM users WHERE id = $1`,
            [id]
        );

        if (existingUser.rows.length === 0) {
            return res.status(404).json({
                error: 'Usuario no encontrado'
            });
        }

        // Solo super_admin puede asignar rol super_admin
        if (role === 'super_admin' && req.user.role !== 'super_admin') {
            return res.status(403).json({
                error: 'Solo super_admin puede asignar el rol super_admin'
            });
        }

        // Construir query de actualización para users
        const updates = [];
        const values = [];
        let paramCount = 1;

        if (email) {
            updates.push(`email = $${paramCount++}`);
            values.push(email);
        }
        if (phone) {
            updates.push(`phone = $${paramCount++}`);
            values.push(phone);
        }
        if (role) {
            updates.push(`role = $${paramCount++}`);
            values.push(role);
        }
        if (status) {
            updates.push(`status = $${paramCount++}`);
            values.push(status);
        }
        if (password) {
            const passwordHash = await bcrypt.hash(password, 10);
            updates.push(`password_hash = $${paramCount++}`);
            values.push(passwordHash);
        }

        if (updates.length > 0) {
            updates.push(`updated_at = NOW()`);
            values.push(id);
            await query(
                `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramCount}`,
                values
            );
        }

        // Actualizar customers si se proporcionaron firstName o lastName
        if (firstName !== undefined || lastName !== undefined) {
            const customerExists = await query(
                `SELECT id FROM customers WHERE user_id = $1`,
                [id]
            );

            if (customerExists.rows.length > 0) {
                const customerUpdates = [];
                const customerValues = [];
                let cpCount = 1;

                if (firstName !== undefined) {
                    customerUpdates.push(`first_name = $${cpCount++}`);
                    customerValues.push(firstName);
                }
                if (lastName !== undefined) {
                    customerUpdates.push(`last_name = $${cpCount++}`);
                    customerValues.push(lastName);
                }

                customerValues.push(id);
                await query(
                    `UPDATE customers SET ${customerUpdates.join(', ')} WHERE user_id = $${cpCount}`,
                    customerValues
                );
            } else {
                await query(
                    `INSERT INTO customers (user_id, first_name, last_name)
                     VALUES ($1, $2, $3)`,
                    [id, firstName || null, lastName || null]
                );
            }
        }

        // Obtener usuario actualizado
        const result = await query(
            `SELECT
                u.id, u.email, u.phone, u.role, u.status, u.created_at, u.last_login_at,
                c.first_name, c.last_name
             FROM users u
             LEFT JOIN customers c ON c.user_id = u.id
             WHERE u.id = $1`,
            [id]
        );

        res.json({
            success: true,
            message: 'Usuario actualizado exitosamente',
            data: result.rows[0]
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
 * @route   DELETE /api/v1/users/:id
 * @desc    Desactivar usuario (soft delete)
 * @access  Private (Admin)
 */
router.delete('/:id', async (req, res, next) => {
    try {
        const { id } = req.params;

        // No permitir eliminarse a sí mismo
        if (String(req.user.id) === String(id)) {
            return res.status(400).json({
                error: 'No puedes desactivar tu propia cuenta'
            });
        }

        // Validar que el usuario existe
        const existingUser = await query(
            `SELECT id, role FROM users WHERE id = $1`,
            [id]
        );

        if (existingUser.rows.length === 0) {
            return res.status(404).json({
                error: 'Usuario no encontrado'
            });
        }

        // No permitir que admin desactive a super_admin
        if (existingUser.rows[0].role === 'super_admin' && req.user.role !== 'super_admin') {
            return res.status(403).json({
                error: 'Solo super_admin puede desactivar a otro super_admin'
            });
        }

        // Soft delete: set status to inactive
        await query(
            `UPDATE users SET status = 'inactive', updated_at = NOW() WHERE id = $1`,
            [id]
        );

        // Invalidar sesiones del usuario
        await query(
            `DELETE FROM sessions WHERE user_id = $1`,
            [id]
        );

        res.json({
            success: true,
            message: 'Usuario desactivado exitosamente'
        });

    } catch (error) {
        next(error);
    }
});

/**
 * @route   PUT /api/v1/users/:id/reset-password
 * @desc    Resetear contraseña de usuario
 * @access  Private (Admin)
 */
router.put('/:id/reset-password', async (req, res, next) => {
    try {
        const { id } = req.params;
        const { newPassword } = req.body;

        if (!newPassword) {
            return res.status(400).json({
                error: 'La nueva contraseña es requerida'
            });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({
                error: 'La contraseña debe tener al menos 6 caracteres'
            });
        }

        // Validar que el usuario existe
        const existingUser = await query(
            `SELECT id FROM users WHERE id = $1`,
            [id]
        );

        if (existingUser.rows.length === 0) {
            return res.status(404).json({
                error: 'Usuario no encontrado'
            });
        }

        // Hash nueva contraseña
        const passwordHash = await bcrypt.hash(newPassword, 10);

        await query(
            `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
            [passwordHash, id]
        );

        // Invalidar sesiones existentes del usuario
        await query(
            `DELETE FROM sessions WHERE user_id = $1`,
            [id]
        );

        res.json({
            success: true,
            message: 'Contraseña actualizada exitosamente'
        });

    } catch (error) {
        next(error);
    }
});

module.exports = router;
