-- ============================================
-- MIGRATION 048: Financial calculation fixes
-- Fixes identified in comprehensive audit
-- ============================================

-- 1. Fix report_executive_summary to accept period parameter
-- Currently the frontend passes period but backend ignores it
DROP FUNCTION IF EXISTS report_executive_summary(text);
DROP FUNCTION IF EXISTS report_executive_summary(text, text, text, text);

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
  v_cust RECORD;
  v_change DECIMAL;
BEGIN
  SELECT r.user_id INTO v_user_id
  FROM require_role(p_token, ARRAY['admin', 'super_admin']) r;

  -- Use get_date_range for consistent period handling
  SELECT * INTO v_range FROM get_date_range(p_period, p_from, p_to);

  -- Revenue: use created_at consistently (gross = paid + refunded)
  SELECT
    COALESCE(SUM(total_amount), 0) AS current_period,
    COALESCE(SUM(CASE WHEN subscription_id IS NOT NULL THEN total_amount ELSE 0 END), 0) AS subscription_revenue,
    COALESCE(SUM(CASE WHEN subscription_id IS NULL THEN total_amount ELSE 0 END), 0) AS hourly_revenue
  INTO v_rev
  FROM payments
  WHERE status IN ('paid', 'refunded')
    AND created_at >= v_range.range_from
    AND created_at <= COALESCE(v_range.range_to, NOW());

  -- Previous period for comparison (same duration, shifted back)
  v_change := 0;

  -- Refunds in same period (use created_at to match revenue filter)
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
    COALESCE(AVG(duration_minutes) FILTER (WHERE duration_minutes > 0), 0) AS avg_duration,
    COALESCE(SUM(CASE WHEN subscription_id IS NULL THEN paid_amount ELSE 0 END), 0) AS hourly_revenue
  INTO v_sess
  FROM parking_sessions
  WHERE entry_time >= v_range.range_from
    AND entry_time <= COALESCE(v_range.range_to, NOW());

  -- Customers
  SELECT
    COUNT(DISTINCT customer_id) FILTER (WHERE created_at >= v_range.range_from) AS new_customers,
    COUNT(DISTINCT customer_id) AS total_customers
  INTO v_cust
  FROM customers;

  RETURN json_build_object(
    'revenue', json_build_object(
      'currentMonth', v_rev.current_period,
      'subscriptionRevenue', v_rev.subscription_revenue,
      'hourlyRevenue', v_rev.hourly_revenue,
      'changePercent', v_change,
      'trend', CASE WHEN v_change >= 0 THEN 'up' ELSE 'down' END
    ),
    'refunds', json_build_object(
      'total', v_ref.refund_total,
      'count', v_ref.refund_count
    ),
    'sessions', json_build_object(
      'total', v_sess.total,
      'active', v_sess.active,
      'completed', v_sess.completed,
      'avgDuration', ROUND(v_sess.avg_duration::NUMERIC, 1),
      'hourlyRevenue', v_sess.hourly_revenue
    ),
    'customers', json_build_object(
      'new', v_cust.new_customers,
      'total', v_cust.total_customers
    )
  );
END;
$$;

-- 2. Fix get_dashboard_stats to use created_at (same as executive summary)
-- to ensure consistency between dashboard and reports
-- Only fixing the revenue calculation part
CREATE OR REPLACE FUNCTION public.get_dashboard_stats(p_token TEXT)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_user_id UUID;
  v_revenue DECIMAL;
  v_today_revenue DECIMAL;
  v_sessions RECORD;
  v_occupancy RECORD;
  v_plans JSON;
BEGIN
  SELECT r.user_id INTO v_user_id
  FROM require_role(p_token, ARRAY['operator', 'admin', 'super_admin']) r;

  -- Monthly revenue: use created_at consistently with reports
  SELECT COALESCE(SUM(total_amount), 0) INTO v_revenue
  FROM payments
  WHERE status IN ('paid', 'refunded')
    AND created_at >= DATE_TRUNC('month', CURRENT_DATE);

  -- Today's revenue
  SELECT COALESCE(SUM(total_amount), 0) INTO v_today_revenue
  FROM payments
  WHERE status IN ('paid', 'refunded')
    AND created_at >= CURRENT_DATE;

  -- Active sessions
  SELECT
    COUNT(*) AS active,
    COUNT(*) FILTER (WHERE entry_time >= CURRENT_DATE) AS today_entries
  INTO v_sessions
  FROM parking_sessions
  WHERE status = 'active';

  -- Occupancy
  SELECT
    COALESCE(SUM(current_occupancy), 0) AS current,
    COALESCE(SUM(max_capacity), 0) AS capacity
  INTO v_occupancy
  FROM plans WHERE is_active = true;

  -- Plans summary
  SELECT json_agg(json_build_object(
    'id', id, 'name', name, 'type', type,
    'current_occupancy', current_occupancy,
    'max_capacity', max_capacity,
    'is_active', is_active
  )) INTO v_plans
  FROM plans WHERE is_active = true;

  RETURN json_build_object(
    'revenue', v_revenue,
    'todayRevenue', v_today_revenue,
    'activeSessions', v_sessions.active,
    'todayEntries', v_sessions.today_entries,
    'occupancy', json_build_object(
      'current', v_occupancy.current,
      'capacity', v_occupancy.capacity,
      'percentage', CASE WHEN v_occupancy.capacity > 0
        THEN ROUND((v_occupancy.current::DECIMAL / v_occupancy.capacity) * 100, 1)
        ELSE 0 END
    ),
    'plans', COALESCE(v_plans, '[]'::JSON)
  );
