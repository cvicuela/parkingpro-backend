const { query, transaction } = require('../config/database');

/**
 * Servicio de gestión de tarjetas RFID
 * Maneja registro, asignación y control de tarjetas para acceso al parqueo
 */
class RFIDService {

    /**
     * Validar formato de UID (4, 7 o 10 bytes hex)
     */
    validateUidFormat(cardUid) {
        const uid = cardUid.replace(/[:\- ]/g, '').toUpperCase();
        const validLengths = [8, 14, 20]; // 4, 7, 10 bytes en hex
        if (!/^[0-9A-F]+$/.test(uid) || !validLengths.includes(uid.length)) {
            throw new Error(
                `Formato de UID inválido. Se esperan 4, 7 o 10 bytes en hexadecimal (${uid.length / 2} bytes detectados)`
            );
        }
        return uid;
    }

    /**
     * Registrar una nueva tarjeta RFID
     */
    async registerCard(cardUid, cardType, label = null) {
        const uid = this.validateUidFormat(cardUid);

        if (!['permanent', 'temporary'].includes(cardType)) {
            throw new Error('Tipo de tarjeta inválido. Debe ser "permanent" o "temporary"');
        }

        // Verificar si ya existe
        const existing = await query(
            'SELECT id FROM rfid_cards WHERE card_uid = $1',
            [uid]
        );
        if (existing.rows.length > 0) {
            throw new Error(`Ya existe una tarjeta con UID ${uid}`);
        }

        // Verificar límite de tarjetas temporales
        if (cardType === 'temporary') {
            const maxResult = await query(
                "SELECT value FROM settings WHERE key = 'rfid_max_temporary_cards'"
            );
            const maxTemporary = parseInt(maxResult.rows[0]?.value || '100');

            const countResult = await query(
                "SELECT COUNT(*) as count FROM rfid_cards WHERE card_type = 'temporary'"
            );
            const currentCount = parseInt(countResult.rows[0].count);

            if (currentCount >= maxTemporary) {
                throw new Error(
                    `Límite de tarjetas temporales alcanzado (${maxTemporary}). No se pueden registrar más.`
                );
            }
        }

        // Auto-generar label si no se proporciona
        if (!label) {
            const countResult = await query('SELECT COUNT(*) as count FROM rfid_cards');
            const nextNumber = parseInt(countResult.rows[0].count) + 1;
            label = `Tarjeta #${String(nextNumber).padStart(3, '0')}`;
        }

        const result = await query(
            `INSERT INTO rfid_cards (card_uid, card_type, status, label)
             VALUES ($1, $2, 'available', $3)
             RETURNING *`,
            [uid, cardType, label]
        );

        return result.rows[0];
    }

    /**
     * Buscar tarjeta por UID (case-insensitive)
     */
    async findByUid(cardUid) {
        const uid = cardUid.replace(/[:\- ]/g, '').toUpperCase();

        const result = await query(
            `SELECT rc.*,
                    c.first_name || ' ' || c.last_name as customer_name,
                    c.email as customer_email,
                    s.id as subscription_id,
                    p.name as plan_name
             FROM rfid_cards rc
             LEFT JOIN customers c ON rc.customer_id = c.id
             LEFT JOIN subscriptions s ON rc.subscription_id = s.id
             LEFT JOIN plans p ON s.plan_id = p.id
             WHERE UPPER(rc.card_uid) = $1`,
            [uid]
        );

        return result.rows[0] || null;
    }

    /**
     * Buscar tarjeta por UUID
     */
    async findById(cardId) {
        const result = await query(
            'SELECT * FROM rfid_cards WHERE id = $1',
            [cardId]
        );
        return result.rows[0] || null;
    }

