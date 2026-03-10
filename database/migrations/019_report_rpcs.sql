-- Migration 019: Report RPCs for PWA (Supabase RPC-only)
-- Ports all REST API report endpoints to PostgreSQL functions

-- ==================== HELPER: Date Range ====================
CREATE OR REPLACE FUNCTION get_date_range(p_period TEXT, p_from TEXT DEFAULT NULL, p_to TEXT DEFAULT NULL)
RETURNS TABLE(range_from TIMESTAMPTZ, range_to TIMESTAMPTZ) LANGUAGE plpgsql STABLE AS $$
BEGIN
  range_to := COALESCE(p_to::TIMESTAMPTZ, NOW());
  CASE p_period
    WHEN 'today' THEN range_from := DATE_TRUNC('day', NOW());
    WHEN 'yesterday' THEN range_from := DATE_TRUNC('day', NOW()) - INTERVAL '1 day'; range_to := DATE_TRUNC('day', NOW());
    WHEN 'week' THEN range_from := NOW() - INTERVAL '7 days';
    WHEN 'month' THEN range_from := DATE_TRUNC('month', NOW());
    WHEN 'quarter' THEN range_from := DATE_TRUNC('quarter', NOW());
    WHEN 'year' THEN range_from := DATE_TRUNC('year', NOW());
    WHEN 'custom' THEN range_from := COALESCE(p_from::TIMESTAMPTZ, DATE_TRUNC('month', NOW()));
    ELSE range_from := DATE_TRUNC('month', NOW());
  END CASE;
  RETURN NEXT;
END;
$$;

-- ==================== 1. EXECUTIVE SUMMARY ====================
CREATE OR REPLACE FUNCTION report_executive_summary(p_token TEXT)
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
  v_user_id := require_role(p_token, ARRAY['admin', 'super_admin']);

  SELECT
    COALESCE(SUM(CASE WHEN created_at >= DATE_TRUNC('month', CURRENT_DATE) THEN total_amount END), 0) AS current_month,
    COALESCE(SUM(CASE WHEN created_at >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
        AND created_at < DATE_TRUNC('month', CURRENT_DATE) THEN total_amount END), 0) AS previous_month
  INTO v_rev FROM payments WHERE status = 'paid';

  SELECT
    COUNT(*) FILTER (WHERE activated_at >= DATE_TRUNC('month', CURRENT_DATE)) AS new_this_month,
    COUNT(*) FILTER (WHERE activated_at >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
        AND activated_at < DATE_TRUNC('month', CURRENT_DATE)) AS new_last_month,
    COUNT(*) FILTER (WHERE cancelled_at >= DATE_TRUNC('month', CURRENT_DATE)) AS cancelled_this_month,
    COUNT(*) FILTER (WHERE status = 'active') AS total_active
  INTO v_sub FROM subscriptions;

  SELECT
    COUNT(*) FILTER (WHERE entry_time >= DATE_TRUNC('month', CURRENT_DATE)) AS sessions_this_month,
    COALESCE(AVG(duration_minutes) FILTER (WHERE exit_time IS NOT NULL AND entry_time >= DATE_TRUNC('month', CURRENT_DATE)), 0) AS avg_duration_min,
    COALESCE(SUM(paid_amount) FILTER (WHERE payment_status = 'paid' AND entry_time >= DATE_TRUNC('month', CURRENT_DATE)), 0) AS hourly_revenue
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
      'hourlyRevenue', v_sess.hourly_revenue
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

-- ==================== 2. REVENUE REPORT ====================
CREATE OR REPLACE FUNCTION report_revenue(p_token TEXT, p_period TEXT DEFAULT 'month', p_from TEXT DEFAULT NULL, p_to TEXT DEFAULT NULL, p_group_by TEXT DEFAULT 'day')
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id UUID;
  v_range RECORD;
  v_trunc TEXT;
  v_totals RECORD;
  v_timeline JSON;
  v_by_method JSON;
  v_by_plan JSON;
