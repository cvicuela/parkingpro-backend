-- Fix verify_token_with_role: cast u.role to varchar
-- Root cause: users table has both a varchar 'role' column and a user_role enum 'role' column
-- PostgreSQL picks the enum version which doesn't match the function's declared varchar return type
CREATE OR REPLACE FUNCTION public.verify_token_with_role(p_token text)
RETURNS TABLE(user_id uuid, user_role character varying)
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY
  SELECT u.id, u.role::VARCHAR FROM sessions s
  JOIN users u ON u.id = s.user_id
  WHERE s.token = p_token AND s.expires_at > NOW();
END;
$function$;

-- Also fix require_role to be consistent
CREATE OR REPLACE FUNCTION public.require_role(p_token text, p_roles text[])
RETURNS TABLE(user_id uuid, user_role character varying)
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_user_id UUID;
  v_role VARCHAR;
BEGIN
  SELECT vr.user_id, vr.user_role INTO v_user_id, v_role
  FROM verify_token_with_role(p_token) vr;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  IF NOT (v_role = ANY(p_roles)) THEN
    RAISE EXCEPTION 'Permisos insuficientes. Se requiere: %', array_to_string(p_roles, ', ');
  END IF;

  user_id := v_user_id;
  user_role := v_role;
  RETURN NEXT;
END;
$function$;
