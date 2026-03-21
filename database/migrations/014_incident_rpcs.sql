-- list_incidents, create_incident, resolve_incident RPCs
-- See Supabase migration for full source
CREATE OR REPLACE FUNCTION public.list_incidents(
  p_token TEXT, p_status VARCHAR DEFAULT NULL, p_severity VARCHAR DEFAULT NULL,
  p_type VARCHAR DEFAULT NULL, p_limit INT DEFAULT 50, p_offset INT DEFAULT 0
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE v_user_id UUID; v_role VARCHAR; v_results JSON; v_total INT;
BEGIN
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM require_role(p_token, ARRAY['operator','admin','super_admin']) r;
  SELECT COUNT(*) INTO v_total FROM incidents i
  WHERE (p_status IS NULL OR i.status = p_status)
    AND (p_severity IS NULL OR i.severity = p_severity)
    AND (p_type IS NULL OR i.type = p_type);
  SELECT json_agg(row_to_json(t)) INTO v_results FROM (
    SELECT i.id, i.type, i.vehicle_plate, i.title, i.description, i.severity, i.status,
      i.resolved_at, i.resolution_notes, i.photos, i.created_at, i.updated_at,
      op.email AS operator_email, rb.email AS resolved_by_email
    FROM incidents i
    LEFT JOIN users op ON op.id = i.operator_id
    LEFT JOIN users rb ON rb.id = i.resolved_by
    WHERE (p_status IS NULL OR i.status = p_status)
      AND (p_severity IS NULL OR i.severity = p_severity)
      AND (p_type IS NULL OR i.type = p_type)
    ORDER BY
      CASE i.status WHEN 'open' THEN 0 WHEN 'investigating' THEN 1 ELSE 2 END,
      CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      i.created_at DESC
    LIMIT p_limit OFFSET p_offset
  ) t;
  RETURN json_build_object('success', true, 'data', json_build_object(
    'incidents', COALESCE(v_results, '[]'::json), 'total', v_total));
EXCEPTION WHEN OTHERS THEN RETURN json_build_object('success', false, 'error', SQLERRM);
END; $function$;

CREATE OR REPLACE FUNCTION public.create_incident(
  p_token TEXT, p_type VARCHAR, p_title VARCHAR, p_description TEXT DEFAULT NULL,
  p_severity VARCHAR DEFAULT 'medium', p_vehicle_plate VARCHAR DEFAULT NULL,
  p_subscription_id UUID DEFAULT NULL, p_photos JSONB DEFAULT NULL
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE v_user_id UUID; v_role VARCHAR; v_id UUID;
BEGIN
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM require_role(p_token, ARRAY['operator','admin','super_admin']) r;
  INSERT INTO incidents (type, vehicle_plate, subscription_id, operator_id, title, description, severity, status, photos)
  VALUES (p_type, p_vehicle_plate, p_subscription_id, v_user_id, p_title, p_description, p_severity, 'open', p_photos)
  RETURNING id INTO v_id;
  INSERT INTO audit_logs (user_id, action, entity_type, entity_id, changes)
  VALUES (v_user_id, 'incident_created', 'incident', v_id,
    jsonb_build_object('type', p_type, 'severity', p_severity, 'title', p_title));
  RETURN json_build_object('success', true, 'data', json_build_object('id', v_id));
EXCEPTION WHEN OTHERS THEN RETURN json_build_object('success', false, 'error', SQLERRM);
END; $function$;

CREATE OR REPLACE FUNCTION public.resolve_incident(
  p_token TEXT, p_id UUID, p_resolution_notes TEXT DEFAULT NULL,
  p_status VARCHAR DEFAULT 'resolved'
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE v_user_id UUID; v_role VARCHAR;
BEGIN
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM require_role(p_token, ARRAY['operator','admin','super_admin']) r;
  UPDATE incidents SET
    status = p_status,
    resolved_at = CASE WHEN p_status = 'resolved' THEN NOW() ELSE resolved_at END,
    resolved_by = CASE WHEN p_status = 'resolved' THEN v_user_id ELSE resolved_by END,
    resolution_notes = COALESCE(p_resolution_notes, resolution_notes),
    updated_at = NOW()
  WHERE id = p_id;
  INSERT INTO audit_logs (user_id, action, entity_type, entity_id, changes)
  VALUES (v_user_id, 'incident_' || p_status, 'incident', p_id,
    jsonb_build_object('status', p_status, 'notes', p_resolution_notes));
  RETURN json_build_object('success', true);
EXCEPTION WHEN OTHERS THEN RETURN json_build_object('success', false, 'error', SQLERRM);
END; $function$;
