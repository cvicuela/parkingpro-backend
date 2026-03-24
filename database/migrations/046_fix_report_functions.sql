-- ============================================
-- MIGRACIÓN 046: Fix report RPC functions
-- Fixes:
--   1. report_sessions: COALESCE(status, 'unknown') crashed because status is enum session_status
--      → Cast enum to TEXT before COALESCE; also adds byAccessMethod from access_events join
--   2. report_occupancy: COALESCE(access_method, validation_method, 'unknown') crashed because
--      access_method is enum access_method but validation_method is varchar
--      → Cast enum to TEXT; also fallback to parking_sessions when access_events is empty
--   3. report_customers: topCustomers was empty when no paid payments exist
--      → Removed HAVING > 0 filter so all customers show in ranking
-- ============================================

-- 1. Fix report_sessions
DROP FUNCTION IF EXISTS report_sessions(text,text,text,text);

CREATE OR REPLACE FUNCTION public.report_sessions(p_token TEXT, p_period TEXT, p_from TEXT, p_to TEXT)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id UUID;
  v_range RECORD;
  v_summary RECORD;
  v_timeline JSON;
  v_by_status JSON;
  v_by_access JSON;
  v_duration_dist JSON;
BEGIN
  SELECT r.user_id INTO v_user_id FROM require_role(p_token, ARRAY['admin', 'super_admin']) r;
  SELECT * INTO v_range FROM get_date_range(p_period, p_from, p_to);

  SELECT
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE status = 'active') AS active,
    COUNT(*) FILTER (WHERE status = 'paid') AS paid,
    COUNT(*) FILTER (WHERE status = 'closed') AS closed,
    COUNT(*) FILTER (WHERE status = 'abandoned') AS abandoned,
    COALESCE(SUM(paid_amount) FILTER (WHERE payment_status = 'paid'), 0) AS total_revenue,
    COALESCE(ROUND(AVG(duration_minutes) FILTER (WHERE exit_time IS NOT NULL)), 0) AS avg_duration,
    ROUND(COALESCE(AVG(paid_amount) FILTER (WHERE payment_status = 'paid'), 0)::NUMERIC, 2) AS avg_ticket
  INTO v_summary FROM parking_sessions
  WHERE entry_time >= v_range.range_from AND entry_time <= v_range.range_to;

  SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_timeline FROM (
    SELECT
      DATE_TRUNC('day', entry_time)::date AS date,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE payment_status = 'paid') AS paid,
      COUNT(*) FILTER (WHERE status = 'abandoned') AS abandoned,
      COALESCE(SUM(paid_amount) FILTER (WHERE payment_status = 'paid'), 0) AS revenue
    FROM parking_sessions
    WHERE entry_time >= v_range.range_from AND entry_time <= v_range.range_to
    GROUP BY DATE_TRUNC('day', entry_time)::date ORDER BY date ASC
  ) t;

  -- By status - cast enum to TEXT to avoid 'unknown' enum error
  SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_by_status FROM (
    SELECT
      COALESCE(status::TEXT, 'desconocido') AS status,
      COUNT(*) AS count,
      COALESCE(SUM(paid_amount) FILTER (WHERE payment_status = 'paid'), 0) AS revenue
    FROM parking_sessions
    WHERE entry_time >= v_range.range_from AND entry_time <= v_range.range_to
    GROUP BY status ORDER BY count DESC
  ) t;

  -- By access method from access_events joined to sessions
  SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_by_access FROM (
    SELECT
      COALESCE(ae.access_method::TEXT, ae.validation_method, 'manual') AS method,
      COUNT(*) AS count,
      COALESCE(SUM(ps.paid_amount) FILTER (WHERE ps.payment_status = 'paid'), 0) AS revenue
    FROM parking_sessions ps
    LEFT JOIN access_events ae ON ae.vehicle_plate = ps.vehicle_plate
      AND ae.type = 'entry'
      AND ae.timestamp >= v_range.range_from AND ae.timestamp <= v_range.range_to
    WHERE ps.entry_time >= v_range.range_from AND ps.entry_time <= v_range.range_to
    GROUP BY COALESCE(ae.access_method::TEXT, ae.validation_method, 'manual') ORDER BY count DESC
  ) t;

  SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_duration_dist FROM (
    SELECT bucket, count, ROUND(avg_paid::NUMERIC, 2) AS "avgPaid" FROM (
      SELECT
        CASE
          WHEN duration_minutes <= 30 THEN '0-30 min'
          WHEN duration_minutes <= 60 THEN '30-60 min'
          WHEN duration_minutes <= 120 THEN '1-2 horas'
          WHEN duration_minutes <= 240 THEN '2-4 horas'
          WHEN duration_minutes <= 480 THEN '4-8 horas'
          ELSE '8+ horas'
        END AS bucket,
        COUNT(*) AS count,
        COALESCE(AVG(paid_amount) FILTER (WHERE payment_status = 'paid'), 0) AS avg_paid,
        MIN(duration_minutes) AS sort_key
      FROM parking_sessions
      WHERE exit_time IS NOT NULL AND entry_time >= v_range.range_from AND entry_time <= v_range.range_to
      GROUP BY bucket ORDER BY sort_key ASC
    ) sub
  ) t;

  RETURN json_build_object('success', true, 'data', json_build_object(
    'summary', json_build_object(
      'total', v_summary.total,
      'active', v_summary.active,
      'paid', v_summary.paid,
      'closed', v_summary.closed,
      'abandoned', v_summary.abandoned,
      'totalRevenue', v_summary.total_revenue,
      'avgDuration', v_summary.avg_duration,
      'avgTicket', v_summary.avg_ticket
    ),
    'timeline', v_timeline,
    'byAccessMethod', v_by_access,
    'byStatus', v_by_status,
    'durationDistribution', v_duration_dist
  ));
