const express = require('express');
const discountRouter = express.Router();
const billingRouter = express.Router();
const { pool } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// Valid PostgreSQL identifier pattern (prevents SQL injection via param keys)
const VALID_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/i;

/**
 * Helper: call a PostgreSQL RPC function with named parameters via pool.
 * Injects p_token from the authenticated request automatically.
 */
async function callRpc(functionName, params, req) {
    const allParams = { p_token: req.token, ...params };
    const paramKeys = Object.keys(allParams);

    for (const key of paramKeys) {
        if (!VALID_IDENTIFIER.test(key)) {
            throw Object.assign(new Error(`Nombre de parámetro inválido: "${key}"`), { status: 400 });
        }
    }

    if (paramKeys.length === 0) {
        const result = await pool.query(`SELECT * FROM ${functionName}()`);
        return result.rows.length === 1 ? result.rows[0] : result.rows;
    }

    const namedPlaceholders = paramKeys.map((key, i) => `${key} := $${i + 1}`).join(', ');
    const values = paramKeys.map(k => {
        const v = allParams[k];
        if (v !== null && typeof v === 'object') return JSON.stringify(v);
        return v;
    });

    const sql = `SELECT * FROM ${functionName}(${namedPlaceholders})`;
    const result = await pool.query(sql, values);
    return result.rows.length === 1 ? result.rows[0] : result.rows;
}

// ==================== DISCOUNT ROUTES ====================

/**
 * @route   GET /api/v1/discounts
 * @desc    List discounts
 * @access  Private
 */
discountRouter.get('/', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const data = await callRpc('list_discounts', {}, req);
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   GET /api/v1/discounts/:id
 * @desc    Get single discount
 * @access  Private
 */
discountRouter.get('/:id', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const data = await callRpc('get_discount', { p_id: req.params.id }, req);
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/discounts
 * @desc    Create discount
 * @access  Private (Admin)
 */
discountRouter.post('/', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const { name, type, value, start_date, end_date, plan_ids, active } = req.body;
        const data = await callRpc('create_discount', {
            p_name: name,
            p_type: type,
            p_value: value,
            p_start_date: start_date || null,
            p_end_date: end_date || null,
            p_plan_ids: plan_ids || null,
            p_active: active !== undefined ? active : true,
        }, req);
        res.status(201).json({ success: true, data });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   PATCH /api/v1/discounts/:id
 * @desc    Update discount
 * @access  Private (Admin)
 */
discountRouter.patch('/:id', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const { name, type, value, start_date, end_date, plan_ids, active } = req.body;
        const data = await callRpc('update_discount', {
            p_id: req.params.id,
            p_name: name !== undefined ? name : null,
            p_type: type !== undefined ? type : null,
            p_value: value !== undefined ? value : null,
            p_start_date: start_date !== undefined ? start_date : null,
            p_end_date: end_date !== undefined ? end_date : null,
            p_plan_ids: plan_ids !== undefined ? plan_ids : null,
            p_active: active !== undefined ? active : null,
        }, req);
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   DELETE /api/v1/discounts/:id
 * @desc    Soft-delete discount
 * @access  Private (Admin)
 */
discountRouter.delete('/:id', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const data = await callRpc('delete_discount', { p_id: req.params.id }, req);
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
});

// ==================== BILLING ROUTES ====================

/**
 * @route   POST /api/v1/billing/calculate-prepaid
 * @desc    Calculate prepaid invoice
 * @access  Private (Admin)
 */
billingRouter.post('/calculate-prepaid', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const { subscription_id, months, discount_id } = req.body;
        const data = await callRpc('calculate_prepaid_invoice', {
            p_subscription_id: subscription_id,
            p_months: months,
            p_discount_id: discount_id || null,
        }, req);
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/billing/generate-prepaid
 * @desc    Generate prepaid invoice
 * @access  Private (Admin)
 */
billingRouter.post('/generate-prepaid', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const { subscription_id, months, discount_id, payment_method } = req.body;
        const data = await callRpc('generate_prepaid_invoice', {
            p_subscription_id: subscription_id,
            p_months: months,
            p_discount_id: discount_id || null,
            p_payment_method: payment_method || null,
        }, req);
        res.status(201).json({ success: true, data });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   GET /api/v1/billing/forecast
 * @desc    Get billing forecast
 * @access  Private (Admin)
 */
billingRouter.get('/forecast', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const { months } = req.query;
        const data = await callRpc('get_billing_forecast', {
            p_months: months ? parseInt(months) : null,
        }, req);
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/billing/auto-suspend
 * @desc    Auto suspend expired subscriptions
 * @access  Private (Admin)
 */
billingRouter.post('/auto-suspend', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const data = await callRpc('auto_suspend_expired', {}, req);
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
});

module.exports = { discountRouter, billingRouter };
