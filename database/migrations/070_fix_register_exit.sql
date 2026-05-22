-- Migration 070: Harden register_exit (hot path)
-- Bug: marked a session status/payment_status = 'paid' purely from a client-supplied
--   flag (p_data.payment.paid=true), with NO payment/invoice/cash record -> a caller
--   could mark any session paid for free; unpaid exits also defaulted to 'free'.
-- Reality: the legit flow calls process_parking_payment first (which creates the payment
--   and sets status='paid'), THEN register_exit, which early-returns on already-paid
--   sessions. So the client paid-flag is redundant in the real flow (verified: all 15
--   paid sessions have a payment_id) and only matters on the exploit path.
-- Fix: require an operator-level role; mark 'paid' only when a real payment is linked
--   (payment_id present), else just close the gate event; never fabricate payment state.

CREATE OR REPLACE FUNCTION public.register_exit(p_token text, p_data json)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_auth RECORD;
  v_session RECORD;
  v_session_id UUID;
  v_new_status TEXT;
BEGIN
  -- Was: verify_token (any authenticated user). Now require an operator-level role.
  SELECT * INTO v_auth FROM require_role(p_token, ARRAY['operator', 'admin', 'super_admin']);

  v_session_id := (p_data->>'sessionId')::UUID;
  IF v_session_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'sessionId requerido');
  END IF;

  SELECT * INTO v_session FROM parking_sessions WHERE id = v_session_id;
  IF v_session IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Sesion no encontrada');
  END IF;

  IF v_session.status IN ('closed', 'paid') THEN
    RETURN json_build_object('success', true, 'data', json_build_object(
      'message', 'Sesion ya cerrada',
      'sessionId', v_session.id,
      'status', v_session.status
    ));
  END IF;

  -- SECURITY: do NOT trust a client 'paid' flag. Only 'paid' when a real payment is
  -- linked (process_parking_payment sets payment_id / payment_status='paid');
  -- otherwise close the gate event without fabricating payment state.
  IF v_session.payment_id IS NOT NULL OR v_session.payment_status = 'paid' THEN
    v_new_status := 'paid';
  ELSE
    v_new_status := 'closed';
  END IF;

  UPDATE parking_sessions SET
    exit_time = COALESCE(exit_time, NOW()),
    status = v_new_status::session_status,
    updated_at = NOW()
  WHERE id = v_session_id;

  IF v_session.plan_id IS NOT NULL THEN
    UPDATE plans SET
      current_occupancy = GREATEST(0, COALESCE(current_occupancy, 1) - 1),
      updated_at = NOW()
    WHERE id = v_session.plan_id;
  END IF;

  PERFORM log_audit(v_auth.user_id, 'register_exit', 'parking_session', v_session_id,
    jsonb_build_object('plate', v_session.vehicle_plate, 'status', v_new_status));

  RETURN json_build_object('success', true, 'data', json_build_object(
    'message', 'Salida registrada',
    'sessionId', v_session_id,
    'plate', v_session.vehicle_plate,
    'status', v_new_status,
    'exitTime', NOW()
  ));
END;
$function$;