END;
$$;


-- 2. Fix report_occupancy
DROP FUNCTION IF EXISTS report_occupancy(text,text,text,text);

CREATE OR REPLACE FUNCTION public.report_occupancy(p_token TEXT, p_period TEXT, p_from TEXT, p_to TEXT)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id UUID;
  v_range RECORD;
  v_peak_hours JSON;
  v_peak_days JSON;
  v_daily_trend JSON;
  v_avg_duration JSON;
  v_access_methods JSON;
  v_day_names TEXT[] := ARRAY['Domingo','Lunes','Martes','Miercoles','Jueves','Viernes','Sabado'];
  v_has_access_events BOOLEAN;
BEGIN
  SELECT r.user_id INTO v_user_id FROM require_role(p_token, ARRAY['admin', 'super_admin']) r;
  SELECT * INTO v_range FROM get_date_range(p_period, p_from, p_to);

  -- Check if there are access_events in range
  SELECT EXISTS(
    SELECT 1 FROM access_events WHERE timestamp >= v_range.range_from AND timestamp <= v_range.range_to
  ) INTO v_has_access_events;

  IF v_has_access_events THEN
    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_peak_hours FROM (
      SELECT EXTRACT(HOUR FROM timestamp)::INT AS hour,
        LPAD(EXTRACT(HOUR FROM timestamp)::INT::TEXT, 2, '0') || ':00' AS label,
        COUNT(*) AS "entryCount"
      FROM access_events WHERE type = 'entry' AND timestamp >= v_range.range_from AND timestamp <= v_range.range_to
      GROUP BY EXTRACT(HOUR FROM timestamp) ORDER BY hour ASC
    ) t;

    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_peak_days FROM (
      SELECT EXTRACT(DOW FROM timestamp)::INT AS "dayOfWeek", COUNT(*) AS "entryCount"
      FROM access_events WHERE type = 'entry' AND timestamp >= v_range.range_from AND timestamp <= v_range.range_to
      GROUP BY EXTRACT(DOW FROM timestamp) ORDER BY "dayOfWeek" ASC
    ) t;

    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_daily_trend FROM (
      SELECT DATE_TRUNC('day', ae.timestamp)::date AS date,
        COUNT(*) FILTER (WHERE ae.type = 'entry') AS entries,
        COUNT(*) FILTER (WHERE ae.type = 'exit') AS exits,
        COUNT(*) FILTER (WHERE ae.type = 'entry') - COUNT(*) FILTER (WHERE ae.type = 'exit') AS net
      FROM access_events ae WHERE ae.timestamp >= v_range.range_from AND ae.timestamp <= v_range.range_to
      GROUP BY DATE_TRUNC('day', ae.timestamp)::date ORDER BY date ASC
    ) t;

    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_access_methods FROM (
      SELECT COALESCE(access_method::TEXT, validation_method, 'manual') AS method,
        COUNT(*) AS count,
        COUNT(*) FILTER (WHERE type = 'entry') AS entries,
        COUNT(*) FILTER (WHERE type = 'exit') AS exits
      FROM access_events WHERE timestamp >= v_range.range_from AND timestamp <= v_range.range_to
      GROUP BY COALESCE(access_method::TEXT, validation_method, 'manual') ORDER BY count DESC
    ) t;
  ELSE
    -- Fallback to parking_sessions
    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_peak_hours FROM (
      SELECT EXTRACT(HOUR FROM entry_time)::INT AS hour,
        LPAD(EXTRACT(HOUR FROM entry_time)::INT::TEXT, 2, '0') || ':00' AS label,
        COUNT(*) AS "entryCount"
      FROM parking_sessions WHERE entry_time >= v_range.range_from AND entry_time <= v_range.range_to
      GROUP BY EXTRACT(HOUR FROM entry_time) ORDER BY hour ASC
    ) t;

    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_peak_days FROM (
      SELECT EXTRACT(DOW FROM entry_time)::INT AS "dayOfWeek", COUNT(*) AS "entryCount"
      FROM parking_sessions WHERE entry_time >= v_range.range_from AND entry_time <= v_range.range_to
      GROUP BY EXTRACT(DOW FROM entry_time) ORDER BY "dayOfWeek" ASC
    ) t;

    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_daily_trend FROM (
      SELECT DATE_TRUNC('day', ps.entry_time)::date AS date,
        COUNT(*) AS entries,
        COUNT(*) FILTER (WHERE ps.exit_time IS NOT NULL) AS exits,
        COUNT(*) - COUNT(*) FILTER (WHERE ps.exit_time IS NOT NULL) AS net
      FROM parking_sessions ps WHERE ps.entry_time >= v_range.range_from AND ps.entry_time <= v_range.range_to
      GROUP BY DATE_TRUNC('day', ps.entry_time)::date ORDER BY date ASC
    ) t;

    v_access_methods := '[]'::json;
  END IF;

  -- Avg duration always from parking_sessions
  SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_avg_duration FROM (
    SELECT COALESCE(p.name, 'Parqueo por hora') AS "planName",
      COUNT(*) AS "sessionCount",
      ROUND(COALESCE(AVG(ps.duration_minutes), 0)) AS "avgMinutes",
      COALESCE(MIN(ps.duration_minutes), 0) AS "minMinutes",
      COALESCE(MAX(ps.duration_minutes), 0) AS "maxMinutes"
    FROM parking_sessions ps LEFT JOIN plans p ON ps.plan_id = p.id
    WHERE ps.exit_time IS NOT NULL AND ps.entry_time >= v_range.range_from AND ps.entry_time <= v_range.range_to
    GROUP BY p.name ORDER BY "sessionCount" DESC
  ) t;

  -- Add day names
  SELECT COALESCE(json_agg(
    json_build_object(
      'dayOfWeek', (elem->>'dayOfWeek')::INT,
      'dayName', v_day_names[(elem->>'dayOfWeek')::INT + 1],
      'entryCount', (elem->>'entryCount')::INT
    )
  ), '[]'::json) INTO v_peak_days
  FROM json_array_elements(v_peak_days) elem;

  RETURN json_build_object('success', true, 'data', json_build_object(
    'peakHours', v_peak_hours,
    'peakDays', v_peak_days,
    'dailyTrend', v_daily_trend,
    'avgDuration', v_avg_duration,
    'accessMethods', v_access_methods
  ));
