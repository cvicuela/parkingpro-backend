-- =====================================================
-- MIGRACIÓN 024: Controles de Concurrencia
-- Previene race conditions: doble-cobro, doble-apertura de caja,
-- actualizaciones simultáneas de ocupación de planes
-- =====================================================

-- =============================================================================
-- 1. RPC: lock_session_for_payment
-- Bloquea una sesión para procesamiento de pago (evita doble cobro)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.lock_session_for_payment(
    p_token      TEXT,
    p_session_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_user_id UUID;
    v_role    VARCHAR;
    v_session RECORD;
BEGIN
    SELECT r.user_id, r.user_role INTO v_user_id, v_role
    FROM require_role(p_token, ARRAY['operator','admin','super_admin']) r;

    -- Intentar bloquear la sesión; SKIP LOCKED devuelve vacío si otro proceso ya la tiene
    SELECT * INTO v_session
    FROM parking_sessions
    WHERE id = p_session_id
    FOR UPDATE SKIP LOCKED;

    IF v_session IS NULL THEN
        RETURN jsonb_build_object(
            'success', true,
            'locked', false,
            'message', 'La sesión está siendo procesada por otro operador'
        );
    END IF;

    IF v_session.payment_status = 'paid' THEN
        RETURN jsonb_build_object(
            'success', false,
            'locked', false,
            'message', 'Esta sesión ya fue pagada'
        );
    END IF;

    IF v_session.status NOT IN ('active', 'paid') THEN
        RETURN jsonb_build_object(
            'success', false,
            'locked', false,
            'message', 'La sesión no está en un estado válido para cobro'
        );
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'locked', true,
        'session_id', p_session_id,
        'status', v_session.status,
        'payment_status', v_session.payment_status,
        'vehicle_plate', v_session.vehicle_plate,
        'calculated_amount', v_session.calculated_amount
    );
EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$;

-- =============================================================================
-- 2. RPC: atomic_session_exit
-- Salida atómica: bloquea + calcula + cobra + cierra en una sola transacción
-- =============================================================================

