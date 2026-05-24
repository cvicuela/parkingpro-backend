-- Migration 074: align fee preview with the real charge + add role checks
-- Applied to prod (ppxjjsfacbepctslyrma) 2026-05-24.
--
-- WHY:
-- 1) calculate_parking_fee (the PREVIEW shown to the operator before charging) diverged
--    from process_parking_payment (the actual charge):
--      - it IGNORED the tiered public.hourly_rates table (used flat base_price * hours)
--      - it did NOT subtract tolerance_minutes before CEIL(minutes/60)
--    The live "Por Hora" plan uses hourly_rates h1=70 / h2=100 (tolerance 10, ITBIS 18% incl),
--    so a 2h stay previewed 140 but charged 170. The operator quoted/made change on the wrong
--    amount and the cash register closed short. This rewrites calculate_parking_fee to use the
--    SAME fee engine as process_parking_payment so quote == charge.
-- 2) close_cash_register and create_invoice_from_payment only called verify_token (any
--    authenticated user, incl. a customer, could invoke them). Added require_role.
--
-- ROLLBACK: the previous definitions are recoverable; calculate_parking_fee old body used flat
-- base_price and no tolerance subtraction; close_cash_register / create_invoice_from_payment old
-- auth preamble was `v_user_id := verify_token(p_token); IF v_user_id IS NULL THEN RETURN ... END IF;`.

-- =========================================================================================
-- 1. calculate_parking_fee — mirror process_parking_payment's fee engine
-- =========================================================================================
CREATE OR REPLACE FUNCTION public.calculate_parking_fee(p_token text, p_data json)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_user_id UUID;
  v_session RECORD;
  v_vehicle RECORD;
  v_plan RECORD;
  v_entry TIMESTAMP;
  v_exit TIMESTAMP;
  v_minutes INT;
  v_billable_minutes INT;
  v_hours INT;
  v_tolerance INT;
  v_rate NUMERIC;            -- effective per-hour, for display only
  v_hour_total NUMERIC;
  v_has_rates BOOLEAN;
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
    SELECT * INTO v_session FROM parking_sessions
    WHERE id = (p_data->>'sessionId')::UUID AND status = 'active' AND exit_time IS NULL;
  ELSIF p_data->>'plateNumber' IS NOT NULL THEN
    SELECT * INTO v_session FROM parking_sessions
    WHERE vehicle_plate = UPPER(p_data->>'plateNumber') AND status = 'active' AND exit_time IS NULL
    ORDER BY entry_time DESC LIMIT 1;
  END IF;

  IF v_session IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'No hay sesion activa para este vehiculo');
  END IF;

  -- Active subscriber: free exit
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

  -- Resolve plan the same way process_parking_payment does: session plan first, else active hourly
  IF v_session.plan_id IS NOT NULL THEN
    SELECT * INTO v_plan FROM plans WHERE id = v_session.plan_id;
  END IF;
  IF v_plan IS NULL THEN
    SELECT * INTO v_plan FROM plans WHERE type = 'hourly' AND is_active = true LIMIT 1;
  END IF;

  v_tolerance := COALESCE(v_plan.tolerance_minutes, 5);
  v_tax_rate := COALESCE(v_plan.tax_rate, 0.18);
  v_price_includes_tax := COALESCE(v_plan.price_includes_tax, true);

  -- Grace period (<= tolerance) is free
  IF v_minutes <= v_tolerance THEN
    RETURN json_build_object('success', true, 'data', json_build_object(
      'sessionId', v_session.id, 'plateNumber', v_session.vehicle_plate,
      'entryTime', v_entry, 'exitTime', v_exit, 'minutes', v_minutes,
      'type', 'grace_period', 'amount', 0, 'subtotal', 0, 'tax', 0, 'total', 0,
      'ratePerHour', COALESCE(v_plan.base_price, 0), 'hours', 0,
      'status', v_session.status,
      'message', 'Periodo de gracia - salida sin costo'
    ));
  END IF;

  -- Billable hours AFTER tolerance (mirror process_parking_payment)
  v_billable_minutes := v_minutes - v_tolerance;
  v_hours := CEIL(v_billable_minutes::NUMERIC / 60);

  -- Tiered hourly_rates if configured, else flat base_price (mirror process_parking_payment)
  SELECT EXISTS(SELECT 1 FROM hourly_rates WHERE plan_id = v_plan.id AND is_active = true) INTO v_has_rates;

  IF v_has_rates THEN
    SELECT COALESCE(SUM(applied_rate), 0) INTO v_hour_total
    FROM (
      SELECT COALESCE(
        (SELECT rate FROM hourly_rates WHERE plan_id = v_plan.id AND hour_number = h.hour_num AND is_active = true),
        (SELECT rate FROM hourly_rates WHERE plan_id = v_plan.id AND is_active = true ORDER BY hour_number DESC LIMIT 1)
      ) AS applied_rate
      FROM generate_series(1, v_hours) AS h(hour_num)
    ) rates;
  ELSE
    v_hour_total := v_hours * COALESCE(v_plan.base_price, 50);
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

  v_rate := CASE WHEN v_hours > 0 THEN ROUND(v_hour_total / v_hours, 2) ELSE 0 END;

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
$function$;

