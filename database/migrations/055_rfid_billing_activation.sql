-- Migration 055: RFID card activation/deactivation linked to billing
--
-- Logic:
-- 1. When a prepaid invoice is generated and paid → activate all RFID cards of that subscription
-- 2. When billing cycle runs and invoice is paid → activate RFID cards
-- 3. When subscription expires past grace period → deactivate RFID cards (auto_suspend_expired)
-- 4. When subscription is reactivated → reactivate RFID cards
-- 5. Each RFID card appears as a line item in the invoice

-- ============================================================
-- 1. Helper: activate all RFID cards for a subscription
-- ============================================================
CREATE OR REPLACE FUNCTION public.activate_subscription_rfid_cards(
    p_subscription_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_count INTEGER := 0;
BEGIN
    UPDATE public.rfid_cards
    SET status = 'assigned',
        updated_at = NOW()
    WHERE subscription_id = p_subscription_id
      AND status IN ('available', 'disabled')
      AND card_type = 'permanent';

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- ============================================================
-- 2. Helper: deactivate all RFID cards for a subscription
-- ============================================================
CREATE OR REPLACE FUNCTION public.deactivate_subscription_rfid_cards(
    p_subscription_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_count INTEGER := 0;
BEGIN
    UPDATE public.rfid_cards
    SET status = 'disabled',
        updated_at = NOW()
    WHERE subscription_id = p_subscription_id
      AND status IN ('assigned', 'in_use')
      AND card_type = 'permanent';

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- ============================================================
-- 3. Helper: build RFID card line items for invoice
-- ============================================================
CREATE OR REPLACE FUNCTION public.build_rfid_invoice_items(
    p_subscription_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_items JSONB := '[]'::JSONB;
    v_card  RECORD;
BEGIN
    FOR v_card IN
        SELECT rc.id, rc.card_uid, rc.label
        FROM public.rfid_cards rc
        WHERE rc.subscription_id = p_subscription_id
          AND rc.card_type = 'permanent'
          AND rc.status != 'lost'
        ORDER BY rc.created_at
    LOOP
        v_items := v_items || jsonb_build_array(
            jsonb_build_object(
                'type',        'rfid_card',
                'description', 'Tarjeta NFC: ' || COALESCE(v_card.label, v_card.card_uid),
                'card_id',     v_card.id,
                'card_uid',    v_card.card_uid,
                'quantity',    1,
                'unit_price',  0,
                'tax_amount',  0,
                'total',       0
            )
        );
    END LOOP;

    RETURN v_items;
END;
$$;


-- ============================================================
-- 4. Updated: generate_prepaid_invoice - now activates RFID cards
-- ============================================================
CREATE OR REPLACE FUNCTION public.generate_prepaid_invoice(
    p_token           TEXT,
    p_subscription_id UUID,
    p_months          INTEGER,
    p_discount_id     UUID    DEFAULT NULL,
    p_payment_method  TEXT    DEFAULT 'cash',
    p_notes           TEXT    DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_auth              RECORD;
    v_sub               RECORD;
    v_customer          RECORD;
    v_plan              RECORD;
    v_discount          RECORD;
    v_price_includes_tax BOOLEAN;
    v_monthly_gross     NUMERIC;
    v_monthly_net       NUMERIC;
    v_net_raw           NUMERIC;
    v_discount_amt      NUMERIC := 0;
    v_subtotal          NUMERIC;
    v_tax_amount        NUMERIC;
    v_total             NUMERIC;
    v_tax_rate          NUMERIC;
    v_ncf_type_setting  TEXT;
    v_ncf               TEXT;
    v_invoice_prefix    TEXT;
    v_invoice_next      BIGINT;
    v_invoice_number    TEXT;
    v_payment_id        UUID;
    v_invoice_id        UUID;
    v_items             JSONB;
    v_rfid_items        JSONB;
    v_new_period_start  DATE;
    v_new_period_end    DATE;
    v_new_next_billing  DATE;
    v_include_extras    BOOLEAN;
    v_extra             RECORD;
    v_extras_subtotal   NUMERIC := 0;
    v_extras_tax        NUMERIC := 0;
    v_cards_activated   INTEGER := 0;
BEGIN
    SELECT * INTO v_auth FROM public.require_role(p_token, ARRAY['admin','super_admin']);

    SELECT s.*, v.plate
    INTO v_sub
    FROM public.subscriptions s
    LEFT JOIN public.vehicles v ON v.id = s.vehicle_id
    WHERE s.id = p_subscription_id;

    IF NOT FOUND THEN
        RETURN json_build_object('success', false, 'error', 'Suscripción no encontrada');
    END IF;

    SELECT * INTO v_customer FROM public.customers WHERE id = v_sub.customer_id;
    SELECT * INTO v_plan     FROM public.plans     WHERE id = v_sub.plan_id;

    v_monthly_gross      := v_sub.price_per_period;
    v_tax_rate           := COALESCE(v_sub.tax_rate, 0.18);
    v_price_includes_tax := COALESCE(v_plan.price_includes_tax, true);

    IF v_price_includes_tax THEN
        v_monthly_net := ROUND(v_monthly_gross / (1 + v_tax_rate), 2);
    ELSE
        v_monthly_net := v_monthly_gross;
    END IF;

    v_net_raw := v_monthly_net * p_months;

    -- Apply discount on NET price
    IF p_discount_id IS NOT NULL THEN
        SELECT * INTO v_discount FROM public.discounts WHERE id = p_discount_id AND is_active = true;
        IF FOUND THEN
            IF p_months < COALESCE(v_discount.min_months, 1) THEN
                RETURN json_build_object('success', false, 'error',
                    'Se requieren mínimo ' || v_discount.min_months || ' meses para este descuento');
            END IF;
            IF v_discount.max_uses IS NOT NULL AND v_discount.current_uses >= v_discount.max_uses THEN
                RETURN json_build_object('success', false, 'error', 'Descuento agotado');
            END IF;

            IF v_discount.type = 'percentage' THEN
                v_discount_amt := ROUND(v_net_raw * (v_discount.value / 100), 2);
            ELSE
                v_discount_amt := LEAST(v_discount.value, v_net_raw);
            END IF;

            UPDATE public.discounts
            SET current_uses = current_uses + 1, updated_at = NOW()
            WHERE id = p_discount_id;
        END IF;
    END IF;

    v_subtotal   := v_net_raw - v_discount_amt;
    v_tax_amount := ROUND(v_subtotal * v_tax_rate, 2);
    v_total      := v_subtotal + v_tax_amount;

    -- Build items array: subscription line
    v_items := jsonb_build_array(
        jsonb_build_object(
            'type',        'subscription_prepaid',
            'description', 'Plan ' || v_plan.name || ' - ' || p_months || ' meses',
            'quantity',    p_months,
            'unit_price',  v_monthly_net,
            'tax_rate',    v_tax_rate,
            'tax_amount',  v_tax_amount,
            'total',       v_total
        )
    );

    -- Add discount line item
    IF v_discount_amt > 0 THEN
        v_items := v_items || jsonb_build_array(
            jsonb_build_object(
                'type',        'discount',
                'description', 'Descuento: ' || v_discount.name ||
                    CASE WHEN v_discount.type = 'percentage'
                         THEN ' (' || v_discount.value || '%)'
                         ELSE '' END,
                'quantity',    1,
                'unit_price',  -v_discount_amt,
                'tax_amount',  0,
                'total',       -v_discount_amt
            )
        );
    END IF;

    -- Add RFID card line items (each card appears in the invoice)
    v_rfid_items := public.build_rfid_invoice_items(p_subscription_id);
    IF jsonb_array_length(v_rfid_items) > 0 THEN
        v_items := v_items || v_rfid_items;
    END IF;

    -- Include pending extras
    SELECT COALESCE((SELECT (value#>>'{}')::BOOLEAN FROM public.settings WHERE key = 'billing.include_extras_in_subscription'), false)
    INTO v_include_extras;

    IF v_include_extras THEN
        FOR v_extra IN
            SELECT * FROM public.pending_charges
            WHERE subscription_id = p_subscription_id AND status = 'pending'
        LOOP
            v_extras_subtotal := v_extras_subtotal + v_extra.amount;
            v_extras_tax      := v_extras_tax + COALESCE(v_extra.tax_amount, 0);
            v_items := v_items || jsonb_build_array(
                jsonb_build_object(
                    'type',        v_extra.type,
                    'description', v_extra.description,
                    'quantity',    1,
                    'unit_price',  v_extra.amount,
                    'tax_amount',  COALESCE(v_extra.tax_amount, 0),
                    'total',       v_extra.amount + COALESCE(v_extra.tax_amount, 0)
                )
            );
        END LOOP;

        v_subtotal   := v_subtotal + v_extras_subtotal;
        v_tax_amount := v_tax_amount + v_extras_tax;
        v_total      := v_subtotal + v_tax_amount;
    END IF;

    -- Determine NCF / invoice number
    SELECT COALESCE((SELECT value#>>'{}' FROM public.settings WHERE key = 'billing.ncf_type_subscription'), 'B02')
    INTO v_ncf_type_setting;

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

    -- Create payment
    INSERT INTO public.payments (
        subscription_id, customer_id,
        amount, tax_amount, total_amount,
        payment_method, status,
        invoice_number, ncf, description,
        attempt_number, metadata
    ) VALUES (
        p_subscription_id, v_sub.customer_id,
        v_subtotal, v_tax_amount, v_total,
        p_payment_method, 'paid',
        v_invoice_number, v_ncf,
        'Factura prepago ' || p_months || ' meses - Plan ' || v_plan.name,
        1,
        jsonb_build_object(
            'generated_by', 'generate_prepaid_invoice',
            'user_id', v_auth.user_id,
            'months', p_months,
            'discount_id', p_discount_id,
            'discount_amount', v_discount_amt
        )
    )
    RETURNING id INTO v_payment_id;

    -- Create invoice
    INSERT INTO public.invoices (
        payment_id, customer_id,
        invoice_number, ncf,
        subtotal, tax_amount, total,
        items, notes, metadata
    ) VALUES (
        v_payment_id, v_sub.customer_id,
        v_invoice_number, v_ncf,
        v_subtotal, v_tax_amount, v_total,
        v_items, p_notes,
        jsonb_build_object(
            'subscription_id', p_subscription_id,
            'plan_id', v_sub.plan_id,
            'prepaid_months', p_months,
            'discount_id', p_discount_id,
            'discount_amount', v_discount_amt,
            'payment_type', 'prepaid'
        )
    )
    RETURNING id INTO v_invoice_id;

    -- Record discount usage
    IF p_discount_id IS NOT NULL AND v_discount_amt > 0 THEN
        INSERT INTO public.subscription_discounts (
            subscription_id, discount_id,
            applied_value, applied_type,
            months_covered, invoice_id
        ) VALUES (
            p_subscription_id, p_discount_id,
            v_discount_amt, v_discount.type,
            p_months, v_invoice_id
        );
    END IF;

    -- Mark pending charges as invoiced
    IF v_include_extras THEN
        UPDATE public.pending_charges
        SET status = 'invoiced', invoice_id = v_invoice_id
        WHERE subscription_id = p_subscription_id AND status = 'pending';
    END IF;

    -- Advance subscription dates
    v_new_period_start := COALESCE(v_sub.current_period_end, CURRENT_DATE);
    v_new_period_end   := v_new_period_start + (p_months || ' months')::INTERVAL;
    v_new_next_billing := v_new_period_end;

    UPDATE public.subscriptions
    SET next_billing_date    = v_new_next_billing,
        current_period_start = v_new_period_start,
        current_period_end   = v_new_period_end,
        billing_end_date     = v_new_period_end,
        prepaid_months       = p_months,
        payment_type         = 'prepaid',
        discount_id          = p_discount_id,
        discount_amount      = v_discount_amt,
        original_price       = v_net_raw,
        status               = 'active',
        activated_at         = COALESCE(activated_at, NOW()),
        updated_at           = NOW()
    WHERE id = p_subscription_id;

    -- ACTIVATE all RFID cards for this subscription (payment confirmed)
    v_cards_activated := public.activate_subscription_rfid_cards(p_subscription_id);

    RETURN json_build_object(
        'success',           true,
        'payment_id',        v_payment_id,
        'invoice_id',        v_invoice_id,
        'invoice_number',    v_invoice_number,
        'ncf',               v_ncf,
        'months',            p_months,
        'discount_amount',   v_discount_amt,
        'subtotal',          v_subtotal,
        'tax_amount',        v_tax_amount,
        'total',             v_total,
        'period_start',      v_new_period_start,
        'period_end',        v_new_period_end,
        'next_billing_date', v_new_next_billing,
        'cards_activated',   v_cards_activated
    );

EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM, 'detail', SQLSTATE);
END;
$$;


-- ============================================================
-- 5. Updated: auto_suspend_expired - now deactivates RFID cards
-- ============================================================
CREATE OR REPLACE FUNCTION public.auto_suspend_expired(
    p_token TEXT
)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_auth      RECORD;
    v_count     INTEGER := 0;
    v_cards_off INTEGER := 0;
    v_grace     INTEGER;
    v_sub       RECORD;
    v_details   JSONB := '[]'::JSONB;
    v_sub_cards INTEGER;
BEGIN
    SELECT * INTO v_auth FROM public.require_role(p_token, ARRAY['admin','super_admin']);

    SELECT COALESCE((SELECT (value#>>'{}')::INTEGER FROM public.settings WHERE key = 'billing.grace_period_days'), 5)
    INTO v_grace;

    FOR v_sub IN
        SELECT s.id, s.customer_id, s.next_billing_date,
               c.first_name || ' ' || c.last_name AS customer_name,
               p.name AS plan_name
        FROM public.subscriptions s
        JOIN public.customers c ON c.id = s.customer_id
        JOIN public.plans p     ON p.id = s.plan_id
        WHERE s.status = 'active'
          AND s.next_billing_date + v_grace < CURRENT_DATE
    LOOP
        -- Suspend subscription
        UPDATE public.subscriptions
        SET status = 'suspended',
            suspended_at = NOW(),
            updated_at = NOW()
        WHERE id = v_sub.id;

        -- DEACTIVATE all RFID cards for this subscription
        v_sub_cards := public.deactivate_subscription_rfid_cards(v_sub.id);
        v_cards_off := v_cards_off + v_sub_cards;

        v_count := v_count + 1;
        v_details := v_details || jsonb_build_array(jsonb_build_object(
            'subscription_id', v_sub.id,
            'customer_name', v_sub.customer_name,
            'plan_name', v_sub.plan_name,
            'expired_date', v_sub.next_billing_date,
            'cards_deactivated', v_sub_cards
        ));
    END LOOP;

    RETURN json_build_object(
        'success', true,
        'suspended_count', v_count,
        'cards_deactivated', v_cards_off,
        'details', v_details
    );
EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$$;


-- ============================================================
-- 6. Updated: generate_subscription_invoice - activates RFID cards + adds card items
-- ============================================================
CREATE OR REPLACE FUNCTION public.generate_subscription_invoice(p_token TEXT, p_subscription_id UUID)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $function$
DECLARE
    v_auth RECORD; v_sub RECORD; v_customer RECORD; v_plan RECORD;
    v_subtotal NUMERIC; v_tax_amount NUMERIC; v_total NUMERIC;
    v_price_includes_tax BOOLEAN; v_include_extras BOOLEAN;
    v_ncf_type_setting TEXT; v_ncf TEXT; v_invoice_prefix TEXT;
    v_invoice_next BIGINT; v_invoice_number TEXT; v_invoice_mode TEXT;
    v_payment_id UUID; v_invoice_id UUID; v_items JSONB;
    v_rfid_items JSONB;
    v_extra RECORD; v_extras_subtotal NUMERIC := 0; v_extras_tax NUMERIC := 0;
    v_billing_interval INTERVAL; v_new_next_billing DATE;
    v_new_period_start DATE; v_new_period_end DATE;
    v_cards_activated INTEGER := 0;
BEGIN
    SELECT * INTO v_auth FROM require_role(p_token, ARRAY['admin','super_admin']);

    SELECT s.*, v.plate INTO v_sub FROM subscriptions s LEFT JOIN vehicles v ON v.id = s.vehicle_id WHERE s.id = p_subscription_id;
    IF NOT FOUND THEN RETURN json_build_object('success', false, 'error', 'Subscription not found'); END IF;

    SELECT * INTO v_customer FROM customers WHERE id = v_sub.customer_id;
    SELECT * INTO v_plan FROM plans WHERE id = v_sub.plan_id;

    v_price_includes_tax := COALESCE(v_plan.price_includes_tax, true);
    SELECT COALESCE((SELECT (value#>>'{}')::BOOLEAN FROM settings WHERE key = 'billing.include_extras_in_subscription'), false) INTO v_include_extras;
    SELECT COALESCE((SELECT value#>>'{}' FROM settings WHERE key = 'billing.ncf_type_subscription'), 'B02') INTO v_ncf_type_setting;

    -- Calculate amounts respecting price_includes_tax
    IF v_price_includes_tax THEN
        v_total := v_sub.price_per_period;
        v_subtotal := ROUND(v_total / (1 + COALESCE(v_sub.tax_rate, 0.18)), 2);
        v_tax_amount := v_total - v_subtotal;
    ELSE
        v_subtotal := v_sub.price_per_period;
        v_tax_amount := ROUND(v_subtotal * COALESCE(v_sub.tax_rate, 0.18), 2);
        v_total := v_subtotal + v_tax_amount;
    END IF;

    v_items := jsonb_build_array(jsonb_build_object(
        'type', 'subscription', 'description', 'Plan ' || v_plan.name || ' - ' || v_sub.billing_frequency,
        'quantity', 1, 'unit_price', v_subtotal, 'tax_rate', COALESCE(v_sub.tax_rate, 0.18),
        'tax_amount', v_tax_amount, 'total', v_total));

    -- Add RFID card line items
    v_rfid_items := build_rfid_invoice_items(p_subscription_id);
    IF jsonb_array_length(v_rfid_items) > 0 THEN
        v_items := v_items || v_rfid_items;
    END IF;

    IF v_include_extras THEN
        FOR v_extra IN SELECT * FROM pending_charges WHERE subscription_id = p_subscription_id AND status = 'pending' LOOP
            v_extras_subtotal := v_extras_subtotal + v_extra.amount;
            v_extras_tax := v_extras_tax + COALESCE(v_extra.tax_amount, 0);
            v_items := v_items || jsonb_build_array(jsonb_build_object(
                'type', v_extra.type, 'description', v_extra.description, 'quantity', 1,
                'unit_price', v_extra.amount, 'tax_amount', COALESCE(v_extra.tax_amount, 0),
                'total', v_extra.amount + COALESCE(v_extra.tax_amount, 0)));
        END LOOP;
        v_tax_amount := v_tax_amount + v_extras_tax;
        v_subtotal := v_subtotal + v_extras_subtotal;
        v_total := v_subtotal + v_tax_amount;
    END IF;

    -- Invoice numbering
    SELECT COALESCE((SELECT value#>>'{}' FROM settings WHERE key = 'invoice_mode'), 'interno') INTO v_invoice_mode;

    IF v_invoice_mode = 'fiscal' OR v_ncf_type_setting NOT IN ('internal','interno') THEN
        BEGIN
            v_ncf := get_next_ncf(CASE WHEN v_ncf_type_setting IN ('internal','interno') THEN 'B02' ELSE v_ncf_type_setting END);
            v_invoice_number := v_ncf;
        EXCEPTION WHEN OTHERS THEN
            v_ncf := NULL; v_invoice_number := NULL;
        END;
    END IF;

    IF v_invoice_number IS NULL THEN
        SELECT value#>>'{}' INTO v_invoice_prefix FROM settings WHERE key = 'internal_invoice_prefix';
        v_invoice_prefix := COALESCE(v_invoice_prefix, 'INV');
        SELECT (value#>>'{}')::BIGINT INTO v_invoice_next FROM settings WHERE key = 'internal_invoice_next';
        v_invoice_next := COALESCE(v_invoice_next, 1);
        v_invoice_number := v_invoice_prefix || LPAD(v_invoice_next::TEXT, 8, '0');
        v_ncf := v_invoice_number;
        UPDATE settings SET value = to_jsonb((v_invoice_next + 1)::TEXT) WHERE key = 'internal_invoice_next';
        IF NOT FOUND THEN INSERT INTO settings (key, value) VALUES ('internal_invoice_next', to_jsonb((v_invoice_next + 1)::TEXT)); END IF;
    END IF;

    INSERT INTO payments (subscription_id, customer_id, amount, tax_amount, total_amount, payment_method, status, invoice_number, ncf, description, attempt_number, metadata)
    VALUES (p_subscription_id, v_sub.customer_id, v_subtotal, v_tax_amount, v_total, 'subscription_auto', 'paid', v_invoice_number, v_ncf,
        'Factura automática - Plan ' || v_plan.name, 1,
        jsonb_build_object('generated_by', 'generate_subscription_invoice', 'user_id', v_auth.user_id, 'price_includes_tax', v_price_includes_tax))
    RETURNING id INTO v_payment_id;

    INSERT INTO invoices (payment_id, customer_id, invoice_number, ncf, subtotal, tax_amount, total, items, notes, metadata)
    VALUES (v_payment_id, v_sub.customer_id, v_invoice_number, v_ncf, v_subtotal, v_tax_amount, v_total, v_items, NULL,
        jsonb_build_object('subscription_id', p_subscription_id, 'plan_id', v_sub.plan_id))
    RETURNING id INTO v_invoice_id;

    IF v_include_extras THEN
        UPDATE pending_charges SET status = 'invoiced', invoice_id = v_invoice_id
        WHERE subscription_id = p_subscription_id AND status = 'pending';
    END IF;

    v_billing_interval := CASE v_sub.billing_frequency
        WHEN 'monthly' THEN INTERVAL '1 month' WHEN 'quarterly' THEN INTERVAL '3 months'
        WHEN 'semiannual' THEN INTERVAL '6 months' WHEN 'annual' THEN INTERVAL '12 months'
        ELSE INTERVAL '1 month' END;

    v_new_period_start := v_sub.current_period_end;
    v_new_period_end := v_sub.current_period_end::DATE + v_billing_interval;
    v_new_next_billing := v_new_period_end;

    UPDATE subscriptions SET next_billing_date = v_new_next_billing, current_period_start = v_new_period_start,
        current_period_end = v_new_period_end WHERE id = p_subscription_id;

    -- ACTIVATE RFID cards on successful billing
    v_cards_activated := activate_subscription_rfid_cards(p_subscription_id);

    RETURN json_build_object('success', true, 'payment_id', v_payment_id, 'invoice_id', v_invoice_id,
        'invoice_number', v_invoice_number, 'ncf', v_ncf, 'subtotal', v_subtotal,
        'tax_amount', v_tax_amount, 'total', v_total, 'next_billing_date', v_new_next_billing,
        'cards_activated', v_cards_activated);

EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM, 'detail', SQLSTATE);
END;
$function$;


-- ============================================================
-- 7. Updated: reactivate_subscription - also reactivates RFID cards
--    (patch the existing function to add RFID activation)
-- ============================================================
DO $$
BEGIN
    -- Only patch if the function exists
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'reactivate_subscription') THEN
        -- We create a wrapper that calls the original + activates cards
        NULL; -- handled below
    END IF;
END $$;

-- Hook into suspend_subscription to deactivate cards
CREATE OR REPLACE FUNCTION public.on_subscription_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    -- When subscription becomes active → activate RFID cards
    IF NEW.status = 'active' AND OLD.status != 'active' THEN
        PERFORM public.activate_subscription_rfid_cards(NEW.id);
    END IF;

    -- When subscription becomes suspended/cancelled → deactivate RFID cards
    IF NEW.status IN ('suspended', 'cancelled') AND OLD.status NOT IN ('suspended', 'cancelled') THEN
        PERFORM public.deactivate_subscription_rfid_cards(NEW.id);
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_subscription_rfid_sync ON public.subscriptions;

CREATE TRIGGER trg_subscription_rfid_sync
    AFTER UPDATE OF status ON public.subscriptions
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION public.on_subscription_status_change();
