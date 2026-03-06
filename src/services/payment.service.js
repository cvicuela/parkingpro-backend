const { query, transaction } = require('../config/database');

class PaymentService {
    constructor() {
        this.providers = {
            cash: this.processCashPayment.bind(this),
            cardnet: this.processCardNetPayment.bind(this),
            stripe: this.processStripePayment.bind(this),
        };
    }

    async processPayment({ amount, taxRate, provider = 'cash', customerId, subscriptionId, sessionId, metadata = {} }) {
        const taxAmount = amount * (taxRate || parseFloat(process.env.TAX_RATE) || 0.18);
        const totalAmount = amount + taxAmount;

        const handler = this.providers[provider];
        if (!handler) {
            throw new Error(`Proveedor de pago no soportado: ${provider}`);
        }

        return await transaction(async (client) => {
            const providerResult = await handler({ amount: totalAmount, metadata });

            const result = await client.query(
                `INSERT INTO payments (
                    subscription_id, customer_id, amount, tax_amount, total_amount,
                    currency, status, payment_method, paid_at, metadata
                ) VALUES ($1, $2, $3, $4, $5, 'DOP', $6, $7, $8, $9)
                RETURNING *`,
                [
                    subscriptionId || null,
                    customerId || null,
                    amount,
                    taxAmount,
                    totalAmount,
                    providerResult.status,
                    provider,
                    providerResult.status === 'paid' ? new Date() : null,
                    JSON.stringify({ ...metadata, provider_response: providerResult })
                ]
            );

            if (sessionId && providerResult.status === 'paid') {
                await client.query(
                    `UPDATE parking_sessions
                     SET payment_id = $1, paid_amount = $2, payment_status = 'paid', updated_at = NOW()
                     WHERE id = $3`,
                    [result.rows[0].id, totalAmount, sessionId]
                );
            }

            return result.rows[0];
        });
    }

    async processCashPayment({ amount }) {
        return {
            status: 'paid',
            transaction_id: `CASH-${Date.now()}`,
            amount
        };
    }

    async processCardNetPayment({ amount, metadata }) {
        // CardNet integration placeholder
        // In production, this would call the CardNet API
        const cardnetUrl = process.env.CARDNET_API_URL;
        const cardnetKey = process.env.CARDNET_API_KEY;

        if (!cardnetUrl || !cardnetKey) {
            return {
                status: 'paid',
                transaction_id: `CARDNET-SIM-${Date.now()}`,
                amount,
                simulated: true,
                message: 'CardNet no configurado - pago simulado'
            };
        }

        // Real CardNet integration would go here
        // const response = await fetch(cardnetUrl + '/transactions', {
        //     method: 'POST',
        //     headers: { 'Authorization': `Bearer ${cardnetKey}`, 'Content-Type': 'application/json' },
        //     body: JSON.stringify({ amount, currency: 'DOP', ...metadata })
        // });
        // return await response.json();

        return {
            status: 'paid',
            transaction_id: `CARDNET-${Date.now()}`,
            amount
        };
    }

    async processStripePayment({ amount, metadata }) {
        const stripeKey = process.env.STRIPE_SECRET_KEY;
        if (!stripeKey || stripeKey.startsWith('sk_test_your')) {
            return {
                status: 'paid',
                transaction_id: `STRIPE-SIM-${Date.now()}`,
                amount,
                simulated: true,
                message: 'Stripe no configurado - pago simulado'
            };
        }

        const stripe = require('stripe')(stripeKey);
        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(amount * 100),
            currency: 'dop',
            metadata
        });

        return {
            status: paymentIntent.status === 'succeeded' ? 'paid' : 'pending',
            transaction_id: paymentIntent.id,
            amount
        };
    }

    async refundPayment(paymentId) {
        const paymentResult = await query('SELECT * FROM payments WHERE id = $1', [paymentId]);
        if (paymentResult.rows.length === 0) {
            throw new Error('Pago no encontrado');
        }

        const payment = paymentResult.rows[0];
        if (payment.status !== 'paid') {
            throw new Error('Solo se pueden reembolsar pagos completados');
        }

        const result = await query(
            `UPDATE payments SET status = 'refunded', refunded_at = NOW() WHERE id = $1 RETURNING *`,
            [paymentId]
        );

        return result.rows[0];
    }
}

module.exports = new PaymentService();
