-- Migration 076: add role checks to the remaining MED-risk write RPCs
-- Applied to prod (ppxjjsfacbepctslyrma) 2026-05-24.
--
-- These 12 RPCs were verify_token-only (any authenticated user, incl. a self-registered
-- customer, could create/modify/delete customers, vehicles and subscriptions, end sessions,
-- or mark session payments). They all share the exact auth preamble
--   v_user_id := verify_token(p_token);
-- This migration rewrites ONLY that preamble to require_role(operator,admin,super_admin)
-- (i.e. excludes the 'customer' role) on each function's live definition, leaving the rest
-- of every body untouched. The position() guard aborts the whole migration if any target
-- function's preamble is not found, so it can never silently skip one.
--
-- ROLLBACK: revert the auth preamble of each function back to
--   v_user_id := verify_token(p_token);

DO $migration$
DECLARE
  v_fns text[] := ARRAY[
    'create_customer(text,json)',
    'update_customer(text,uuid,json)',
    'delete_customer(text,uuid)',
    'create_vehicle(text,json)',
    'update_vehicle(text,uuid,json)',
    'delete_vehicle(text,uuid)',
    'create_subscription(text,json)',
    'update_subscription(text,uuid,json)',
    'suspend_subscription(text,uuid)',
    'reactivate_subscription(text,uuid)',
    'end_session(text,uuid)',
    'session_payment(text,uuid)'
  ];
  v_sig  text;
  v_def  text;
  v_new  text;
  v_old_preamble text := 'v_user_id := verify_token(p_token);';
  v_new_preamble text := 'BEGIN SELECT r.user_id INTO v_user_id FROM require_role(p_token, ARRAY[''operator'',''admin'',''super_admin'']) r; EXCEPTION WHEN OTHERS THEN RETURN json_build_object(''success'', false, ''error'', ''No autorizado''); END;';
BEGIN
  FOREACH v_sig IN ARRAY v_fns LOOP
    v_def := pg_get_functiondef(('public.' || v_sig)::regprocedure);
    IF position(v_old_preamble IN v_def) = 0 THEN
      RAISE EXCEPTION 'Auth preamble not found in %, aborting migration', v_sig;
    END IF;
    v_new := replace(v_def, v_old_preamble, v_new_preamble);
    EXECUTE v_new;
    RAISE NOTICE 'Patched role check into %', v_sig;
  END LOOP;
END
$migration$;
