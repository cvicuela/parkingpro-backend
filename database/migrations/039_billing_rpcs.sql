-- Migration 039: Billing RPC functions
-- Creates: generate_subscription_invoice, run_billing_cycle, list_billing_runs

-- ============================================================
-- 1. generate_subscription_invoice
-- ============================================================
CREATE OR REPLACE FUNCTION public.generate_subscription_invoice(
    p_token          TEXT,
    p_subscription_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_auth              RECORD;
    v_sub               RECORD;
    v_customer          RECORD;
    v_plan              RECORD;
    v_subtotal          NUMERIC;
    v_tax_amount        NUMERIC;
    v_total             NUMERIC;
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
    -- Auth
    SELECT * INTO v_auth
    FROM public.require_role(p_token, ARRAY['admin', 'super_admin']);

    -- Load subscription
    SELECT s.*, v.plate_number
    INTO v_sub
    FROM public.subscriptions s
    JOIN public.vehicles v ON v.id = s.vehicle_id
    WHERE s.id = p_subscription_id;

    IF NOT FOUND THEN
        RETURN json_build_object('success', false, 'error', 'Subscription not found');
    END IF;

    -- Load customer
    SELECT * INTO v_customer
    FROM public.customers
    WHERE id = v_sub.customer_id;

    -- Load plan
    SELECT * INTO v_plan
    FROM public.plans
    WHERE id = v_sub.plan_id;

    -- Read settings
    SELECT
        COALESCE((SELECT (value#>>'{}')::BOOLEAN FROM public.settings WHERE key = 'billing.include_extras_in_subscription'), false)
        INTO v_include_extras;

    SELECT
        COALESCE((SELECT value#>>'{}' FROM public.settings WHERE key = 'billing.ncf_type_subscription'), 'B02')
        INTO v_ncf_type_setting;

    -- Base amounts
    v_subtotal   := v_sub.price_per_period;
    v_tax_amount := ROUND(v_subtotal * v_sub.tax_rate, 2);
    v_total      := v_subtotal + v_tax_amount;

    -- Build base items array
    v_items := jsonb_build_array(
        jsonb_build_object(
            'type',        'subscription',
            'description', 'Plan ' || v_plan.name || ' - ' || v_sub.billing_frequency,
            'quantity',    1,
            'unit_price',  v_subtotal,
            'tax_rate',    v_sub.tax_rate,
            'tax_amount',  v_tax_amount,
            'total',       v_subtotal + v_tax_amount
        )
    );

    -- Include extras if configured
    IF v_include_extras THEN
        FOR v_extra IN
            SELECT *
            FROM public.pending_charges
            WHERE subscription_id = p_subscription_id
              AND status = 'pending'
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
                    'total',       v_extra.amount + COALESCE(v_extra.tax_amount, 0),
                    'session_id',  v_extra.session_id
                )
            );
        END LOOP;

        v_total      := v_total + v_extras_subtotal + v_extras_tax;
        v_tax_amount := v_tax_amount + v_extras_tax;
        v_subtotal   := v_subtotal + v_extras_subtotal;
    END IF;

    -- Determine NCF / invoice number
    IF v_ncf_type_setting = 'internal' THEN
        SELECT value#>>'{}' INTO v_invoice_prefix
        FROM public.settings WHERE key = 'internal_invoice_prefix';
        v_invoice_prefix := COALESCE(v_invoice_prefix, 'INV');

        SELECT (value#>>'{}')::BIGINT INTO v_invoice_next
        FROM public.settings WHERE key = 'internal_invoice_next';
        v_invoice_next := COALESCE(v_invoice_next, 1);

        v_invoice_number := v_invoice_prefix || LPAD(v_invoice_next::TEXT, 8, '0');
        v_ncf := v_invoice_number;

        -- Increment counter
        UPDATE public.settings
        SET value = to_jsonb((v_invoice_next + 1)::TEXT)
        WHERE key = 'internal_invoice_next';

        IF NOT FOUND THEN
            INSERT INTO public.settings (key, value)
            VALUES ('internal_invoice_next', to_jsonb((v_invoice_next + 1)::TEXT));
        END IF;
    ELSE
        v_ncf := public.get_next_ncf(v_ncf_type_setting);
        v_invoice_number := v_ncf;
    END IF;

    -- Create payment record
    INSERT INTO public.payments (
        subscription_id,
        customer_id,
        amount,
        tax_amount,
        total_amount,
        payment_method,
        status,
        invoice_number,
        ncf,
        description,
        attempt_number,
        metadata
    ) VALUES (
        p_subscription_id,
        v_sub.customer_id,
        v_subtotal,
        v_tax_amount,
        v_total,
        'subscription_auto',
        'paid',
        v_invoice_number,
        v_ncf,
        'Factura automática - Plan ' || v_plan.name,
        1,
        jsonb_build_object('generated_by', 'generate_subscription_invoice', 'user_id', v_auth.user_id)
    )
    RETURNING id INTO v_payment_id;

    -- Create invoice record
    INSERT INTO public.invoices (
        payment_id,
        customer_id,
        invoice_number,
        ncf,
        subtotal,
        tax_amount,
        total,
        items,
        notes,
        metadata
    ) VALUES (
        v_payment_id,
        v_sub.customer_id,
        v_invoice_number,
        v_ncf,
        v_subtotal,
        v_tax_amount,
        v_total,
        v_items,
        NULL,
        jsonb_build_object('subscription_id', p_subscription_id, 'plan_id', v_sub.plan_id)
    )
    RETURNING id INTO v_invoice_id;

    -- Mark pending_charges as invoiced
    IF v_include_extras THEN
        UPDATE public.pending_charges
        SET status     = 'invoiced',
            invoice_id = v_invoice_id
        WHERE subscription_id = p_subscription_id
          AND status = 'pending';
    END IF;

    -- Determine billing interval
    v_billing_interval := CASE v_sub.billing_frequency
        WHEN 'monthly'    THEN INTERVAL '1 month'
        WHEN 'quarterly'  THEN INTERVAL '3 months'
        WHEN 'semiannual' THEN INTERVAL '6 months'
        WHEN 'annual'     THEN INTERVAL '12 months'
        ELSE                   INTERVAL '1 month'
    END;

    v_new_period_start := v_sub.current_period_end;
    v_new_period_end   := v_sub.current_period_end::DATE + v_billing_interval;
    v_new_next_billing := v_new_period_end;

    -- Advance subscription billing dates
    UPDATE public.subscriptions
    SET next_billing_date     = v_new_next_billing,
        current_period_start  = v_new_period_start,
        current_period_end    = v_new_period_end
    WHERE id = p_subscription_id;

    RETURN json_build_object(
        'success',         true,
        'payment_id',      v_payment_id,
        'invoice_id',      v_invoice_id,
        'invoice_number',  v_invoice_number,
        'ncf',             v_ncf,
        'subtotal',        v_subtotal,
        'tax_amount',      v_tax_amount,
        'total',           v_total,
        'next_billing_date', v_new_next_billing
    );

EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object(
        'success', false,
        'error',   SQLERRM,
        'detail',  SQLSTATE
    );
END;
$$;


-- ============================================================
-- 2. run_billing_cycle
-- ============================================================
CREATE OR REPLACE FUNCTION public.run_billing_cycle(
    p_token TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_auth              RECORD;
    v_run_id            UUID;
    v_sub               RECORD;
    v_customer          RECORD;
    v_plan              RECORD;
    v_extra             RECORD;
    v_include_extras    BOOLEAN;
    v_ncf_type_setting  TEXT;
    v_send_email        BOOLEAN;
    v_ncf               TEXT;
    v_invoice_prefix    TEXT;
    v_invoice_next      BIGINT;
    v_invoice_number    TEXT;
    v_payment_id        UUID;
    v_invoice_id        UUID;
    v_items             JSONB;
    v_subtotal          NUMERIC;
    v_tax_amount        NUMERIC;
    v_total             NUMERIC;
    v_extras_subtotal   NUMERIC;
    v_extras_tax        NUMERIC;
    v_billing_interval  INTERVAL;
    v_new_next_billing  DATE;
    v_new_period_start  DATE;
    v_new_period_end    DATE;
    v_processed         INTEGER := 0;
    v_invoiced          INTEGER := 0;
    v_failed            INTEGER := 0;
    v_total_amount      NUMERIC := 0;
    v_total_extras_amt  NUMERIC := 0;
    v_details           JSONB   := '[]'::JSONB;
    v_detail_entry      JSONB;
BEGIN
    -- Auth
    SELECT * INTO v_auth
    FROM public.require_role(p_token, ARRAY['admin', 'super_admin']);

    -- Create billing_run record
    INSERT INTO public.billing_runs (
        run_date,
        status,
        total_processed,
        total_invoiced,
        total_failed,
        total_amount,
        total_extras_amount,
        started_at
    ) VALUES (
        CURRENT_DATE,
        'running',
        0, 0, 0, 0, 0,
        NOW()
    )
    RETURNING id INTO v_run_id;

    -- Read settings
    SELECT
        COALESCE((SELECT (value#>>'{}')::BOOLEAN FROM public.settings WHERE key = 'billing.include_extras_in_subscription'), false)
        INTO v_include_extras;

    SELECT
        COALESCE((SELECT value#>>'{}' FROM public.settings WHERE key = 'billing.ncf_type_subscription'), 'B02')
        INTO v_ncf_type_setting;

    SELECT
        COALESCE((SELECT (value#>>'{}')::BOOLEAN FROM public.settings WHERE key = 'billing.send_email'), false)
        INTO v_send_email;

    -- Loop through due subscriptions
    FOR v_sub IN
        SELECT s.*, v.plate_number
        FROM public.subscriptions s
        JOIN public.vehicles v ON v.id = s.vehicle_id
        WHERE s.status = 'active'
          AND s.next_billing_date <= CURRENT_DATE
    LOOP
        v_processed := v_processed + 1;

        BEGIN
            -- Load customer and plan
            SELECT * INTO v_customer FROM public.customers WHERE id = v_sub.customer_id;
            SELECT * INTO v_plan     FROM public.plans     WHERE id = v_sub.plan_id;

            -- Base amounts
            v_subtotal       := v_sub.price_per_period;
            v_tax_amount     := ROUND(v_subtotal * v_sub.tax_rate, 2);
            v_total          := v_subtotal + v_tax_amount;
            v_extras_subtotal := 0;
            v_extras_tax     := 0;

            -- Build base items
            v_items := jsonb_build_array(
                jsonb_build_object(
                    'type',        'subscription',
                    'description', 'Plan ' || v_plan.name || ' - ' || v_sub.billing_frequency,
                    'quantity',    1,
                    'unit_price',  v_subtotal,
                    'tax_rate',    v_sub.tax_rate,
                    'tax_amount',  v_tax_amount,
                    'total',       v_subtotal + v_tax_amount
                )
            );

            -- Include extras if configured
            IF v_include_extras THEN
                FOR v_extra IN
                    SELECT *
                    FROM public.pending_charges
                    WHERE subscription_id = v_sub.id
                      AND status = 'pending'
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
                            'total',       v_extra.amount + COALESCE(v_extra.tax_amount, 0),
                            'session_id',  v_extra.session_id
                        )
                    );
                END LOOP;

                v_tax_amount := v_tax_amount + v_extras_tax;
                v_subtotal   := v_subtotal + v_extras_subtotal;
                v_total      := v_subtotal + v_tax_amount;
            END IF;

            -- Determine NCF / invoice number
            IF v_ncf_type_setting = 'internal' THEN
                SELECT value#>>'{}' INTO v_invoice_prefix
                FROM public.settings WHERE key = 'internal_invoice_prefix';
                v_invoice_prefix := COALESCE(v_invoice_prefix, 'INV');

                SELECT (value#>>'{}')::BIGINT INTO v_invoice_next
                FROM public.settings WHERE key = 'internal_invoice_next';
                v_invoice_next := COALESCE(v_invoice_next, 1);

                v_invoice_number := v_invoice_prefix || LPAD(v_invoice_next::TEXT, 8, '0');
                v_ncf := v_invoice_number;

                UPDATE public.settings
                SET value = to_jsonb((v_invoice_next + 1)::TEXT)
                WHERE key = 'internal_invoice_next';

                IF NOT FOUND THEN
                    INSERT INTO public.settings (key, value)
                    VALUES ('internal_invoice_next', to_jsonb((v_invoice_next + 1)::TEXT));
                END IF;
            ELSE
                v_ncf := public.get_next_ncf(v_ncf_type_setting);
                v_invoice_number := v_ncf;
            END IF;

            -- Create payment
            INSERT INTO public.payments (
                subscription_id,
                customer_id,
                amount,
                tax_amount,
                total_amount,
                payment_method,
                status,
                invoice_number,
                ncf,
                description,
                attempt_number,
                metadata
            ) VALUES (
                v_sub.id,
                v_sub.customer_id,
                v_subtotal,
                v_tax_amount,
                v_total,
                'subscription_auto',
                'paid',
                v_invoice_number,
                v_ncf,
                'Factura automática - Plan ' || v_plan.name,
                1,
                jsonb_build_object('billing_run_id', v_run_id, 'generated_by', 'run_billing_cycle')
            )
            RETURNING id INTO v_payment_id;

            -- Create invoice
            INSERT INTO public.invoices (
                payment_id,
                customer_id,
                invoice_number,
                ncf,
                subtotal,
                tax_amount,
                total,
                items,
                notes,
                metadata
            ) VALUES (
                v_payment_id,
                v_sub.customer_id,
                v_invoice_number,
                v_ncf,
                v_subtotal,
                v_tax_amount,
                v_total,
                v_items,
                NULL,
                jsonb_build_object(
                    'subscription_id', v_sub.id,
                    'plan_id',         v_sub.plan_id,
                    'billing_run_id',  v_run_id
                )
            )
            RETURNING id INTO v_invoice_id;

            -- Mark pending_charges invoiced
            IF v_include_extras THEN
                UPDATE public.pending_charges
                SET status     = 'invoiced',
                    invoice_id = v_invoice_id
                WHERE subscription_id = v_sub.id
                  AND status = 'pending';
            END IF;

            -- Advance subscription dates
            v_billing_interval := CASE v_sub.billing_frequency
                WHEN 'monthly'    THEN INTERVAL '1 month'
                WHEN 'quarterly'  THEN INTERVAL '3 months'
                WHEN 'semiannual' THEN INTERVAL '6 months'
                WHEN 'annual'     THEN INTERVAL '12 months'
                ELSE                   INTERVAL '1 month'
            END;

            v_new_period_start := v_sub.current_period_end;
            v_new_period_end   := v_sub.current_period_end::DATE + v_billing_interval;
            v_new_next_billing := v_new_period_end;

            UPDATE public.subscriptions
            SET next_billing_date    = v_new_next_billing,
                current_period_start = v_new_period_start,
                current_period_end   = v_new_period_end
            WHERE id = v_sub.id;

            -- Tally
            v_invoiced       := v_invoiced + 1;
            v_total_amount   := v_total_amount + v_total;
            v_total_extras_amt := v_total_extras_amt + v_extras_subtotal + v_extras_tax;

            v_detail_entry := jsonb_build_object(
                'subscription_id', v_sub.id,
                'customer_id',     v_sub.customer_id,
                'invoice_number',  v_invoice_number,
                'total',           v_total,
                'status',          'success'
            );

            -- Optional email notification
            IF v_send_email THEN
                BEGIN
                    INSERT INTO public.notifications (
                        user_id,
                        type,
                        title,
                        message,
                        metadata,
                        channel
                    ) VALUES (
                        v_customer.user_id,
                        'invoice_generated',
                        'Nueva factura generada',
                        'Su factura ' || v_invoice_number || ' por RD$' || v_total || ' ha sido generada.',
                        jsonb_build_object(
                            'invoice_id',     v_invoice_id,
                            'payment_id',     v_payment_id,
                            'invoice_number', v_invoice_number,
                            'total',          v_total
                        ),
                        'email'
                    );
                EXCEPTION WHEN OTHERS THEN
                    -- Notifications table may not exist; continue silently
                    NULL;
                END;
            END IF;

        EXCEPTION WHEN OTHERS THEN
            v_failed := v_failed + 1;
            v_detail_entry := jsonb_build_object(
                'subscription_id', v_sub.id,
                'customer_id',     v_sub.customer_id,
                'status',          'failed',
                'error',           SQLERRM
            );
        END;

        v_details := v_details || jsonb_build_array(v_detail_entry);
    END LOOP;

    -- Update billing_run record
    UPDATE public.billing_runs
    SET status              = 'completed',
        total_processed     = v_processed,
        total_invoiced      = v_invoiced,
        total_failed        = v_failed,
        total_amount        = v_total_amount,
        total_extras_amount = v_total_extras_amt,
        details             = v_details,
        completed_at        = NOW()
    WHERE id = v_run_id;

    RETURN json_build_object(
        'success',           true,
        'billing_run_id',    v_run_id,
        'total_processed',   v_processed,
        'total_invoiced',    v_invoiced,
        'total_failed',      v_failed,
        'total_amount',      v_total_amount,
        'total_extras_amount', v_total_extras_amt,
        'details',           v_details
    );

EXCEPTION WHEN OTHERS THEN
    -- Update billing_run to failed if we have an id
    IF v_run_id IS NOT NULL THEN
        UPDATE public.billing_runs
        SET status        = 'failed',
            error_message = SQLERRM,
            completed_at  = NOW()
        WHERE id = v_run_id;
    END IF;

    RETURN json_build_object(
        'success', false,
        'error',   SQLERRM,
        'detail',  SQLSTATE
    );
END;
$$;


-- ============================================================
-- 3. list_billing_runs
-- ============================================================
CREATE OR REPLACE FUNCTION public.list_billing_runs(
    p_token TEXT,
    p_limit INTEGER DEFAULT 20
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_auth   RECORD;
    v_result JSON;
BEGIN
    -- Auth
    SELECT * INTO v_auth
    FROM public.require_role(p_token, ARRAY['admin', 'super_admin', 'operator']);

    SELECT json_agg(r ORDER BY r.run_date DESC, r.started_at DESC)
    INTO v_result
    FROM (
        SELECT *
        FROM public.billing_runs
        ORDER BY run_date DESC, started_at DESC
        LIMIT p_limit
    ) r;

    RETURN json_build_object(
        'success', true,
        'data',    COALESCE(v_result, '[]'::JSON)
    );

EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object(
        'success', false,
        'error',   SQLERRM,
        'detail',  SQLSTATE
    );
END;
$$;