BEGIN
  v_user_id := require_role(p_token, ARRAY['admin', 'super_admin']);
  SELECT * INTO v_range FROM get_date_range(p_period, p_from, p_to);
  v_trunc := CASE WHEN p_group_by IN ('hour','day','week','month','year') THEN p_group_by ELSE 'day' END;

  -- Totals
  SELECT
    COUNT(*) AS transactions,
    COALESCE(SUM(total_amount), 0) AS gross_revenue,
    COALESCE(SUM(amount), 0) AS net_revenue,
    COALESCE(SUM(tax_amount), 0) AS total_tax,
    COALESCE(AVG(total_amount), 0) AS avg_ticket
  INTO v_totals FROM payments
  WHERE status = 'paid' AND created_at >= v_range.range_from AND created_at <= v_range.range_to;

  -- Timeline
  SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_timeline FROM (
    SELECT DATE_TRUNC(v_trunc, created_at) AS period, COUNT(*) AS count,
      COALESCE(SUM(total_amount), 0) AS total, COALESCE(SUM(amount), 0) AS subtotal, COALESCE(SUM(tax_amount), 0) AS tax
    FROM payments WHERE status = 'paid' AND created_at >= v_range.range_from AND created_at <= v_range.range_to
    GROUP BY DATE_TRUNC(v_trunc, created_at) ORDER BY period ASC
  ) t;

  -- By method
  SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_by_method FROM (
    SELECT COALESCE(payment_method, 'unknown') AS method, COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS total
    FROM payments WHERE status = 'paid' AND created_at >= v_range.range_from AND created_at <= v_range.range_to
    GROUP BY payment_method ORDER BY total DESC
  ) t;

  -- By plan
  SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_by_plan FROM (
    SELECT COALESCE(p.name, 'Parqueo por hora') AS "planName", COALESCE(p.type, 'hourly') AS "planType",
      COUNT(*) AS count, COALESCE(SUM(pay.total_amount), 0) AS total
    FROM payments pay
    LEFT JOIN subscriptions s ON pay.subscription_id = s.id
    LEFT JOIN plans p ON s.plan_id = p.id
    WHERE pay.status = 'paid' AND pay.created_at >= v_range.range_from AND pay.created_at <= v_range.range_to
    GROUP BY p.name, p.type ORDER BY total DESC
  ) t;

  RETURN json_build_object('success', true, 'data', json_build_object(
    'totals', json_build_object(
      'transactions', v_totals.transactions,
      'grossRevenue', v_totals.gross_revenue,
      'netRevenue', v_totals.net_revenue,
      'totalTax', v_totals.total_tax,
      'avgTicket', ROUND(v_totals.avg_ticket::NUMERIC, 2)
    ),
    'timeline', v_timeline,
    'byMethod', v_by_method,
    'byPlan', v_by_plan
  ));
END;
$$;

-- ==================== 2b. REVENUE BY OPERATOR ====================
CREATE OR REPLACE FUNCTION report_revenue_by_operator(p_token TEXT, p_period TEXT DEFAULT 'month', p_from TEXT DEFAULT NULL, p_to TEXT DEFAULT NULL)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id UUID;
  v_range RECORD;
  v_operators JSON;
