const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const invoiceService = require('../services/invoice.service');

router.get('/', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const { limit, offset, customerId, startDate, endDate, search } = req.query;
        const invoices = await invoiceService.list({
            limit: parseInt(limit) || 50,
            offset: parseInt(offset) || 0,
            customerId: customerId || null,
            startDate: startDate || null,
            endDate: endDate || null,
            search: search || null
        });
        res.json({ success: true, data: invoices });
    } catch (error) {
        next(error);
    }
});

router.get('/stats', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const { startDate, endDate } = req.query;
        const stats = await invoiceService.getStats({ startDate, endDate });
        res.json({ success: true, data: stats });
    } catch (error) {
        next(error);
    }
});

router.get('/:id', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const invoice = await invoiceService.getById(req.params.id);
        res.json({ success: true, data: invoice });
    } catch (error) {
        next(error);
    }
});

router.post('/from-payment/:paymentId', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const invoice = await invoiceService.generateFromPayment(req.params.paymentId, {
            userId: req.user.id,
            req
        });
        res.status(201).json({ success: true, data: invoice });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
