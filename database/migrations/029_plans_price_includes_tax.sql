-- ============================================
-- MIGRACIÓN 029: Precios de planes con ITBIS incluido
-- Los precios ahora se almacenan CON ITBIS (18%) incluido.
-- El sistema extrae subtotal e ITBIS automáticamente.
-- ============================================

-- Agregar columna para indicar que el precio incluye impuesto
ALTER TABLE plans ADD COLUMN IF NOT EXISTS price_includes_tax BOOLEAN DEFAULT TRUE;

-- Agregar columna tax_rate a nivel de plan (por defecto 18% ITBIS)
ALTER TABLE plans ADD COLUMN IF NOT EXISTS tax_rate DECIMAL(5,4) DEFAULT 0.1800;

-- Actualizar precios existentes para incluir ITBIS (base_price * 1.18)
-- Solo si los precios actuales NO incluyen ITBIS (primera vez que se ejecuta)
DO $$
BEGIN
    -- Verificar si ya se actualizaron (si price_includes_tax ya existía como true, no actualizar)
    IF EXISTS (
        SELECT 1 FROM plans WHERE price_includes_tax IS NULL OR price_includes_tax = FALSE
    ) THEN
        -- Actualizar precios de suscripción (diurno, nocturno, 24h) para incluir ITBIS
        UPDATE plans
        SET base_price = ROUND(base_price * 1.18, 2),
            weekly_price = CASE WHEN weekly_price IS NOT NULL THEN ROUND(weekly_price * 1.18, 2) ELSE NULL END,
            overage_hourly_rate = ROUND(overage_hourly_rate * 1.18, 2),
            additional_vehicle_monthly = ROUND(additional_vehicle_monthly * 1.18, 2),
            price_includes_tax = TRUE
        WHERE type IN ('diurno', 'nocturno', '24h');

        -- Actualizar precios de plan por hora
        UPDATE plans
        SET base_price = ROUND(base_price * 1.18, 2),
            overage_hourly_rate = ROUND(overage_hourly_rate * 1.18, 2),
            price_includes_tax = TRUE
        WHERE type = 'hourly';

        -- Actualizar tarifas por hora para incluir ITBIS
        UPDATE hourly_rates
        SET rate = ROUND(rate * 1.18, 2),
            updated_at = NOW();
    END IF;
END $$;

-- Función helper para extraer subtotal de un precio con ITBIS incluido
CREATE OR REPLACE FUNCTION extract_subtotal(price_with_tax DECIMAL, tax_rate DECIMAL DEFAULT 0.18)
RETURNS DECIMAL AS $$
BEGIN
    RETURN ROUND(price_with_tax / (1 + tax_rate), 2);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Función helper para extraer el monto de ITBIS de un precio con ITBIS incluido
CREATE OR REPLACE FUNCTION extract_tax(price_with_tax DECIMAL, tax_rate DECIMAL DEFAULT 0.18)
RETURNS DECIMAL AS $$
BEGIN
    RETURN price_with_tax - ROUND(price_with_tax / (1 + tax_rate), 2);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Comentarios
COMMENT ON COLUMN plans.price_includes_tax IS 'Si true, base_price ya incluye ITBIS (18%)';
COMMENT ON COLUMN plans.tax_rate IS 'Tasa de impuesto aplicable (0.18 = 18% ITBIS)';
COMMENT ON FUNCTION extract_subtotal IS 'Extrae subtotal de un precio con ITBIS incluido';
COMMENT ON FUNCTION extract_tax IS 'Extrae el monto de ITBIS de un precio con ITBIS incluido';

-- ============================================
-- Actualizar calculate_hourly para devolver desglose ITBIS
-- ============================================
CREATE OR REPLACE FUNCTION calculate_hourly(p_token TEXT, p_data JSON)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id UUID;
  v_plan_id UUID;
  v_entry_time TIMESTAMPTZ;
  v_exit_time TIMESTAMPTZ;
  v_tolerance INT;
  v_total_minutes INT;
  v_total_hours INT;
  v_amount DECIMAL := 0;
  v_rates RECORD;
  v_hour_rate DECIMAL;
  v_breakdown JSON;
  v_i INT;
  v_price_includes_tax BOOLEAN;
  v_tax_rate DECIMAL;
  v_subtotal DECIMAL;
  v_tax_amount DECIMAL;
