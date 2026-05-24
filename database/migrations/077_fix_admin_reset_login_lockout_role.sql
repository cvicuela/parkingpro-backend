-- Migration 077: fix role typo in admin_reset_login_lockout
-- Applied to prod (ppxjjsfacbepctslyrma) 2026-05-24.
--
-- The role guard compared against 'superadmin' (no underscore) but the actual enum
-- value is 'super_admin', so a super_admin was wrongly rejected and only 'admin' could
-- clear a user's login lockout. Not a security hole (it was stricter than intended),
-- but a functional bug. Fix: 'superadmin' -> 'super_admin'. Nothing else changes.

CREATE OR REPLACE FUNCTION public.admin_reset_login_lockout(p_token text, p_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_user_id UUID;
  v_role VARCHAR;
BEGIN
  SELECT user_id, user_role INTO v_user_id, v_role
  FROM verify_token_with_role(p_token);

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Token invalido o sesion expirada' USING ERRCODE = 'P0001';
  END IF;

  IF v_role NOT IN ('admin', 'super_admin') THEN
    RAISE EXCEPTION 'Se requiere rol de administrador' USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM login_attempts
  WHERE email = p_email AND success = FALSE;
END;
$function$;
