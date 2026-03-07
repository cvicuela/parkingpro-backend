const { query, transaction } = require('../config/database');
const { logAudit } = require('../middleware/audit');
const nodemailer = require('nodemailer');

// Helper: leer setting de la DB con fallback
async function getSetting(key, fallback) {
    try {
        const result = await query(`SELECT value FROM settings WHERE key = $1`, [key]);
        if (result.rows.length > 0) {
            const v = result.rows[0].value;
            return typeof v === 'string' ? v : JSON.stringify(v);
        }
    } catch {}
    return fallback;
}

class CashRegisterService {

    // ─── APERTURA DE CAJA ────────────────────────────────────────────────────

    async openRegister({ operatorId, openingBalance, name, req }) {
        // Verificar que el operador no tenga caja abierta
        const existing = await query(
            `SELECT id FROM cash_registers WHERE operator_id = $1 AND status = 'open'`,
            [operatorId]
        );
        if (existing.rows.length > 0) {
            throw new Error('Ya tienes una caja abierta. Ciérrala antes de abrir otra.');
        }

        return await transaction(async (client) => {
            const result = await client.query(
                `INSERT INTO cash_registers (name, operator_id, status, opened_at, opening_balance, opened_by)
                 VALUES ($1, $2, 'open', NOW(), $3, $2)
                 RETURNING *`,
                [name || 'Caja Principal', operatorId, openingBalance || 0]
            );
            const register = result.rows[0];

            // Registrar el fondo inicial como transacción
            if (openingBalance > 0) {
                await client.query(
                    `INSERT INTO cash_register_transactions (cash_register_id, type, amount, direction, operator_id, description)
                     VALUES ($1, 'opening_float', $2, 'in', $3, 'Fondo inicial de caja')`,
                    [register.id, openingBalance, operatorId]
                );
            }

            await logAudit({
                userId: operatorId,
                action: 'cash_register_opened',
                entityType: 'cash_register',
                entityId: register.id,
                changes: { opening_balance: openingBalance },
                req
            });

            return register;
        });
    }

    // ─── REGISTRAR COBRO EN CAJA ─────────────────────────────────────────────

    async recordPayment({ registerId, paymentId, amount, sessionId, operatorId, description, req }) {
        const registerCheck = await query(
            `SELECT id, status FROM cash_registers WHERE id = $1 AND operator_id = $2`,
            [registerId, operatorId]
        );
        if (registerCheck.rows.length === 0) {
            throw new Error('Caja no encontrada o no pertenece a este operador');
        }
        if (registerCheck.rows[0].status !== 'open') {
            throw new Error('La caja está cerrada. Ábrela antes de registrar cobros.');
        }

        const result = await query(
            `INSERT INTO cash_register_transactions
             (cash_register_id, type, amount, direction, payment_id, parking_session_id, operator_id, description)
             VALUES ($1, 'payment', $2, 'in', $3, $4, $5, $6)
             RETURNING *`,
            [registerId, amount, paymentId || null, sessionId || null, operatorId, description || 'Cobro de estacionamiento']
        );

        return result.rows[0];
    }

    // ─── REGISTRAR REEMBOLSO EN CAJA ─────────────────────────────────────────

    async recordRefund({ registerId, paymentId, amount, operatorId, req }) {
        const registerCheck = await query(
            `SELECT id, status FROM cash_registers WHERE id = $1 AND operator_id = $2`,
            [registerId, operatorId]
        );
        if (registerCheck.rows.length === 0 || registerCheck.rows[0].status !== 'open') {
            throw new Error('No hay caja abierta para este operador');
        }

        const result = await query(
            `INSERT INTO cash_register_transactions
             (cash_register_id, type, amount, direction, payment_id, operator_id, description)
             VALUES ($1, 'refund', $2, 'out', $3, $4, 'Reembolso procesado')
             RETURNING *`,
            [registerId, amount, paymentId || null, operatorId]
        );

        await logAudit({
            userId: operatorId,
            action: 'cash_refund_recorded',
            entityType: 'cash_register',
            entityId: registerId,
            changes: { amount, payment_id: paymentId },
            req
        });

        return result.rows[0];
    }

