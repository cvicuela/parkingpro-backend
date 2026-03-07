const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const cashRegisterService = require('../services/cashRegister.service');

const { query: dbQuery } = require('../config/database');

// ── APERTURA DE CAJA ─────────────────────────────────────────────────────────
router.post('/open', authenticate, authorize(['operator', 'admin', 'super_admin']), auditMiddleware('cash_register'), async (req, res, next) => {
    try {
        const { openingBalance, name } = req.body;
        const register = await cashRegisterService.openRegister({
            operatorId: req.user.id,
            openingBalance: parseFloat(openingBalance) || 0,
            name,
            req
        });
        res.status(201).json({ success: true, data: register });
    } catch (error) {
        next(error);
    }
});

// ── CAJA ACTIVA DEL OPERADOR ─────────────────────────────────────────────────
router.get('/active', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const register = await cashRegisterService.getActiveRegister(req.user.id);
        res.json({ success: true, data: register });
    } catch (error) {
        next(error);
    }
});

// ── HISTORIAL DE CAJAS ───────────────────────────────────────────────────────
router.get('/history', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const { limit, offset, operatorId, startDate, endDate } = req.query;
        const history = await cashRegisterService.getHistory({
            limit: parseInt(limit) || 50,
            offset: parseInt(offset) || 0,
            operatorId: operatorId || null,
            startDate: startDate || null,
            endDate: endDate || null
        });
        res.json({ success: true, data: history });
    } catch (error) {
        next(error);
    }
});

// ── TRANSACCIONES DE UNA CAJA ────────────────────────────────────────────────
router.get('/:id/transactions', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const transactions = await cashRegisterService.getTransactions(req.params.id);
        res.json({ success: true, data: transactions });
    } catch (error) {
        next(error);
    }
});

// ── CIERRE DE CAJA ───────────────────────────────────────────────────────────
router.post('/:id/close', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const { countedBalance, denominations, notes } = req.body;
        if (countedBalance === undefined || countedBalance === null) {
            return res.status(400).json({ success: false, error: 'countedBalance es requerido' });
        }
        const result = await cashRegisterService.closeRegister({
            registerId: req.params.id,
            operatorId: req.user.id,
            countedBalance: parseFloat(countedBalance),
            denominations: denominations || [],
            notes,
            req
        });
        res.json({ success: true, data: result });
    } catch (error) {
        next(error);
    }
});

// ── APROBACIÓN DE SUPERVISOR ─────────────────────────────────────────────────
router.post('/:id/approve', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const { notes } = req.body;
        const result = await cashRegisterService.approveClose({
            registerId: req.params.id,
            supervisorId: req.user.id,
            notes,
            req
        });
        res.json({ success: true, data: result });
    } catch (error) {
        next(error);
    }
});

// ── INFO DE LÍMITES (para que el frontend sepa los umbrales) ─────────────────
router.get('/limits', authenticate, async (req, res, next) => {
    try {
        const result = await dbQuery(
            `SELECT key, value FROM settings WHERE key IN ('cash_diff_threshold', 'refund_limit_operator', 'currency')`
        );
        const map = {};
        result.rows.forEach(r => {
            const v = typeof r.value === 'string' ? r.value : JSON.stringify(r.value);
            map[r.key] = v;
        });
        res.json({
            success: true,
            data: {
                cashDiffThreshold: parseFloat(map.cash_diff_threshold) || 200,
                refundLimitOperator: parseFloat(map.refund_limit_operator) || 500,
                currency: map.currency || 'DOP'
            }
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
