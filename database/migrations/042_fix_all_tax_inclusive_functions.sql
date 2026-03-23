-- Migration 042: Fix tax-inclusive pricing in ALL remaining functions
-- Bug: atomic_session_exit, lost_ticket_charge, generate_subscription_invoice,
--      and run_billing_cycle all added ITBIS on top instead of extracting it
--      when price_includes_tax=true on the plan.
--
-- Example with subscription RD$2,500 (ITBIS included):
--   BEFORE: subtotal=2500, ITBIS=450, total=2950 (WRONG - double taxed)
--   AFTER:  total=2500, subtotal=2118.64, ITBIS=381.36 (CORRECT)

-- ============================================================================
-- FIX 1: atomic_session_exit
-- ============================================================================
CREATE OR REPLACE FUNCTION public.atomic_session_exit(
    p_token          TEXT,
    p_session_id     UUID,
    p_payment_method VARCHAR,
    p_metadata       JSONB DEFAULT '{}'
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $function$
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
    v_price_includes_tax BOOLEAN;
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

    SELECT ps.*, p.name AS plan_name
    INTO v_session
    FROM parking_sessions ps
    LEFT JOIN plans p ON ps.plan_id = p.id
    WHERE ps.id = p_session_id
    FOR UPDATE;

    IF v_session IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Sesión no encontrada');
    END IF;

    IF v_session.status != 'active' THEN
        RETURN jsonb_build_object('success', false, 'error', 'La sesión no está activa (estado: ' || v_session.status || ')');
    END IF;

    IF v_session.payment_status = 'paid' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Esta sesión ya fue pagada');
    END IF;

    -- Read tax config from plan
    SELECT COALESCE(price_includes_tax, true), COALESCE(tax_rate, 0.18)
    INTO v_price_includes_tax, v_tax_rate
    FROM plans WHERE id = v_session.plan_id;

    v_price_includes_tax := COALESCE(v_price_includes_tax, true);
    v_tax_rate := COALESCE(v_tax_rate, 0.18);

    v_amount := COALESCE(v_session.calculated_amount, 0);

    IF v_price_includes_tax THEN
        v_total_amount := v_amount;
        v_subtotal := ROUND(v_amount / (1 + v_tax_rate), 2);
        v_tax_amount := v_total_amount - v_subtotal;
    ELSE
        v_subtotal := v_amount;
        v_tax_amount := ROUND(v_amount * v_tax_rate, 2);
        v_total_amount := v_subtotal + v_tax_amount;
    END IF;

    v_verification := LPAD(FLOOR(RANDOM() * 1000000)::TEXT, 6, '0');

    IF p_payment_method IN ('cardnet', 'stripe') THEN
        v_method_norm := 'card';
    ELSE
        v_method_norm := p_payment_method;
    END IF;

    INSERT INTO payments (
        amount, tax_amount, total_amount, currency, status,
        payment_method, paid_at, metadata
    ) VALUES (
        v_subtotal, v_tax_amount, v_total_amount, 'DOP', 'paid',
        p_payment_method, NOW(),
        jsonb_build_object(
            'sessionId', v_session.id, 'plate', v_session.vehicle_plate,
            'verification_code', v_verification, 'atomic', true,
            'price_includes_tax', v_price_includes_tax
        ) || p_metadata
    ) RETURNING id INTO v_payment_id;

    SELECT id INTO v_register_id FROM cash_registers
    WHERE operator_id = v_user_id AND status = 'open' LIMIT 1;

    IF v_register_id IS NOT NULL THEN
        INSERT INTO cash_register_transactions (
            cash_register_id, type, amount, direction,
            payment_id, parking_session_id, operator_id,
            description, payment_method
        ) VALUES (
            v_register_id, 'payment', v_total_amount, 'in',
            v_payment_id, v_session.id, v_user_id,
            'Cobro estacionamiento ' || v_session.vehicle_plate, v_method_norm
        );
    END IF;

    SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM '[0-9]+$') AS INT)), 0) + 1
    INTO v_invoice_id FROM invoices;
    v_invoice_number := 'PP-' || TO_CHAR(NOW(), 'YYYY') || '-' || LPAD(v_invoice_id::TEXT, 4, '0');

    BEGIN
        SELECT prefix || LPAD(current_number::TEXT, 8, '0') INTO v_ncf
        FROM ncf_sequences
        WHERE ncf_type = '02' AND status = 'active' AND current_number <= end_number LIMIT 1;
        IF v_ncf IS NOT NULL THEN
            UPDATE ncf_sequences SET current_number = current_number + 1
            WHERE ncf_type = '02' AND status = 'active' AND current_number <= end_number;
        END IF;
    EXCEPTION WHEN OTHERS THEN v_ncf := NULL;
    END;

    INSERT INTO invoices (payment_id, invoice_number, ncf, subtotal, tax_amount, total, status, issued_at)
    VALUES (v_payment_id, v_invoice_number, v_ncf, v_subtotal, v_tax_amount, v_total_amount, 'issued', NOW());

    UPDATE parking_sessions SET
        payment_id = v_payment_id, paid_amount = v_total_amount,
        payment_status = 'paid', status = 'closed',
        exit_time = COALESCE(exit_time, NOW()), updated_at = NOW()
    WHERE id = v_session.id;

    IF v_session.plan_id IS NOT NULL THEN
        UPDATE plans SET current_occupancy = GREATEST(0, COALESCE(current_occupancy, 1) - 1), updated_at = NOW()
        WHERE id = v_session.plan_id;
    END IF;

    INSERT INTO audit_logs (user_id, action, entity_type, entity_id, changes)
    VALUES (v_user_id, 'atomic_session_exit', 'payment', v_payment_id,
        jsonb_build_object(
            'subtotal', v_subtotal, 'tax', v_tax_amount, 'total', v_total_amount,
            'method', p_payment_method, 'plate', v_session.vehicle_plate,
            'session_id', v_session.id, 'register_id', v_register_id
        ));

    v_receipt := jsonb_build_object(
        'plateNumber', v_session.vehicle_plate, 'invoiceNumber', v_invoice_number,
        'ncf', v_ncf, 'subtotal', v_subtotal, 'tax', v_tax_amount, 'total', v_total_amount,
        'taxRate', v_tax_rate, 'paymentMethod', p_payment_method,
        'entryTime', v_session.entry_time, 'exitTime', NOW(),
        'hours', CEIL(EXTRACT(EPOCH FROM (NOW() - v_session.entry_time)) / 3600),
        'code', 'REC-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD(FLOOR(RANDOM() * 100000)::TEXT, 5, '0'),
        'verification_code', v_verification, 'paymentId', v_payment_id
    );

    RETURN jsonb_build_object('success', true, 'data', jsonb_build_object('receipt', v_receipt));
EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$;

-- ============================================================================
-- FIX 2: lost_ticket_charge
-- ============================================================================
CREATE OR REPLACE FUNCTION public.lost_ticket_charge(p_token TEXT, p_data JSONB)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $function$
DECLARE
  v_user_id UUID;
  v_plate VARCHAR;
  v_ticket VARCHAR;
  v_session RECORD;
  v_lost_fee DECIMAL;
  v_plan_name VARCHAR;
  v_session_id UUID;
  v_entry_time TIMESTAMP;
  v_subtotal DECIMAL;
  v_tax DECIMAL;
  v_total DECIMAL;
  v_tax_rate DECIMAL;
  v_price_includes_tax BOOLEAN;
  v_setting_val TEXT;
BEGIN
  SELECT r.user_id INTO v_user_id
  FROM require_role(p_token, ARRAY['operator', 'admin', 'super_admin']) r;

  v_plate := UPPER(TRIM(COALESCE(p_data->>'plateNumber', '')));
  v_ticket := UPPER(TRIM(COALESCE(p_data->>'ticketNumber', '')));

  IF v_plate = '' AND v_ticket = '' THEN
    RAISE EXCEPTION 'plateNumber o ticketNumber es requerido';
  END IF;

  IF v_ticket != '' THEN
    SELECT ps.id, ps.entry_time, ps.vehicle_plate, p.name AS plan_name,
           p.lost_ticket_fee, COALESCE(p.price_includes_tax, true) AS price_includes_tax,
           COALESCE(p.tax_rate, 0.18) AS plan_tax_rate
    INTO v_session
    FROM parking_sessions ps
    JOIN plans p ON ps.plan_id = p.id
    WHERE ps.verification_code = v_ticket AND ps.status = 'active'
    ORDER BY ps.entry_time DESC LIMIT 1;
  ELSE
    SELECT ps.id, ps.entry_time, ps.vehicle_plate, p.name AS plan_name,
           p.lost_ticket_fee, COALESCE(p.price_includes_tax, true) AS price_includes_tax,
           COALESCE(p.tax_rate, 0.18) AS plan_tax_rate
    INTO v_session
    FROM parking_sessions ps
    JOIN plans p ON ps.plan_id = p.id
    WHERE ps.vehicle_plate = v_plate AND ps.status = 'active'
    ORDER BY ps.entry_time DESC LIMIT 1;
  END IF;

  IF v_session IS NOT NULL THEN
    v_lost_fee := COALESCE(v_session.lost_ticket_fee, 500);
    v_plan_name := v_session.plan_name;
    v_session_id := v_session.id;
    v_entry_time := v_session.entry_time;
    v_plate := COALESCE(v_session.vehicle_plate, v_plate);
    v_price_includes_tax := v_session.price_includes_tax;
    v_tax_rate := v_session.plan_tax_rate;
  ELSE
    SELECT value INTO v_setting_val FROM settings WHERE key = 'charges.lost_ticket';
    v_lost_fee := COALESCE(v_setting_val::DECIMAL, 500);
    v_plan_name := NULL;
    v_session_id := NULL;
    v_entry_time := NULL;
    v_price_includes_tax := true;
    v_tax_rate := 0.18;
  END IF;

  IF v_price_includes_tax THEN
    v_total := v_lost_fee;
    v_subtotal := ROUND(v_lost_fee / (1 + v_tax_rate), 2);
    v_tax := v_total - v_subtotal;
  ELSE
    v_subtotal := v_lost_fee;
    v_tax := ROUND(v_subtotal * v_tax_rate, 2);
    v_total := v_subtotal + v_tax;
  END IF;

  RETURN json_build_object(
    'success', true,
    'data', json_build_object(
      'type', 'lost_ticket',
      'plateNumber', v_plate,
      'sessionId', v_session_id,
      'entryTime', v_entry_time,
      'planName', v_plan_name,
      'subtotal', v_subtotal,
      'tax', v_tax,
      'total', v_total,
      'lost_ticket_fee', v_lost_fee,
      'charge_reason', 'Cargo por ticket perdido',
      'payment_status', 'pending',
      'barrier_allowed', false
    )
  );
