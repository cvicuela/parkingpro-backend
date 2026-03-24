-- Migration 049: Fix executive summary to return all fields the frontend expects
-- Missing: subscriptions, collection, cashRegisters sections
-- Mismatched keys: sessions.totalThisMonth, sessions.avgDurationMinutes

DROP FUNCTION IF EXISTS public.report_executive_summary(text, text, text, text);

CREATE OR REPLACE FUNCTION public.report_executive_summary(
  p_token TEXT,
  p_period TEXT DEFAULT 'month',
  p_from TEXT DEFAULT NULL,
  p_to TEXT DEFAULT NULL
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_user_id UUID;
  v_range RECORD;
  v_rev RECORD;
  v_ref RECORD;
  v_sess RECORD;
  v_subs RECORD;
  v_col RECORD;
  v_cash RECORD;
  v_change DECIMAL;
  v_prev_rev DECIMAL;
  v_period_len INTERVAL;
BEGIN
  SELECT r.user_id INTO v_user_id
  FROM require_role(p_token, ARRAY['admin', 'super_admin']) r;

  -- Date range
  SELECT * INTO v_range FROM get_date_range(p_period, p_from, p_to);

  -- Revenue
  SELECT
    COALESCE(SUM(total_amount), 0) AS current_period,
    COALESCE(SUM(CASE WHEN subscription_id IS NOT NULL THEN total_amount ELSE 0 END), 0) AS subscription_revenue,
    COALESCE(SUM(CASE WHEN subscription_id IS NULL THEN total_amount ELSE 0 END), 0) AS hourly_revenue
  INTO v_rev
  FROM payments
  WHERE status IN ('paid', 'refunded')
    AND created_at >= v_range.range_from
    AND created_at <= COALESCE(v_range.range_to, NOW());

  -- Previous period comparison
  v_period_len := COALESCE(v_range.range_to, NOW()) - v_range.range_from;
  SELECT COALESCE(SUM(total_amount), 0) INTO v_prev_rev
  FROM payments
  WHERE status IN ('paid', 'refunded')
    AND created_at >= (v_range.range_from - v_period_len)
    AND created_at < v_range.range_from;

  IF v_prev_rev > 0 THEN
    v_change := ROUND(((v_rev.current_period - v_prev_rev) / v_prev_rev * 100)::NUMERIC, 1);
  ELSE
    v_change := 0;
  END IF;

  -- Refunds
  SELECT
    COALESCE(SUM(total_amount), 0) AS refund_total,
    COUNT(*) AS refund_count
  INTO v_ref
  FROM payments
  WHERE status = 'refunded'
    AND created_at >= v_range.range_from
    AND created_at <= COALESCE(v_range.range_to, NOW());

  -- Sessions
  SELECT
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE status = 'active') AS active,
    COUNT(*) FILTER (WHERE status IN ('paid', 'closed')) AS completed,
    COALESCE(ROUND(AVG(duration_minutes) FILTER (WHERE duration_minutes > 0)), 0) AS avg_duration,
    COALESCE(SUM(CASE WHEN subscription_id IS NULL THEN paid_amount ELSE 0 END), 0) AS hourly_revenue
  INTO v_sess
  FROM parking_sessions
  WHERE entry_time >= v_range.range_from
    AND entry_time <= COALESCE(v_range.range_to, NOW());

  -- Subscriptions
  SELECT
    COUNT(*) FILTER (WHERE status = 'active') AS total_active,
    COUNT(*) FILTER (WHERE status = 'active' AND activated_at >= v_range.range_from) AS new_this_month,
    COUNT(*) FILTER (WHERE status = 'cancelled' AND cancelled_at >= v_range.range_from) AS cancelled_this_month
  INTO v_subs
  FROM subscriptions;

  -- Collection rate (paid vs total payments in period)
  SELECT
    COUNT(*) AS total_count,
    COUNT(*) FILTER (WHERE status = 'paid') AS paid_count,
    CASE WHEN COUNT(*) > 0
      THEN ROUND((COUNT(*) FILTER (WHERE status = 'paid'))::NUMERIC / COUNT(*)::NUMERIC * 100, 1)
      ELSE 0
    END AS rate
  INTO v_col
  FROM payments
  WHERE created_at >= v_range.range_from
    AND created_at <= COALESCE(v_range.range_to, NOW());

  -- Cash registers
  SELECT
    COUNT(*) FILTER (WHERE status = 'closed') AS total_closures,
    COUNT(*) FILTER (WHERE status = 'closed' AND requires_approval = true AND approved_by IS NULL) AS requiring_approval
  INTO v_cash
  FROM cash_registers
  WHERE created_at >= v_range.range_from
    AND created_at <= COALESCE(v_range.range_to, NOW());

  RETURN json_build_object(
    'success', true,
    'data', json_build_object(
      'revenue', json_build_object(
        'currentMonth', v_rev.current_period,
        'subscriptionRevenue', v_rev.subscription_revenue,
        'hourlyRevenue', v_rev.hourly_revenue,
        'changePercent', v_change,
        'trend', CASE WHEN v_change >= 0 THEN 'up' ELSE 'down' END
      ),
      'subscriptions', json_build_object(
        'totalActive', v_subs.total_active,
        'newThisMonth', v_subs.new_this_month,
        'cancelledThisMonth', v_subs.cancelled_this_month
      ),
      'collection', json_build_object(
        'rate', v_col.rate,
        'paidCount', v_col.paid_count,
        'totalCount', v_col.total_count
      ),
      'sessions', json_build_object(
        'totalThisMonth', v_sess.total,
        'active', v_sess.active,
        'completed', v_sess.completed,
        'avgDurationMinutes', v_sess.avg_duration,
        'hourlyRevenue', v_sess.hourly_revenue
      ),
      'cashRegisters', json_build_object(
        'totalClosures', v_cash.total_closures,
        'requiringApproval', v_cash.requiring_approval
      ),
      'refunds', json_build_object(
        'total', v_ref.refund_total,
        'count', v_ref.refund_count
      ),
      'customers', json_build_object(
        'new', 0,
        'total', 0
      )
    )
  );
END;
$$;