BEGIN
  SELECT r.user_id INTO v_user_id
  FROM require_role(p_token, ARRAY['admin', 'super_admin', 'operator']) r;

  v_plan_id := (p_data->>'planId')::UUID;
  v_entry_time := COALESCE((p_data->>'entryTime')::TIMESTAMPTZ, (p_data->>'entry_time')::TIMESTAMPTZ);
  v_exit_time := COALESCE((p_data->>'exitTime')::TIMESTAMPTZ, (p_data->>'exit_time')::TIMESTAMPTZ, NOW());

  -- Get tolerance and tax config
  SELECT COALESCE(tolerance_minutes, 5), COALESCE(price_includes_tax, true), COALESCE(tax_rate, 0.18)
  INTO v_tolerance, v_price_includes_tax, v_tax_rate
  FROM plans WHERE id = v_plan_id;

  -- Calculate minutes
  v_total_minutes := EXTRACT(EPOCH FROM (v_exit_time - v_entry_time))::INT / 60;

  -- Within tolerance = free
  IF v_total_minutes <= v_tolerance THEN
    RETURN json_build_object('success', true, 'data', json_build_object(
      'amount', 0, 'subtotal', 0, 'tax', 0, 'taxRate', v_tax_rate,
      'totalMinutes', v_total_minutes, 'totalHours', 0, 'isFree', true,
      'priceIncludesTax', v_price_includes_tax,
      'breakdown', json_build_array(json_build_object('hour', 0, 'rate', 0, 'description', 'Gratis (tolerancia de ' || v_tolerance || ' min)'))
    ));
  END IF;

  -- Subtract tolerance
  v_total_minutes := v_total_minutes - v_tolerance;
  v_total_hours := CEIL(v_total_minutes::DECIMAL / 60);

  -- Build breakdown
  SELECT COALESCE(json_agg(json_build_object(
    'hour', sub.hour_num,
    'rate', sub.applied_rate,
    'description', sub.desc_text
  ) ORDER BY sub.hour_num), '[]'::json) INTO v_breakdown
  FROM (
    SELECT
      h.hour_num,
      COALESCE(
        (SELECT rate FROM hourly_rates WHERE plan_id = v_plan_id AND hour_number = h.hour_num AND is_active = true),
        (SELECT rate FROM hourly_rates WHERE plan_id = v_plan_id AND is_active = true ORDER BY hour_number DESC LIMIT 1)
      ) AS applied_rate,
      COALESCE(
        (SELECT description FROM hourly_rates WHERE plan_id = v_plan_id AND hour_number = h.hour_num AND is_active = true),
        'Hora ' || h.hour_num
      ) AS desc_text
    FROM generate_series(1, v_total_hours) AS h(hour_num)
  ) sub;

  -- Sum total
  SELECT COALESCE(SUM((elem->>'rate')::DECIMAL), 0) INTO v_amount
  FROM json_array_elements(v_breakdown) elem;

  -- Calcular desglose ITBIS
  IF v_price_includes_tax THEN
    -- El monto ya incluye ITBIS, extraer subtotal
    v_subtotal := ROUND(v_amount / (1 + v_tax_rate), 2);
    v_tax_amount := v_amount - v_subtotal;
  ELSE
    -- Monto sin ITBIS, calcular impuesto encima
    v_subtotal := v_amount;
    v_tax_amount := ROUND(v_amount * v_tax_rate, 2);
    v_amount := v_subtotal + v_tax_amount;
  END IF;

  RETURN json_build_object('success', true, 'data', json_build_object(
    'amount', v_amount,
    'subtotal', v_subtotal,
    'tax', v_tax_amount,
    'taxRate', v_tax_rate,
    'priceIncludesTax', v_price_includes_tax,
    'totalMinutes', v_total_minutes + v_tolerance,
    'totalHours', v_total_hours,
    'toleranceApplied', v_tolerance,
    'isFree', false,
    'breakdown', v_breakdown
  ));
END;
$$;

-- Alias
CREATE OR REPLACE FUNCTION calculate_parking_fee(p_token TEXT, p_data JSON)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN calculate_hourly(p_token, p_data);
END;
$$;

