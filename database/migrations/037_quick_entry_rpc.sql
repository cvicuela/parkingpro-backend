-- ============================================
-- MIGRACIÓN 037: RPC quick_entry para registrar entradas
-- Reemplaza el endpoint Express /api/v1/access/quick-entry
-- para que use el mismo sistema de auth (sessions table) que el resto de RPCs
-- ============================================

CREATE OR REPLACE FUNCTION public.quick_entry(p_token TEXT, p_data JSONB)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id UUID;
  v_role VARCHAR;
  v_plate VARCHAR;
  v_plan RECORD;
  v_subscription RECORD;
  v_session RECORD;
  v_event RECORD;
  v_verification_code VARCHAR;
  v_access_type VARCHAR := 'hourly';
  v_customer_id UUID;
  v_result JSON;
BEGIN
  -- 1. Authenticate
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM require_role(p_token, ARRAY['operator', 'admin', 'super_admin']) r;

  -- 2. Extract plate
  v_plate := UPPER(TRIM(COALESCE(p_data->>'plateNumber', '')));
  IF v_plate = '' THEN
    RAISE EXCEPTION 'plateNumber es requerido';
  END IF;

  -- 3. Check for active subscription (subscriptions has vehicle_id, not vehicle_plate)
  SELECT s.id AS sub_id, s.customer_id, v.plate AS vehicle_plate,
         c.first_name || ' ' || c.last_name AS customer_name,
         p.id AS plan_id, p.name AS plan_name, p.type AS plan_type, p.base_price
  INTO v_subscription
  FROM subscriptions s
  JOIN plans p ON p.id = s.plan_id
  LEFT JOIN customers c ON c.id = s.customer_id
  LEFT JOIN vehicles v ON v.id = s.vehicle_id
  WHERE v.plate = v_plate
    AND s.status = 'active'
    AND (s.current_period_end IS NULL OR s.current_period_end >= CURRENT_DATE)
  ORDER BY s.created_at DESC
  LIMIT 1;

  IF v_subscription IS NOT NULL THEN
    -- Subscription entry
    v_access_type := 'subscription';
    v_customer_id := v_subscription.customer_id;

    INSERT INTO access_events (
      subscription_id, vehicle_plate, type, timestamp,
      validation_method, operator_id, was_valid
    ) VALUES (
      v_subscription.sub_id, v_plate, 'entry', NOW(),
      'plate', v_user_id, true
    ) RETURNING * INTO v_event;

    v_result := json_build_object(
      'success', true,
      'data', json_build_object(
        'id', v_event.id,
        'entry_time', v_event.timestamp,
        'vehicle_plate', v_plate,
        'subscription_id', v_subscription.sub_id,
        'plan_name', v_subscription.plan_name,
        'plan_type', v_subscription.plan_type,
        'base_price', v_subscription.base_price,
        'customer_name', v_subscription.customer_name,
        'verification_code', NULL
      )
    );
  ELSE
    -- Hourly entry: find hourly plan
    SELECT p.id AS plan_id, p.name, p.type, p.base_price, p.capacity
    INTO v_plan
    FROM plans p
    WHERE p.type = 'hourly' AND p.is_active = true
    ORDER BY p.created_at ASC
    LIMIT 1;

    IF v_plan IS NULL THEN
      RAISE EXCEPTION 'No hay plan por hora activo configurado';
    END IF;

    -- Check if already has active session
    PERFORM 1 FROM parking_sessions
    WHERE vehicle_plate = v_plate AND status = 'active';
    IF FOUND THEN
      RAISE EXCEPTION 'Este vehículo ya tiene una sesión activa';
    END IF;

    -- Generate verification code
    v_verification_code := LPAD(FLOOR(RANDOM() * 1000000)::TEXT, 6, '0');

    -- Create parking session
    INSERT INTO parking_sessions (
      vehicle_plate, plan_id, entry_time, status, verification_code
    ) VALUES (
      v_plate, v_plan.plan_id, NOW(), 'active', v_verification_code
    ) RETURNING * INTO v_session;

    v_result := json_build_object(
      'success', true,
      'data', json_build_object(
        'id', v_session.id,
        'entry_time', v_session.entry_time,
        'vehicle_plate', v_plate,
        'subscription_id', NULL,
        'plan_name', v_plan.name,
        'plan_type', v_plan.type,
        'base_price', v_plan.base_price,
        'customer_name', NULL,
        'verification_code', v_verification_code
      )
    );
  END IF;

  RETURN v_result;
