-- Migration 053: Discounts system and prepaid multi-period billing
-- Creates: discounts table, subscription_discounts, new fields on subscriptions
-- New RPCs: CRUD discounts, calculate_prepaid_invoice, generate_prepaid_invoice

-- ============================================================
-- 1. discounts table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.discounts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(100) NOT NULL,
    description     TEXT,
    type            VARCHAR(20) NOT NULL DEFAULT 'percentage'
                    CHECK (type IN ('percentage', 'fixed_amount')),
    value           DECIMAL(10,2) NOT NULL CHECK (value >= 0),
    applies_to      VARCHAR(20) NOT NULL DEFAULT 'global'
                    CHECK (applies_to IN ('plan', 'subscription', 'global')),
    plan_id         UUID REFERENCES public.plans(id) ON DELETE SET NULL,
    min_months      INTEGER DEFAULT 1,
    max_uses        INTEGER,          -- NULL = unlimited
    current_uses    INTEGER DEFAULT 0,
    valid_from      DATE DEFAULT CURRENT_DATE,
    valid_until     DATE,             -- NULL = no expiration
    is_active       BOOLEAN DEFAULT true,
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_discounts_active ON public.discounts(is_active);
CREATE INDEX IF NOT EXISTS idx_discounts_plan   ON public.discounts(plan_id);

-- ============================================================
-- 2. subscription_discounts (applied discounts history)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.subscription_discounts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    subscription_id UUID NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
    discount_id     UUID NOT NULL REFERENCES public.discounts(id) ON DELETE RESTRICT,
    applied_value   DECIMAL(10,2) NOT NULL,
    applied_type    VARCHAR(20) NOT NULL,
    months_covered  INTEGER DEFAULT 1,
    invoice_id      UUID REFERENCES public.invoices(id) ON DELETE SET NULL,
    applied_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sub_discounts_sub ON public.subscription_discounts(subscription_id);

