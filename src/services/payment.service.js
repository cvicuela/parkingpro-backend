const { query, transaction } = require('../config/database');
const { logAudit } = require('../middleware/audit');

const REFUND_LIMIT_OPERATOR = parseFloat(process.env.REFUND_LIMIT_OPERATOR) || 500;

class PaymentService {
    constructor() {
        this.providers = {
            cash: this.processCashPayment.bind(this),
            cardnet: this.processCardNetPayment.bind(this),
            stripe: this.processStripePayment.bind(this),
        };
    }

    async processPayment({ amount, taxRate, provider = 'cash', customerId, subscriptionId, sessionId, metadata = {}, userId, req }) {
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

            const payment = result.rows[0];

            if (sessionId && providerResult.status === 'paid') {
                await client.query(
                    `UPDATE parking_sessions
                     SET payment_id = $1, paid_amount = $2, payment_status = 'paid', updated_at = NOW()
                     WHERE id = $3`,
                    [payment.id, totalAmount, sessionId]
                );
            }

            // Auditar creación de pago
            await logAudit({
                userId: userId || null,
                action: 'payment_created',
                entityType: 'payment',
                entityId: payment.id,
                changes: { amount, taxAmount, totalAmount, provider, status: providerResult.status },
                req
            });

            // Generar factura automáticamente si el pago fue exitoso
            if (providerResult.status === 'paid') {
                try {
                    const invoiceService = require('./invoice.service');
                    await invoiceService.generateFromPayment(payment.id, { userId, req });
                } catch (invoiceErr) {
                    // La factura falla silenciosamente — no cancela el pago
                    console.error('[Payment] Error generando factura:', invoiceErr.message);
                }
            }

            return payment;
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

    async refundPayment(paymentId, { requestingUser, req } = {}) {
        const paymentResult = await query('SELECT * FROM payments WHERE id = $1', [paymentId]);
        if (paymentResult.rows.length === 0) {
            throw new Error('Pago no encontrado');
        }

        const payment = paymentResult.rows[0];
        if (payment.status !== 'paid') {
            throw new Error('Solo se pueden reembolsar pagos completados');
        }

        // Control antifraude: operadores tienen límite de RD$500
        if (requestingUser && requestingUser.role === 'operator') {
            if (parseFloat(payment.total_amount) > REFUND_LIMIT_OPERATOR) {
                throw new Error(
                    `Los operadores solo pueden reembolsar hasta RD$${REFUND_LIMIT_OPERATOR}. ` +
                    `Este pago requiere aprobación de un administrador.`
                );
            }

            // Verificar cuánto ha reembolsado este operador hoy
            const todayRefunds = await query(
                `SELECT COALESCE(SUM(total_amount), 0) as total
                 FROM payments
                 WHERE status = 'refunded'
                   AND refunded_at >= CURRENT_DATE
                   AND metadata->>'refunded_by' = $1`,
                [requestingUser.id]
            );
            const todayTotal = parseFloat(todayRefunds.rows[0].total) + parseFloat(payment.total_amount);
            if (todayTotal > REFUND_LIMIT_OPERATOR * 3) {
                throw new Error('Límite diario de reembolsos alcanzado. Contacta al administrador.');
            }
        }

        const refundedBy = requestingUser ? requestingUser.id : null;

        const result = await query(
            `UPDATE payments
             SET status = 'refunded',
                 refunded_at = NOW(),
                 metadata = jsonb_set(COALESCE(metadata, '{}'), '{refunded_by}', $1::jsonb)
             WHERE id = $2
             RETURNING *`,
            [JSON.stringify(refundedBy), paymentId]
        );

        await logAudit({
            userId: refundedBy,
            action: 'payment_refunded',
            entityType: 'payment',
            entityId: paymentId,
            changes: {
                amount: payment.total_amount,
                original_status: 'paid',
                new_status: 'refunded'
            },
            req
        });

        // Generar nota de crédito
        try {
            const invoiceService = require('./invoice.service');
            const originalInvoice = await query('SELECT id FROM invoices WHERE payment_id = $1', [paymentId]);
            if (originalInvoice.rows.length > 0) {
                await invoiceService.generateCreditNote(originalInvoice.rows[0].id, {
                    userId: refundedBy,
                    req
                });
            }
        } catch (err) {
            console.error('[Payment] Error generando nota de crédito:', err.message);
        }

        return result.rows[0];
    }
}

module.exports = new PaymentService();