END;
$$;

-- ============================================
-- RPC lost_ticket_charge: Calcular cobro por ticket perdido
-- ============================================
CREATE OR REPLACE FUNCTION public.lost_ticket_charge(p_token TEXT, p_data JSONB)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id UUID;
  v_plate VARCHAR;
  v_ticket VARCHAR;
  v_session RECORD;
  v_lost_fee DECIMAL;
  v_plan_name VARCHAR;
  v_session_id UUID;
  v_entry_time TIMESTAMP;
  v_subtotal DECIMAL;
  v_tax DECIMAL;
  v_total DECIMAL;
  v_setting_val TEXT;
BEGIN
  -- Auth
  SELECT r.user_id INTO v_user_id
  FROM require_role(p_token, ARRAY['operator', 'admin', 'super_admin']) r;

  v_plate := UPPER(TRIM(COALESCE(p_data->>'plateNumber', '')));
  v_ticket := UPPER(TRIM(COALESCE(p_data->>'ticketNumber', '')));

  IF v_plate = '' AND v_ticket = '' THEN
    RAISE EXCEPTION 'plateNumber o ticketNumber es requerido';
  END IF;

  -- Find active session
  IF v_ticket != '' THEN
    SELECT ps.id, ps.entry_time, ps.vehicle_plate, p.name AS plan_name, p.lost_ticket_fee
    INTO v_session
    FROM parking_sessions ps
    JOIN plans p ON ps.plan_id = p.id
    WHERE ps.verification_code = v_ticket AND ps.status = 'active'
    ORDER BY ps.entry_time DESC LIMIT 1;
  ELSE
    SELECT ps.id, ps.entry_time, ps.vehicle_plate, p.name AS plan_name, p.lost_ticket_fee
    INTO v_session
    FROM parking_sessions ps
    JOIN plans p ON ps.plan_id = p.id
    WHERE ps.vehicle_plate = v_plate AND ps.status = 'active'
    ORDER BY ps.entry_time DESC LIMIT 1;
  END IF;

  IF v_session IS NOT NULL THEN
    v_lost_fee := COALESCE(v_session.lost_ticket_fee, 500);
    v_plan_name := v_session.plan_name;
    v_session_id := v_session.id;
    v_entry_time := v_session.entry_time;
    v_plate := COALESCE(v_session.vehicle_plate, v_plate);
  ELSE
    -- Default from settings
    SELECT value INTO v_setting_val FROM settings WHERE key = 'charges.lost_ticket';
    v_lost_fee := COALESCE(v_setting_val::DECIMAL, 500);
    v_plan_name := NULL;
    v_session_id := NULL;
    v_entry_time := NULL;
  END IF;

  v_subtotal := v_lost_fee;
  v_tax := ROUND(v_subtotal * 0.18, 2);
  v_total := v_subtotal + v_tax;

  RETURN json_build_object(
    'success', true,
    'data', json_build_object(
      'type', 'lost_ticket',
      'plateNumber', v_plate,
      'sessionId', v_session_id,
      'entryTime', v_entry_time,
      'planName', v_plan_name,
      'subtotal', v_subtotal,
      'tax', v_tax,
      'total', v_total,
      'lost_ticket_fee', v_lost_fee,
      'charge_reason', 'Cargo por ticket perdido',
      'payment_status', 'pending',
      'barrier_allowed', false
    )
  );
END;
$$;