-- ============================================
-- Actualizar atomic_session_exit para extraer ITBIS de precios incluidos
-- ============================================
CREATE OR REPLACE FUNCTION atomic_session_exit(
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
    v_plan            RECORD;
    v_amount          DECIMAL(10,2);
    v_tax_rate        DECIMAL(5,4);
    v_tax_amount      DECIMAL(10,2);
    v_total_amount    DECIMAL(10,2);
    v_subtotal        DECIMAL(10,2);
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

    -- 3. Obtener configuración fiscal del plan
    SELECT COALESCE(price_includes_tax, true), COALESCE(tax_rate, 0.18)
    INTO v_plan
    FROM plans WHERE id = v_session.plan_id;

    v_tax_rate := COALESCE(v_plan.tax_rate, 0.18);

    -- 4. Calcular tarifa con desglose ITBIS
    v_amount := COALESCE(v_session.calculated_amount, 0);

    IF COALESCE(v_plan.price_includes_tax, true) THEN
        -- Las tarifas ya incluyen ITBIS — extraer subtotal
        v_total_amount := v_amount;
        v_subtotal := ROUND(v_amount / (1 + v_tax_rate), 2);
        v_tax_amount := v_total_amount - v_subtotal;
    ELSE
        -- Tarifas sin ITBIS — agregar impuesto
        v_subtotal := v_amount;
        v_tax_amount := ROUND(v_amount * v_tax_rate, 2);
        v_total_amount := v_subtotal + v_tax_amount;
    END IF;

    v_verification := LPAD(FLOOR(RANDOM() * 1000000)::TEXT, 6, '0');

    -- Normalizar método de pago para caja (cardnet/stripe -> card)
    IF p_payment_method IN ('cardnet', 'stripe') THEN
        v_method_norm := 'card';
    ELSE
        v_method_norm := p_payment_method;
    END IF;

    -- 5. Crear pago (amount = subtotal sin ITBIS)
    INSERT INTO payments (
        amount, tax_amount, total_amount, currency, status,
        payment_method, paid_at, metadata
    ) VALUES (
        v_subtotal, v_tax_amount, v_total_amount, 'DOP', 'paid',
        p_payment_method, NOW(),
        jsonb_build_object(
            'sessionId',          v_session.id,
            'plate',              v_session.vehicle_plate,
            'verification_code',  v_verification,
            'atomic',             true,
            'price_includes_tax', COALESCE(v_plan.price_includes_tax, true)
        ) || p_metadata
    )
    RETURNING id INTO v_payment_id;

    -- 6. Registrar transacción en caja activa
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

    -- 7. Generar número de factura
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
    VALUES (v_payment_id, v_invoice_number, v_ncf, v_subtotal, v_tax_amount, v_total_amount, 'issued', NOW());

    -- 8. Cerrar la sesión
    UPDATE parking_sessions SET
        payment_id     = v_payment_id,
        paid_amount    = v_total_amount,
        payment_status = 'paid',
        status         = 'closed',
        exit_time      = COALESCE(exit_time, NOW()),
        updated_at     = NOW()
    WHERE id = v_session.id;

    -- 9. Actualizar ocupación del plan
    IF v_session.plan_id IS NOT NULL THEN
        UPDATE plans SET
            current_occupancy = GREATEST(0, COALESCE(current_occupancy, 1) - 1),
            updated_at = NOW()
        WHERE id = v_session.plan_id;
    END IF;

    -- 10. Audit log
    INSERT INTO audit_logs (user_id, action, entity_type, entity_id, changes)
    VALUES (v_user_id, 'atomic_session_exit', 'payment', v_payment_id,
        jsonb_build_object(
            'amount',      v_total_amount,
            'subtotal',    v_subtotal,
            'tax',         v_tax_amount,
            'method',      p_payment_method,
            'plate',       v_session.vehicle_plate,
            'session_id',  v_session.id,
            'register_id', v_register_id
        ));

    -- 11. Construir recibo
    v_receipt := jsonb_build_object(
        'plateNumber',      v_session.vehicle_plate,
        'invoiceNumber',    v_invoice_number,
        'ncf',              v_ncf,
        'subtotal',         v_subtotal,
        'tax',              v_tax_amount,
        'total',            v_total_amount,
        'taxRate',          v_tax_rate,
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
