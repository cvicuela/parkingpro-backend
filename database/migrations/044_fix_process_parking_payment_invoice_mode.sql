-- Migration 044: Fix process_parking_payment to respect invoice_mode setting
-- Bug: process_parking_payment always hardcoded 'B01' NCF and 'PP-YYYY-NNNN'
--      invoice numbers, ignoring the invoice_mode setting entirely.
--      When invoice_mode = 'interno', it should use internal numbering (FAC prefix).
--      When invoice_mode = 'fiscal', it should use get_next_ncf() for proper NCF.

-- If no NCF sequences exist, default invoice_mode to 'interno'
-- (prevents generating fake B01 numbers for businesses without NCF authorization)
UPDATE settings SET value = '"interno"'
WHERE key = 'invoice_mode'
  AND (value#>>'{}') = 'fiscal'
  AND NOT EXISTS (SELECT 1 FROM ncf_sequences WHERE is_active = true);

CREATE OR REPLACE FUNCTION process_parking_payment(p_token TEXT, p_data JSON)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_user_id UUID;
  v_session RECORD;
  v_payment RECORD;
  v_invoice RECORD;
  v_vehicle RECORD;
  v_plan RECORD;
  v_amount NUMERIC;
  v_tax NUMERIC;
  v_total NUMERIC;
  v_receipt_code TEXT;
  v_minutes INT;
  v_hours NUMERIC;
  v_rate NUMERIC;
  v_tolerance INT;
  v_tax_rate NUMERIC;
  v_price_includes_tax BOOLEAN;
  -- Invoice mode variables
  v_invoice_mode TEXT;
  v_invoice_number TEXT;
  v_ncf TEXT;
  v_inv_prefix TEXT;
  v_inv_next BIGINT;
  v_seq INT;
BEGIN
  v_user_id := verify_token(p_token);
  IF v_user_id IS NULL THEN RETURN json_build_object('success', false, 'error', 'No autorizado'); END IF;

  IF p_data->>'sessionId' IS NULL OR p_data->>'sessionId' = '' THEN
    RETURN json_build_object('success', false, 'error', 'sessionId no proporcionado en los datos de pago');
  END IF;

  BEGIN
    SELECT * INTO v_session FROM parking_sessions WHERE id = (p_data->>'sessionId')::UUID;
  EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', 'sessionId inválido: ' || COALESCE(p_data->>'sessionId', 'NULL'));
  END;

  IF v_session IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Sesion no encontrada para ID: ' || COALESCE(p_data->>'sessionId', 'NULL'));
  END IF;

  IF v_session.payment_status = 'paid' OR v_session.status = 'paid' THEN
    RETURN json_build_object('success', false, 'error', 'Esta sesion ya fue pagada');
  END IF;

  IF v_session.status = 'closed' OR v_session.status = 'abandoned' THEN
    RETURN json_build_object('success', false, 'error', 'Sesion ya cerrada o abandonada');
  END IF;

  v_minutes := EXTRACT(EPOCH FROM (NOW() - v_session.entry_time)) / 60;

  IF v_session.metadata->>'subscription_id' IS NOT NULL
     AND v_session.metadata->>'subscription_id' != ''
     AND v_session.metadata->>'subscription_id' != 'null' THEN
    IF EXISTS (SELECT 1 FROM subscriptions WHERE id = (v_session.metadata->>'subscription_id')::UUID AND status = 'active') THEN
      v_amount := 0; v_tax := 0; v_total := 0;
    END IF;
  END IF;

  IF v_total IS NULL THEN
    SELECT * INTO v_plan FROM plans WHERE type = 'hourly' AND is_active = true LIMIT 1;
    v_rate := COALESCE(v_plan.base_price, 50);
    v_tolerance := COALESCE(v_plan.tolerance_minutes, 15);
    v_tax_rate := COALESCE(v_plan.tax_rate, 0.18);
    v_price_includes_tax := COALESCE(v_plan.price_includes_tax, true);

    IF v_minutes <= v_tolerance THEN
      v_amount := 0; v_tax := 0; v_total := 0;
    ELSE
      v_hours := CEIL(v_minutes::NUMERIC / 60);

      IF v_price_includes_tax THEN
        -- Rate already includes ITBIS — extract subtotal and tax
        v_total := v_hours * v_rate;
        v_amount := ROUND(v_total / (1 + v_tax_rate), 2);
        v_tax := v_total - v_amount;
      ELSE
        -- Rate without ITBIS — add tax on top
        v_amount := v_hours * v_rate;
        v_tax := ROUND(v_amount * v_tax_rate, 2);
        v_total := v_amount + v_tax;
      END IF;
    END IF;
  END IF;

  SELECT * INTO v_vehicle FROM vehicles WHERE plate = v_session.vehicle_plate;
  v_receipt_code := 'REC-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD(FLOOR(RANDOM() * 99999)::TEXT, 5, '0');

  INSERT INTO payments (customer_id, amount, tax_amount, total_amount, currency, status, payment_method, paid_at, metadata)
  VALUES (
    v_session.customer_id, v_amount, v_tax, v_total, 'DOP', 'paid',
    COALESCE(p_data->>'paymentMethod', 'cash'), NOW(),
    jsonb_build_object('sessionId', v_session.id, 'plateNumber', v_session.vehicle_plate, 'receiptCode', v_receipt_code,
      'calculated_server_side', true, 'minutes', v_minutes, 'rate_used', v_rate,
      'price_includes_tax', COALESCE(v_price_includes_tax, true))
  ) RETURNING * INTO v_payment;

  -- ══════════════════════════════════════════════════════════════
  -- Determine invoice mode from settings (fiscal vs interno)
  -- ══════════════════════════════════════════════════════════════
  SELECT COALESCE(value#>>'{}', 'interno') INTO v_invoice_mode FROM settings WHERE key = 'invoice_mode';
  v_invoice_mode := COALESCE(v_invoice_mode, 'interno');

  IF v_invoice_mode = 'fiscal' THEN
    -- Fiscal mode: use NCF sequences from ncf_sequences table
    BEGIN
      v_ncf := get_next_ncf('02'); -- B02 = Factura de Consumo
      v_invoice_number := v_ncf;
    EXCEPTION WHEN OTHERS THEN
      v_ncf := NULL;
      v_invoice_number := NULL;
    END;
    -- Fallback if NCF sequence unavailable
    IF v_invoice_number IS NULL THEN
      SELECT 'PP-' || TO_CHAR(NOW(), 'YYYY') || '-' || LPAD(
        (COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM '[0-9]+$') AS INT)), 0) + 1)::TEXT, 4, '0')
      INTO v_invoice_number FROM invoices;
      v_ncf := NULL;
    END IF;
  ELSE
    -- Internal mode: use prefix + sequential number from settings
    SELECT COALESCE(value#>>'{}', 'FAC') INTO v_inv_prefix FROM settings WHERE key = 'internal_invoice_prefix';
    SELECT COALESCE((value#>>'{}')::BIGINT, 1) INTO v_inv_next FROM settings WHERE key = 'internal_invoice_next';
    v_inv_prefix := COALESCE(v_inv_prefix, 'FAC');
    v_inv_next := COALESCE(v_inv_next, 1);
    v_invoice_number := v_inv_prefix || LPAD(v_inv_next::TEXT, 8, '0');
    v_ncf := NULL; -- No NCF for internal mode
    UPDATE settings SET value = to_jsonb((v_inv_next + 1)::TEXT) WHERE key = 'internal_invoice_next';
    IF NOT FOUND THEN
      INSERT INTO settings (key, value, description, category)
      VALUES ('internal_invoice_next', to_jsonb('2'), 'Próximo número secuencial de factura interna', 'facturacion');
    END IF;
  END IF;

  INSERT INTO invoices (payment_id, customer_id, invoice_number, ncf, subtotal, tax_amount, total, currency, items, notes)
  VALUES (
    v_payment.id, v_session.customer_id,
    v_invoice_number,
    v_ncf,
    v_amount, v_tax, v_total, 'DOP',
    jsonb_build_array(jsonb_build_object(
      'description', 'Estacionamiento - ' || v_session.vehicle_plate || ' (' || CEIL(v_minutes::NUMERIC / 60) || 'h)',
      'quantity', 1, 'unit_price', v_amount, 'amount', v_amount
    )),
    'Placa: ' || v_session.vehicle_plate
  ) RETURNING * INTO v_invoice;

  UPDATE parking_sessions SET
    exit_time = NOW(), status = 'paid', payment_status = 'paid',
    paid_amount = v_total, payment_id = v_payment.id,
    duration_minutes = v_minutes,
    calculated_amount = v_total
  WHERE id = v_session.id;

  INSERT INTO cash_register_transactions (cash_register_id, type, amount, direction, operator_id, description)
  SELECT cr.id, 'payment', v_total, 'in', v_user_id,
    'Pago estacionamiento - ' || v_session.vehicle_plate || ' RD$' || v_total
  FROM cash_registers cr WHERE cr.status = 'open' LIMIT 1;

  PERFORM log_audit(v_user_id, 'payment_processed', 'parking_session', v_session.id,
    jsonb_build_object(
      'payment_id', v_payment.id, 'amount', v_amount, 'tax', v_tax, 'total', v_total,
      'plate', v_session.vehicle_plate, 'minutes', v_minutes,
      'payment_method', COALESCE(p_data->>'paymentMethod', 'cash'),
      'receipt_code', v_receipt_code, 'invoice_number', v_invoice.invoice_number,
      'invoice_mode', v_invoice_mode,
      'status', 'paid', 'price_includes_tax', COALESCE(v_price_includes_tax, true)
    ));

  RETURN json_build_object('success', true, 'data', json_build_object(
    'payment', row_to_json(v_payment),
    'invoice', row_to_json(v_invoice),
    'receipt', json_build_object(
      'code', v_receipt_code, 'plateNumber', v_session.vehicle_plate,
      'entryTime', v_session.entry_time, 'exitTime', NOW(),
      'hours', CEIL(v_minutes::NUMERIC / 60), 'subtotal', v_amount, 'tax', v_tax, 'total', v_total,
      'paymentMethod', COALESCE(p_data->>'paymentMethod', 'cash'),
      'invoiceNumber', v_invoice.invoice_number, 'ncf', v_invoice.ncf, 'paidAt', NOW(),
      'verification_code', v_session.verification_code
    )
  ));
END;
$$;

-- ============================================================================
-- FIX 2: Create missing register_exit function
-- The frontend calls this for free exits (subscribers, grace period) and
-- after paid exits to properly close the session.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.register_exit(p_token TEXT, p_data JSON)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_user_id UUID;
  v_session RECORD;
  v_session_id UUID;
BEGIN
  v_user_id := verify_token(p_token);
  IF v_user_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'No autorizado');
  END IF;

  v_session_id := (p_data->>'sessionId')::UUID;
  IF v_session_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'sessionId requerido');
  END IF;

  SELECT * INTO v_session FROM parking_sessions WHERE id = v_session_id;
  IF v_session IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Sesión no encontrada');
  END IF;

  -- Already closed/paid
  IF v_session.status IN ('closed', 'paid') THEN
    RETURN json_build_object('success', true, 'data', json_build_object(
      'message', 'Sesión ya cerrada',
      'sessionId', v_session.id,
      'status', v_session.status
    ));
  END IF;

  -- Close the session
  UPDATE parking_sessions SET
    exit_time = COALESCE(exit_time, NOW()),
    status = CASE
      WHEN (p_data->>'payment') IS NOT NULL AND (p_data->'payment'->>'paid')::BOOLEAN = true THEN 'paid'
      ELSE 'closed'
    END,
    payment_status = CASE
      WHEN (p_data->>'payment') IS NOT NULL AND (p_data->'payment'->>'paid')::BOOLEAN = true THEN 'paid'
      ELSE COALESCE(payment_status, 'free')
    END,
    updated_at = NOW()
  WHERE id = v_session_id;

  -- Decrement plan occupancy
  IF v_session.plan_id IS NOT NULL THEN
    UPDATE plans SET
      current_occupancy = GREATEST(0, COALESCE(current_occupancy, 1) - 1),
      updated_at = NOW()
    WHERE id = v_session.plan_id;
  END IF;

  -- Log audit
  PERFORM log_audit(v_user_id, 'register_exit', 'parking_session', v_session_id,
    jsonb_build_object('plate', v_session.vehicle_plate, 'status', v_session.status));

  RETURN json_build_object('success', true, 'data', json_build_object(
    'message', 'Salida registrada',
    'sessionId', v_session_id,
    'plate', v_session.vehicle_plate,
    'exitTime', NOW()
  ));
END;
$$;
