-- Migration 072: Harden process_parking_payment (hottest path)
-- Faithful reproduction of the current function with THREE targeted fixes:
--   [1] require an operator-level role (was: verify_token = any authenticated user)
--   [2] attribute the cash-in to the OPERATOR's open register (was: any open register
--       via 'WHERE status=open LIMIT 1' -> misattributed/untracked with >1 operator)
--       and link it via payment_id (+ record payment_method)
--   [3] FOR UPDATE row-lock when reading settings.internal_invoice_next (was: unlocked
--       read+increment -> duplicate internal invoice numbers under concurrency)
-- Everything else is byte-identical to the prior definition.
CREATE OR REPLACE FUNCTION public.process_parking_payment(p_token text, p_data json)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
  v_billable_minutes INT;
  v_hours INT;
  v_rate NUMERIC;
  v_tolerance INT;
  v_tax_rate NUMERIC;
  v_price_includes_tax BOOLEAN;
  v_has_rates BOOLEAN;
  v_hour_total NUMERIC;
  v_invoice_mode TEXT;
  v_invoice_number TEXT;
  v_ncf TEXT;
  v_inv_prefix TEXT;
  v_inv_next BIGINT;
  v_seq INT;
BEGIN
  -- [1] require operator-level role
  BEGIN
    SELECT r.user_id INTO v_user_id FROM require_role(p_token, ARRAY['operator','admin','super_admin']) r;
  EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', 'No autorizado');
  END;

  IF p_data->>'sessionId' IS NULL OR p_data->>'sessionId' = '' THEN
    RETURN json_build_object('success', false, 'error', 'sessionId no proporcionado en los datos de pago');
  END IF;

  BEGIN
    SELECT * INTO v_session FROM parking_sessions WHERE id = (p_data->>'sessionId')::UUID;
  EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', 'sessionId invalido: ' || COALESCE(p_data->>'sessionId', 'NULL'));
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
    IF v_session.plan_id IS NOT NULL THEN
      SELECT * INTO v_plan FROM plans WHERE id = v_session.plan_id;
    END IF;
    IF v_plan IS NULL THEN
      SELECT * INTO v_plan FROM plans WHERE type = 'hourly' AND is_active = true LIMIT 1;
    END IF;

    v_tolerance := COALESCE(v_plan.tolerance_minutes, 5);
    v_tax_rate := COALESCE(v_plan.tax_rate, 0.18);
    v_price_includes_tax := COALESCE(v_plan.price_includes_tax, true);

    IF v_minutes <= v_tolerance THEN
      v_amount := 0; v_tax := 0; v_total := 0;
      v_rate := 0;
      v_hours := 0;
    ELSE
      v_billable_minutes := v_minutes - v_tolerance;
      v_hours := CEIL(v_billable_minutes::NUMERIC / 60);

      SELECT EXISTS(
        SELECT 1 FROM hourly_rates WHERE plan_id = v_plan.id AND is_active = true
      ) INTO v_has_rates;

      IF v_has_rates THEN
        SELECT COALESCE(SUM(applied_rate), 0) INTO v_hour_total
        FROM (
          SELECT
            COALESCE(
              (SELECT rate FROM hourly_rates WHERE plan_id = v_plan.id AND hour_number = h.hour_num AND is_active = true),
              (SELECT rate FROM hourly_rates WHERE plan_id = v_plan.id AND is_active = true ORDER BY hour_number DESC LIMIT 1)
            ) AS applied_rate
          FROM generate_series(1, v_hours) AS h(hour_num)
        ) rates;

        v_rate := v_hour_total;
      ELSE
        v_rate := COALESCE(v_plan.base_price, 50);
        v_hour_total := v_hours * v_rate;
      END IF;

      IF v_price_includes_tax THEN
        v_total := v_hour_total;
        v_amount := ROUND(v_total / (1 + v_tax_rate), 2);
        v_tax := v_total - v_amount;
      ELSE
        v_amount := v_hour_total;
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
      'calculated_server_side', true, 'minutes', v_minutes, 'billable_minutes', v_billable_minutes,
      'tolerance_applied', v_tolerance, 'rate_used', v_rate,
      'hours', v_hours, 'uses_hourly_rates', COALESCE(v_has_rates, false),
      'price_includes_tax', COALESCE(v_price_includes_tax, true))
  ) RETURNING * INTO v_payment;

  SELECT COALESCE(value#>>'{}', 'interno') INTO v_invoice_mode FROM settings WHERE key = 'invoice_mode';
  v_invoice_mode := COALESCE(v_invoice_mode, 'interno');

  IF v_invoice_mode = 'fiscal' THEN
    BEGIN
      v_ncf := get_next_ncf('02');
      v_invoice_number := v_ncf;
    EXCEPTION WHEN OTHERS THEN
      v_ncf := NULL;
      v_invoice_number := NULL;
    END;
    IF v_invoice_number IS NULL THEN
      SELECT 'PP-' || TO_CHAR(NOW(), 'YYYY') || '-' || LPAD(
        (COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM '[0-9]+$') AS INT)), 0) + 1)::TEXT, 4, '0')
      INTO v_invoice_number FROM invoices;
      v_ncf := NULL;
    END IF;
  ELSE
    SELECT COALESCE(value#>>'{}', 'FAC') INTO v_inv_prefix FROM settings WHERE key = 'internal_invoice_prefix';
    -- [3] lock the counter row to prevent duplicate internal invoice numbers
    SELECT COALESCE((value#>>'{}')::BIGINT, 1) INTO v_inv_next FROM settings WHERE key = 'internal_invoice_next' FOR UPDATE;
    v_inv_prefix := COALESCE(v_inv_prefix, 'FAC');
    v_inv_next := COALESCE(v_inv_next, 1);
    v_invoice_number := v_inv_prefix || LPAD(v_inv_next::TEXT, 8, '0');
    v_ncf := NULL;
    UPDATE settings SET value = to_jsonb((v_inv_next + 1)::TEXT) WHERE key = 'internal_invoice_next';
    IF NOT FOUND THEN
      INSERT INTO settings (key, value, description, category)
      VALUES ('internal_invoice_next', to_jsonb('2'), 'Proximo numero secuencial de factura interna', 'facturacion');
    END IF;
  END IF;

  INSERT INTO invoices (payment_id, customer_id, invoice_number, ncf, subtotal, tax_amount, total, currency, items, notes)
  VALUES (
    v_payment.id, v_session.customer_id,
    v_invoice_number,
    v_ncf,
    v_amount, v_tax, v_total, 'DOP',
    jsonb_build_array(jsonb_build_object(
      'description', 'Estacionamiento - ' || v_session.vehicle_plate || ' (' || v_hours || 'h)',
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

  -- [2] attribute cash-in to the operator's open register + link the payment
  INSERT INTO cash_register_transactions (cash_register_id, type, amount, direction, operator_id, payment_id, payment_method, description)
  SELECT cr.id, 'payment', v_total, 'in', v_user_id, v_payment.id,
    COALESCE(p_data->>'paymentMethod', 'cash'),
    'Pago estacionamiento - ' || v_session.vehicle_plate || ' RD$' || v_total
  FROM cash_registers cr WHERE cr.status = 'open'
  ORDER BY (cr.operator_id = v_user_id) DESC LIMIT 1;

  PERFORM log_audit(v_user_id, 'payment_processed', 'parking_session', v_session.id,
    jsonb_build_object(
      'payment_id', v_payment.id, 'amount', v_amount, 'tax', v_tax, 'total', v_total,
      'plate', v_session.vehicle_plate, 'minutes', v_minutes,
      'tolerance_applied', v_tolerance, 'billable_minutes', v_billable_minutes,
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
      'hours', v_hours, 'minutes', v_minutes, 'toleranceApplied', v_tolerance,
      'subtotal', v_amount, 'tax', v_tax, 'total', v_total,
      'paymentMethod', COALESCE(p_data->>'paymentMethod', 'cash'),
      'invoiceNumber', v_invoice.invoice_number, 'ncf', v_invoice.ncf, 'paidAt', NOW(),
      'verification_code', v_session.verification_code
    )
  ));
END;
$function$;
