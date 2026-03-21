-- list_notifications: Paginated notification log
CREATE OR REPLACE FUNCTION public.list_notifications(
  p_token TEXT, p_channel VARCHAR DEFAULT NULL, p_status VARCHAR DEFAULT NULL,
  p_from_date DATE DEFAULT NULL, p_to_date DATE DEFAULT NULL,
  p_limit INT DEFAULT 50, p_offset INT DEFAULT 0
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE v_user_id UUID; v_role VARCHAR; v_results JSON; v_total INT;
BEGIN
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM require_role(p_token, ARRAY['admin','super_admin']) r;
  SELECT COUNT(*) INTO v_total FROM notifications n
  WHERE (p_channel IS NULL OR n.channel = p_channel)
    AND (p_status IS NULL OR n.status = p_status)
    AND (p_from_date IS NULL OR n.created_at >= p_from_date)
    AND (p_to_date IS NULL OR n.created_at < (p_to_date::DATE + 1));
  SELECT json_agg(row_to_json(t)) INTO v_results FROM (
    SELECT n.id, n.type, n.channel, n.recipient, n.subject,
      LEFT(n.body, 200) AS body_preview, n.status, n.sent_at, n.failed_at,
      n.failure_reason, n.provider, n.created_at,
      c.first_name || ' ' || c.last_name AS customer_name
    FROM notifications n
    LEFT JOIN users u ON u.id = n.user_id
    LEFT JOIN customers c ON c.user_id = n.user_id
    WHERE (p_channel IS NULL OR n.channel = p_channel)
      AND (p_status IS NULL OR n.status = p_status)
      AND (p_from_date IS NULL OR n.created_at >= p_from_date)
      AND (p_to_date IS NULL OR n.created_at < (p_to_date::DATE + 1))
    ORDER BY n.created_at DESC LIMIT p_limit OFFSET p_offset
  ) t;
  RETURN json_build_object('success', true, 'data', json_build_object(
    'notifications', COALESCE(v_results, '[]'::json), 'total', v_total, 'limit', p_limit, 'offset', p_offset));
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', SQLERRM);
END; $function$;

-- notification_stats
CREATE OR REPLACE FUNCTION public.notification_stats(p_token TEXT)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE v_user_id UUID; v_role VARCHAR; v_stats JSON;
BEGIN
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM require_role(p_token, ARRAY['admin','super_admin']) r;
  SELECT json_build_object(
    'total', COUNT(*), 'sent', COUNT(*) FILTER (WHERE status = 'sent'),
    'failed', COUNT(*) FILTER (WHERE status = 'failed'),
    'pending', COUNT(*) FILTER (WHERE status = 'pending'),
    'by_channel', json_build_object(
      'whatsapp', COUNT(*) FILTER (WHERE channel = 'whatsapp'),
      'email', COUNT(*) FILTER (WHERE channel = 'email'),
      'sms', COUNT(*) FILTER (WHERE channel = 'sms'),
      'push', COUNT(*) FILTER (WHERE channel = 'push')
    ),
    'today', COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE),
    'this_month', COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('month', CURRENT_DATE))
  ) INTO v_stats FROM notifications;
  RETURN json_build_object('success', true, 'data', v_stats);
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', SQLERRM);
END; $function$;

-- send_notification: Queue a notification
CREATE OR REPLACE FUNCTION public.send_notification(
  p_token TEXT, p_channel VARCHAR, p_recipient VARCHAR,
  p_subject VARCHAR DEFAULT NULL, p_body TEXT DEFAULT NULL,
  p_type VARCHAR DEFAULT 'manual', p_template_id VARCHAR DEFAULT NULL,
  p_template_data JSONB DEFAULT NULL, p_customer_id UUID DEFAULT NULL
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE v_user_id UUID; v_role VARCHAR; v_target_user_id UUID; v_notif_id UUID;
BEGIN
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM require_role(p_token, ARRAY['admin','super_admin']) r;
  IF p_customer_id IS NOT NULL THEN
    SELECT user_id INTO v_target_user_id FROM customers WHERE id = p_customer_id;
  END IF;
  INSERT INTO notifications (user_id, type, channel, recipient, subject, body, template_id, template_data, status)
  VALUES (COALESCE(v_target_user_id, v_user_id), p_type, p_channel, p_recipient,
    p_subject, p_body, p_template_id, p_template_data, 'pending')
  RETURNING id INTO v_notif_id;
  INSERT INTO audit_logs (user_id, action, entity_type, entity_id, changes)
  VALUES (v_user_id, 'notification_queued', 'notification', v_notif_id,
    jsonb_build_object('channel', p_channel, 'recipient', p_recipient, 'type', p_type));
  RETURN json_build_object('success', true, 'data', json_build_object('id', v_notif_id));
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', SQLERRM);
END; $function$;