    /**
     * Listar tarjetas con filtros opcionales
     */
    async listCards(filters = {}) {
        let queryText = `
            SELECT rc.*,
                   c.first_name || ' ' || c.last_name as customer_name,
                   p.name as plan_name
            FROM rfid_cards rc
            LEFT JOIN customers c ON rc.customer_id = c.id
            LEFT JOIN subscriptions s ON rc.subscription_id = s.id
            LEFT JOIN plans p ON s.plan_id = p.id
            WHERE 1=1
        `;

        const params = [];
        let paramCount = 1;

        if (filters.cardType) {
            queryText += ` AND rc.card_type = $${paramCount}`;
            params.push(filters.cardType);
            paramCount++;
        }

        if (filters.status) {
            queryText += ` AND rc.status = $${paramCount}`;
            params.push(filters.status);
            paramCount++;
        }

        if (filters.search) {
            queryText += ` AND (
                rc.card_uid ILIKE $${paramCount}
                OR rc.label ILIKE $${paramCount}
                OR c.first_name ILIKE $${paramCount}
                OR c.last_name ILIKE $${paramCount}
            )`;
            params.push(`%${filters.search}%`);
            paramCount++;
        }

        queryText += ' ORDER BY rc.created_at DESC';

        if (filters.limit) {
            queryText += ` LIMIT $${paramCount}`;
            params.push(filters.limit);
            paramCount++;
        }

        if (filters.offset) {
            queryText += ` OFFSET $${paramCount}`;
            params.push(filters.offset);
            paramCount++;
        }

        const result = await query(queryText, params);
        return result.rows;
    }

    /**
     * Obtener estadísticas del pool de tarjetas
     */
    async getPoolStats() {
        const result = await query(`
            SELECT
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE status = 'available') as available,
                COUNT(*) FILTER (WHERE status = 'assigned') as assigned,
                COUNT(*) FILTER (WHERE status = 'in_use') as in_use,
                COUNT(*) FILTER (WHERE status = 'lost') as lost,
                COUNT(*) FILTER (WHERE status = 'disabled') as disabled,
                COUNT(*) FILTER (WHERE card_type = 'permanent') as permanent,
                COUNT(*) FILTER (WHERE card_type = 'temporary') as temporary
            FROM rfid_cards
        `);

        const row = result.rows[0];
        return {
            total: parseInt(row.total),
            available: parseInt(row.available),
            assigned: parseInt(row.assigned),
            in_use: parseInt(row.in_use),
            lost: parseInt(row.lost),
            disabled: parseInt(row.disabled),
            byType: {
                permanent: parseInt(row.permanent),
                temporary: parseInt(row.temporary)
            }
        };
    }

    /**
     * Asignar tarjeta permanente a una suscripción
     * Supports multiple cards per subscription via rfid_cards.subscription_id (many-to-one)
     */
    async assignPermanentCard(cardId, subscriptionId) {
        return await transaction(async (client) => {
            // Obtener tarjeta
            const cardResult = await client.query(
                'SELECT * FROM rfid_cards WHERE id = $1 FOR UPDATE',
                [cardId]
            );
            if (cardResult.rows.length === 0) {
                throw new Error('Tarjeta no encontrada');
            }
            const card = cardResult.rows[0];

            if (card.status !== 'available') {
                throw new Error(`La tarjeta no está disponible (estado actual: ${card.status})`);
            }
            if (card.card_type !== 'permanent') {
                throw new Error('Solo se pueden asignar tarjetas permanentes a suscripciones');
            }

            // Obtener suscripción para el customer_id
            const subResult = await client.query(
                'SELECT * FROM subscriptions WHERE id = $1',
                [subscriptionId]
            );
            if (subResult.rows.length === 0) {
                throw new Error('Suscripción no encontrada');
            }
            const subscription = subResult.rows[0];

            // Actualizar tarjeta con subscription_id y customer_id (many-to-one)
            const updatedCard = await client.query(
                `UPDATE rfid_cards
                 SET status = 'assigned',
                     subscription_id = $1,
                     customer_id = $2,
                     assigned_at = NOW(),
                     updated_at = NOW()
                 WHERE id = $3
                 RETURNING *`,
                [subscriptionId, subscription.customer_id, cardId]
            );

            return updatedCard.rows[0];
        });
    }

    /**
     * Asignar tarjeta temporal para parqueo por hora
     */
    async assignTemporaryCard(cardId, vehiclePlate) {
        const cardResult = await query(
            'SELECT * FROM rfid_cards WHERE id = $1',
            [cardId]
        );
        if (cardResult.rows.length === 0) {
            throw new Error('Tarjeta no encontrada');
        }
        const card = cardResult.rows[0];

        if (card.status !== 'available') {
            throw new Error(`La tarjeta no está disponible (estado actual: ${card.status})`);
        }
        if (card.card_type !== 'temporary') {
            throw new Error('Solo se pueden asignar tarjetas temporales para parqueo por hora');
        }

        const result = await query(
            `UPDATE rfid_cards
             SET status = 'assigned',
                 assigned_at = NOW(),
                 metadata = jsonb_set(COALESCE(metadata, '{}'), '{vehicle_plate}', to_jsonb($1::text)),
                 updated_at = NOW()
             WHERE id = $2
             RETURNING *`,
            [vehiclePlate.toUpperCase().trim(), cardId]
        );

        return result.rows[0];
    }