    // ─── CIERRE DE CAJA ───────────────────────────────────────────────────────

    async closeRegister({ registerId, operatorId, countedBalance, denominations, notes, req }) {
        const register = await query(
            `SELECT * FROM cash_registers WHERE id = $1 AND operator_id = $2 AND status = 'open'`,
            [registerId, operatorId]
        );
        if (register.rows.length === 0) {
            throw new Error('Caja abierta no encontrada para este operador');
        }

        // Calcular saldo esperado: fondo inicial + ingresos - egresos
        const totalsResult = await query(
            `SELECT
                COALESCE(SUM(CASE WHEN direction = 'in' THEN amount ELSE 0 END), 0) as total_in,
                COALESCE(SUM(CASE WHEN direction = 'out' THEN amount ELSE 0 END), 0) as total_out
             FROM cash_register_transactions
             WHERE cash_register_id = $1`,
            [registerId]
        );
        const { total_in, total_out } = totalsResult.rows[0];
        const expectedBalance = parseFloat(total_in) - parseFloat(total_out);
        const difference = parseFloat(countedBalance) - expectedBalance;
        const threshold = parseFloat(await getSetting('cash_diff_threshold', '200'));
        const requiresApproval = Math.abs(difference) > threshold;

        return await transaction(async (client) => {
            // Guardar desglose por denominación
            if (denominations && denominations.length > 0) {
                for (const d of denominations) {
                    if (d.quantity > 0) {
                        await client.query(
                            `INSERT INTO denomination_counts (cash_register_id, denomination, quantity)
                             VALUES ($1, $2, $3)`,
                            [registerId, d.denomination, d.quantity]
                        );
                    }
                }
            }

            const result = await client.query(
                `UPDATE cash_registers SET
                    status = 'closed',
                    closed_at = NOW(),
                    expected_balance = $1,
                    counted_balance = $2,
                    difference = $3,
                    requires_approval = $4,
                    notes = $5,
                    updated_at = NOW()
                 WHERE id = $6
                 RETURNING *`,
                [expectedBalance, countedBalance, difference, requiresApproval, notes || null, registerId]
            );

            const closed = result.rows[0];

            await logAudit({
                userId: operatorId,
                action: 'cash_register_closed',
                entityType: 'cash_register',
                entityId: registerId,
                changes: { expectedBalance, countedBalance, difference, requiresApproval },
                req
            });

            // Enviar alerta por email si hay diferencia mayor al umbral
            if (requiresApproval) {
                await this._sendDifferenceAlert({ register: closed, operatorId, difference, expectedBalance, countedBalance });
            }

            return { ...closed, requiresApproval, message: requiresApproval
                ? `Diferencia de RD$${Math.abs(difference).toFixed(2)} requiere aprobación del supervisor`
                : 'Caja cerrada correctamente'
            };
        });
    }

    // ─── APROBACIÓN DE SUPERVISOR ─────────────────────────────────────────────

    async approveClose({ registerId, supervisorId, notes, req }) {
        const result = await query(
            `UPDATE cash_registers SET
                approved_by = $1,
                approved_at = NOW(),
                approval_notes = $2
             WHERE id = $3 AND requires_approval = TRUE AND approved_by IS NULL
             RETURNING *`,
            [supervisorId, notes || null, registerId]
        );
        if (result.rows.length === 0) {
            throw new Error('Caja no encontrada o ya fue aprobada');
        }

        await logAudit({
            userId: supervisorId,
            action: 'cash_register_approved',
            entityType: 'cash_register',
            entityId: registerId,
            changes: { approval_notes: notes },
            req
        });

        return result.rows[0];
    }

    // ─── OBTENER CAJA ACTIVA DEL OPERADOR ─────────────────────────────────────

