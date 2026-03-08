const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const rfidService = require('../services/rfid.service');

/**
 * @route   GET /api/v1/rfid/cards
 * @desc    List RFID cards with filters
 */
router.get('/cards', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const { cardType, status, search, limit, offset } = req.query;
        const filters = { cardType, status, search, limit, offset };
        const data = await rfidService.listCards(filters);
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   GET /api/v1/rfid/cards/pool-stats
 * @desc    Get RFID card pool statistics
 */
router.get('/cards/pool-stats', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const data = await rfidService.getPoolStats();
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   GET /api/v1/rfid/cards/:id
 * @desc    Get RFID card by ID
 */
router.get('/cards/:id', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const data = await rfidService.findById(req.params.id);
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/rfid/cards
 * @desc    Register a new RFID card
 */
router.post('/cards', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const { cardUid, cardType, label } = req.body;
        const data = await rfidService.registerCard(cardUid, cardType, label);
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/rfid/cards/:id/assign-permanent
 * @desc    Assign a permanent RFID card to a subscription
 */
router.post('/cards/:id/assign-permanent', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const { subscriptionId } = req.body;
        const data = await rfidService.assignPermanentCard(req.params.id, subscriptionId);
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/rfid/cards/:id/assign-temporary
 * @desc    Assign a temporary RFID card to a vehicle
 */
router.post('/cards/:id/assign-temporary', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const { vehiclePlate } = req.body;
        const data = await rfidService.assignTemporaryCard(req.params.id, vehiclePlate);
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/rfid/cards/:id/return
 * @desc    Return a temporary RFID card
 */
router.post('/cards/:id/return', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const data = await rfidService.returnTemporaryCard(req.params.id);
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/rfid/cards/:id/report-lost
 * @desc    Report an RFID card as lost
 */
router.post('/cards/:id/report-lost', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const operatorId = req.user.id;
        const data = await rfidService.reportLostCard(req.params.id, operatorId);
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/rfid/cards/:id/disable
 * @desc    Disable an RFID card
 */
router.post('/cards/:id/disable', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const data = await rfidService.disableCard(req.params.id);
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/rfid/cards/:id/enable
 * @desc    Enable an RFID card
 */
router.post('/cards/:id/enable', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const data = await rfidService.enableCard(req.params.id);
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/rfid/cards/:id/unlink
 * @desc    Unlink an RFID card from its subscription
 */
router.post('/cards/:id/unlink', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const data = await rfidService.unlinkFromSubscription(req.params.id);
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   GET /api/v1/rfid/resolve/:cardUid
 * @desc    Resolve RFID card for access (used by PWA to check what a scanned card maps to)
 */
router.get('/resolve/:cardUid', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const data = await rfidService.resolveCardForAccess(req.params.cardUid);
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