BEGIN
  v_user_id := require_role(p_token, ARRAY['admin', 'super_admin']);
  SELECT * INTO v_range FROM get_date_range(p_period, p_from, p_to);

  SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_operators FROM (
    SELECT
      u.id AS "operatorId", u.email AS "operatorEmail",
      COALESCE(c.first_name || ' ' || c.last_name, u.email) AS "operatorName",
      COUNT(crt.id) AS "transactionCount",
      COALESCE(SUM(CASE WHEN crt.direction = 'in' THEN crt.amount ELSE 0 END), 0) AS "totalIncome",
      COALESCE(SUM(CASE WHEN crt.direction = 'out' THEN crt.amount ELSE 0 END), 0) AS "totalExpenses",
      COALESCE(SUM(CASE WHEN crt.direction = 'in' THEN crt.amount ELSE 0 END), 0) - COALESCE(SUM(CASE WHEN crt.direction = 'out' THEN crt.amount ELSE 0 END), 0) AS "netIncome",
      COUNT(DISTINCT cr.id) AS "shiftsCount",
      ROUND(COALESCE(AVG(CASE WHEN crt.direction = 'in' THEN crt.amount END), 0)::NUMERIC, 2) AS "avgTransaction"
    FROM cash_register_transactions crt
    JOIN cash_registers cr ON crt.cash_register_id = cr.id
    JOIN users u ON cr.operator_id = u.id
    LEFT JOIN customers c ON c.user_id = u.id
    WHERE crt.created_at >= v_range.range_from AND crt.created_at <= v_range.range_to
    GROUP BY u.id, u.email, c.first_name, c.last_name
    ORDER BY "totalIncome" DESC
  ) t;

  RETURN json_build_object('success', true, 'data', json_build_object('operators', v_operators));
END;
$$;

-- ==================== 3. CASH RECONCILIATION ====================
CREATE OR REPLACE FUNCTION report_cash_reconciliation(p_token TEXT, p_period TEXT DEFAULT 'month', p_from TEXT DEFAULT NULL, p_to TEXT DEFAULT NULL)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id UUID;
  v_range RECORD;
  v_summary RECORD;
  v_closures JSON;
  v_by_operator JSON;
BEGIN
  v_user_id := require_role(p_token, ARRAY['admin', 'super_admin']);
  SELECT * INTO v_range FROM get_date_range(p_period, p_from, p_to);

  -- Summary
  SELECT
    COUNT(*) AS total_closures,
    COALESCE(SUM(expected_balance), 0) AS total_expected,
    COALESCE(SUM(counted_balance), 0) AS total_counted,
    COALESCE(SUM(difference), 0) AS net_difference,
    COALESCE(SUM(ABS(difference)), 0) AS abs_difference,
    ROUND(COALESCE(AVG(ABS(difference)), 0)::NUMERIC, 2) AS avg_difference,
    COALESCE(MAX(ABS(difference)), 0) AS max_difference,
    COUNT(*) FILTER (WHERE difference > 0) AS surplus_count,
    COUNT(*) FILTER (WHERE difference < 0) AS shortage_count,
    COUNT(*) FILTER (WHERE difference = 0) AS exact_count,
    COUNT(*) FILTER (WHERE requires_approval = true) AS flagged_count,
    COUNT(*) FILTER (WHERE approved_by IS NOT NULL) AS approved_count
  INTO v_summary FROM cash_registers
  WHERE status = 'closed' AND closed_at >= v_range.range_from AND closed_at <= v_range.range_to;

  -- Closures detail
  SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_closures FROM (
    SELECT
      cr.id,
      cr.name AS "registerName",
      COALESCE(c_op.first_name || ' ' || c_op.last_name, u_op.email) AS "operatorName",
      cr.opened_at AS "openedAt", cr.closed_at AS "closedAt",
      cr.opening_balance AS "openingBalance",
      cr.expected_balance AS "expectedBalance",
      cr.counted_balance AS "countedBalance",
      cr.difference,
      cr.requires_approval AS "requiresApproval",
      (cr.approved_by IS NOT NULL) AS "isApproved",
      (SELECT COUNT(*) FROM cash_register_transactions t WHERE t.cash_register_id = cr.id AND t.type = 'payment') AS "paymentCount",
      (SELECT COUNT(*) FROM cash_register_transactions t WHERE t.cash_register_id = cr.id AND t.type = 'refund') AS "refundCount"
    FROM cash_registers cr
    JOIN users u_op ON cr.operator_id = u_op.id
    LEFT JOIN customers c_op ON c_op.user_id = u_op.id
    WHERE cr.status = 'closed' AND cr.closed_at >= v_range.range_from AND cr.closed_at <= v_range.range_to
    ORDER BY cr.closed_at DESC
  ) t;

  -- By operator
  SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_by_operator FROM (
    SELECT
      COALESCE(c.first_name || ' ' || c.last_name, u.email) AS "operatorName",
      COUNT(*) AS closures,
      COALESCE(SUM(ABS(cr.difference)), 0) AS "totalAbsDiff",
      ROUND(COALESCE(AVG(ABS(cr.difference)), 0)::NUMERIC, 2) AS "avgDiff",
      COUNT(*) FILTER (WHERE cr.difference = 0) AS "exactClosures",
      COUNT(*) FILTER (WHERE cr.requires_approval = true) AS "flaggedClosures"
    FROM cash_registers cr
    JOIN users u ON cr.operator_id = u.id
    LEFT JOIN customers c ON c.user_id = u.id
    WHERE cr.status = 'closed' AND cr.closed_at >= v_range.range_from AND cr.closed_at <= v_range.range_to
    GROUP BY u.id, u.email, c.first_name, c.last_name
    ORDER BY "totalAbsDiff" DESC
  ) t;

  RETURN json_build_object('success', true, 'data', json_build_object(
    'summary', json_build_object(
      'totalClosures', v_summary.total_closures,
      'totalExpected', v_summary.total_expected,
      'totalCounted', v_summary.total_counted,
      'netDifference', v_summary.net_difference,
      'absDifference', v_summary.abs_difference,
      'avgDifference', v_summary.avg_difference,
      'maxDifference', v_summary.max_difference,
      'surplusCount', v_summary.surplus_count,
      'shortageCount', v_summary.shortage_count,
      'exactCount', v_summary.exact_count,
      'flaggedCount', v_summary.flagged_count,
      'approvedCount', v_summary.approved_count
    ),
    'closures', v_closures,
    'byOperator', v_by_operator
  ));
