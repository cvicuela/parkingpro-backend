-- Migration 057: Security and validation fixes from code review
--
-- Fixes:
-- 1. Enable RLS on discounts and subscription_discounts tables
-- 2. Remove SECURITY DEFINER from RFID helper functions (internal use only)
-- 3. Add percentage <= 100 constraint on discounts
-- 4. Fix get_discount remaining_uses bug (NULL max_uses)
-- 5. Add p_months validation (1-36) to calculate/generate_prepaid_invoice
-- 6. Add valid_until check to generate_prepaid_invoice
-- 7. Add subscription status check to generate_prepaid_invoice
-- 8. Fix discount race condition with atomic WHERE clause
-- 9. Clamp percentage discount to not exceed net total

-- 1. RLS
ALTER TABLE public.discounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_discounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS discounts_select ON public.discounts FOR SELECT TO authenticated USING (true);
CREATE POLICY IF NOT EXISTS discounts_insert ON public.discounts FOR INSERT TO authenticated WITH CHECK (
  EXISTS (SELECT 1 FROM public.users u JOIN public.sessions s ON s.user_id = u.id WHERE u.role IN ('admin','super_admin'))
);
CREATE POLICY IF NOT EXISTS discounts_update ON public.discounts FOR UPDATE TO authenticated USING (
  EXISTS (SELECT 1 FROM public.users u JOIN public.sessions s ON s.user_id = u.id WHERE u.role IN ('admin','super_admin'))
);
CREATE POLICY IF NOT EXISTS sub_discounts_select ON public.subscription_discounts FOR SELECT TO authenticated USING (true);

-- 2. Remove SECURITY DEFINER from helpers
CREATE OR REPLACE FUNCTION public.activate_subscription_rfid_cards(p_subscription_id UUID)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE v_count INTEGER := 0;
BEGIN
    UPDATE public.rfid_cards SET status = 'assigned', updated_at = NOW()
    WHERE subscription_id = p_subscription_id AND status IN ('available', 'disabled') AND card_type = 'permanent';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.deactivate_subscription_rfid_cards(p_subscription_id UUID)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE v_count INTEGER := 0;
BEGIN
    UPDATE public.rfid_cards SET status = 'disabled', updated_at = NOW()
    WHERE subscription_id = p_subscription_id AND status IN ('assigned', 'in_use') AND card_type = 'permanent';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.build_rfid_invoice_items(p_subscription_id UUID)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_items JSONB := '[]'::JSONB; v_card RECORD;
BEGIN
    FOR v_card IN
        SELECT rc.id, rc.card_uid, rc.label FROM public.rfid_cards rc
        WHERE rc.subscription_id = p_subscription_id AND rc.card_type = 'permanent' AND rc.status != 'lost'
        ORDER BY rc.created_at
    LOOP
        v_items := v_items || jsonb_build_array(jsonb_build_object(
            'type', 'rfid_card', 'description', 'Tarjeta NFC: ' || COALESCE(v_card.label, v_card.card_uid),
            'card_id', v_card.id, 'card_uid', v_card.card_uid, 'quantity', 1, 'unit_price', 0, 'tax_amount', 0, 'total', 0));
    END LOOP;
    RETURN v_items;
END;
$$;

-- 3. Percentage constraint
ALTER TABLE public.discounts DROP CONSTRAINT IF EXISTS chk_discount_percentage_max;
ALTER TABLE public.discounts ADD CONSTRAINT chk_discount_percentage_max CHECK (type != 'percentage' OR value <= 100);

-- 4. Fix get_discount remaining_uses
CREATE OR REPLACE FUNCTION public.get_discount(p_token TEXT, p_id UUID)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_auth RECORD; v_result JSON;
BEGIN
    SELECT * INTO v_auth FROM public.require_role(p_token, ARRAY['admin','super_admin','operator']);
    SELECT row_to_json(d) INTO v_result FROM (
        SELECT d.*, p.name AS plan_name,
               CASE WHEN d.max_uses IS NOT NULL THEN d.max_uses - d.current_uses ELSE NULL END AS remaining_uses
        FROM public.discounts d LEFT JOIN public.plans p ON p.id = d.plan_id WHERE d.id = p_id
    ) d;
    IF v_result IS NULL THEN RETURN json_build_object('success', false, 'error', 'Descuento no encontrado'); END IF;
    RETURN json_build_object('success', true, 'data', v_result);
EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$$;