END;
$function$;

-- ============================================================================
-- FIX 3: generate_subscription_invoice
-- ============================================================================
CREATE OR REPLACE FUNCTION public.generate_subscription_invoice(p_token TEXT, p_subscription_id UUID)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $function$
DECLARE
    v_auth              RECORD;
    v_sub               RECORD;
    v_customer          RECORD;
    v_plan              RECORD;
    v_subtotal          NUMERIC;
    v_tax_amount        NUMERIC;
    v_total             NUMERIC;
    v_price_includes_tax BOOLEAN;
    v_include_extras    BOOLEAN;
    v_ncf_type_setting  TEXT;
    v_ncf               TEXT;
    v_invoice_prefix    TEXT;
    v_invoice_next      BIGINT;
    v_invoice_number    TEXT;
    v_payment_id        UUID;
    v_invoice_id        UUID;
    v_items             JSONB;
    v_extra             RECORD;
    v_extras_subtotal   NUMERIC := 0;
    v_extras_tax        NUMERIC := 0;
    v_billing_interval  INTERVAL;
    v_new_next_billing  DATE;
    v_new_period_start  DATE;
    v_new_period_end    DATE;
BEGIN
    SELECT * INTO v_auth FROM public.require_role(p_token, ARRAY['admin', 'super_admin']);

    SELECT s.*, v.plate INTO v_sub
    FROM public.subscriptions s
    JOIN public.vehicles v ON v.id = s.vehicle_id
    WHERE s.id = p_subscription_id;

    IF NOT FOUND THEN
        RETURN json_build_object('success', false, 'error', 'Subscription not found');
    END IF;

    SELECT * INTO v_customer FROM public.customers WHERE id = v_sub.customer_id;
    SELECT * INTO v_plan FROM public.plans WHERE id = v_sub.plan_id;

    v_price_includes_tax := COALESCE(v_plan.price_includes_tax, true);

    SELECT COALESCE((SELECT (value#>>'{}')::BOOLEAN FROM public.settings WHERE key = 'billing.include_extras_in_subscription'), false) INTO v_include_extras;
    SELECT COALESCE((SELECT value#>>'{}' FROM public.settings WHERE key = 'billing.ncf_type_subscription'), 'B02') INTO v_ncf_type_setting;

    IF v_price_includes_tax THEN
        v_total := v_sub.price_per_period;
        v_subtotal := ROUND(v_sub.price_per_period / (1 + v_sub.tax_rate), 2);
        v_tax_amount := v_total - v_subtotal;
    ELSE
        v_subtotal := v_sub.price_per_period;
        v_tax_amount := ROUND(v_subtotal * v_sub.tax_rate, 2);
        v_total := v_subtotal + v_tax_amount;
    END IF;

    v_items := jsonb_build_array(
        jsonb_build_object(
            'type', 'subscription',
            'description', 'Plan ' || v_plan.name || ' - ' || v_sub.billing_frequency,
            'quantity', 1, 'unit_price', v_subtotal, 'tax_rate', v_sub.tax_rate,
            'tax_amount', v_tax_amount, 'total', v_total
        )
    );

    IF v_include_extras THEN
        FOR v_extra IN
            SELECT * FROM public.pending_charges
            WHERE subscription_id = p_subscription_id AND status = 'pending'
        LOOP
            v_extras_subtotal := v_extras_subtotal + v_extra.amount;
            v_extras_tax := v_extras_tax + COALESCE(v_extra.tax_amount, 0);
            v_items := v_items || jsonb_build_array(
                jsonb_build_object(
                    'type', v_extra.type, 'description', v_extra.description,
                    'quantity', 1, 'unit_price', v_extra.amount,
                    'tax_amount', COALESCE(v_extra.tax_amount, 0),
                    'total', v_extra.amount + COALESCE(v_extra.tax_amount, 0),
                    'session_id', v_extra.session_id
                )
            );
        END LOOP;
        v_total := v_total + v_extras_subtotal + v_extras_tax;
        v_tax_amount := v_tax_amount + v_extras_tax;
        v_subtotal := v_subtotal + v_extras_subtotal;
    END IF;

    IF v_ncf_type_setting = 'internal' THEN
        SELECT value#>>'{}' INTO v_invoice_prefix FROM public.settings WHERE key = 'internal_invoice_prefix';
        v_invoice_prefix := COALESCE(v_invoice_prefix, 'INV');
        SELECT (value#>>'{}')::BIGINT INTO v_invoice_next FROM public.settings WHERE key = 'internal_invoice_next';
        v_invoice_next := COALESCE(v_invoice_next, 1);
        v_invoice_number := v_invoice_prefix || LPAD(v_invoice_next::TEXT, 8, '0');
        v_ncf := v_invoice_number;
        UPDATE public.settings SET value = to_jsonb((v_invoice_next + 1)::TEXT) WHERE key = 'internal_invoice_next';
        IF NOT FOUND THEN
            INSERT INTO public.settings (key, value) VALUES ('internal_invoice_next', to_jsonb((v_invoice_next + 1)::TEXT));
        END IF;
    ELSE
        v_ncf := public.get_next_ncf(v_ncf_type_setting);
        v_invoice_number := v_ncf;
    END IF;

    INSERT INTO public.payments (
        subscription_id, customer_id, amount, tax_amount, total_amount,
        payment_method, status, invoice_number, ncf, description, attempt_number, metadata
    ) VALUES (
        p_subscription_id, v_sub.customer_id, v_subtotal, v_tax_amount, v_total,
        'subscription_auto', 'paid', v_invoice_number, v_ncf,
        'Factura automática - Plan ' || v_plan.name, 1,
        jsonb_build_object('generated_by', 'generate_subscription_invoice', 'user_id', v_auth.user_id, 'price_includes_tax', v_price_includes_tax)
    ) RETURNING id INTO v_payment_id;

    INSERT INTO public.invoices (
        payment_id, customer_id, invoice_number, ncf, subtotal, tax_amount, total, items, notes, metadata
    ) VALUES (
        v_payment_id, v_sub.customer_id, v_invoice_number, v_ncf,
        v_subtotal, v_tax_amount, v_total, v_items, NULL,
        jsonb_build_object('subscription_id', p_subscription_id, 'plan_id', v_sub.plan_id)
    ) RETURNING id INTO v_invoice_id;

    IF v_include_extras THEN
        UPDATE public.pending_charges SET status = 'invoiced', invoice_id = v_invoice_id
        WHERE subscription_id = p_subscription_id AND status = 'pending';
    END IF;

    v_billing_interval := CASE v_sub.billing_frequency
        WHEN 'monthly' THEN INTERVAL '1 month' WHEN 'quarterly' THEN INTERVAL '3 months'
        WHEN 'semiannual' THEN INTERVAL '6 months' WHEN 'annual' THEN INTERVAL '12 months'
        ELSE INTERVAL '1 month'
    END;

    v_new_period_start := v_sub.current_period_end;
    v_new_period_end := v_sub.current_period_end::DATE + v_billing_interval;
    v_new_next_billing := v_new_period_end;

    UPDATE public.subscriptions
    SET next_billing_date = v_new_next_billing, current_period_start = v_new_period_start, current_period_end = v_new_period_end
    WHERE id = p_subscription_id;

    RETURN json_build_object(
        'success', true, 'payment_id', v_payment_id, 'invoice_id', v_invoice_id,
        'invoice_number', v_invoice_number, 'ncf', v_ncf,
        'subtotal', v_subtotal, 'tax_amount', v_tax_amount, 'total', v_total,
        'next_billing_date', v_new_next_billing
    );
EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM, 'detail', SQLSTATE);
END;
$function$;

-- ============================================================================
-- FIX 4: run_billing_cycle
-- ============================================================================
CREATE OR REPLACE FUNCTION public.run_billing_cycle(p_token TEXT)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $function$
DECLARE
    v_auth RECORD; v_run_id UUID; v_sub RECORD; v_customer RECORD; v_plan RECORD;
    v_extra RECORD; v_include_extras BOOLEAN; v_ncf_type_setting TEXT; v_send_email BOOLEAN;
    v_ncf TEXT; v_invoice_prefix TEXT; v_invoice_next BIGINT; v_invoice_number TEXT;
    v_payment_id UUID; v_invoice_id UUID; v_items JSONB;
    v_subtotal NUMERIC; v_tax_amount NUMERIC; v_total NUMERIC;
    v_price_includes_tax BOOLEAN;
    v_extras_subtotal NUMERIC; v_extras_tax NUMERIC;
    v_billing_interval INTERVAL; v_new_next_billing DATE; v_new_period_start DATE; v_new_period_end DATE;
    v_processed INTEGER := 0; v_invoiced INTEGER := 0; v_failed INTEGER := 0;
    v_total_amount NUMERIC := 0; v_total_extras_amt NUMERIC := 0;
    v_details JSONB := '[]'::JSONB; v_detail_entry JSONB;
BEGIN
    SELECT * INTO v_auth FROM public.require_role(p_token, ARRAY['admin', 'super_admin']);

    INSERT INTO public.billing_runs (run_date, status, total_processed, total_invoiced, total_failed, total_amount, total_extras_amount, started_at)
    VALUES (CURRENT_DATE, 'running', 0, 0, 0, 0, 0, NOW())
    RETURNING id INTO v_run_id;

    SELECT COALESCE((SELECT (value#>>'{}')::BOOLEAN FROM public.settings WHERE key = 'billing.include_extras_in_subscription'), false) INTO v_include_extras;
    SELECT COALESCE((SELECT value#>>'{}' FROM public.settings WHERE key = 'billing.ncf_type_subscription'), 'B02') INTO v_ncf_type_setting;
    SELECT COALESCE((SELECT (value#>>'{}')::BOOLEAN FROM public.settings WHERE key = 'billing.send_email'), false) INTO v_send_email;

    FOR v_sub IN
        SELECT s.*, v.plate
        FROM public.subscriptions s
        JOIN public.vehicles v ON v.id = s.vehicle_id
        WHERE s.status = 'active' AND s.next_billing_date <= CURRENT_DATE
    LOOP
        v_processed := v_processed + 1;
        BEGIN
            SELECT * INTO v_customer FROM public.customers WHERE id = v_sub.customer_id;
            SELECT * INTO v_plan FROM public.plans WHERE id = v_sub.plan_id;

            v_price_includes_tax := COALESCE(v_plan.price_includes_tax, true);

            IF v_price_includes_tax THEN
                v_total := v_sub.price_per_period;
                v_subtotal := ROUND(v_sub.price_per_period / (1 + v_sub.tax_rate), 2);
                v_tax_amount := v_total - v_subtotal;
            ELSE
                v_subtotal := v_sub.price_per_period;
                v_tax_amount := ROUND(v_subtotal * v_sub.tax_rate, 2);
                v_total := v_subtotal + v_tax_amount;
            END IF;

            v_extras_subtotal := 0; v_extras_tax := 0;

            v_items := jsonb_build_array(jsonb_build_object(
                'type', 'subscription', 'description', 'Plan ' || v_plan.name || ' - ' || v_sub.billing_frequency,
                'quantity', 1, 'unit_price', v_subtotal, 'tax_rate', v_sub.tax_rate,
                'tax_amount', v_tax_amount, 'total', v_total
            ));

            IF v_include_extras THEN
                FOR v_extra IN SELECT * FROM public.pending_charges WHERE subscription_id = v_sub.id AND status = 'pending' LOOP
                    v_extras_subtotal := v_extras_subtotal + v_extra.amount;
                    v_extras_tax := v_extras_tax + COALESCE(v_extra.tax_amount, 0);
                    v_items := v_items || jsonb_build_array(jsonb_build_object(
                        'type', v_extra.type, 'description', v_extra.description, 'quantity', 1,
                        'unit_price', v_extra.amount, 'tax_amount', COALESCE(v_extra.tax_amount, 0),
                        'total', v_extra.amount + COALESCE(v_extra.tax_amount, 0), 'session_id', v_extra.session_id
                    ));
                END LOOP;
                v_tax_amount := v_tax_amount + v_extras_tax;
                v_subtotal := v_subtotal + v_extras_subtotal;
                v_total := v_subtotal + v_tax_amount;
            END IF;

            IF v_ncf_type_setting = 'internal' THEN
                SELECT value#>>'{}' INTO v_invoice_prefix FROM public.settings WHERE key = 'internal_invoice_prefix';
                v_invoice_prefix := COALESCE(v_invoice_prefix, 'INV');
                SELECT (value#>>'{}')::BIGINT INTO v_invoice_next FROM public.settings WHERE key = 'internal_invoice_next';
                v_invoice_next := COALESCE(v_invoice_next, 1);
                v_invoice_number := v_invoice_prefix || LPAD(v_invoice_next::TEXT, 8, '0');
                v_ncf := v_invoice_number;
                UPDATE public.settings SET value = to_jsonb((v_invoice_next + 1)::TEXT) WHERE key = 'internal_invoice_next';
                IF NOT FOUND THEN INSERT INTO public.settings (key, value) VALUES ('internal_invoice_next', to_jsonb((v_invoice_next + 1)::TEXT)); END IF;
            ELSE
                v_ncf := public.get_next_ncf(v_ncf_type_setting);
                v_invoice_number := v_ncf;
            END IF;

            INSERT INTO public.payments (subscription_id, customer_id, amount, tax_amount, total_amount, payment_method, status, invoice_number, ncf, description, attempt_number, metadata)
            VALUES (v_sub.id, v_sub.customer_id, v_subtotal, v_tax_amount, v_total, 'subscription_auto', 'paid', v_invoice_number, v_ncf,
                    'Factura automática - Plan ' || v_plan.name, 1, jsonb_build_object('billing_run_id', v_run_id, 'generated_by', 'run_billing_cycle', 'price_includes_tax', v_price_includes_tax))
            RETURNING id INTO v_payment_id;

            INSERT INTO public.invoices (payment_id, customer_id, invoice_number, ncf, subtotal, tax_amount, total, items, notes, metadata)
            VALUES (v_payment_id, v_sub.customer_id, v_invoice_number, v_ncf, v_subtotal, v_tax_amount, v_total, v_items, NULL,
                    jsonb_build_object('subscription_id', v_sub.id, 'plan_id', v_sub.plan_id, 'billing_run_id', v_run_id))
            RETURNING id INTO v_invoice_id;

            IF v_include_extras THEN
                UPDATE public.pending_charges SET status = 'invoiced', invoice_id = v_invoice_id
                WHERE subscription_id = v_sub.id AND status = 'pending';
            END IF;

            v_billing_interval := CASE v_sub.billing_frequency
                WHEN 'monthly' THEN INTERVAL '1 month' WHEN 'quarterly' THEN INTERVAL '3 months'
                WHEN 'semiannual' THEN INTERVAL '6 months' WHEN 'annual' THEN INTERVAL '12 months'
                ELSE INTERVAL '1 month'
            END;

            v_new_period_start := v_sub.current_period_end;
            v_new_period_end := v_sub.current_period_end::DATE + v_billing_interval;
            v_new_next_billing := v_new_period_end;

            UPDATE public.subscriptions SET next_billing_date = v_new_next_billing, current_period_start = v_new_period_start, current_period_end = v_new_period_end WHERE id = v_sub.id;

            v_invoiced := v_invoiced + 1;
            v_total_amount := v_total_amount + v_total;
            v_total_extras_amt := v_total_extras_amt + v_extras_subtotal + v_extras_tax;

            v_detail_entry := jsonb_build_object('subscription_id', v_sub.id, 'customer_id', v_sub.customer_id, 'invoice_number', v_invoice_number, 'total', v_total, 'status', 'success');

            IF v_send_email THEN
                BEGIN
                    INSERT INTO public.notifications (user_id, type, title, message, metadata, channel)
                    VALUES (v_customer.user_id, 'invoice_generated', 'Nueva factura generada',
                            'Su factura ' || v_invoice_number || ' por RD$' || v_total || ' ha sido generada.',
                            jsonb_build_object('invoice_id', v_invoice_id, 'payment_id', v_payment_id, 'invoice_number', v_invoice_number, 'total', v_total), 'email');
                EXCEPTION WHEN OTHERS THEN NULL;
                END;
            END IF;

        EXCEPTION WHEN OTHERS THEN
            v_failed := v_failed + 1;
            v_detail_entry := jsonb_build_object('subscription_id', v_sub.id, 'customer_id', v_sub.customer_id, 'status', 'failed', 'error', SQLERRM);
        END;
        v_details := v_details || jsonb_build_array(v_detail_entry);
    END LOOP;

    UPDATE public.billing_runs SET status = 'completed', total_processed = v_processed, total_invoiced = v_invoiced,
        total_failed = v_failed, total_amount = v_total_amount, total_extras_amount = v_total_extras_amt,
        details = v_details, completed_at = NOW()
    WHERE id = v_run_id;

    RETURN json_build_object('success', true, 'billing_run_id', v_run_id, 'total_processed', v_processed,
        'total_invoiced', v_invoiced, 'total_failed', v_failed, 'total_amount', v_total_amount,
        'total_extras_amount', v_total_extras_amt, 'details', v_details);

EXCEPTION WHEN OTHERS THEN
    IF v_run_id IS NOT NULL THEN
        UPDATE public.billing_runs SET status = 'failed', error_message = SQLERRM, completed_at = NOW() WHERE id = v_run_id;
    END IF;
    RETURN json_build_object('success', false, 'error', SQLERRM, 'detail', SQLSTATE);
END;
$function$;