END;
$$;

-- ==================== 4. CUSTOMERS REPORT ====================
CREATE OR REPLACE FUNCTION report_customers(p_token TEXT, p_period TEXT DEFAULT 'month', p_from TEXT DEFAULT NULL, p_to TEXT DEFAULT NULL)
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
  v_user_id := require_role(p_token, ARRAY['admin', 'super_admin']);
  SELECT * INTO v_range FROM get_date_range(p_period, p_from, p_to);

  -- New customers trend
  SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_new_trend FROM (
    SELECT DATE_TRUNC('week', c.created_at) AS period, COUNT(*) AS count
    FROM customers c WHERE c.created_at >= v_range.range_from AND c.created_at <= v_range.range_to
    GROUP BY DATE_TRUNC('week', c.created_at) ORDER BY period ASC
  ) t;

  -- Status distribution
  SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_status_dist FROM (
    SELECT status, COUNT(*) AS count FROM subscriptions GROUP BY status ORDER BY count DESC
  ) t;

  -- Top customers
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
    HAVING COALESCE(SUM(p.total_amount), 0) > 0
    ORDER BY "totalPaid" DESC LIMIT 20
  ) t;

  -- Delinquent
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

  -- Churn trend
  SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_churn_trend FROM (
    SELECT DATE_TRUNC('week', cancelled_at) AS period, COUNT(*) AS count
    FROM subscriptions WHERE cancelled_at >= v_range.range_from AND cancelled_at <= v_range.range_to
    GROUP BY DATE_TRUNC('week', cancelled_at) ORDER BY period ASC
  ) t;

  -- Retention rate
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

