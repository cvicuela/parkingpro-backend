const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const expenseService = require('../services/expense.service');

router.get('/', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
  try {
    const { limit, offset, category, status, fromDate, toDate, search } = req.query;
    const data = await expenseService.list({
      limit: parseInt(limit) || 50, offset: parseInt(offset) || 0,
      category, status, fromDate, toDate, search
    });
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.post('/', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
  try {
    const expense = await expenseService.create(req.body, { userId: req.user.id, req });
    res.status(201).json({ success: true, data: expense });
  } catch (error) { next(error); }
});

router.put('/:id', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
  try {
    const expense = await expenseService.update(req.params.id, req.body, { userId: req.user.id, req });
    res.json({ success: true, data: expense });
  } catch (error) { next(error); }
});

router.delete('/:id', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
  try {
    await expenseService.delete(req.params.id, { userId: req.user.id, req });
    res.json({ success: true });
  } catch (error) { next(error); }
});

router.get('/stats', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
  try {
    const { fromDate, toDate } = req.query;
    const stats = await expenseService.stats({ fromDate, toDate });
    res.json({ success: true, data: stats });
  } catch (error) { next(error); }
});

module.exports = router;
