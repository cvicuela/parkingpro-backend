-- Migration 065: Drop ambiguous function overloads & create missing functions
-- Fixes "Could not choose the best candidate function" errors across the app

-- ============================================================
-- 1. DROP AMBIGUOUS OVERLOADS
-- ============================================================

-- 1a. create_system_user: keep (p_token, p_data json), drop individual-params version
DROP FUNCTION IF EXISTS public.create_system_user(text, text, text, text, text, text, text);

-- 1b. create_operator: keep (p_token, p_data json), drop jsonb version
DROP FUNCTION IF EXISTS public.create_operator(text, jsonb);

-- 1c. get_active_notification_emails: keep (p_token text), drop no-param version
DROP FUNCTION IF EXISTS public.get_active_notification_emails();

-- 1d. get_next_ncf: keep 3-param (p_ncf_type, p_source, p_operator_id), drop 1-param
DROP FUNCTION IF EXISTS public.get_next_ncf(character varying);

-- 1e. update_ncf_sequence: drop version without p_range_from
DROP FUNCTION IF EXISTS public.update_ncf_sequence(text, uuid, bigint, integer, boolean, date, date);

-- ============================================================
-- 2. CREATE MISSING FUNCTIONS
-- ============================================================

-- 2a. get_server_time — public function for connectivity check
CREATE OR REPLACE FUNCTION public.get_server_time()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN json_build_object(
    'success', true,
    'server_time', NOW(),
    'timezone', current_setting('TIMEZONE')
  );
END;
$$;

-- 2b. update_user_profile — update first_name/last_name for authenticated user
CREATE OR REPLACE FUNCTION public.update_user_profile(
  p_token TEXT,
  p_first_name TEXT,
  p_last_name TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user_id UUID;
  v_customer_id UUID;
BEGIN
  -- Validate session
  SELECT user_id INTO v_user_id
  FROM public.sessions
  WHERE token = p_token AND expires_at > NOW();

  IF v_user_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Sesión inválida o expirada');
  END IF;

  -- Validate inputs
  IF p_first_name IS NULL OR p_last_name IS NULL OR
     TRIM(p_first_name) = '' OR TRIM(p_last_name) = '' THEN
    RETURN json_build_object('success', false, 'error', 'Nombre y apellido son requeridos');
  END IF;

  IF LENGTH(p_first_name) > 100 OR LENGTH(p_last_name) > 100 THEN
    RETURN json_build_object('success', false, 'error', 'Nombre o apellido excede 100 caracteres');
  END IF;

  -- Check if customer record exists
  SELECT id INTO v_customer_id
  FROM public.customers
  WHERE user_id = v_user_id;

  IF v_customer_id IS NOT NULL THEN
    -- Update existing
    UPDATE public.customers
    SET first_name = TRIM(p_first_name),
        last_name = TRIM(p_last_name),
        updated_at = NOW()
    WHERE user_id = v_user_id;
  ELSE
    -- Insert new
    INSERT INTO public.customers (user_id, first_name, last_name)
    VALUES (v_user_id, TRIM(p_first_name), TRIM(p_last_name));
  END IF;

  RETURN json_build_object(
    'success', true,
    'message', 'Perfil actualizado exitosamente',
    'data', json_build_object(
      'first_name', TRIM(p_first_name),
      'last_name', TRIM(p_last_name)
    )
  );
END;
$$;