-- ============================================================
-- 3. Add prepaid fields to subscriptions
-- ============================================================
ALTER TABLE public.subscriptions
    ADD COLUMN IF NOT EXISTS prepaid_months    INTEGER DEFAULT 1,
    ADD COLUMN IF NOT EXISTS discount_id       UUID REFERENCES public.discounts(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS discount_amount   DECIMAL(10,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS original_price    DECIMAL(10,2),
    ADD COLUMN IF NOT EXISTS billing_end_date  DATE,
    ADD COLUMN IF NOT EXISTS payment_type      VARCHAR(20) DEFAULT 'recurring'
                             CHECK (payment_type IN ('recurring', 'prepaid'));


-- ============================================================
-- 4. CRUD RPCs for discounts
-- ============================================================

-- 4a. list_discounts
CREATE OR REPLACE FUNCTION public.list_discounts(
    p_token   TEXT,
    p_active  BOOLEAN DEFAULT NULL,
    p_plan_id UUID    DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_auth   RECORD;
    v_result JSON;
BEGIN
    SELECT * INTO v_auth FROM public.require_role(p_token, ARRAY['admin','super_admin','operator']);

    SELECT json_agg(row_to_json(d) ORDER BY d.created_at DESC)
    INTO v_result
    FROM (
        SELECT d.*, p.name AS plan_name
        FROM public.discounts d
        LEFT JOIN public.plans p ON p.id = d.plan_id
        WHERE (p_active IS NULL OR d.is_active = p_active)
          AND (p_plan_id IS NULL OR d.plan_id = p_plan_id)
        ORDER BY d.created_at DESC
    ) d;

    RETURN json_build_object('success', true, 'data', COALESCE(v_result, '[]'::JSON));
EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- 4b. get_discount
CREATE OR REPLACE FUNCTION public.get_discount(
    p_token TEXT,
    p_id    UUID
)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_auth   RECORD;
    v_result JSON;
BEGIN
    SELECT * INTO v_auth FROM public.require_role(p_token, ARRAY['admin','super_admin','operator']);

    SELECT row_to_json(d)
    INTO v_result
    FROM (
        SELECT d.*, p.name AS plan_name,
               COALESCE(d.max_uses, 0) - d.current_uses AS remaining_uses
        FROM public.discounts d
        LEFT JOIN public.plans p ON p.id = d.plan_id
        WHERE d.id = p_id
    ) d;

    IF v_result IS NULL THEN
        RETURN json_build_object('success', false, 'error', 'Descuento no encontrado');
    END IF;

    RETURN json_build_object('success', true, 'data', v_result);
EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- 4c. create_discount
CREATE OR REPLACE FUNCTION public.create_discount(
    p_token TEXT,
    p_data  JSONB
)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_auth   RECORD;
    v_id     UUID;
BEGIN
    SELECT * INTO v_auth FROM public.require_role(p_token, ARRAY['admin','super_admin']);

    INSERT INTO public.discounts (
        name, description, type, value, applies_to, plan_id,
        min_months, max_uses, valid_from, valid_until, is_active
    ) VALUES (
        p_data->>'name',
        p_data->>'description',
        COALESCE(p_data->>'type', 'percentage'),
        (p_data->>'value')::DECIMAL,
        COALESCE(p_data->>'applies_to', 'global'),
        CASE WHEN p_data->>'plan_id' IS NOT NULL AND p_data->>'plan_id' != ''
             THEN (p_data->>'plan_id')::UUID ELSE NULL END,
        COALESCE((p_data->>'min_months')::INTEGER, 1),
        CASE WHEN p_data->>'max_uses' IS NOT NULL AND p_data->>'max_uses' != ''
             THEN (p_data->>'max_uses')::INTEGER ELSE NULL END,
        COALESCE((p_data->>'valid_from')::DATE, CURRENT_DATE),
        CASE WHEN p_data->>'valid_until' IS NOT NULL AND p_data->>'valid_until' != ''
             THEN (p_data->>'valid_until')::DATE ELSE NULL END,
        COALESCE((p_data->>'is_active')::BOOLEAN, true)
    )
    RETURNING id INTO v_id;

    RETURN json_build_object('success', true, 'id', v_id);
EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- 4d. update_discount
CREATE OR REPLACE FUNCTION public.update_discount(
    p_token TEXT,
    p_id    UUID,
    p_data  JSONB
)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_auth RECORD;
BEGIN
    SELECT * INTO v_auth FROM public.require_role(p_token, ARRAY['admin','super_admin']);

    UPDATE public.discounts SET
        name        = COALESCE(p_data->>'name', name),
        description = COALESCE(p_data->>'description', description),
        type        = COALESCE(p_data->>'type', type),
        value       = COALESCE((p_data->>'value')::DECIMAL, value),
        applies_to  = COALESCE(p_data->>'applies_to', applies_to),
        plan_id     = CASE WHEN p_data ? 'plan_id' THEN
                        CASE WHEN p_data->>'plan_id' IS NOT NULL AND p_data->>'plan_id' != ''
                             THEN (p_data->>'plan_id')::UUID ELSE NULL END
                      ELSE plan_id END,
        min_months  = COALESCE((p_data->>'min_months')::INTEGER, min_months),
        max_uses    = CASE WHEN p_data ? 'max_uses' THEN
                        CASE WHEN p_data->>'max_uses' IS NOT NULL AND p_data->>'max_uses' != ''
                             THEN (p_data->>'max_uses')::INTEGER ELSE NULL END
                      ELSE max_uses END,
        valid_from  = COALESCE((p_data->>'valid_from')::DATE, valid_from),
        valid_until = CASE WHEN p_data ? 'valid_until' THEN
                        CASE WHEN p_data->>'valid_until' IS NOT NULL AND p_data->>'valid_until' != ''
                             THEN (p_data->>'valid_until')::DATE ELSE NULL END
                      ELSE valid_until END,
        is_active   = COALESCE((p_data->>'is_active')::BOOLEAN, is_active),
        updated_at  = NOW()
    WHERE id = p_id;

    IF NOT FOUND THEN
        RETURN json_build_object('success', false, 'error', 'Descuento no encontrado');
    END IF;

    RETURN json_build_object('success', true);
EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- 4e. delete_discount (soft delete)
CREATE OR REPLACE FUNCTION public.delete_discount(
    p_token TEXT,
    p_id    UUID
)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_auth RECORD;
BEGIN
    SELECT * INTO v_auth FROM public.require_role(p_token, ARRAY['admin','super_admin']);

    UPDATE public.discounts SET is_active = false, updated_at = NOW() WHERE id = p_id;

    IF NOT FOUND THEN
        RETURN json_build_object('success', false, 'error', 'Descuento no encontrado');
    END IF;

    RETURN json_build_object('success', true);
EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$$;


-- ============================================================
-- 5. calculate_prepaid_invoice (preview without creating)
-- ============================================================
CREATE OR REPLACE FUNCTION public.calculate_prepaid_invoice(
    p_token           TEXT,
    p_subscription_id UUID,
    p_months          INTEGER,
    p_discount_id     UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_auth              RECORD;
    v_sub               RECORD;
    v_plan              RECORD;
    v_discount          RECORD;
    v_price_includes_tax BOOLEAN;
    v_monthly_gross     NUMERIC;  -- monthly price as stored (may include ITBIS)
    v_monthly_net       NUMERIC;  -- monthly price without ITBIS
    v_tax_rate          NUMERIC;
    v_net_raw           NUMERIC;  -- net total for N months before discount
    v_gross_raw         NUMERIC;  -- gross total for N months before discount
    v_discount_amt      NUMERIC := 0;  -- discount applied on NET
    v_subtotal          NUMERIC;  -- net after discount
    v_tax_amount        NUMERIC;  -- ITBIS on discounted net
    v_total             NUMERIC;  -- final total
BEGIN
    SELECT * INTO v_auth FROM public.require_role(p_token, ARRAY['admin','super_admin','operator']);

    -- Load subscription
    SELECT * INTO v_sub FROM public.subscriptions WHERE id = p_subscription_id;
    IF NOT FOUND THEN
        RETURN json_build_object('success', false, 'error', 'Suscripción no encontrada');
    END IF;

    -- Load plan to check price_includes_tax
    SELECT * INTO v_plan FROM public.plans WHERE id = v_sub.plan_id;

    v_monthly_gross      := v_sub.price_per_period;
    v_tax_rate           := COALESCE(v_sub.tax_rate, 0.18);
    v_price_includes_tax := COALESCE(v_plan.price_includes_tax, true);

    -- Extract net monthly price (without ITBIS)
    IF v_price_includes_tax THEN
        v_monthly_net := ROUND(v_monthly_gross / (1 + v_tax_rate), 2);
    ELSE
        v_monthly_net := v_monthly_gross;
    END IF;

    v_net_raw   := v_monthly_net * p_months;
    v_gross_raw := v_monthly_gross * p_months;

    -- Apply discount on NET price if provided
    IF p_discount_id IS NOT NULL THEN
        SELECT * INTO v_discount FROM public.discounts WHERE id = p_discount_id AND is_active = true;

        IF FOUND THEN
            IF p_months < COALESCE(v_discount.min_months, 1) THEN
                RETURN json_build_object('success', false, 'error',
                    'Se requieren mínimo ' || v_discount.min_months || ' meses para este descuento');
            END IF;

            IF v_discount.max_uses IS NOT NULL AND v_discount.current_uses >= v_discount.max_uses THEN
                RETURN json_build_object('success', false, 'error', 'Este descuento ha alcanzado el límite de usos');
            END IF;

            IF v_discount.valid_until IS NOT NULL AND CURRENT_DATE > v_discount.valid_until THEN
                RETURN json_build_object('success', false, 'error', 'Este descuento ha expirado');
            END IF;

            -- Discount always calculated on NET (sin ITBIS)
            IF v_discount.type = 'percentage' THEN
                v_discount_amt := ROUND(v_net_raw * (v_discount.value / 100), 2);
            ELSE
                v_discount_amt := LEAST(v_discount.value, v_net_raw);
            END IF;
        END IF;
    END IF;

    -- Final calculation: net after discount + ITBIS on that
    v_subtotal   := v_net_raw - v_discount_amt;
    v_tax_amount := ROUND(v_subtotal * v_tax_rate, 2);
    v_total      := v_subtotal + v_tax_amount;

    RETURN json_build_object(
        'success',             true,
        'plan_name',           v_plan.name,
        'plan_type',           v_plan.type,
        'price_includes_tax',  v_price_includes_tax,
        'monthly_price',       v_monthly_gross,
        'monthly_net',         v_monthly_net,
        'months',              p_months,
        'gross_raw',           v_gross_raw,
        'subtotal_raw',        v_net_raw,
        'discount_name',       COALESCE(v_discount.name, NULL),
        'discount_type',       COALESCE(v_discount.type, NULL),
        'discount_value',      COALESCE(v_discount.value, 0),
        'discount_amount',     v_discount_amt,
        'subtotal',            v_subtotal,
        'tax_rate',            v_tax_rate,
        'tax_amount',          v_tax_amount,
        'total',               v_total,
        'period_start',        COALESCE(v_sub.current_period_end, CURRENT_DATE),
        'period_end',          COALESCE(v_sub.current_period_end, CURRENT_DATE) + (p_months || ' months')::INTERVAL
    );
EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$$;


-- ============================================================
-- 6. generate_prepaid_invoice (create payment + invoice for N months)
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
    v_new_period_start  DATE;
    v_new_period_end    DATE;
    v_new_next_billing  DATE;
    v_include_extras    BOOLEAN;
    v_extra             RECORD;
    v_extras_subtotal   NUMERIC := 0;
    v_extras_tax        NUMERIC := 0;
BEGIN
    SELECT * INTO v_auth FROM public.require_role(p_token, ARRAY['admin','super_admin']);

    -- Load subscription with vehicle plate
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

    -- Extract net monthly price (without ITBIS)
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

            -- Discount always on NET (sin ITBIS)
            IF v_discount.type = 'percentage' THEN
                v_discount_amt := ROUND(v_net_raw * (v_discount.value / 100), 2);
            ELSE
                v_discount_amt := LEAST(v_discount.value, v_net_raw);
            END IF;

            -- Increment usage counter
            UPDATE public.discounts
            SET current_uses = current_uses + 1, updated_at = NOW()
            WHERE id = p_discount_id;
        END IF;
    END IF;

    -- Final: net after discount + ITBIS on that
    v_subtotal   := v_net_raw - v_discount_amt;
    v_tax_amount := ROUND(v_subtotal * v_tax_rate, 2);
    v_total      := v_subtotal + v_tax_amount;

    -- Build items array
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

    -- Add discount line item if applicable
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
        'next_billing_date', v_new_next_billing
    );

EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM, 'detail', SQLSTATE);
END;
$$;


-- ============================================================
-- 7. get_billing_forecast - upcoming renewals
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_billing_forecast(
    p_token   TEXT,
    p_days    INTEGER DEFAULT 30
)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_auth   RECORD;
    v_result JSON;
BEGIN
    SELECT * INTO v_auth FROM public.require_role(p_token, ARRAY['admin','super_admin']);

    SELECT json_agg(row_to_json(f) ORDER BY f.next_billing_date)
    INTO v_result
    FROM (
        SELECT
            s.id AS subscription_id,
            s.status,
            s.next_billing_date,
            s.billing_end_date,
            s.prepaid_months,
            s.payment_type,
            s.price_per_period,
            s.billing_frequency,
            s.discount_amount,
            c.first_name || ' ' || c.last_name AS customer_name,
            c.id AS customer_id,
            p.name AS plan_name,
            p.type AS plan_type,
            v.plate AS vehicle_plate,
            s.next_billing_date - CURRENT_DATE AS days_until_due,
            CASE
                WHEN s.next_billing_date <= CURRENT_DATE THEN 'overdue'
                WHEN s.next_billing_date <= CURRENT_DATE + 7 THEN 'urgent'
                WHEN s.next_billing_date <= CURRENT_DATE + 15 THEN 'upcoming'
                ELSE 'scheduled'
            END AS urgency
        FROM public.subscriptions s
        JOIN public.customers c ON c.id = s.customer_id
        JOIN public.plans p     ON p.id = s.plan_id
        LEFT JOIN public.vehicles v ON v.id = s.vehicle_id
        WHERE s.status IN ('active', 'past_due')
          AND s.next_billing_date <= CURRENT_DATE + p_days
        ORDER BY s.next_billing_date
    ) f;

    RETURN json_build_object('success', true, 'data', COALESCE(v_result, '[]'::JSON));
EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$$;


-- ============================================================
-- 8. auto_suspend_expired - suspend expired prepaid subscriptions
-- ============================================================
CREATE OR REPLACE FUNCTION public.auto_suspend_expired(
    p_token TEXT
)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_auth      RECORD;
    v_count     INTEGER := 0;
    v_grace     INTEGER;
    v_sub       RECORD;
    v_details   JSONB := '[]'::JSONB;
BEGIN
    SELECT * INTO v_auth FROM public.require_role(p_token, ARRAY['admin','super_admin']);

    -- Get grace period from settings
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
        UPDATE public.subscriptions
        SET status = 'suspended',
            suspended_at = NOW(),
            updated_at = NOW()
        WHERE id = v_sub.id;

        v_count := v_count + 1;
        v_details := v_details || jsonb_build_array(jsonb_build_object(
            'subscription_id', v_sub.id,
            'customer_name', v_sub.customer_name,
            'plan_name', v_sub.plan_name,
            'expired_date', v_sub.next_billing_date
        ));
    END LOOP;

    RETURN json_build_object(
        'success', true,
        'suspended_count', v_count,
        'details', v_details
    );
EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$$;