END;
$$;


-- 3. Fix report_customers (topCustomers shows all customers, not just those with paid payments)
DROP FUNCTION IF EXISTS report_customers(text,text,text,text);

CREATE OR REPLACE FUNCTION public.report_customers(p_token TEXT, p_period TEXT, p_from TEXT, p_to TEXT)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id UUID;
  v_range RECORD;
  v_new_trend JSON;
  v_status_dist JSON;
  v_top_customers JSON;
  v_delinquent JSON;
  v_churn_trend JSON;
  v_retention RECORD;
  v_retention_rate DECIMAL;
BEGIN
  SELECT r.user_id INTO v_user_id FROM require_role(p_token, ARRAY['admin', 'super_admin']) r;
  SELECT * INTO v_range FROM get_date_range(p_period, p_from, p_to);

  SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_new_trend FROM (
    SELECT DATE_TRUNC('week', c.created_at) AS period, COUNT(*) AS count
    FROM customers c WHERE c.created_at >= v_range.range_from AND c.created_at <= v_range.range_to
    GROUP BY DATE_TRUNC('week', c.created_at) ORDER BY period ASC
  ) t;

  SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_status_dist FROM (
    SELECT status, COUNT(*) AS count FROM subscriptions GROUP BY status ORDER BY count DESC
  ) t;

  SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_top_customers FROM (
    SELECT
      c.id AS "customerId",
      c.first_name || ' ' || c.last_name AS "customerName",
      c.id_document AS "idDocument",
      COUNT(p.id) AS "paymentCount",
      COALESCE(SUM(p.total_amount), 0) AS "totalPaid",
      COUNT(DISTINCT s.id) AS "subscriptionCount",
      MIN(c.created_at) AS "customerSince"
    FROM customers c
    LEFT JOIN payments p ON p.customer_id = c.id AND p.status = 'paid' AND p.created_at >= v_range.range_from AND p.created_at <= v_range.range_to
    LEFT JOIN subscriptions s ON s.customer_id = c.id AND s.status = 'active'
    GROUP BY c.id, c.first_name, c.last_name, c.id_document
    ORDER BY "totalPaid" DESC, "subscriptionCount" DESC LIMIT 20
  ) t;

  SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_delinquent FROM (
    SELECT
      c.first_name || ' ' || c.last_name AS "customerName",
      s.status,
      p.name AS "planName",
      s.next_billing_date AS "nextBillingDate",
      s.price_per_period AS "pricePerPeriod",
      COALESCE(CURRENT_DATE - s.next_billing_date, 0) AS "daysOverdue"
    FROM subscriptions s
    JOIN customers c ON s.customer_id = c.id
    JOIN plans p ON s.plan_id = p.id
    WHERE s.status IN ('past_due', 'suspended')
    ORDER BY "daysOverdue" DESC NULLS LAST
  ) t;

  SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_churn_trend FROM (
    SELECT DATE_TRUNC('week', cancelled_at) AS period, COUNT(*) AS count
    FROM subscriptions WHERE cancelled_at >= v_range.range_from AND cancelled_at <= v_range.range_to
    GROUP BY DATE_TRUNC('week', cancelled_at) ORDER BY period ASC
  ) t;

  SELECT
    COUNT(*) FILTER (WHERE status = 'active') AS active_count,
    COUNT(*) AS total_count
  INTO v_retention FROM subscriptions WHERE activated_at IS NOT NULL;

  v_retention_rate := CASE WHEN v_retention.total_count > 0
    THEN ROUND((v_retention.active_count::DECIMAL / v_retention.total_count * 100)::NUMERIC, 2) ELSE 100 END;

  RETURN json_build_object('success', true, 'data', json_build_object(
    'newCustomersTrend', v_new_trend,
    'statusDistribution', v_status_dist,
    'topCustomers', v_top_customers,
    'delinquent', v_delinquent,
    'churnTrend', v_churn_trend,
    'retentionRate', v_retention_rate
  ));
END;
$$;