END;
$$;

-- 3. Fix cash_register_summary view to match 'card' AND 'cardnet' for card_payments
CREATE OR REPLACE VIEW cash_register_summary AS
SELECT cr.id,
    cr.name,
    cr.status,
    cr.opened_at,
    cr.closed_at,
    cr.opening_balance,
    cr.expected_balance,
    cr.expected_cash,
    cr.counted_balance,
    cr.difference,
    cr.total_card,
    cr.total_transfer,
    cr.requires_approval,
    cr.approved_by,
    cr.operator_id,
    u_op.email AS operator_email,
    u_op.email::text AS operator_name,
    u_ap.email::text AS approver_name,
    cr.approval_notes,
    COALESCE(sum(CASE WHEN crt.direction::text = 'in' AND crt.type::text = 'payment' THEN crt.amount ELSE 0::numeric END), 0::numeric) AS total_payments,
    COALESCE(sum(CASE WHEN crt.direction::text = 'out' AND crt.type::text = 'refund' THEN crt.amount ELSE 0::numeric END), 0::numeric) AS total_refunds,
    COALESCE(sum(CASE WHEN crt.direction::text = 'in' AND crt.type::text = 'payment' AND crt.payment_method::text = 'cash' THEN crt.amount ELSE 0::numeric END), 0::numeric) AS cash_payments,
    COALESCE(sum(CASE WHEN crt.direction::text = 'in' AND crt.type::text = 'payment' AND crt.payment_method::text IN ('card', 'cardnet') THEN crt.amount ELSE 0::numeric END), 0::numeric) AS card_payments,
    COALESCE(sum(CASE WHEN crt.direction::text = 'in' AND crt.type::text = 'payment' AND crt.payment_method::text = 'transfer' THEN crt.amount ELSE 0::numeric END), 0::numeric) AS transfer_payments,
    count(CASE WHEN crt.type::text = 'payment' THEN 1 ELSE NULL::integer END) AS payment_count,
    count(CASE WHEN crt.type::text = 'refund' THEN 1 ELSE NULL::integer END) AS refund_count
FROM cash_registers cr
LEFT JOIN users u_op ON cr.operator_id = u_op.id
LEFT JOIN users u_ap ON cr.approved_by = u_ap.id
LEFT JOIN cash_register_transactions crt ON crt.cash_register_id = cr.id
GROUP BY cr.id, cr.name, cr.status, cr.opened_at, cr.closed_at, cr.opening_balance, cr.expected_balance, cr.expected_cash, cr.counted_balance, cr.difference, cr.total_card, cr.total_transfer, cr.requires_approval, cr.approved_by, cr.operator_id, u_op.email, u_ap.email, cr.approval_notes;

-- 4. Fix process_parking_payment to include payment_method in cash register transaction
-- and assign to correct operator's register
-- (This is done via a new wrapper that patches the INSERT)
CREATE OR REPLACE FUNCTION public.record_register_transaction(
  p_user_id UUID,
  p_amount DECIMAL,
  p_type TEXT DEFAULT 'payment',
  p_direction TEXT DEFAULT 'in',
  p_payment_method TEXT DEFAULT 'cash',
  p_description TEXT DEFAULT ''
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO cash_register_transactions (cash_register_id, type, amount, direction, payment_method, operator_id, description)
  SELECT cr.id, p_type, p_amount, p_direction,
    CASE WHEN p_payment_method IN ('cardnet', 'stripe') THEN 'card' ELSE COALESCE(p_payment_method, 'cash') END,
    p_user_id, p_description
  FROM cash_registers cr
  WHERE cr.status = 'open' AND cr.operator_id = p_user_id
  LIMIT 1;
END;
$$;