    /**
     * Activar tarjeta (primer escaneo en entrada)
     */
    async activateCard(cardId) {
        const cardResult = await query(
            'SELECT * FROM rfid_cards WHERE id = $1',
            [cardId]
        );
        if (cardResult.rows.length === 0) {
            throw new Error('Tarjeta no encontrada');
        }
        const card = cardResult.rows[0];

        if (card.status !== 'assigned') {
            throw new Error(`La tarjeta debe estar asignada para activarse (estado actual: ${card.status})`);
        }

        const result = await query(
            `UPDATE rfid_cards
             SET status = 'in_use', updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [cardId]
        );

        return result.rows[0];
    }

    /**
     * Devolver tarjeta temporal al pool
     */
    async returnTemporaryCard(cardId) {
        return await transaction(async (client) => {
            const cardResult = await client.query(
                'SELECT * FROM rfid_cards WHERE id = $1 FOR UPDATE',
                [cardId]
            );
            if (cardResult.rows.length === 0) {
                throw new Error('Tarjeta no encontrada');
            }
            const card = cardResult.rows[0];

            if (card.card_type !== 'temporary') {
                throw new Error('Solo se pueden devolver tarjetas temporales con este método');
            }

            const result = await client.query(
                `UPDATE rfid_cards
                 SET status = 'available',
                     customer_id = NULL,
                     returned_at = NOW(),
                     metadata = jsonb_set(COALESCE(metadata, '{}'), '{vehicle_plate}', 'null'),
                     updated_at = NOW()
                 WHERE id = $1
                 RETURNING *`,
                [cardId]
            );

            return result.rows[0];
        });
    }

    /**
     * Reportar tarjeta perdida
     */
    async reportLostCard(cardId, operatorId = null) {
        const cardResult = await query(
            'SELECT * FROM rfid_cards WHERE id = $1',
            [cardId]
        );
        if (cardResult.rows.length === 0) {
            throw new Error('Tarjeta no encontrada');
        }
        const card = cardResult.rows[0];

        // Obtener monto de penalidad
        let penaltyAmount = parseFloat(card.lost_penalty || '0');
        if (!penaltyAmount) {
            const settingResult = await query(
                "SELECT value FROM settings WHERE key = 'rfid_lost_card_penalty'"
            );
            penaltyAmount = parseFloat(settingResult.rows[0]?.value || '500.00');
        }

        // Marcar como perdida
        await query(
            `UPDATE rfid_cards
             SET status = 'lost',
                 metadata = jsonb_set(
                     COALESCE(metadata, '{}'),
                     '{lost_reported_by}',
                     to_jsonb($1::text)
                 ),
                 updated_at = NOW()
             WHERE id = $2`,
            [operatorId, cardId]
        );

        // Si es temporal, limpiar sesión de parqueo activa vinculada
        if (card.card_type === 'temporary') {
            await query(
                `UPDATE parking_sessions
                 SET status = 'cancelled',
                     exit_time = NOW(),
                     notes = 'Tarjeta RFID reportada como perdida',
                     updated_at = NOW()
                 WHERE rfid_card_id = $1
                   AND status = 'active'`,
                [cardId]
            );
        }

        // Re-fetch updated card
        const updatedCard = await query(
            'SELECT * FROM rfid_cards WHERE id = $1',
            [cardId]
        );

        return {
            card: updatedCard.rows[0],
            penaltyAmount
        };
    }

    /**
     * Deshabilitar tarjeta
     */
    async disableCard(cardId) {
        const cardResult = await query(
            'SELECT * FROM rfid_cards WHERE id = $1',
            [cardId]
        );
        if (cardResult.rows.length === 0) {
            throw new Error('Tarjeta no encontrada');
        }

        const result = await query(
            `UPDATE rfid_cards
             SET status = 'disabled', updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [cardId]
        );

        return result.rows[0];
    }