-- =========================================================================================
-- 2. close_cash_register — add role check (was verify_token only)
-- =========================================================================================
CREATE OR REPLACE FUNCTION public.close_cash_register(p_token text, p_id uuid, p_data json)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_user_id UUID;
  v_register RECORD;
  v_expected NUMERIC;
  v_counted NUMERIC;
  v_diff NUMERIC;
  v_threshold NUMERIC := 200;
BEGIN
  BEGIN
    SELECT r.user_id INTO v_user_id FROM require_role(p_token, ARRAY['operator','admin','super_admin']) r;
  EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', 'No autorizado');
  END;

  SELECT * INTO v_register FROM cash_registers WHERE id = p_id AND status = 'open';
  IF v_register IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Caja no encontrada o ya cerrada');
  END IF;

  -- Calculate expected balance
  SELECT v_register.opening_balance +
    COALESCE(SUM(CASE WHEN direction = 'in' AND type != 'opening_float' THEN amount ELSE 0 END), 0) -
    COALESCE(SUM(CASE WHEN direction = 'out' THEN amount ELSE 0 END), 0)
  INTO v_expected
  FROM cash_register_transactions WHERE cash_register_id = p_id;

  v_counted := (p_data->>'countedBalance')::NUMERIC;
  v_diff := v_counted - v_expected;

  UPDATE cash_registers SET
    status = 'closed',
    closed_at = NOW(),
    expected_balance = v_expected,
    counted_balance = v_counted,
    difference = v_diff,
    requires_approval = ABS(v_diff) > v_threshold,
    notes = COALESCE(p_data->>'notes', notes)
  WHERE id = p_id
  RETURNING * INTO v_register;

  RETURN json_build_object('success', true, 'data', row_to_json(v_register));
END;
$function$;

-- =========================================================================================
-- 3. create_invoice_from_payment — add role check (was verify_token only)
-- =========================================================================================
CREATE OR REPLACE FUNCTION public.create_invoice_from_payment(p_token text, p_payment_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_user_id UUID;
  v_payment RECORD;
  v_invoice RECORD;
  v_invoice_mode TEXT;
  v_invoice_number TEXT;
  v_ncf TEXT;
  v_inv_prefix TEXT;
  v_inv_next BIGINT;
BEGIN
  BEGIN
    SELECT r.user_id INTO v_user_id FROM require_role(p_token, ARRAY['operator','admin','super_admin']) r;
  EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', 'No autorizado');
  END;

  SELECT * INTO v_payment FROM payments WHERE id = p_payment_id;
  IF v_payment IS NULL THEN RETURN json_build_object('success', false, 'error', 'Pago no encontrado'); END IF;

  SELECT * INTO v_invoice FROM invoices WHERE payment_id = p_payment_id LIMIT 1;
  IF v_invoice IS NOT NULL THEN
    RETURN json_build_object('success', true, 'data', row_to_json(v_invoice));
  END IF;

  SELECT COALESCE(value#>>'{}', 'interno') INTO v_invoice_mode FROM settings WHERE key = 'invoice_mode';
  v_invoice_mode := COALESCE(v_invoice_mode, 'interno');

  IF v_invoice_mode = 'fiscal' THEN
    BEGIN
      v_ncf := get_next_ncf('02', 'manual_invoice', v_user_id);
      v_invoice_number := v_ncf;
    EXCEPTION WHEN OTHERS THEN
      v_ncf := NULL; v_invoice_number := NULL;
    END;
  END IF;

  IF v_invoice_number IS NULL THEN
    SELECT COALESCE(value#>>'{}', 'FAC') INTO v_inv_prefix FROM settings WHERE key = 'internal_invoice_prefix';
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

  INSERT INTO invoices (payment_id, customer_id, invoice_number, ncf, subtotal, tax_amount, total, currency, items)
  VALUES (v_payment.id, v_payment.customer_id, v_invoice_number, v_ncf,
    v_payment.amount, v_payment.tax_amount, v_payment.total_amount, 'DOP',
    json_build_array(json_build_object('description', 'Pago de servicio', 'quantity', 1,
      'unit_price', v_payment.amount, 'amount', v_payment.amount))::jsonb)
  RETURNING * INTO v_invoice;

  RETURN json_build_object('success', true, 'data', row_to_json(v_invoice));
END;
$function$;
