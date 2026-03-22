const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { logAudit } = require('../middleware/audit');

// CardNet webhook - receives payment status updates
router.post('/cardnet', async (req, res, next) => {
    try {
        const { transactionId, status, responseCode, amount, merchantId, signature } = req.body;

        // Verify webhook signature (HMAC with API key) — REQUIRED when key is configured
        const crypto = require('crypto');
        const expectedKey = process.env.CARDNET_API_KEY;
        if (expectedKey) {
            if (!signature) {
                console.error('[Webhook] CardNet signature missing');
                return res.status(401).json({ error: 'Signature required' });
            }
            const payload = `${transactionId}|${status}|${amount}|${merchantId}`;
            const expected = crypto.createHmac('sha256', expectedKey).update(payload).digest('hex');
            if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
                console.error('[Webhook] CardNet signature mismatch');
                return res.status(401).json({ error: 'Invalid signature' });
            }
        }

        // Find payment by transaction ID in metadata
        const paymentResult = await query(
            `SELECT id, status, metadata FROM payments
             WHERE metadata->>'provider_response' LIKE $1
                OR metadata->'provider_response'->>'transaction_id' = $2
             LIMIT 1`,
            [`%${transactionId}%`, transactionId]
        );

        if (paymentResult.rows.length === 0) {
            console.warn(`[Webhook] CardNet - payment not found for txn ${transactionId}`);
            return res.json({ received: true, matched: false });
        }

        const payment = paymentResult.rows[0];
        const newStatus = responseCode === '00' ? 'paid' : 'failed';

        if (payment.status !== newStatus) {
            await query(
                `UPDATE payments SET status = $1, paid_at = $2, updated_at = NOW(),
                 metadata = jsonb_set(metadata, '{webhook_update}', $3::jsonb)
                 WHERE id = $4`,
                [
                    newStatus,
                    newStatus === 'paid' ? new Date() : null,
                    JSON.stringify({ transactionId, responseCode, status, received_at: new Date().toISOString() }),
                    payment.id
                ]
            );

            // If now paid, update parking session
            if (newStatus === 'paid') {
                await query(
                    `UPDATE parking_sessions SET payment_status = 'paid', updated_at = NOW()
                     WHERE payment_id = $1`,
                    [payment.id]
                );
            }

            await logAudit({
                action: 'webhook_payment_update',
                entityType: 'payment',
                entityId: payment.id,
                changes: { from: payment.status, to: newStatus, transactionId }
            });
        }

        res.json({ received: true, matched: true });
    } catch (error) {
        next(error);
    }
});

// Stripe webhook (keep existing placeholder, enhance later)
router.post('/stripe', express.raw({ type: 'application/json' }), (req, res) => {
    res.json({ received: true });
});

// Twilio webhook
router.post('/twilio', (req, res) => {
    res.json({ received: true });
});

module.exports = router;