CREATE OR REPLACE FUNCTION public.atomic_session_exit(
    p_token          TEXT,
    p_session_id     UUID,
    p_payment_method VARCHAR,
    p_metadata       JSONB DEFAULT '{}'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_user_id         UUID;
    v_role            VARCHAR;
    v_session         RECORD;
    v_amount          DECIMAL(10,2);
    v_tax_rate        DECIMAL(5,4) := 0.18;
    v_tax_amount      DECIMAL(10,2);
    v_total_amount    DECIMAL(10,2);
    v_payment_id      UUID;
    v_register_id     UUID;
    v_invoice_id      UUID;
    v_invoice_number  VARCHAR(50);
    v_ncf             VARCHAR(30);
    v_verification    VARCHAR(10);
    v_method_norm     VARCHAR(20);
    v_receipt         JSONB;
BEGIN
    SELECT r.user_id, r.user_role INTO v_user_id, v_role
    FROM require_role(p_token, ARRAY['operator','admin','super_admin']) r;

    -- 1. Bloquear la sesión atómicamente (FOR UPDATE)
    SELECT ps.*, p.name AS plan_name
    INTO v_session
    FROM parking_sessions ps
    LEFT JOIN plans p ON ps.plan_id = p.id
    WHERE ps.id = p_session_id
    FOR UPDATE;

    IF v_session IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Sesión no encontrada');
    END IF;

    -- 2. Verificar estado
    IF v_session.status != 'active' THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'La sesión no está activa (estado: ' || v_session.status || ')'
        );
    END IF;

    IF v_session.payment_status = 'paid' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Esta sesión ya fue pagada');
    END IF;

    -- 3. Calcular tarifa
    v_amount       := COALESCE(v_session.calculated_amount, 0);
    v_tax_amount   := ROUND(v_amount * v_tax_rate, 2);
    v_total_amount := v_amount + v_tax_amount;
    v_verification := LPAD(FLOOR(RANDOM() * 1000000)::TEXT, 6, '0');

    -- Normalizar método de pago para caja (cardnet/stripe -> card)
    IF p_payment_method IN ('cardnet', 'stripe') THEN
        v_method_norm := 'card';
    ELSE
        v_method_norm := p_payment_method;
    END IF;

    -- 4. Crear pago
    INSERT INTO payments (
        amount, tax_amount, total_amount, currency, status,
        payment_method, paid_at, metadata
    ) VALUES (
        v_amount, v_tax_amount, v_total_amount, 'DOP', 'paid',
        p_payment_method, NOW(),
        jsonb_build_object(
            'sessionId',          v_session.id,
            'plate',              v_session.vehicle_plate,
            'verification_code',  v_verification,
            'atomic',             true
        ) || p_metadata
    )
    RETURNING id INTO v_payment_id;

    -- 5. Registrar transacción en caja activa
    SELECT id INTO v_register_id FROM cash_registers
    WHERE operator_id = v_user_id AND status = 'open'
    LIMIT 1;

    IF v_register_id IS NOT NULL THEN
        INSERT INTO cash_register_transactions (
            cash_register_id, type, amount, direction,
            payment_id, parking_session_id, operator_id,
            description, payment_method
        ) VALUES (
            v_register_id, 'payment', v_total_amount, 'in',
            v_payment_id, v_session.id, v_user_id,
            'Cobro estacionamiento ' || v_session.vehicle_plate,
            v_method_norm
        );
    END IF;

    -- 6. Generar número de factura
    SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM '[0-9]+$') AS INT)), 0) + 1
    INTO v_invoice_id FROM invoices;
    v_invoice_number := 'PP-' || TO_CHAR(NOW(), 'YYYY') || '-' || LPAD(v_invoice_id::TEXT, 4, '0');

    -- Obtener NCF si hay secuencia disponible
    BEGIN
        SELECT prefix || LPAD(current_number::TEXT, 8, '0') INTO v_ncf
        FROM ncf_sequences
        WHERE ncf_type = '02' AND status = 'active' AND current_number <= end_number
        LIMIT 1;

        IF v_ncf IS NOT NULL THEN
            UPDATE ncf_sequences
            SET current_number = current_number + 1
            WHERE ncf_type = '02' AND status = 'active' AND current_number <= end_number;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        v_ncf := NULL;
    END;

    INSERT INTO invoices (payment_id, invoice_number, ncf, subtotal, tax_amount, total, status, issued_at)
    VALUES (v_payment_id, v_invoice_number, v_ncf, v_amount, v_tax_amount, v_total_amount, 'issued', NOW());

    -- 7. Cerrar la sesión
    UPDATE parking_sessions SET
        payment_id     = v_payment_id,
        paid_amount    = v_total_amount,
        payment_status = 'paid',
        status         = 'closed',
        exit_time      = COALESCE(exit_time, NOW()),
        updated_at     = NOW()
    WHERE id = v_session.id;

    -- 8. Actualizar ocupación del plan
    IF v_session.plan_id IS NOT NULL THEN
        UPDATE plans SET
            current_occupancy = GREATEST(0, COALESCE(current_occupancy, 1) - 1),
            updated_at = NOW()
        WHERE id = v_session.plan_id;
    END IF;

    -- 9. Audit log
    INSERT INTO audit_logs (user_id, action, entity_type, entity_id, changes)
    VALUES (v_user_id, 'atomic_session_exit', 'payment', v_payment_id,
        jsonb_build_object(
            'amount',      v_total_amount,
            'method',      p_payment_method,
            'plate',       v_session.vehicle_plate,
            'session_id',  v_session.id,
            'register_id', v_register_id
        ));

    -- 10. Construir recibo
    v_receipt := jsonb_build_object(
        'plateNumber',      v_session.vehicle_plate,
        'invoiceNumber',    v_invoice_number,
        'ncf',              v_ncf,
        'subtotal',         v_amount,
        'tax',              v_tax_amount,
        'total',            v_total_amount,
        'paymentMethod',    p_payment_method,
        'entryTime',        v_session.entry_time,
        'exitTime',         NOW(),
        'hours',            CEIL(EXTRACT(EPOCH FROM (NOW() - v_session.entry_time)) / 3600),
        'code',             'REC-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD(FLOOR(RANDOM() * 100000)::TEXT, 5, '0'),
        'verification_code', v_verification,
        'paymentId',        v_payment_id
    );

    RETURN jsonb_build_object('success', true, 'data', jsonb_build_object('receipt', v_receipt));
EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$;