-- ==================== 5. OCCUPANCY REPORT ====================
CREATE OR REPLACE FUNCTION report_occupancy(p_token TEXT, p_period TEXT DEFAULT 'week', p_from TEXT DEFAULT NULL, p_to TEXT DEFAULT NULL)
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
BEGIN
  v_user_id := require_role(p_token, ARRAY['admin', 'super_admin']);
  SELECT * INTO v_range FROM get_date_range(p_period, p_from, p_to);

  -- Peak hours
  SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_peak_hours FROM (
    SELECT
      EXTRACT(HOUR FROM timestamp)::INT AS hour,
      LPAD(EXTRACT(HOUR FROM timestamp)::INT::TEXT, 2, '0') || ':00' AS label,
      COUNT(*) AS "entryCount"
    FROM access_events
    WHERE type = 'entry' AND timestamp >= v_range.range_from AND timestamp <= v_range.range_to
    GROUP BY EXTRACT(HOUR FROM timestamp) ORDER BY hour ASC
  ) t;

  -- Peak days
  SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_peak_days FROM (
    SELECT
      EXTRACT(DOW FROM timestamp)::INT AS "dayOfWeek",
      COUNT(*) AS "entryCount"
    FROM access_events
    WHERE type = 'entry' AND timestamp >= v_range.range_from AND timestamp <= v_range.range_to
    GROUP BY EXTRACT(DOW FROM timestamp) ORDER BY "dayOfWeek" ASC
  ) t;

  -- Daily trend
  SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_daily_trend FROM (
    SELECT
      DATE_TRUNC('day', ae.timestamp)::date AS date,
      COUNT(*) FILTER (WHERE ae.type = 'entry') AS entries,
      COUNT(*) FILTER (WHERE ae.type = 'exit') AS exits,
      COUNT(*) FILTER (WHERE ae.type = 'entry') - COUNT(*) FILTER (WHERE ae.type = 'exit') AS net
    FROM access_events ae
    WHERE ae.timestamp >= v_range.range_from AND ae.timestamp <= v_range.range_to
    GROUP BY DATE_TRUNC('day', ae.timestamp)::date ORDER BY date ASC
  ) t;

  -- Average duration by plan
  SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_avg_duration FROM (
    SELECT
      COALESCE(p.name, 'Parqueo por hora') AS "planName",
      COUNT(*) AS "sessionCount",
      ROUND(COALESCE(AVG(ps.duration_minutes), 0)) AS "avgMinutes",
      COALESCE(MIN(ps.duration_minutes), 0) AS "minMinutes",
      COALESCE(MAX(ps.duration_minutes), 0) AS "maxMinutes"
    FROM parking_sessions ps
    LEFT JOIN plans p ON ps.plan_id = p.id
    WHERE ps.exit_time IS NOT NULL AND ps.entry_time >= v_range.range_from AND ps.entry_time <= v_range.range_to
    GROUP BY p.name ORDER BY "sessionCount" DESC
  ) t;

  -- Access methods
  SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_access_methods FROM (
    SELECT
      COALESCE(access_method, validation_method, 'unknown') AS method,
      COUNT(*) AS count,
      COUNT(*) FILTER (WHERE type = 'entry') AS entries,
      COUNT(*) FILTER (WHERE type = 'exit') AS exits
    FROM access_events
    WHERE timestamp >= v_range.range_from AND timestamp <= v_range.range_to
    GROUP BY COALESCE(access_method, validation_method, 'unknown') ORDER BY count DESC
  ) t;

  -- Add dayName to peak days
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

-- ==================== 6. SESSIONS REPORT ====================
CREATE OR REPLACE FUNCTION report_sessions(p_token TEXT, p_period TEXT DEFAULT 'month', p_from TEXT DEFAULT NULL, p_to TEXT DEFAULT NULL)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id UUID;
  v_range RECORD;
  v_summary RECORD;
  v_timeline JSON;
  v_by_access JSON;
  v_duration_dist JSON;
BEGIN
  v_user_id := require_role(p_token, ARRAY['admin', 'super_admin']);
  SELECT * INTO v_range FROM get_date_range(p_period, p_from, p_to);

  -- Summary
  SELECT
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE status = 'active') AS active,
    COUNT(*) FILTER (WHERE status = 'paid') AS paid,
    COUNT(*) FILTER (WHERE status = 'closed') AS closed,
    COUNT(*) FILTER (WHERE status = 'abandoned') AS abandoned,
    COALESCE(SUM(paid_amount) FILTER (WHERE payment_status = 'paid'), 0) AS total_revenue,
    ROUND(COALESCE(AVG(duration_minutes) FILTER (WHERE exit_time IS NOT NULL), 0)) AS avg_duration,
    ROUND(COALESCE(AVG(paid_amount) FILTER (WHERE payment_status = 'paid'), 0)::NUMERIC, 2) AS avg_ticket
  INTO v_summary FROM parking_sessions
  WHERE entry_time >= v_range.range_from AND entry_time <= v_range.range_to;

  -- Timeline
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

  -- By access method
  SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_by_access FROM (
    SELECT
      COALESCE(access_method::text, 'qr') AS method,
      COUNT(*) AS count,
      COALESCE(SUM(paid_amount) FILTER (WHERE payment_status = 'paid'), 0) AS revenue
    FROM parking_sessions
    WHERE entry_time >= v_range.range_from AND entry_time <= v_range.range_to
    GROUP BY access_method ORDER BY count DESC
  ) t;

  -- Duration distribution
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
    'durationDistribution', v_duration_dist
  ));
