-- Migration 075: close settings secret-exposure + add missing role checks
-- Applied to prod (ppxjjsfacbepctslyrma) 2026-05-24.
--
-- CRITICAL: get_setting/list_settings used verify_token only, so ANY authenticated
-- user (incl. a self-registered customer) could read settings.jwt_secret (and SMTP
-- creds / device & email API keys) and then forge a super_admin JWT -> full system
-- compromise. Fix: jwt_secret is never returned to any client; other sensitive keys
-- (smtp_pass/smtp_user/*_api_key/secret/password/credential/private) are masked to
-- '***' for non-admins. The Config page (admin/super_admin) still sees real values.
--
-- HIGH: create_payment / create_plan / delete_plan had verify_token only (no role) —
-- any authenticated user could record payments or create/deactivate pricing plans.
-- Added require_role. (approve_cash_register and create_operator already enforce
-- admin/super_admin via a manual check, so they are left unchanged.)
--
-- ROLLBACK: previous defs were get_setting/list_settings with `verify_token` + raw
-- SELECT; create_payment/create_plan/delete_plan with the same verify_token preamble.

-- =========================================================================================
-- 1. get_setting — never expose jwt_secret; gate other sensitive keys to admins
-- =========================================================================================
CREATE OR REPLACE FUNCTION public.get_setting(p_token text, p_key text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_user_id UUID;
  v_role    VARCHAR;
  v_result  JSON;
BEGIN
  SELECT user_id, user_role INTO v_user_id, v_role FROM verify_token_with_role(p_token);
  IF v_user_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'No autorizado');
  END IF;

  -- jwt_secret is never returned to any client (no UI needs it; authenticate reads it server-side)
  IF lower(p_key) = 'jwt_secret' THEN
    RETURN json_build_object('success', false, 'error', 'Configuración protegida');
  END IF;

  -- Other sensitive keys are admin-only
  IF p_key ~* '(secret|password|passwd|api_key|private|credential|smtp_pass|smtp_user)'
     AND v_role NOT IN ('admin', 'super_admin') THEN
    RETURN json_build_object('success', false, 'error', 'No autorizado');
  END IF;

  SELECT row_to_json(s) INTO v_result FROM settings s WHERE s.key = p_key;
  RETURN json_build_object('success', true, 'data', v_result);
END;
$function$;

-- =========================================================================================
-- 2. list_settings — drop jwt_secret entirely; mask other sensitive keys for non-admins
-- =========================================================================================
CREATE OR REPLACE FUNCTION public.list_settings(p_token text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_user_id UUID;
  v_role    VARCHAR;
  v_results JSON;
BEGIN
  SELECT user_id, user_role INTO v_user_id, v_role FROM verify_token_with_role(p_token);
  IF v_user_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'No autorizado');
  END IF;

  SELECT json_agg(
    CASE
      WHEN s.key ~* '(secret|password|passwd|api_key|private|credential|smtp_pass|smtp_user)'
           AND v_role NOT IN ('admin', 'super_admin')
      THEN (to_jsonb(s) || jsonb_build_object('value', to_jsonb('***'::text)))::json
      ELSE row_to_json(s)
    END
  ) INTO v_results
  FROM settings s
  WHERE lower(s.key) <> 'jwt_secret';   -- never expose to any client

  RETURN json_build_object('success', true, 'data', COALESCE(v_results, '[]'::json));
END;
$function$;

-- =========================================================================================
-- 3. create_payment — add role check (was verify_token only)
-- =========================================================================================
CREATE OR REPLACE FUNCTION public.create_payment(p_token text, p_data json)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE v_user_id UUID; v_payment RECORD; v_sub_id UUID;
BEGIN
  BEGIN
    SELECT r.user_id INTO v_user_id FROM require_role(p_token, ARRAY['operator','admin','super_admin']) r;
  EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', 'No autorizado');
  END;

  -- GUARD: Check for duplicate subscription payment in same period
  v_sub_id := NULLIF(p_data->>'subscriptionId','')::UUID;
  IF v_sub_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM payments
      WHERE subscription_id = v_sub_id AND status = 'paid'
      AND paid_at >= date_trunc('month', NOW())
    ) THEN
      RETURN json_build_object('success', false, 'error', 'Ya existe un pago para esta suscripcion en el periodo actual');
    END IF;
  END IF;

  INSERT INTO payments (subscription_id, customer_id, amount, tax_amount, total_amount, currency, status, payment_method, paid_at)
  VALUES (v_sub_id, (p_data->>'customerId')::UUID, (p_data->>'amount')::NUMERIC, COALESCE((p_data->>'taxAmount')::NUMERIC, 0), COALESCE((p_data->>'totalAmount')::NUMERIC, (p_data->>'amount')::NUMERIC), 'DOP', 'paid', COALESCE(p_data->>'paymentMethod', 'cash'), NOW())
  RETURNING * INTO v_payment;

  PERFORM log_audit(v_user_id, 'payment_created', 'payment', v_payment.id,
    jsonb_build_object('amount', v_payment.amount, 'total', v_payment.total_amount,
      'method', v_payment.payment_method, 'subscription_id', v_sub_id));

  RETURN json_build_object('success', true, 'data', row_to_json(v_payment));
END;
$function$;

-- =========================================================================================
-- 4. create_plan — add role check (was verify_token only)
-- =========================================================================================
CREATE OR REPLACE FUNCTION public.create_plan(p_token text, p_data json)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE v_user_id UUID; v_plan RECORD;
BEGIN
  BEGIN
    SELECT r.user_id INTO v_user_id FROM require_role(p_token, ARRAY['admin','super_admin']) r;
  EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', 'No autorizado');
  END;
  INSERT INTO plans (name, type, base_price, max_capacity, description, start_hour, end_hour,
    tolerance_minutes, daily_entry_limit, overage_hourly_rate, crosses_midnight)
  VALUES (
    p_data->>'name',
    COALESCE(p_data->>'type', 'hourly')::plan_type,
    COALESCE((p_data->>'base_price')::NUMERIC, (p_data->>'basePrice')::NUMERIC, 0),
    COALESCE((p_data->>'max_capacity')::INT, (p_data->>'maxCapacity')::INT, 50),
    p_data->>'description',
    NULLIF(COALESCE(p_data->>'start_hour', p_data->>'startHour'), '')::INT,
    NULLIF(COALESCE(p_data->>'end_hour', p_data->>'endHour'), '')::INT,
    COALESCE(NULLIF(COALESCE(p_data->>'tolerance_minutes', p_data->>'toleranceMinutes'), '')::INT, 15),
    COALESCE(NULLIF(COALESCE(p_data->>'daily_entry_limit', p_data->>'dailyEntryLimit'), '')::INT, 5),
    COALESCE(NULLIF(COALESCE(p_data->>'overage_hourly_rate', p_data->>'overageHourlyRate'), '')::NUMERIC, 100),
    COALESCE((p_data->>'crosses_midnight')::BOOLEAN, false)
  )
  RETURNING * INTO v_plan;
  RETURN json_build_object('success', true, 'data', row_to_json(v_plan));
END;
$function$;

-- =========================================================================================
-- 5. delete_plan — add role check (was verify_token only)
-- =========================================================================================
CREATE OR REPLACE FUNCTION public.delete_plan(p_token text, p_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE v_user_id UUID;
BEGIN
  BEGIN
    SELECT r.user_id INTO v_user_id FROM require_role(p_token, ARRAY['admin','super_admin']) r;
  EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', 'No autorizado');
  END;
  UPDATE plans SET is_active = false WHERE id = p_id;
  RETURN json_build_object('success', true, 'message', 'Plan desactivado');
END;
$function$;
