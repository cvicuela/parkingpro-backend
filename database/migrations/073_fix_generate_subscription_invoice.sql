-- Migration 073: Fix generate_subscription_invoice NCF + paid_at
-- Bugs:
--   * internal-mode fallback set v_ncf := v_invoice_number (stamped the internal number
--     like 'INV000..' into the fiscal `ncf` column; others use NULL) -> data hygiene /
--     potential 607 contamination (already mitigated by migration 069's fiscal filter).
--   * payment row was status='paid' but had NO paid_at -> revenue reports keyed on
--     paid_at undercount auto-billed subscriptions.
--   * internal_invoice_next read+increment without a row lock (dup numbers under race).
-- Fix: v_ncf := NULL for internal; add paid_at = NOW(); FOR UPDATE on the counter read.
CREATE OR REPLACE FUNCTION public.generate_subscription_invoice(p_token text, p_subscription_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
    v_auth RECORD; v_sub RECORD; v_customer RECORD; v_plan RECORD;
    v_subtotal NUMERIC; v_tax_amount NUMERIC; v_total NUMERIC;
    v_price_includes_tax BOOLEAN; v_include_extras BOOLEAN;
    v_ncf_type_setting TEXT; v_ncf TEXT; v_invoice_prefix TEXT;
    v_invoice_next BIGINT; v_invoice_number TEXT; v_invoice_mode TEXT;
    v_payment_id UUID; v_invoice_id UUID; v_items JSONB; v_rfid_items JSONB;
    v_extra RECORD; v_extras_subtotal NUMERIC := 0; v_extras_tax NUMERIC := 0;
    v_billing_interval INTERVAL; v_new_next_billing DATE;
    v_new_period_start DATE; v_new_period_end DATE; v_cards_activated INTEGER := 0;
BEGIN
    SELECT * INTO v_auth FROM require_role(p_token, ARRAY['admin','super_admin']);
    SELECT s.*, v.plate INTO v_sub FROM subscriptions s LEFT JOIN vehicles v ON v.id = s.vehicle_id WHERE s.id = p_subscription_id;
    IF NOT FOUND THEN RETURN json_build_object('success', false, 'error', 'Subscription not found'); END IF;
    SELECT * INTO v_customer FROM customers WHERE id = v_sub.customer_id;
    SELECT * INTO v_plan FROM plans WHERE id = v_sub.plan_id;

    v_price_includes_tax := COALESCE(v_plan.price_includes_tax, true);
    SELECT COALESCE((SELECT (value#>>'{}')::BOOLEAN FROM settings WHERE key = 'billing.include_extras_in_subscription'), false) INTO v_include_extras;
    SELECT COALESCE((SELECT value#>>'{}' FROM settings WHERE key = 'billing.ncf_type_subscription'), 'B02') INTO v_ncf_type_setting;

    IF v_price_includes_tax THEN
        v_total := v_sub.price_per_period;
        v_subtotal := ROUND(v_total / (1 + COALESCE(v_sub.tax_rate, 0.18)), 2);
        v_tax_amount := v_total - v_subtotal;
    ELSE
        v_subtotal := v_sub.price_per_period;
        v_tax_amount := ROUND(v_subtotal * COALESCE(v_sub.tax_rate, 0.18), 2);
        v_total := v_subtotal + v_tax_amount;
    END IF;

    v_items := jsonb_build_array(jsonb_build_object('type', 'subscription', 'description', 'Plan ' || v_plan.name || ' - ' || v_sub.billing_frequency,
        'quantity', 1, 'unit_price', v_subtotal, 'tax_rate', COALESCE(v_sub.tax_rate, 0.18), 'tax_amount', v_tax_amount, 'total', v_total));

    v_rfid_items := build_rfid_invoice_items(p_subscription_id);
    IF jsonb_array_length(v_rfid_items) > 0 THEN v_items := v_items || v_rfid_items; END IF;

    IF v_include_extras THEN
        FOR v_extra IN SELECT * FROM pending_charges WHERE subscription_id = p_subscription_id AND status = 'pending' LOOP
            v_extras_subtotal := v_extras_subtotal + v_extra.amount; v_extras_tax := v_extras_tax + COALESCE(v_extra.tax_amount, 0);
            v_items := v_items || jsonb_build_array(jsonb_build_object('type', v_extra.type, 'description', v_extra.description,
                'quantity', 1, 'unit_price', v_extra.amount, 'tax_amount', COALESCE(v_extra.tax_amount, 0),
                'total', v_extra.amount + COALESCE(v_extra.tax_amount, 0)));
        END LOOP;
        v_tax_amount := v_tax_amount + v_extras_tax; v_subtotal := v_subtotal + v_extras_subtotal; v_total := v_subtotal + v_tax_amount;
    END IF;

    SELECT COALESCE((SELECT value#>>'{}' FROM settings WHERE key = 'invoice_mode'), 'interno') INTO v_invoice_mode;
    IF v_invoice_mode = 'fiscal' OR v_ncf_type_setting NOT IN ('internal','interno') THEN
        BEGIN v_ncf := get_next_ncf(CASE WHEN v_ncf_type_setting IN ('internal','interno') THEN 'B02' ELSE v_ncf_type_setting END);
            v_invoice_number := v_ncf; EXCEPTION WHEN OTHERS THEN v_ncf := NULL; v_invoice_number := NULL; END;
    END IF;
    IF v_invoice_number IS NULL THEN
        SELECT value#>>'{}' INTO v_invoice_prefix FROM settings WHERE key = 'internal_invoice_prefix';
        v_invoice_prefix := COALESCE(v_invoice_prefix, 'INV');
        SELECT (value#>>'{}')::BIGINT INTO v_invoice_next FROM settings WHERE key = 'internal_invoice_next' FOR UPDATE;
        v_invoice_next := COALESCE(v_invoice_next, 1);
        v_invoice_number := v_invoice_prefix || LPAD(v_invoice_next::TEXT, 8, '0');
        v_ncf := NULL;  -- FIX: internal invoices keep ncf NULL (was: v_ncf := v_invoice_number)
        UPDATE settings SET value = to_jsonb((v_invoice_next + 1)::TEXT) WHERE key = 'internal_invoice_next';
        IF NOT FOUND THEN INSERT INTO settings (key, value) VALUES ('internal_invoice_next', to_jsonb((v_invoice_next + 1)::TEXT)); END IF;
    END IF;

    INSERT INTO payments (subscription_id, customer_id, amount, tax_amount, total_amount, payment_method, status, invoice_number, ncf, description, attempt_number, paid_at, metadata)
    VALUES (p_subscription_id, v_sub.customer_id, v_subtotal, v_tax_amount, v_total, 'subscription_auto', 'paid', v_invoice_number, v_ncf,
        'Factura automatica - Plan ' || v_plan.name, 1, NOW(),
        jsonb_build_object('generated_by', 'generate_subscription_invoice', 'user_id', v_auth.user_id, 'price_includes_tax', v_price_includes_tax))
    RETURNING id INTO v_payment_id;

    INSERT INTO invoices (payment_id, customer_id, invoice_number, ncf, subtotal, tax_amount, total, items, notes, metadata)
    VALUES (v_payment_id, v_sub.customer_id, v_invoice_number, v_ncf, v_subtotal, v_tax_amount, v_total, v_items, NULL,
        jsonb_build_object('subscription_id', p_subscription_id, 'plan_id', v_sub.plan_id))
    RETURNING id INTO v_invoice_id;

    IF v_include_extras THEN
        UPDATE pending_charges SET status = 'invoiced', invoice_id = v_invoice_id WHERE subscription_id = p_subscription_id AND status = 'pending';
    END IF;

    v_billing_interval := CASE v_sub.billing_frequency WHEN 'monthly' THEN INTERVAL '1 month' WHEN 'quarterly' THEN INTERVAL '3 months'
        WHEN 'semiannual' THEN INTERVAL '6 months' WHEN 'annual' THEN INTERVAL '12 months' ELSE INTERVAL '1 month' END;
    v_new_period_start := v_sub.current_period_end;
    v_new_period_end := v_sub.current_period_end::DATE + v_billing_interval;
    v_new_next_billing := v_new_period_end;
    UPDATE subscriptions SET next_billing_date = v_new_next_billing, current_period_start = v_new_period_start,
        current_period_end = v_new_period_end WHERE id = p_subscription_id;

    v_cards_activated := activate_subscription_rfid_cards(p_subscription_id);

    RETURN json_build_object('success', true, 'payment_id', v_payment_id, 'invoice_id', v_invoice_id,
        'invoice_number', v_invoice_number, 'ncf', v_ncf, 'subtotal', v_subtotal,
        'tax_amount', v_tax_amount, 'total', v_total, 'next_billing_date', v_new_next_billing, 'cards_activated', v_cards_activated);
EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM, 'detail', SQLSTATE);
END;
$function$;
