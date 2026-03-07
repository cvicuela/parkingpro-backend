const { query, transaction } = require('../config/database');
const { logAudit } = require('../middleware/audit');

// Prefijos NCF provisionales (demo - en producción vienen de DGII)
const NCF_SERIES = {
    consumer: 'B01',   // Factura consumidor final
    fiscal:   'B14',   // Factura con valor fiscal (requiere RNC)
    credit:   'B04'    // Nota de crédito
};

class InvoiceService {

    // ─── GENERAR FACTURA DESDE PAGO ──────────────────────────────────────────

    async generateFromPayment(paymentId, { userId, req } = {}) {
        const paymentResult = await query(
            `SELECT p.*, c.first_name, c.last_name, c.rnc, c.email,
                    s.plan_id, pl.name as plan_name
             FROM payments p
             LEFT JOIN customers c ON p.customer_id = c.id
             LEFT JOIN subscriptions s ON p.subscription_id = s.id
             LEFT JOIN plans pl ON s.plan_id = pl.id
             WHERE p.id = $1`,
            [paymentId]
        );

        if (paymentResult.rows.length === 0) {
            throw new Error('Pago no encontrado');
        }

        const payment = paymentResult.rows[0];

        // Verificar que no tenga factura ya
        const existing = await query(
            `SELECT id FROM invoices WHERE payment_id = $1`,
            [paymentId]
        );
        if (existing.rows.length > 0) {
            return (await query('SELECT * FROM invoices WHERE payment_id = $1', [paymentId])).rows[0];
        }

        const invoiceNumber = await this._nextInvoiceNumber();
        const hasRnc = payment.rnc && payment.rnc.trim().length > 0;
        const ncf = `${hasRnc ? NCF_SERIES.fiscal : NCF_SERIES.consumer}${invoiceNumber.toString().padStart(8, '0')}`;

        const customerName = payment.first_name
            ? `${payment.first_name} ${payment.last_name}`.trim()
            : 'Consumidor Final';

        const items = [
            {
                description: payment.plan_name
                    ? `Suscripción plan ${payment.plan_name}`
                    : 'Servicio de estacionamiento',
                quantity: 1,
                unit_price: parseFloat(payment.amount),
                subtotal: parseFloat(payment.amount)
            }
        ];

        return await transaction(async (client) => {
            const result = await client.query(
                `INSERT INTO invoices
                    (payment_id, customer_id, invoice_number, ncf, subtotal, tax_amount, total, currency, items)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'DOP', $8)
                 RETURNING *`,
                [
                    paymentId,
                    payment.customer_id || null,
                    invoiceNumber,
                    ncf,
                    parseFloat(payment.amount),
                    parseFloat(payment.tax_amount),
                    parseFloat(payment.total_amount),
                    JSON.stringify(items)
                ]
            );

            const invoice = result.rows[0];

            await logAudit({
                userId: userId || null,
                action: 'invoice_generated',
                entityType: 'invoice',
                entityId: invoice.id,
                changes: { invoice_number: invoiceNumber, ncf, total: payment.total_amount },
                req
            });

            return { ...invoice, customer_name: customerName, items };
        });
    }

    // ─── GENERAR NOTA DE CRÉDITO (reembolso) ─────────────────────────────────

    async generateCreditNote(originalInvoiceId, { userId, req } = {}) {
        const original = await query('SELECT * FROM invoices WHERE id = $1', [originalInvoiceId]);
        if (original.rows.length === 0) throw new Error('Factura original no encontrada');

        const inv = original.rows[0];
        const invoiceNumber = await this._nextInvoiceNumber();
        const ncf = `${NCF_SERIES.credit}${invoiceNumber.toString().padStart(8, '0')}`;

        const result = await query(
            `INSERT INTO invoices
                (payment_id, customer_id, invoice_number, ncf, subtotal, tax_amount, total, currency, items, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'DOP', $8, $9)
             RETURNING *`,
            [
                inv.payment_id,
                inv.customer_id,
                invoiceNumber,
                ncf,
                -parseFloat(inv.subtotal),
                -parseFloat(inv.tax_amount),
                -parseFloat(inv.total),
                JSON.stringify([{ description: `Nota de crédito - Ref. ${inv.ncf}`, quantity: 1, unit_price: -parseFloat(inv.total), subtotal: -parseFloat(inv.total) }]),
                `Nota de crédito referenciando ${inv.ncf}`
            ]
        );

        await logAudit({
            userId: userId || null,
            action: 'credit_note_generated',
            entityType: 'invoice',
            entityId: result.rows[0].id,
            changes: { original_invoice: inv.invoice_number, ncf },
            req
        });

        return result.rows[0];
    }

    // ─── LISTAR FACTURAS ─────────────────────────────────────────────────────

    async list({ limit = 50, offset = 0, customerId, startDate, endDate, search }) {
        const params = [];
        let where = 'WHERE 1=1';

        if (customerId) { params.push(customerId); where += ` AND i.customer_id = $${params.length}`; }
        if (startDate)  { params.push(startDate);  where += ` AND i.created_at >= $${params.length}`; }
        if (endDate)    { params.push(endDate);     where += ` AND i.created_at <= $${params.length}`; }
        if (search) {
            params.push(`%${search}%`);
            where += ` AND (i.invoice_number::text ILIKE $${params.length} OR i.ncf ILIKE $${params.length} OR c.first_name || ' ' || c.last_name ILIKE $${params.length})`;
        }

        params.push(limit, offset);
        const result = await query(
            `SELECT i.*,
                COALESCE(c.first_name || ' ' || c.last_name, 'Consumidor Final') as customer_name,
                c.rnc
             FROM invoices i
             LEFT JOIN customers c ON i.customer_id = c.id
             ${where}
             ORDER BY i.created_at DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );
        return result.rows;
    }

    // ─── OBTENER FACTURA POR ID ───────────────────────────────────────────────

    async getById(id) {
        const result = await query(
            `SELECT i.*,
                COALESCE(c.first_name || ' ' || c.last_name, 'Consumidor Final') as customer_name,
                c.rnc, c.email as customer_email,
                p.payment_method, p.status as payment_status
             FROM invoices i
             LEFT JOIN customers c ON i.customer_id = c.id
             LEFT JOIN payments p ON i.payment_id = p.id
             WHERE i.id = $1`,
            [id]
        );
        if (result.rows.length === 0) throw new Error('Factura no encontrada');
        return result.rows[0];
    }

    // ─── SIGUIENTE NÚMERO DE FACTURA ──────────────────────────────────────────

    async _nextInvoiceNumber() {
        const result = await query(
            `SELECT COALESCE(MAX(invoice_number), 0) + 1 as next_number FROM invoices`
        );
        return result.rows[0].next_number;
    }

    // ─── ESTADÍSTICAS DE FACTURACIÓN ─────────────────────────────────────────

    async getStats({ startDate, endDate }) {
        const params = [];
        let dateFilter = '';
        if (startDate) { params.push(startDate); dateFilter += ` AND created_at >= $${params.length}`; }
        if (endDate)   { params.push(endDate);   dateFilter += ` AND created_at <= $${params.length}`; }

        const result = await query(
            `SELECT
                COUNT(*) as total_invoices,
                COALESCE(SUM(CASE WHEN total > 0 THEN total END), 0) as total_revenue,
                COALESCE(SUM(CASE WHEN total < 0 THEN ABS(total) END), 0) as total_refunds,
                COALESCE(SUM(tax_amount), 0) as total_tax
             FROM invoices
             WHERE 1=1 ${dateFilter}`,
            params
        );
        return result.rows[0];
    }
}

module.exports = new InvoiceService();
