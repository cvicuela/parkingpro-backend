-- 079: Fix notifications_user_id_fkey violation on payments >= RD$5000.
--
-- Root cause: trg_notify_payment (AFTER INSERT ON payments) passes
-- payments.customer_id (a customers.id) into notify_system_event(p_user_id),
-- which inserted it into notifications.user_id. That column has a FK to
-- users(id), so a customers.id -- or the previous all-zero uuid fallback,
-- which is not a real user -- violates the constraint and rolls back the
-- entire payment transaction. The error surfaces in the operator UI as a
-- failed card/cash charge, but ONLY for totals >= RD$5000 (the threshold at
-- which trg_notify_payment fires the "Pago Grande" alert). Short stays under
-- that amount never trip the trigger, which is why most charges worked.
--
-- notifications.user_id is nullable (FK is ON DELETE SET NULL), so the correct
-- value for a system alert is NULL whenever the provided id is not a real user.

CREATE OR REPLACE FUNCTION public.notify_system_event(
  p_event_type text, p_subject text, p_body text, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_enabled BOOLEAN;
  v_events JSONB;
  v_user_id UUID;
BEGIN
  -- Check if email is enabled
  SELECT (value#>>'{}')::boolean INTO v_enabled FROM settings WHERE key = 'email_enabled';
  IF NOT COALESCE(v_enabled, false) THEN RETURN; END IF;

  -- Check if this event type is enabled
  SELECT value::jsonb INTO v_events FROM settings WHERE key = 'notification_events_enabled';
  IF v_events IS NOT NULL AND NOT v_events ? p_event_type THEN
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_events) e WHERE e = p_event_type) THEN
      RETURN;
    END IF;
  END IF;

  -- Only reference user_id if it is a REAL user; otherwise NULL (system alert).
  -- Prevents the FK violation when callers pass a customers.id or a bogus uuid.
  v_user_id := NULL;
  IF p_user_id IS NOT NULL AND EXISTS (SELECT 1 FROM users WHERE id = p_user_id) THEN
    v_user_id := p_user_id;
  END IF;

  -- Queue the notification (trigger will send the email)
  INSERT INTO notifications (user_id, type, channel, recipient, subject, body, status)
  VALUES (v_user_id, p_event_type, 'email', 'system', p_subject, p_body, 'pending');
END;
$function$;
