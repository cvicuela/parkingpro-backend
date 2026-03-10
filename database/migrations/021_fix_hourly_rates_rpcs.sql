-- Migration 021: Fix hourly rates - add missing RPCs
-- get_hourly_rates, calculate_hourly RPCs were missing entirely
-- Also adds is_additional_flat flag for "hora X en adelante" pricing

-- Add is_additional_flat column to hourly_rates if not exists
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'hourly_rates' AND column_name = 'is_additional_flat') THEN
    ALTER TABLE hourly_rates ADD COLUMN is_additional_flat BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

-- ==================== GET HOURLY RATES ====================
CREATE OR REPLACE FUNCTION get_hourly_rates(p_token TEXT, p_plan_id UUID)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id UUID;
  v_rates JSON;
BEGIN
  SELECT r.user_id INTO v_user_id
  FROM require_role(p_token, ARRAY['admin', 'super_admin', 'operator']) r;

  SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.hour_number), '[]'::json)
  INTO v_rates
  FROM (
    SELECT hour_number, rate, description, is_active, is_additional_flat
    FROM hourly_rates
    WHERE plan_id = p_plan_id AND is_active = true
    ORDER BY hour_number ASC
  ) t;

  RETURN json_build_object('success', true, 'data', v_rates);
END;
$$;

-- ==================== FIX UPDATE HOURLY RATES ====================
-- Rewrites to properly handle the UNIQUE constraint and is_additional_flat
CREATE OR REPLACE FUNCTION update_hourly_rates(p_token TEXT, p_plan_id UUID, p_rates JSON)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id UUID;
  v_role VARCHAR;
  v_rate JSON;
  v_results JSON;
  v_old_rates JSON;
BEGIN
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM require_role(p_token, ARRAY['admin', 'super_admin']) r;

  -- Capture old rates for audit
  SELECT COALESCE(json_agg(row_to_json(hr)), '[]'::json) INTO v_old_rates
  FROM (SELECT hour_number, rate, description, is_additional_flat FROM hourly_rates WHERE plan_id = p_plan_id AND is_active = true ORDER BY hour_number) hr;

  -- Deactivate all existing rates for this plan (soft delete to avoid UNIQUE conflicts)
  UPDATE hourly_rates SET is_active = false, updated_at = NOW() WHERE plan_id = p_plan_id;

  -- Upsert new rates
  FOR v_rate IN SELECT * FROM json_array_elements(p_rates)
  LOOP
    INSERT INTO hourly_rates (plan_id, hour_number, rate, description, is_active, is_additional_flat, updated_at)
    VALUES (
      p_plan_id,
      COALESCE((v_rate->>'hour_number')::INT, (v_rate->>'hourNumber')::INT, 1),
      COALESCE((v_rate->>'rate')::NUMERIC, (v_rate->>'ratePerHour')::NUMERIC, 50),
      COALESCE(v_rate->>'description', ''),
      true,
      COALESCE((v_rate->>'is_additional_flat')::BOOLEAN, (v_rate->>'isAdditionalFlat')::BOOLEAN, false),
      NOW()
    )
    ON CONFLICT (plan_id, hour_number)
    DO UPDATE SET
      rate = EXCLUDED.rate,
      description = EXCLUDED.description,
      is_active = true,
      is_additional_flat = EXCLUDED.is_additional_flat,
      updated_at = NOW();
  END LOOP;

  -- Return updated rates
  SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.hour_number), '[]'::json)
  INTO v_results
  FROM (
    SELECT hour_number, rate, description, is_active, is_additional_flat
    FROM hourly_rates WHERE plan_id = p_plan_id AND is_active = true ORDER BY hour_number
  ) t;

  -- Audit
  PERFORM log_audit(v_user_id, 'hourly_rates_updated', 'plan', p_plan_id,
    jsonb_build_object(
      'old_rates', COALESCE(v_old_rates::jsonb, '[]'::jsonb),
      'new_rates', COALESCE(v_results::jsonb, '[]'::jsonb),
      'updated_by_role', v_role
    ));

  RETURN json_build_object('success', true, 'data', v_results);
EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- ==================== CALCULATE HOURLY FEE ====================
CREATE OR REPLACE FUNCTION calculate_hourly(p_token TEXT, p_data JSON)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id UUID;
  v_plan_id UUID;
  v_entry_time TIMESTAMPTZ;
  v_exit_time TIMESTAMPTZ;
  v_tolerance INT;
  v_total_minutes INT;
  v_total_hours INT;
  v_amount DECIMAL := 0;
  v_rates RECORD;
  v_hour_rate DECIMAL;
  v_breakdown JSON;
  v_i INT;
BEGIN
  SELECT r.user_id INTO v_user_id
  FROM require_role(p_token, ARRAY['admin', 'super_admin', 'operator']) r;

  v_plan_id := (p_data->>'planId')::UUID;
  v_entry_time := COALESCE((p_data->>'entryTime')::TIMESTAMPTZ, (p_data->>'entry_time')::TIMESTAMPTZ);
  v_exit_time := COALESCE((p_data->>'exitTime')::TIMESTAMPTZ, (p_data->>'exit_time')::TIMESTAMPTZ, NOW());

  -- Get tolerance
  SELECT COALESCE(tolerance_minutes, 5) INTO v_tolerance FROM plans WHERE id = v_plan_id;

  -- Calculate minutes
  v_total_minutes := EXTRACT(EPOCH FROM (v_exit_time - v_entry_time))::INT / 60;

  -- Within tolerance = free
  IF v_total_minutes <= v_tolerance THEN
    RETURN json_build_object('success', true, 'data', json_build_object(
      'amount', 0, 'totalMinutes', v_total_minutes, 'totalHours', 0, 'isFree', true,
      'breakdown', json_build_array(json_build_object('hour', 0, 'rate', 0, 'description', 'Gratis (tolerancia de ' || v_tolerance || ' min)'))
    ));
  END IF;

  -- Subtract tolerance
  v_total_minutes := v_total_minutes - v_tolerance;
  v_total_hours := CEIL(v_total_minutes::DECIMAL / 60);

  -- Build breakdown
  SELECT COALESCE(json_agg(json_build_object(
    'hour', sub.hour_num,
    'rate', sub.applied_rate,
    'description', sub.desc_text
  ) ORDER BY sub.hour_num), '[]'::json) INTO v_breakdown
  FROM (
    SELECT
      h.hour_num,
      COALESCE(
        (SELECT rate FROM hourly_rates WHERE plan_id = v_plan_id AND hour_number = h.hour_num AND is_active = true),
        (SELECT rate FROM hourly_rates WHERE plan_id = v_plan_id AND is_active = true ORDER BY hour_number DESC LIMIT 1)
      ) AS applied_rate,
      COALESCE(
        (SELECT description FROM hourly_rates WHERE plan_id = v_plan_id AND hour_number = h.hour_num AND is_active = true),
        'Hora ' || h.hour_num
      ) AS desc_text
    FROM generate_series(1, v_total_hours) AS h(hour_num)
  ) sub;

  -- Sum total
  SELECT COALESCE(SUM((elem->>'rate')::DECIMAL), 0) INTO v_amount
  FROM json_array_elements(v_breakdown) elem;

  RETURN json_build_object('success', true, 'data', json_build_object(
    'amount', v_amount,
    'totalMinutes', v_total_minutes + v_tolerance,
    'totalHours', v_total_hours,
    'toleranceApplied', v_tolerance,
    'isFree', false,
    'breakdown', v_breakdown
  ));
END;
$$;

-- ==================== CALCULATE PARKING FEE (alias) ====================
CREATE OR REPLACE FUNCTION calculate_parking_fee(p_token TEXT, p_data JSON)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN calculate_hourly(p_token, p_data);
END;
$$;
