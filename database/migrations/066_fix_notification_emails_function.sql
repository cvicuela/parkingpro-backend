-- Migration 066: Fix get_active_notification_emails and create test_email_notification
--
-- Problem: Migration 065 dropped get_active_notification_emails() (no-param version)
-- but something in the database still calls it. Also, test_email_notification (called
-- from the frontend) was never defined in migrations.
--
-- Fix:
-- 1. Create get_active_notification_emails() no-param version for internal SQL use
-- 2. Create test_email_notification(p_token) RPC for the frontend "Enviar Prueba" button

-- ============================================================
-- 1. Restore no-param version for internal use by other SQL functions
--    This returns active notification emails without auth (SECURITY DEFINER)
-- ============================================================
-- Drop old JSON version first to allow return type change
DROP FUNCTION IF EXISTS public.get_active_notification_emails();

CREATE OR REPLACE FUNCTION public.get_active_notification_emails()
RETURNS TEXT[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_emails TEXT[] := '{}';
  v_email TEXT;
BEGIN
  FOR n IN 1..5 LOOP
    -- Check if this email slot is enabled
    IF EXISTS (
      SELECT 1 FROM public.settings
      WHERE key = 'notification_email_' || n || '_enabled'
        AND (value::TEXT = 'true' OR value::TEXT = '"true"')
    ) THEN
      SELECT TRIM(BOTH '"' FROM value::TEXT) INTO v_email
      FROM public.settings
      WHERE key = 'notification_email_' || n;

      IF v_email IS NOT NULL AND v_email != '' AND v_email LIKE '%@%' THEN
        v_emails := array_append(v_emails, v_email);
      END IF;
    END IF;
  END LOOP;

  RETURN v_emails;
END;
$$;

-- ============================================================
-- 2. Create test_email_notification RPC
--    Called from frontend: notificationsAPI.testEmail()
--    Returns the list of active emails so the backend can send test emails
-- ============================================================
CREATE OR REPLACE FUNCTION public.test_email_notification(p_token TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user_id UUID;
  v_role VARCHAR;
  v_emails JSON;
BEGIN
  -- Require admin or super_admin
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM public.require_role(p_token, ARRAY['admin', 'super_admin']) r;

  -- Get active notification emails (returns TEXT[])
  v_emails := to_json(public.get_active_notification_emails());

  IF v_emails IS NULL OR v_emails::TEXT = '[]' OR v_emails::TEXT = 'null' THEN
    RETURN json_build_object(
      'success', false,
      'error', 'No hay emails de notificación activos. Configure al menos un email en Configuración → Notificaciones.'
    );
  END IF;

  -- Log the test attempt
  INSERT INTO public.audit_logs (user_id, action, entity_type, changes)
  VALUES (v_user_id, 'test_email_notification', 'notification',
    jsonb_build_object('emails', v_emails, 'triggered_by', v_user_id));

  RETURN json_build_object(
    'success', true,
    'data', json_build_object(
      'message', 'Solicitud de email de prueba registrada',
      'emails', v_emails
    )
  );
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$$;