    async getActiveRegister(operatorId) {
        const result = await query(
            `SELECT cr.*,
                COALESCE(SUM(CASE WHEN crt.direction = 'in' THEN crt.amount ELSE 0 END), 0) as total_in,
                COALESCE(SUM(CASE WHEN crt.direction = 'out' THEN crt.amount ELSE 0 END), 0) as total_out,
                COUNT(CASE WHEN crt.type = 'payment' THEN 1 END) as payment_count
             FROM cash_registers cr
             LEFT JOIN cash_register_transactions crt ON crt.cash_register_id = cr.id
             WHERE cr.operator_id = $1 AND cr.status = 'open'
             GROUP BY cr.id`,
            [operatorId]
        );
        return result.rows[0] || null;
    }

    // ─── HISTORIAL DE CIERRES ─────────────────────────────────────────────────

    async getHistory({ limit = 50, offset = 0, operatorId, startDate, endDate }) {
        let whereClause = "WHERE 1=1";
        const params = [];

        if (operatorId) {
            params.push(operatorId);
            whereClause += ` AND operator_email = (SELECT email FROM users WHERE id = $${params.length})`;
        }
        if (startDate) {
            params.push(startDate);
            whereClause += ` AND opened_at >= $${params.length}`;
        }
        if (endDate) {
            params.push(endDate);
            whereClause += ` AND opened_at <= $${params.length}`;
        }

        params.push(limit, offset);
        const result = await query(
            `SELECT * FROM cash_register_summary
             ${whereClause}
             ORDER BY opened_at DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );
        return result.rows;
    }

    // ─── TRANSACCIONES DE UNA CAJA ────────────────────────────────────────────

    async getTransactions(registerId) {
        const result = await query(
            `SELECT crt.*, u.email as operator_name
             FROM cash_register_transactions crt
             LEFT JOIN users u ON crt.operator_id = u.id
             WHERE crt.cash_register_id = $1
             ORDER BY crt.created_at ASC`,
            [registerId]
        );
        return result.rows;
    }

    // ─── ALERTA POR EMAIL ─────────────────────────────────────────────────────

    async _sendDifferenceAlert({ register, operatorId, difference, expectedBalance, countedBalance }) {
        try {
            const smtpHost = process.env.SMTP_HOST;
            const smtpUser = process.env.SMTP_USER;
            const smtpPass = process.env.SMTP_PASS;

            if (!smtpHost || !smtpUser) {
                console.warn('[CashRegister] SMTP no configurado, alerta no enviada');
                return;
            }

            const transporter = nodemailer.createTransport({
                host: smtpHost,
                port: parseInt(process.env.SMTP_PORT) || 587,
                secure: false,
                auth: { user: smtpUser, pass: smtpPass }
            });

            const tipo = difference < 0 ? 'FALTANTE' : 'SOBRANTE';
            await transporter.sendMail({
                from: smtpUser,
                to: await getSetting('alert_email', 'alonsoveloz@gmail.com'),
                subject: `[ParkingPro] Alerta de Caja: ${tipo} de RD$${Math.abs(difference).toFixed(2)}`,
                html: `
                    <h2>Alerta de Cuadre de Caja</h2>
                    <p><strong>Tipo:</strong> ${tipo}</p>
                    <p><strong>Caja:</strong> ${register.name}</p>
                    <p><strong>Cierre:</strong> ${new Date().toLocaleString('es-DO')}</p>
                    <p><strong>Saldo esperado:</strong> RD$${parseFloat(expectedBalance).toFixed(2)}</p>
                    <p><strong>Saldo contado:</strong> RD$${parseFloat(countedBalance).toFixed(2)}</p>
                    <p><strong>Diferencia:</strong> RD$${difference.toFixed(2)}</p>
                    <p><em>Esta caja requiere aprobación del supervisor antes de ser archivada.</em></p>
                `
            });
        } catch (err) {
            console.error('[CashRegister] Error enviando alerta:', err.message);
        }
    }
}

module.exports = new CashRegisterService();
