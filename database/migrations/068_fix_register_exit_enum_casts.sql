-- Migration 068: Add explicit enum casts in register_exit
--
-- Problem: register_exit (migrations/044) sets:
--   status = CASE WHEN ... THEN 'paid' ELSE 'closed' END
-- Both branches are text literals, so PostgreSQL infers the CASE
-- result as text. Assigning text to a session_status enum column
-- now fails with:
--   column "status" is of type session_status but expression is of type text
--   HINT: You will need to rewrite or cast the expression.
--
-- This was previously masked by migration 067's bug (the 'free' literal
-- in the payment_status CASE failed before the status CASE was evaluated).
-- Once 'free' was added to the enum, the status-type mismatch surfaced.
--
-- Fix: cast both branches of each CASE to the target enum.

CREATE OR REPLACE FUNCTION public.register_exit(p_token TEXT, p_data JSON)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_user_id UUID;
  v_session RECORD;
  v_session_id UUID;
BEGIN
  v_user_id := verify_token(p_token);
  IF v_user_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'No autorizado');
  END IF;

  v_session_id := (p_data->>'sessionId')::UUID;
  IF v_session_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'sessionId requerido');
  END IF;

  SELECT * INTO v_session FROM parking_sessions WHERE id = v_session_id;
  IF v_session IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Sesión no encontrada');
  END IF;

  IF v_session.status IN ('closed', 'paid') THEN
    RETURN json_build_object('success', true, 'data', json_build_object(
      'message', 'Sesión ya cerrada',
      'sessionId', v_session.id,
      'status', v_session.status
    ));
  END IF;

  UPDATE parking_sessions SET
    exit_time = COALESCE(exit_time, NOW()),
    status = CASE
      WHEN (p_data->>'payment') IS NOT NULL AND (p_data->'payment'->>'paid')::BOOLEAN = true
        THEN 'paid'::session_status
      ELSE 'closed'::session_status
    END,
    payment_status = CASE
      WHEN (p_data->>'payment') IS NOT NULL AND (p_data->'payment'->>'paid')::BOOLEAN = true
        THEN 'paid'::payment_status
      ELSE COALESCE(payment_status, 'free'::payment_status)
    END,
    updated_at = NOW()
  WHERE id = v_session_id;

  IF v_session.plan_id IS NOT NULL THEN
    UPDATE plans SET
      current_occupancy = GREATEST(0, COALESCE(current_occupancy, 1) - 1),
      updated_at = NOW()
    WHERE id = v_session.plan_id;
  END IF;

  PERFORM log_audit(v_user_id, 'register_exit', 'parking_session', v_session_id,
    jsonb_build_object('plate', v_session.vehicle_plate, 'status', v_session.status));

  RETURN json_build_object('success', true, 'data', json_build_object(
    'message', 'Salida registrada',
    'sessionId', v_session_id,
    'plate', v_session.vehicle_plate,
    'exitTime', NOW()
  ));
END;
$$;
