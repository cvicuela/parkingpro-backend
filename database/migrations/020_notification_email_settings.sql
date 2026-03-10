-- Migration 020: Add 3 notification email options with individual toggles
-- Replaces single alert_email with 3 configurable email addresses

-- Add new notification email settings
INSERT INTO settings (key, value, description, category) VALUES
('notification_email_1_enabled', 'true', 'Activar envio de alertas al Email 1', 'notificaciones'),
('notification_email_1', '"admin@empresa.com"', 'Email principal para alertas de caja, reembolsos y alertas criticas', 'notificaciones'),
('notification_email_2_enabled', 'false', 'Activar envio de alertas al Email 2', 'notificaciones'),
('notification_email_2', '""', 'Email secundario para recibir copias de notificaciones', 'notificaciones'),
('notification_email_3_enabled', 'false', 'Activar envio de alertas al Email 3', 'notificaciones'),
('notification_email_3', '""', 'Email adicional para notificaciones', 'notificaciones')
ON CONFLICT (key) DO NOTHING;

-- Migrate existing alert_email value to notification_email_1 if it exists
DO $$
DECLARE
  v_existing TEXT;
BEGIN
  SELECT value::TEXT INTO v_existing FROM settings WHERE key = 'alert_email' OR key = 'cash.alert_email';
  IF v_existing IS NOT NULL AND v_existing != '""' AND v_existing != '' THEN
    UPDATE settings SET value = v_existing WHERE key = 'notification_email_1';
    UPDATE settings SET value = 'true' WHERE key = 'notification_email_1_enabled';
  END IF;
END $$;

-- Migrate old notification category settings to use 'notificaciones' category
UPDATE settings SET category = 'notificaciones' WHERE category = 'notifications';

-- Ensure notification_email_enabled maps to the new toggle structure
-- If old single toggle existed, map it to email 1
DO $$
DECLARE
  v_old_toggle TEXT;
BEGIN
  SELECT value::TEXT INTO v_old_toggle FROM settings WHERE key = 'notification_email_enabled';
  IF v_old_toggle IS NOT NULL THEN
    UPDATE settings SET value = v_old_toggle WHERE key = 'notification_email_1_enabled';
    DELETE FROM settings WHERE key = 'notification_email_enabled';
  END IF;
  -- Remove old single alert_email field (now replaced by 3 fields)
  DELETE FROM settings WHERE key = 'alert_email';
END $$;

-- Create helper function to get active notification emails
CREATE OR REPLACE FUNCTION get_active_notification_emails(p_token TEXT)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id UUID;
  v_emails JSON;
BEGIN
  v_user_id := require_role(p_token, ARRAY['admin', 'super_admin', 'operator']);

  SELECT json_agg(email) INTO v_emails FROM (
    SELECT
      CASE n
        WHEN 1 THEN (SELECT TRIM(BOTH '"' FROM value::TEXT) FROM settings WHERE key = 'notification_email_1')
        WHEN 2 THEN (SELECT TRIM(BOTH '"' FROM value::TEXT) FROM settings WHERE key = 'notification_email_2')
        WHEN 3 THEN (SELECT TRIM(BOTH '"' FROM value::TEXT) FROM settings WHERE key = 'notification_email_3')
      END AS email
    FROM generate_series(1, 3) n
    WHERE EXISTS (
      SELECT 1 FROM settings
      WHERE key = 'notification_email_' || n || '_enabled'
        AND (value::TEXT = 'true' OR value::TEXT = '"true"')
    )
    AND (
      SELECT TRIM(BOTH '"' FROM value::TEXT) FROM settings
      WHERE key = 'notification_email_' || n
    ) IS NOT NULL
    AND (
      SELECT TRIM(BOTH '"' FROM value::TEXT) FROM settings
      WHERE key = 'notification_email_' || n
    ) != ''
  ) sub;

  RETURN json_build_object('success', true, 'data', COALESCE(v_emails, '[]'::JSON));
END;
$$;
