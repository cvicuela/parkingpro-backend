-- Migration 022: Reset Operational Data RPC
-- Allows super_admin to reset all operational/transactional data
-- while preserving company configuration, NCF, plans, users, etc.

-- 1. Function to get counts of operational data (preview before reset)
CREATE OR REPLACE FUNCTION reset_data_preview(p_token TEXT)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id UUID;
  v_role VARCHAR;
  v_result JSON;
BEGIN
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM verify_token_with_role(p_token) r;
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'No autorizado'; END IF;
  IF v_role != 'super_admin' THEN RAISE EXCEPTION 'Solo super_admin puede realizar esta operacion'; END IF;

  SELECT json_build_object(
    'parking_sessions', (SELECT COUNT(*) FROM parking_sessions),
    'access_events', (SELECT COUNT(*) FROM access_events),
    'payments', (SELECT COUNT(*) FROM payments),
    'invoices', (SELECT COUNT(*) FROM invoices),
    'cash_registers', (SELECT COUNT(*) FROM cash_registers),
    'cash_register_transactions', (SELECT COUNT(*) FROM cash_register_transactions),
    'denomination_counts', (SELECT COUNT(*) FROM denomination_counts),
    'incidents', (SELECT COUNT(*) FROM incidents),
    'notifications', (SELECT COUNT(*) FROM notifications),
    'audit_logs', (SELECT COUNT(*) FROM audit_logs),
    'otp_codes', (SELECT COUNT(*) FROM otp_codes)
  ) INTO v_result;

  RETURN json_build_object('success', true, 'data', v_result);
END;
$$;

-- 2. Main reset function with confirmation code verification
CREATE OR REPLACE FUNCTION reset_operational_data(p_token TEXT, p_confirmation_code TEXT)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id UUID;
  v_role VARCHAR;
  v_deleted RECORD;
BEGIN
  -- Verify super_admin
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM verify_token_with_role(p_token) r;
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'No autorizado'; END IF;
  IF v_role != 'super_admin' THEN RAISE EXCEPTION 'Solo super_admin puede realizar esta operacion'; END IF;

  -- Verify confirmation code matches expected value
  IF p_confirmation_code != 'RESETEAR-DATOS-OPERACIONALES' THEN
    RAISE EXCEPTION 'Codigo de confirmacion incorrecto';
  END IF;

  -- Log the reset action BEFORE deleting audit_logs
  INSERT INTO audit_logs (user_id, action, entity_type, entity_id, changes, ip_address)
  VALUES (v_user_id, 'SYSTEM_RESET', 'system', v_user_id,
    json_build_object('action', 'reset_operational_data', 'timestamp', NOW()::TEXT)::JSONB,
    '0.0.0.0');

  -- Delete in order respecting foreign keys
  -- 1. denomination_counts depends on cash_registers
  DELETE FROM denomination_counts;
  -- 2. cash_register_transactions depends on cash_registers
  DELETE FROM cash_register_transactions;
  -- 3. cash_registers depends on users
  DELETE FROM cash_registers;
  -- 4. invoices depends on payments
  DELETE FROM invoices;
  -- 5. payments depends on subscriptions/customers
  DELETE FROM payments;
  -- 6. access_events depends on subscriptions
  DELETE FROM access_events;
  -- 7. parking_sessions
  DELETE FROM parking_sessions;
  -- 8. incidents
  DELETE FROM incidents;
  -- 9. notifications
  DELETE FROM notifications;
  -- 10. otp_codes
  DELETE FROM otp_codes;
  -- 11. audit_logs (except the reset log we just created)
  DELETE FROM audit_logs WHERE action != 'SYSTEM_RESET' OR created_at < NOW() - INTERVAL '1 second';

  -- Reset NCF current sequences back to their start values (keep the ranges)
  -- Use range_from (not 0) to respect the ncf_current_in_range CHECK constraint
  UPDATE ncf_sequences SET current_number = range_from WHERE current_number > range_from;

  -- Reset internal invoice counter
  UPDATE settings SET value = '"1"' WHERE key = 'internal_invoice_next';

  RETURN json_build_object(
    'success', true,
    'message', 'Datos operacionales reseteados exitosamente. Se preservaron: usuarios, clientes, vehiculos, planes, suscripciones, configuraciones generales, NCF (rangos), y gastos.'
  );
END;
$$;