    /**
     * Re-habilitar tarjeta deshabilitada
     */
    async enableCard(cardId) {
        const cardResult = await query(
            'SELECT * FROM rfid_cards WHERE id = $1',
            [cardId]
        );
        if (cardResult.rows.length === 0) {
            throw new Error('Tarjeta no encontrada');
        }
        if (cardResult.rows[0].status !== 'disabled') {
            throw new Error('Solo se pueden habilitar tarjetas deshabilitadas');
        }

        const result = await query(
            `UPDATE rfid_cards
             SET status = 'available', updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [cardId]
        );

        return result.rows[0];
    }

    /**
     * Desvincular tarjeta permanente de suscripción
     */
    async unlinkFromSubscription(cardId) {
        return await transaction(async (client) => {
            const cardResult = await client.query(
                'SELECT * FROM rfid_cards WHERE id = $1 FOR UPDATE',
                [cardId]
            );
            if (cardResult.rows.length === 0) {
                throw new Error('Tarjeta no encontrada');
            }
            const card = cardResult.rows[0];

            if (!card.subscription_id) {
                throw new Error('La tarjeta no está vinculada a ninguna suscripción');
            }

            // Limpiar tarjeta (subscription_id y customer_id)
            const result = await client.query(
                `UPDATE rfid_cards
                 SET status = 'available',
                     subscription_id = NULL,
                     customer_id = NULL,
                     updated_at = NOW()
                 WHERE id = $1
                 RETURNING *`,
                [cardId]
            );

            return result.rows[0];
        });
    }

    /**
     * Resolver tarjeta para control de acceso
     * Método clave para integración con el sistema de acceso
     */
    async resolveCardForAccess(cardUid) {
        const card = await this.findByUid(cardUid);

        if (!card) {
            return {
                allowed: false,
                reason: 'CARD_NOT_FOUND',
                message: 'Tarjeta no registrada en el sistema'
            };
        }

        if (card.status === 'disabled') {
            return {
                allowed: false,
                reason: 'CARD_DISABLED',
                message: 'Tarjeta deshabilitada',
                card
            };
        }

        if (card.status === 'lost') {
            return {
                allowed: false,
                reason: 'CARD_LOST',
                message: 'Tarjeta reportada como perdida',
                card
            };
        }

        // Tarjeta permanente con suscripción
        if (card.card_type === 'permanent' && card.subscription_id) {
            const subResult = await query(
                `SELECT s.*,
                        p.name as plan_name,
                        p.type as plan_type,
                        c.first_name || ' ' || c.last_name as customer_name,
                        v.plate as vehicle_plate
                 FROM subscriptions s
                 JOIN plans p ON s.plan_id = p.id
                 JOIN customers c ON s.customer_id = c.id
                 LEFT JOIN vehicles v ON s.vehicle_id = v.id
                 WHERE s.id = $1`,
                [card.subscription_id]
            );

            const subscription = subResult.rows[0];
            if (!subscription) {
                return {
                    allowed: false,
                    reason: 'SUBSCRIPTION_NOT_FOUND',
                    message: 'Suscripción vinculada no encontrada',
                    card
                };
            }

            return {
                allowed: true,
                accessType: 'subscription',
                subscription,
                card
            };
        }

        // Tarjeta temporal asignada o en uso
        if (card.card_type === 'temporary' && (card.status === 'assigned' || card.status === 'in_use')) {
            return {
                allowed: true,
                accessType: 'hourly',
                card
            };
        }

        // Tarjeta disponible pero no asignada, u otro estado inesperado
        return {
            allowed: false,
            reason: 'CARD_NOT_ASSIGNED',
            message: 'Tarjeta no está asignada a ningún usuario o sesión',
            card
        };
    }

    /**
     * Listar tarjetas RFID por cliente
     */
    async listCardsByCustomer(customerId) {
        const result = await query(
            `SELECT rc.*,
                    s.id as subscription_id,
                    s.status as subscription_status,
                    p.name as plan_name,
                    p.type as plan_type
             FROM rfid_cards rc
             LEFT JOIN subscriptions s ON rc.subscription_id = s.id
             LEFT JOIN plans p ON s.plan_id = p.id
             WHERE rc.customer_id = $1
             ORDER BY rc.created_at DESC`,
            [customerId]
        );
        return result.rows;
    }

    /**
     * Listar tarjetas RFID por suscripción
     */
    async listCardsBySubscription(subscriptionId) {
        const result = await query(
            `SELECT rc.*
             FROM rfid_cards rc
             WHERE rc.subscription_id = $1
             ORDER BY rc.created_at DESC`,
            [subscriptionId]
        );
        return result.rows;
    }
}

module.exports = new RFIDService();
