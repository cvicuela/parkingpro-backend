-- Fix update_hourly_rates to use correct column names (hour_number, rate, description)
-- The previous version referenced non-existent columns (from_hour, to_hour, rate_per_hour)

CREATE OR REPLACE FUNCTION public.update_hourly_rates(p_token text, p_plan_id uuid, p_rates json)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_user_id UUID;
  v_role VARCHAR;
  v_rate JSON;
  v_results JSON;
  v_old_rates JSON;
BEGIN
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM require_role(p_token, ARRAY['admin', 'super_admin']) r;

  -- Capture old rates before delete
  SELECT json_agg(row_to_json(hr)) INTO v_old_rates
  FROM (SELECT * FROM hourly_rates WHERE plan_id = p_plan_id ORDER BY hour_number) hr;

  -- Delete existing rates for this plan
  DELETE FROM hourly_rates WHERE plan_id = p_plan_id;

  -- Insert new rates
  FOR v_rate IN SELECT * FROM json_array_elements(p_rates)
  LOOP
    INSERT INTO hourly_rates (plan_id, hour_number, rate, description, is_active)
    VALUES (
      p_plan_id,
      COALESCE((v_rate->>'hour_number')::INT, (v_rate->>'hourNumber')::INT, 1),
      COALESCE((v_rate->>'rate')::NUMERIC, (v_rate->>'ratePerHour')::NUMERIC, 50),
      COALESCE(v_rate->>'description', ''),
      COALESCE((v_rate->>'is_active')::BOOLEAN, true)
    );
  END LOOP;

  SELECT json_agg(row_to_json(hr)) INTO v_results
  FROM (SELECT * FROM hourly_rates WHERE plan_id = p_plan_id ORDER BY hour_number) hr;

  -- AUDIT LOG
  PERFORM log_audit(v_user_id, 'hourly_rates_updated', 'plan', p_plan_id,
    jsonb_build_object(
      'old_rates', COALESCE(v_old_rates::jsonb, '[]'::jsonb),
      'new_rates', COALESCE(v_results::jsonb, '[]'::jsonb),
      'updated_by_role', v_role
    ));

  RETURN json_build_object('success', true, 'data', COALESCE(v_results, '[]'::json));
EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$function$;
