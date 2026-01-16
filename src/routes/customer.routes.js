const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { query } = require('../config/database');

/**
 * @route   GET /api/v1/customers
 * @desc    Listar clientes
 * @access  Private (Operator, Admin)
 */
router.get('/', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const result = await query(
            `SELECT 
                c.*,
                u.email,
                u.phone,
                u.status as user_status
             FROM customers c
             JOIN users u ON c.user_id = u.id
             ORDER BY c.created_at DESC`
        );
        
        res.json({
            success: true,
            data: result.rows,
            count: result.rows.length
        });
        
    } catch (error) {
        next(error);
    }
});

/**
 * @route   GET /api/v1/customers/:id
 * @desc    Obtener cliente por ID
 * @access  Private
 */
router.get('/:id', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        
        const result = await query(
            `SELECT 
                c.*,
                u.email,
                u.phone,
                u.role,
                u.verified
             FROM customers c
             JOIN users u ON c.user_id = u.id
             WHERE c.id = $1`,
            [id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                error: 'Cliente no encontrado'
            });
        }
        
        res.json({
            success: true,
            data: result.rows[0]
        });
        
    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/customers
 * @desc    Crear cliente
 * @access  Private (Admin)
 */
router.post('/', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const {
            email,
            phone,
            firstName,
            lastName,
            idDocument,
            rnc,
            isCompany,
            companyName,
            address,
            notes
        } = req.body;
        
        // Validar campos requeridos
        if (!email || !phone || !firstName || !lastName) {
            return res.status(400).json({
                error: 'Email, teléfono, nombre y apellido son requeridos'
            });
        }
        
        // Crear usuario primero
        const userResult = await query(
            `INSERT INTO users (email, phone, role)
             VALUES ($1, $2, 'customer')
             RETURNING id`,
            [email, phone]
        );
        
        const userId = userResult.rows[0].id;
        
        // Crear customer
        const customerResult = await query(
            `INSERT INTO customers (
                user_id, first_name, last_name, id_document,
                rnc, is_company, company_name, address, notes
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *`,
            [userId, firstName, lastName, idDocument, rnc, isCompany, companyName, address, notes]
        );
        
        res.status(201).json({
            success: true,
            message: 'Cliente creado exitosamente',
            data: customerResult.rows[0]
        });
        
    } catch (error) {
        next(error);
    }
});

/**
 * @route   PATCH /api/v1/customers/:id
 * @desc    Actualizar cliente
 * @access  Private
 */
router.patch('/:id', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        
        const fields = [];
        const values = [];
        let paramCount = 1;
        
        const allowedFields = [
            'first_name', 'last_name', 'id_document', 'rnc',
            'is_company', 'company_name', 'address', 'notes'
        ];
        
        for (const [key, value] of Object.entries(updates)) {
            const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
            
            if (allowedFields.includes(snakeKey)) {
                fields.push(`${snakeKey} = $${paramCount}`);
                values.push(value);
                paramCount++;
            }
        }
        
        if (fields.length === 0) {
            return res.status(400).json({
                error: 'No hay campos válidos para actualizar'
            });
        }
        
        values.push(id);
        
        const result = await query(
            `UPDATE customers
             SET ${fields.join(', ')}, updated_at = NOW()
             WHERE id = $${paramCount}
             RETURNING *`,
            values
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                error: 'Cliente no encontrado'
            });
        }
        
        res.json({
            success: true,
            message: 'Cliente actualizado exitosamente',
            data: result.rows[0]
        });
        
    } catch (error) {
        next(error);
    }
});

module.exports = router;
