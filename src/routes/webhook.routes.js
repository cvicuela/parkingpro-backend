const express = require('express');
const crypto = require('crypto');
const router = express.Router();

/**
 * Verify Stripe webhook signature
 */
function verifyStripeSignature(req) {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!endpointSecret) {
        console.warn('[Webhook] STRIPE_WEBHOOK_SECRET not configured — rejecting request');
        return false;
    }
    if (!sig) return false;

    try {
        // Parse Stripe signature header
        const parts = sig.split(',').reduce((acc, part) => {
            const [key, value] = part.split('=');
            acc[key] = value;
            return acc;
        }, {});

        const timestamp = parts.t;
        const receivedSig = parts.v1;

        // Reject if timestamp is older than 5 minutes (replay protection)
        const tolerance = 300; // 5 minutes
        if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > tolerance) {
            return false;
        }

        const payload = `${timestamp}.${req.body}`;
        const expectedSig = crypto
            .createHmac('sha256', endpointSecret)
            .update(payload, 'utf8')
            .digest('hex');

        return crypto.timingSafeEqual(
            Buffer.from(receivedSig, 'hex'),
            Buffer.from(expectedSig, 'hex')
        );
    } catch {
        return false;
    }
}

/**
 * Verify Twilio webhook signature
 */
function verifyTwilioSignature(req) {
    const twilioSig = req.headers['x-twilio-signature'];
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!authToken) {
        console.warn('[Webhook] TWILIO_AUTH_TOKEN not configured — rejecting request');
        return false;
    }
    if (!twilioSig) return false;

    try {
        const url = `${process.env.BASE_URL || 'https://localhost:3000'}${req.originalUrl}`;
        const params = req.body || {};
        const sortedKeys = Object.keys(params).sort();
        const data = url + sortedKeys.map(k => k + params[k]).join('');

        const expectedSig = crypto
            .createHmac('sha1', authToken)
            .update(data, 'utf8')
            .digest('base64');

        return crypto.timingSafeEqual(
            Buffer.from(twilioSig),
            Buffer.from(expectedSig)
        );
    } catch {
        return false;
    }
}

router.post('/stripe', async (req, res) => {
    if (!verifyStripeSignature(req)) {
        return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    // TODO: Process Stripe webhook event
    res.json({ received: true });
});

router.post('/twilio', async (req, res) => {
    if (!verifyTwilioSignature(req)) {
        return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    // TODO: Process Twilio webhook event
    res.json({ received: true });
});

module.exports = router;