END;
$$;

-- ==================== 7. INVOICES REPORT ====================
CREATE OR REPLACE FUNCTION report_invoices(p_token TEXT, p_period TEXT DEFAULT 'month', p_from TEXT DEFAULT NULL, p_to TEXT DEFAULT NULL)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id UUID;
  v_range RECORD;
  v_summary RECORD;
  v_by_ncf JSON;
  v_timeline JSON;
BEGIN
  v_user_id := require_role(p_token, ARRAY['admin', 'super_admin']);
  SELECT * INTO v_range FROM get_date_range(p_period, p_from, p_to);

  -- Summary
  SELECT
    COUNT(*) AS total_invoices,
    COALESCE(SUM(total), 0) AS total_amount,
    COALESCE(SUM(subtotal), 0) AS total_subtotal,
    COALESCE(SUM(tax_amount), 0) AS total_tax,
    COUNT(DISTINCT customer_id) AS unique_customers
  INTO v_summary FROM invoices
  WHERE created_at >= v_range.range_from AND created_at <= v_range.range_to;

  -- By NCF type
  SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_by_ncf FROM (
    SELECT
      CASE
        WHEN ncf LIKE 'B01%' THEN 'Consumidor Final (B01)'
        WHEN ncf LIKE 'B14%' THEN 'Credito Fiscal (B14)'
        WHEN ncf LIKE 'B04%' THEN 'Nota de Credito (B04)'
        ELSE 'Sin NCF'
      END AS type,
      COUNT(*) AS count,
      COALESCE(SUM(total), 0) AS total
    FROM invoices
    WHERE created_at >= v_range.range_from AND created_at <= v_range.range_to
    GROUP BY type ORDER BY count DESC
  ) t;

  -- Timeline
  SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_timeline FROM (
    SELECT DATE_TRUNC('day', created_at)::date AS date, COUNT(*) AS count, COALESCE(SUM(total), 0) AS total
    FROM invoices WHERE created_at >= v_range.range_from AND created_at <= v_range.range_to
    GROUP BY DATE_TRUNC('day', created_at)::date ORDER BY date ASC
  ) t;

  RETURN json_build_object('success', true, 'data', json_build_object(
    'summary', json_build_object(
      'totalInvoices', v_summary.total_invoices,
      'totalAmount', v_summary.total_amount,
      'totalSubtotal', v_summary.total_subtotal,
      'totalTax', v_summary.total_tax,
      'uniqueCustomers', v_summary.unique_customers
    ),
    'byNCFType', v_by_ncf,
    'timeline', v_timeline
  ));
END;
$$;

-- ==================== 8. CSV EXPORT ====================
CREATE OR REPLACE FUNCTION report_export_csv(p_token TEXT, p_type TEXT, p_period TEXT DEFAULT 'month', p_from TEXT DEFAULT NULL, p_to TEXT DEFAULT NULL)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id UUID;
  v_range RECORD;
  v_rows JSON;
  v_headers JSON;
  v_filename TEXT;