-- =============================================================================
-- 3. RPC: safe_open_cash_register
-- Apertura segura de caja (previene duplicados por operador)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.safe_open_cash_register(
    p_token TEXT,
    p_data  JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_user_id         UUID;
    v_role            VARCHAR;
    v_operator_id     UUID;
    v_opening_balance DECIMAL(10,2);
    v_name            VARCHAR(100);
    v_existing_id     UUID;
    v_new_id          UUID;
    v_result          JSON;
BEGIN
    SELECT r.user_id, r.user_role INTO v_user_id, v_role
    FROM require_role(p_token, ARRAY['operator','admin','super_admin']) r;

    v_opening_balance := COALESCE(
        (p_data->>'openingBalance')::DECIMAL,
        (p_data->>'opening_balance')::DECIMAL,
        0
    );
    v_name := COALESCE(p_data->>'name', 'Caja Principal');

    -- Determinar operador objetivo
    IF v_role IN ('admin', 'super_admin') AND (p_data->>'operatorId') IS NOT NULL AND (p_data->>'operatorId') != '' THEN
        v_operator_id := (p_data->>'operatorId')::UUID;
    ELSE
        v_operator_id := v_user_id;
    END IF;

    -- Bloquear fila con FOR UPDATE para prevenir apertura doble concurrente
    SELECT id INTO v_existing_id
    FROM cash_registers
    WHERE operator_id = v_operator_id AND status = 'open'
    FOR UPDATE SKIP LOCKED;

    -- Si no se pudo bloquear (otra transacción la tiene), buscar sin lock
    IF v_existing_id IS NULL THEN
        SELECT id INTO v_existing_id
        FROM cash_registers
        WHERE operator_id = v_operator_id AND status = 'open'
        LIMIT 1;
    END IF;

    IF v_existing_id IS NOT NULL THEN
        -- Ya existe una caja abierta: devolver la existente
        SELECT row_to_json(cr) INTO v_result
        FROM (
            SELECT c.*,
                COALESCE(SUM(CASE WHEN t.direction = 'in' THEN t.amount ELSE 0 END), 0) AS total_in,
                COALESCE(SUM(CASE WHEN t.direction = 'out' THEN t.amount ELSE 0 END), 0) AS total_out,
                COALESCE(SUM(CASE WHEN t.direction = 'in' AND (t.payment_method = 'cash' OR t.payment_method IS NULL) THEN t.amount ELSE 0 END), 0) AS cash_in,
                COALESCE(SUM(CASE WHEN t.direction = 'in' AND t.payment_method = 'card' THEN t.amount ELSE 0 END), 0) AS total_card,
                COALESCE(SUM(CASE WHEN t.direction = 'in' AND t.payment_method = 'transfer' THEN t.amount ELSE 0 END), 0) AS total_transfer,
                COUNT(CASE WHEN t.type = 'payment' THEN 1 END) AS payment_count
            FROM cash_registers c
            LEFT JOIN cash_register_transactions t ON t.cash_register_id = c.id
            WHERE c.id = v_existing_id
            GROUP BY c.id
        ) cr;
        RETURN jsonb_build_object('success', true, 'data', v_result, 'already_open', true);
    END IF;

    -- Crear nueva caja
    INSERT INTO cash_registers (name, operator_id, status, opened_at, opening_balance, opened_by)
    VALUES (v_name, v_operator_id, 'open', NOW(), v_opening_balance, v_user_id)
    RETURNING id INTO v_new_id;

    -- Fondo inicial
    IF v_opening_balance > 0 THEN
        INSERT INTO cash_register_transactions (
            cash_register_id, type, amount, direction, operator_id, description, payment_method
        ) VALUES (
            v_new_id, 'opening_float', v_opening_balance, 'in', v_operator_id, 'Fondo inicial de caja', 'cash'
        );
    END IF;

    -- Audit log
    INSERT INTO audit_logs (user_id, action, entity_type, entity_id, changes)
    VALUES (v_user_id, 'cash_register_opened', 'cash_register', v_new_id,
        jsonb_build_object('opening_balance', v_opening_balance, 'operator_id', v_operator_id));

    SELECT row_to_json(c) INTO v_result FROM cash_registers c WHERE c.id = v_new_id;
    RETURN jsonb_build_object('success', true, 'data', v_result, 'already_open', false);
EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$;
