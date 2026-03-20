const { query, transaction, supabase } = require('../config/database');
const { logAudit } = require('../middleware/audit');

const REFUND_LIMIT_OPERATOR = parseFloat(process.env.REFUND_LIMIT_OPERATOR) || 500;
const ALLOW_SIMULATED_PAYMENTS = process.env.ALLOW_SIMULATED_PAYMENTS === 'true';

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

            // Build enriched metadata, storing simulation flags when present
            const enrichedMetadata = { ...metadata, provider_response: providerResult };
            if (providerResult.simulated) {
                enrichedMetadata.simulated = true;
                if (providerResult.status === 'paid') {
                    enrichedMetadata.simulated_at = new Date().toISOString();
                }
            }

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
                    JSON.stringify(enrichedMetadata)
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
        const cardnetService = require('./cardnet.service');

        if (!cardnetService.isConfigured()) {
            const allowSimulated = process.env.ALLOW_SIMULATED_PAYMENTS === 'true';
            if (!allowSimulated) {
                console.warn('[Payment] CardNet not configured and simulation not allowed');
                return {
                    status: 'pending',
                    transaction_id: `CARDNET-PENDING-${Date.now()}`,
                    amount,
                    warning: 'CardNet no configurado. Configure CARDNET_MERCHANT_ID y CARDNET_API_KEY.'
                };
            }
            console.warn('[Payment] CardNet not configured - using simulated payment');
            return {
                status: 'paid',
                transaction_id: `CARDNET-SIM-${Date.now()}`,
                amount,
                simulated: true,
                warning: 'SIMULATED PAYMENT - not charged'
            };
        }

        // Real CardNet payment
        const { cardNumber, cardExpMonth, cardExpYear, cardCvv, cardHolderName } = metadata;

        if (!cardNumber || !cardExpMonth || !cardExpYear || !cardCvv) {
            throw new Error('Datos de tarjeta requeridos: cardNumber, cardExpMonth, cardExpYear, cardCvv');
        }

        const result = await cardnetService.processSale({
            amount,
            currency: 'DOP',
            cardNumber,
            cardExpMonth,
            cardExpYear,
            cardCvv,
            cardHolderName: cardHolderName || 'PARKING CLIENT',
            description: metadata.description || 'Pago estacionamiento ParkingPro',
            orderId: metadata.orderId || `PP-${Date.now()}`
        });

        return {
            status: result.status,
            transaction_id: result.transactionId,
            authorization_code: result.authorizationCode,
            card_brand: result.cardBrand,
            card_last_four: cardNumber.slice(-4),
            amount,
            response_code: result.responseCode,
            response_message: result.responseMessage
        };
    }

    async processStripePayment({ amount, metadata }) {
        const stripeKey = process.env.STRIPE_SECRET_KEY;
        if (!stripeKey || stripeKey.startsWith('sk_test_your')) {
            if (!ALLOW_SIMULATED_PAYMENTS) {
                console.warn('[Payment] WARNING: Stripe is not configured and ALLOW_SIMULATED_PAYMENTS is false. Payment will not be charged.');
                return {
                    status: 'pending',
                    transaction_id: `STRIPE-UNCONFIGURED-${Date.now()}`,
                    amount,
                    warning: 'Stripe no configurado y pagos simulados no permitidos - pago pendiente sin cobro real'
                };
            }
            console.warn('[Payment] WARNING: Stripe is not configured. Returning simulated payment (ALLOW_SIMULATED_PAYMENTS=true).');
            return {
                status: 'paid',
                transaction_id: `STRIPE-SIM-${Date.now()}`,
                amount,
                simulated: true,
                warning: 'SIMULATED PAYMENT - not charged'
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

    async refundPayment(paymentId, { requestingUser, reason, req } = {}) {
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

        // Call the Supabase RPC refund_payment with p_reason parameter
        const token = process.env.SUPABASE_SERVICE_KEY;
        const { data: rpcResult, error: rpcError } = await supabase.rpc('refund_payment', {
            p_token: token,
            p_id: paymentId,
            p_reason: reason || null
        });

        if (rpcError) {
            throw new Error(`Error al procesar reembolso: ${rpcError.message}`);
        }

        await logAudit({
            userId: refundedBy,
            action: 'payment_refunded',
            entityType: 'payment',
            entityId: paymentId,
            changes: {
                amount: payment.total_amount,
                original_status: 'paid',
                new_status: 'refunded',
                reason: reason || null
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

        // Return the updated payment (re-fetch after RPC)
        const updated = await query('SELECT * FROM payments WHERE id = $1', [paymentId]);
        return updated.rows[0];
    }
}

module.exports = new PaymentService();