BEGIN
  v_user_id := require_role(p_token, ARRAY['admin', 'super_admin']);
  SELECT * INTO v_range FROM get_date_range(p_period, p_from, p_to);

  CASE p_type
    WHEN 'payments' THEN
      v_headers := '["fecha","cliente","monto","metodo_pago","estado","plan"]'::JSON;
      v_filename := 'pagos';
      SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_rows FROM (
        SELECT p.created_at AS fecha,
          COALESCE(c.first_name || ' ' || c.last_name, 'N/A') AS cliente,
          p.total_amount AS monto, p.payment_method AS metodo_pago, p.status AS estado,
          COALESCE(pl.name, 'Parqueo por hora') AS plan
        FROM payments p
        LEFT JOIN customers c ON p.customer_id = c.id
        LEFT JOIN subscriptions s ON p.subscription_id = s.id
        LEFT JOIN plans pl ON s.plan_id = pl.id
        WHERE p.created_at >= v_range.range_from AND p.created_at <= v_range.range_to
        ORDER BY p.created_at DESC
      ) t;
    WHEN 'cash-registers' THEN
      v_headers := '["fecha_cierre","operador","saldo_apertura","saldo_esperado","saldo_contado","diferencia","requiere_aprobacion"]'::JSON;
      v_filename := 'cuadre_caja';
      SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_rows FROM (
        SELECT cr.closed_at AS fecha_cierre,
          COALESCE(co.first_name || ' ' || co.last_name, u.email) AS operador,
          cr.opening_balance AS saldo_apertura, cr.expected_balance AS saldo_esperado,
          cr.counted_balance AS saldo_contado, cr.difference AS diferencia,
          CASE WHEN cr.requires_approval THEN 'Si' ELSE 'No' END AS requiere_aprobacion
        FROM cash_registers cr JOIN users u ON cr.operator_id = u.id
        LEFT JOIN customers co ON co.user_id = u.id
        WHERE cr.status = 'closed' AND cr.closed_at >= v_range.range_from AND cr.closed_at <= v_range.range_to
        ORDER BY cr.closed_at DESC
      ) t;
    WHEN 'sessions' THEN
      v_headers := '["entrada","salida","placa","plan","duracion_min","monto_pagado","estado","metodo_acceso"]'::JSON;
      v_filename := 'sesiones_parqueo';
      SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_rows FROM (
        SELECT ps.entry_time AS entrada, ps.exit_time AS salida, ps.vehicle_plate AS placa,
          COALESCE(p.name, 'N/A') AS plan, ps.duration_minutes AS duracion_min,
          COALESCE(ps.paid_amount, 0) AS monto_pagado, ps.status AS estado,
          COALESCE(ps.access_method::text, 'qr') AS metodo_acceso
        FROM parking_sessions ps LEFT JOIN plans p ON ps.plan_id = p.id
        WHERE ps.entry_time >= v_range.range_from AND ps.entry_time <= v_range.range_to
        ORDER BY ps.entry_time DESC
      ) t;
    WHEN 'customers' THEN
      v_headers := '["nombre","documento","email","telefono","fecha_registro","suscripciones_activas","total_pagado"]'::JSON;
      v_filename := 'clientes';
      SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_rows FROM (
        SELECT c.first_name || ' ' || c.last_name AS nombre, c.id_document AS documento,
          u.email, u.phone AS telefono, c.created_at AS fecha_registro,
          COUNT(DISTINCT s.id) AS suscripciones_activas,
          COALESCE(SUM(p.total_amount), 0) AS total_pagado
        FROM customers c JOIN users u ON c.user_id = u.id
        LEFT JOIN subscriptions s ON s.customer_id = c.id AND s.status = 'active'
        LEFT JOIN payments p ON p.customer_id = c.id AND p.status = 'paid'
        GROUP BY c.id, c.first_name, c.last_name, c.id_document, u.email, u.phone, c.created_at
        ORDER BY total_pagado DESC
      ) t;
    ELSE
      RETURN json_build_object('success', false, 'error', 'Tipo de reporte no valido');
  END CASE;

  RETURN json_build_object('success', true, 'data', json_build_object(
    'headers', v_headers,
    'rows', v_rows,
    'filename', v_filename
  ));
END;
$$;
