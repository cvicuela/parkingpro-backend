-- ============================================================
-- Settings RPC Functions
-- Provides list_settings, get_setting, update_setting via RPC
-- so the PWA can use Supabase RPC in remote mode
-- ============================================================

-- ============================================================
-- list_settings: List all settings (admin only)
-- ============================================================
CREATE OR REPLACE FUNCTION public.list_settings(p_token text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user_id UUID;
  v_user_role VARCHAR;
  v_results JSON;
BEGIN
  SELECT user_id, user_role INTO v_user_id, v_user_role
  FROM verify_token_with_role(p_token);

  IF v_user_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'No autorizado');
  END IF;

  IF v_user_role NOT IN ('admin', 'super_admin') THEN
    RETURN json_build_object('success', false, 'error', 'No tiene permisos para ver configuraciones');
  END IF;

  SELECT json_agg(row_to_json(t)) INTO v_results FROM (
    SELECT id, key, value, description, category, updated_by, updated_at
    FROM settings
    ORDER BY category, key
  ) t;

  RETURN json_build_object('success', true, 'data', COALESCE(v_results, '[]'::json));
END;
$function$;

-- ============================================================
-- get_setting: Get a specific setting by key
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_setting(p_token text, p_key text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user_id UUID;
  v_user_role VARCHAR;
  v_setting RECORD;
BEGIN
  SELECT user_id, user_role INTO v_user_id, v_user_role
  FROM verify_token_with_role(p_token);

  IF v_user_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'No autorizado');
  END IF;

  SELECT * INTO v_setting FROM settings WHERE key = p_key;

  IF v_setting IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Configuración no encontrada');
  END IF;

  RETURN json_build_object('success', true, 'data', row_to_json(v_setting));
END;
$function$;

-- ============================================================
-- update_setting: Update a setting value (admin only)
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_setting(p_token text, p_key text, p_value text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user_id UUID;
  v_user_role VARCHAR;
  v_updated RECORD;
  v_json_value JSONB;
BEGIN
  SELECT user_id, user_role INTO v_user_id, v_user_role
  FROM verify_token_with_role(p_token);

  IF v_user_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'No autorizado');
  END IF;

  IF v_user_role NOT IN ('admin', 'super_admin') THEN
    RETURN json_build_object('success', false, 'error', 'No tiene permisos para modificar configuraciones');
  END IF;

  -- Convert text value to JSONB string
  v_json_value := to_jsonb(p_value);

  UPDATE settings
  SET value = v_json_value, updated_by = v_user_id, updated_at = NOW()
  WHERE key = p_key
  RETURNING * INTO v_updated;

  IF v_updated IS NULL THEN
    -- If setting doesn't exist, create it
    INSERT INTO settings (key, value, category, updated_by)
    VALUES (p_key, v_json_value, 'general', v_user_id)
    RETURNING * INTO v_updated;
  END IF;

  RETURN json_build_object('success', true, 'data', row_to_json(v_updated));
END;
$function$;
