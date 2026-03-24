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
--   4. report_executive_summary: subscriptionRevenue was calculated as
--      currentMonth - hourlyRevenue using inconsistent data sources (payments vs sessions)
--      → Now computes subscriptionRevenue and hourlyRevenue from same payments table
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


-- 4. Fix report_executive_summary - consistent revenue sources
DROP FUNCTION IF EXISTS report_executive_summary(text);

CREATE OR REPLACE FUNCTION public.report_executive_summary(p_token TEXT)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id UUID;
  v_rev RECORD;
  v_sub RECORD;
  v_sess RECORD;
  v_cash RECORD;
  v_col RECORD;
  v_ref RECORD;
  v_change DECIMAL;
BEGIN
  SELECT r.user_id INTO v_user_id FROM require_role(p_token, ARRAY['admin', 'super_admin']) r;

  -- Gross revenue = paid + refunded (refunded payments were collected before being returned)
  -- This way Total Bruto reflects all money that entered, and Total Neto = Bruto - Reembolsos
  SELECT
    COALESCE(SUM(CASE WHEN created_at >= DATE_TRUNC('month', CURRENT_DATE) THEN total_amount END), 0) AS current_month,
    COALESCE(SUM(CASE WHEN created_at >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
        AND created_at < DATE_TRUNC('month', CURRENT_DATE) THEN total_amount END), 0) AS previous_month,
    COALESCE(SUM(CASE WHEN created_at >= DATE_TRUNC('month', CURRENT_DATE) AND subscription_id IS NOT NULL THEN total_amount END), 0) AS subscription_revenue,
    COALESCE(SUM(CASE WHEN created_at >= DATE_TRUNC('month', CURRENT_DATE) AND subscription_id IS NULL THEN total_amount END), 0) AS hourly_revenue
  INTO v_rev FROM payments WHERE status IN ('paid', 'refunded');

  SELECT
    COUNT(*) FILTER (WHERE activated_at >= DATE_TRUNC('month', CURRENT_DATE)) AS new_this_month,
    COUNT(*) FILTER (WHERE activated_at >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
        AND activated_at < DATE_TRUNC('month', CURRENT_DATE)) AS new_last_month,
    COUNT(*) FILTER (WHERE cancelled_at >= DATE_TRUNC('month', CURRENT_DATE)) AS cancelled_this_month,
    COUNT(*) FILTER (WHERE status = 'active') AS total_active
  INTO v_sub FROM subscriptions;

  SELECT
    COUNT(*) FILTER (WHERE entry_time >= DATE_TRUNC('month', CURRENT_DATE)) AS sessions_this_month,
    COALESCE(AVG(duration_minutes) FILTER (WHERE exit_time IS NOT NULL AND entry_time >= DATE_TRUNC('month', CURRENT_DATE)), 0) AS avg_duration_min
  INTO v_sess FROM parking_sessions;

  SELECT
    COUNT(*) AS total_closures,
    COALESCE(SUM(expected_balance), 0) AS total_expected,
    COALESCE(SUM(counted_balance), 0) AS total_counted,
    COALESCE(SUM(ABS(difference)), 0) AS total_abs_difference,
    COUNT(*) FILTER (WHERE requires_approval = true) AS requiring_approval
  INTO v_cash FROM cash_registers
  WHERE status = 'closed' AND closed_at >= DATE_TRUNC('month', CURRENT_DATE);

  SELECT
    COUNT(*) FILTER (WHERE status = 'paid') AS paid_count,
    COUNT(*) AS total_count,
    COALESCE(SUM(total_amount) FILTER (WHERE status = 'paid'), 0) AS collected,
    COALESCE(SUM(total_amount), 0) AS total_billed
  INTO v_col FROM payments
  WHERE created_at >= DATE_TRUNC('month', CURRENT_DATE);

  SELECT
    COUNT(*) AS refund_count,
    COALESCE(SUM(total_amount), 0) AS refund_total
  INTO v_ref FROM payments
  WHERE status = 'refunded' AND refunded_at >= DATE_TRUNC('month', CURRENT_DATE);

  v_change := CASE WHEN v_rev.previous_month > 0
    THEN ROUND(((v_rev.current_month - v_rev.previous_month) / v_rev.previous_month * 100)::NUMERIC, 2)
    ELSE 0 END;

  RETURN json_build_object('success', true, 'data', json_build_object(
    'revenue', json_build_object(
      'currentMonth', v_rev.current_month,
      'previousMonth', v_rev.previous_month,
      'subscriptionRevenue', v_rev.subscription_revenue,
      'hourlyRevenue', v_rev.hourly_revenue,
      'changePercent', v_change,
      'trend', CASE WHEN v_change >= 0 THEN 'up' ELSE 'down' END
    ),
    'subscriptions', json_build_object(
      'totalActive', v_sub.total_active,
      'newThisMonth', v_sub.new_this_month,
      'newLastMonth', v_sub.new_last_month,
      'cancelledThisMonth', v_sub.cancelled_this_month
    ),
    'sessions', json_build_object(
      'totalThisMonth', v_sess.sessions_this_month,
      'avgDurationMinutes', ROUND(v_sess.avg_duration_min),
      'hourlyRevenue', v_rev.hourly_revenue
    ),
    'cashRegisters', json_build_object(
      'totalClosures', v_cash.total_closures,
      'totalExpected', v_cash.total_expected,
      'totalCounted', v_cash.total_counted,
      'totalAbsDifference', v_cash.total_abs_difference,
      'requiringApproval', v_cash.requiring_approval
    ),
    'collection', json_build_object(
      'rate', CASE WHEN v_col.total_count > 0 THEN ROUND((v_col.paid_count::DECIMAL / v_col.total_count * 100)::NUMERIC, 2) ELSE 100 END,
      'collected', v_col.collected,
      'totalBilled', v_col.total_billed,
      'paidCount', v_col.paid_count,
      'totalCount', v_col.total_count
    ),
    'refunds', json_build_object(
      'count', v_ref.refund_count,
      'total', v_ref.refund_total
    )
  ));
END;
$$;
