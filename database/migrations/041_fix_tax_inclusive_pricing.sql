-- Migration 041: Fix tax-inclusive pricing in calculate_parking_fee and process_parking_payment
-- Bug: Both functions always calculated ITBIS on top of the rate, ignoring price_includes_tax.
-- With rate RD$70 (ITBIS included), it showed subtotal=70, ITBIS=12.60, total=82.60
-- Fix: When price_includes_tax=true, extract subtotal/tax FROM the rate instead.
-- Correct: total=70, subtotal=59.32, ITBIS=10.68

CREATE OR REPLACE FUNCTION calculate_parking_fee(p_token TEXT, p_data JSON)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_user_id UUID;
  v_session RECORD;
  v_vehicle RECORD;
  v_plan RECORD;
  v_entry TIMESTAMP;
  v_exit TIMESTAMP;
  v_minutes INT;
  v_hours NUMERIC;
  v_tolerance INT := 15;
  v_rate NUMERIC;
  v_amount NUMERIC;
  v_tax NUMERIC;
  v_total NUMERIC;
  v_tax_rate NUMERIC;
  v_price_includes_tax BOOLEAN;
  v_sub_id TEXT;
BEGIN
  v_user_id := verify_token(p_token);
  IF v_user_id IS NULL THEN RETURN json_build_object('success', false, 'error', 'No autorizado'); END IF;

  IF p_data->>'sessionId' IS NOT NULL THEN
    SELECT * INTO v_session FROM parking_sessions WHERE id = (p_data->>'sessionId')::UUID AND status = 'active' AND exit_time IS NULL;
  ELSIF p_data->>'plateNumber' IS NOT NULL THEN
    SELECT * INTO v_session FROM parking_sessions
    WHERE vehicle_plate = UPPER(p_data->>'plateNumber') AND status = 'active' AND exit_time IS NULL
    ORDER BY entry_time DESC LIMIT 1;
  END IF;

  IF v_session IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'No hay sesion activa para este vehiculo');
  END IF;

  v_sub_id := v_session.metadata->>'subscription_id';
  IF v_sub_id IS NOT NULL AND v_sub_id != '' AND v_sub_id != 'null' THEN
    IF EXISTS (SELECT 1 FROM subscriptions WHERE id = v_sub_id::UUID AND status = 'active') THEN
      RETURN json_build_object('success', true, 'data', json_build_object(
        'sessionId', v_session.id, 'plateNumber', v_session.vehicle_plate,
        'entryTime', v_session.entry_time, 'exitTime', NOW(),
        'type', 'subscriber', 'amount', 0, 'subtotal', 0, 'tax', 0, 'total', 0,
        'status', v_session.status,
        'message', 'Suscriptor activo - salida sin costo'
      ));
    END IF;
  END IF;

  v_entry := v_session.entry_time;
  v_exit := NOW();
  v_minutes := EXTRACT(EPOCH FROM (v_exit - v_entry)) / 60;

  SELECT * INTO v_plan FROM plans WHERE type = 'hourly' AND is_active = true LIMIT 1;
  v_rate := COALESCE(v_plan.base_price, 50);
  v_tolerance := COALESCE(v_plan.tolerance_minutes, 15);
  v_tax_rate := COALESCE(v_plan.tax_rate, 0.18);
  v_price_includes_tax := COALESCE(v_plan.price_includes_tax, true);

  IF v_minutes <= v_tolerance THEN
    RETURN json_build_object('success', true, 'data', json_build_object(
      'sessionId', v_session.id, 'plateNumber', v_session.vehicle_plate,
      'entryTime', v_entry, 'exitTime', v_exit, 'minutes', v_minutes,
      'type', 'grace_period', 'amount', 0, 'subtotal', 0, 'tax', 0, 'total', 0,
      'status', v_session.status,
      'message', 'Periodo de gracia - salida sin costo'
    ));
  END IF;

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

  SELECT * INTO v_vehicle FROM vehicles WHERE plate = v_session.vehicle_plate;

  RETURN json_build_object('success', true, 'data', json_build_object(
    'sessionId', v_session.id,
    'plateNumber', v_session.vehicle_plate,
    'brand', v_vehicle.make, 'model', v_vehicle.model, 'color', v_vehicle.color,
    'entryTime', v_entry, 'exitTime', v_exit,
    'minutes', v_minutes, 'hours', v_hours, 'ratePerHour', v_rate,
    'type', 'hourly', 'subtotal', v_amount, 'tax', v_tax, 'taxRate', v_tax_rate, 'total', v_total,
    'priceIncludesTax', v_price_includes_tax,
    'status', v_session.status
  ));
END;
$$;

CREATE OR REPLACE FUNCTION process_parking_payment(p_token TEXT, p_data JSON)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_user_id UUID;
  v_session RECORD;
  v_payment RECORD;
  v_invoice RECORD;
  v_vehicle RECORD;
  v_plan RECORD;
  v_seq INT;
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
BEGIN
  v_user_id := verify_token(p_token);
  IF v_user_id IS NULL THEN RETURN json_build_object('success', false, 'error', 'No autorizado'); END IF;

  SELECT * INTO v_session FROM parking_sessions WHERE id = (p_data->>'sessionId')::UUID;
  IF v_session IS NULL THEN RETURN json_build_object('success', false, 'error', 'Sesion no encontrada'); END IF;

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

  SELECT COUNT(*) + 1 INTO v_seq FROM invoices;
  INSERT INTO invoices (payment_id, customer_id, invoice_number, ncf, subtotal, tax_amount, total, currency, items, notes)
  VALUES (
    v_payment.id, v_session.customer_id,
    'PP-' || TO_CHAR(NOW(), 'YYYY') || '-' || LPAD(v_seq::TEXT, 4, '0'),
    'B01' || LPAD(v_seq::TEXT, 8, '0'),
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
