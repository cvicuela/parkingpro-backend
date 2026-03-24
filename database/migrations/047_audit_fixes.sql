-- Migration 047: Audit fixes
-- 1. Add missing refund_payment RPC function
-- 2. Fix process_parking_payment to decrement occupancy via trigger
-- 3. Fix auto_close_stale_sessions to use 'abandoned' status

-- ------------------------------------------------------------
-- 1. refund_payment RPC
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refund_payment(p_token TEXT, p_id UUID, p_reason TEXT DEFAULT '')
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_user_id UUID;
  v_payment RECORD;
  v_refund_amount DECIMAL;
BEGIN
  SELECT r.user_id INTO v_user_id
  FROM require_role(p_token, ARRAY['admin', 'super_admin']) r;

  SELECT * INTO v_payment FROM payments WHERE id = p_id;
  IF v_payment IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Pago no encontrado');
  END IF;
  IF v_payment.status = 'refunded' THEN
    RETURN json_build_object('success', false, 'error', 'Este pago ya fue reembolsado');
  END IF;
  IF v_payment.status != 'paid' THEN
    RETURN json_build_object('success', false, 'error', 'Solo se pueden reembolsar pagos completados');
  END IF;

  v_refund_amount := v_payment.total_amount;

  -- Update payment status
  UPDATE payments SET
    status = 'refunded',
    refunded_at = NOW(),
    refund_reason = p_reason,
    updated_at = NOW()
  WHERE id = p_id;

  -- Record cash register transaction if register is open
  INSERT INTO cash_register_transactions (cash_register_id, type, amount, direction, payment_method, operator_id, description)
  SELECT cr.id, 'refund', v_refund_amount, 'out',
    COALESCE(v_payment.payment_method, 'cash'),
    v_user_id,
    'Reembolso: ' || COALESCE(p_reason, 'Sin razón especificada')
  FROM cash_registers cr
  WHERE cr.status = 'open' AND cr.operator_id = v_user_id
  LIMIT 1;

  -- Update related invoice if exists
  UPDATE invoices SET status = 'cancelled', updated_at = NOW()
  WHERE payment_id = p_id;

  -- Audit log
  PERFORM log_audit(v_user_id, 'refund_payment', 'payment', p_id,
    jsonb_build_object('amount', v_refund_amount, 'reason', p_reason));

  RETURN json_build_object('success', true, 'data', json_build_object(
    'paymentId', p_id,
    'refundAmount', v_refund_amount,
    'reason', p_reason,
    'status', 'refunded'
  ));
END;
$$;

-- ------------------------------------------------------------
-- 2. Fix: process_parking_payment must decrement plan occupancy
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fix_occupancy_on_payment()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  -- When a parking session status changes to 'paid' or 'closed', decrement occupancy
  IF (OLD.status = 'active' AND NEW.status IN ('paid', 'closed')) THEN
    UPDATE plans SET current_occupancy = GREATEST(0, current_occupancy - 1)
    WHERE id = NEW.plan_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fix_occupancy_on_session_close ON parking_sessions;
CREATE TRIGGER trg_fix_occupancy_on_session_close
  AFTER UPDATE OF status ON parking_sessions
  FOR EACH ROW
  WHEN (OLD.status = 'active' AND NEW.status IN ('paid', 'closed', 'abandoned'))
  EXECUTE FUNCTION fix_occupancy_on_payment();

-- ------------------------------------------------------------
-- 3. Fix stale session auto-close: use 'abandoned' status and decrement occupancy
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auto_close_stale_sessions()
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_closed_count INT;
  v_plan_ids UUID[];
BEGIN
  -- Collect plan_ids of sessions being closed
  SELECT ARRAY_AGG(DISTINCT plan_id) INTO v_plan_ids
  FROM parking_sessions
  WHERE status = 'active' AND entry_time < NOW() - INTERVAL '24 hours';

  -- Close stale sessions
  UPDATE parking_sessions SET
    status = 'abandoned',
    exit_time = NOW(),
    payment_status = CASE
      WHEN payment_status = 'pending' THEN 'pending'
      ELSE payment_status
    END,
    updated_at = NOW()
  WHERE status = 'active' AND entry_time < NOW() - INTERVAL '24 hours';

  GET DIAGNOSTICS v_closed_count = ROW_COUNT;

  -- Note: occupancy decrement is now handled by trigger trg_fix_occupancy_on_session_close

  RETURN json_build_object('success', true, 'closed_count', v_closed_count);
END;
$$;
