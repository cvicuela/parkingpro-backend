-- ============================================
-- MIGRACIÓN 030: RPC get_dashboard_stats
-- Función principal del Dashboard para KPIs en tiempo real
-- ============================================

CREATE OR REPLACE FUNCTION get_dashboard_stats(p_token TEXT)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id UUID;
  v_revenue DECIMAL;
  v_prev_revenue DECIMAL;
  v_active_customers INT;
  v_overdue_count INT;
  v_today_entries INT;
  v_today_exits INT;
  v_today_payments INT;
  v_today_revenue DECIMAL;
  v_sessions_paid INT;
  v_sessions_completed INT;
  v_total_subscriptions INT;
  v_expense_total DECIMAL;
  v_expense_itbis DECIMAL;
BEGIN
  SELECT r.user_id INTO v_user_id
  FROM require_role(p_token, ARRAY['admin', 'super_admin', 'operator']) r;

  -- Ingresos del mes actual (pagos completados)
  SELECT COALESCE(SUM(total_amount), 0)
  INTO v_revenue
  FROM payments
  WHERE status = 'paid'
    AND paid_at >= DATE_TRUNC('month', CURRENT_DATE);

  -- Ingresos del mes anterior (para comparación)
  SELECT COALESCE(SUM(total_amount), 0)
  INTO v_prev_revenue
  FROM payments
  WHERE status = 'paid'
    AND paid_at >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
    AND paid_at < DATE_TRUNC('month', CURRENT_DATE);

  -- Clientes activos (con suscripción activa)
  SELECT COUNT(DISTINCT customer_id)
  INTO v_active_customers
  FROM subscriptions
  WHERE status = 'active';

  -- Total suscripciones activas
  SELECT COUNT(*)
  INTO v_total_subscriptions
  FROM subscriptions
  WHERE status = 'active';

  -- Morosos (suscripciones vencidas)
  SELECT COUNT(*)
  INTO v_overdue_count
  FROM subscriptions
  WHERE status = 'past_due';

  -- Estadísticas de HOY
  SELECT
    COUNT(*) FILTER (WHERE type = 'entry' AND timestamp >= CURRENT_DATE),
    COUNT(*) FILTER (WHERE type = 'exit' AND timestamp >= CURRENT_DATE)
  INTO v_today_entries, v_today_exits
  FROM access_events
  WHERE timestamp >= CURRENT_DATE;

  SELECT
    COUNT(*),
    COALESCE(SUM(total_amount), 0)
  INTO v_today_payments, v_today_revenue
  FROM payments
  WHERE status = 'paid'
    AND paid_at >= CURRENT_DATE;

  -- Tasa de cobro (sesiones pagadas vs completadas este mes)
  SELECT
    COUNT(*) FILTER (WHERE payment_status = 'paid'),
    COUNT(*)
  INTO v_sessions_paid, v_sessions_completed
  FROM parking_sessions
  WHERE status IN ('paid', 'closed')
    AND entry_time >= DATE_TRUNC('month', CURRENT_DATE);

  -- Gastos del mes
  SELECT
    COALESCE(SUM(total), 0),
    COALESCE(SUM(itbis_amount), 0)
  INTO v_expense_total, v_expense_itbis
  FROM expenses
  WHERE status = 'active'
    AND expense_date >= DATE_TRUNC('month', CURRENT_DATE);

  -- Incluir conteo de entradas hoy desde parking_sessions si access_events está vacío
  IF v_today_entries = 0 THEN
    SELECT COUNT(*) INTO v_today_entries
    FROM parking_sessions
    WHERE entry_time >= CURRENT_DATE AND status IN ('active', 'paid', 'closed');
  END IF;

  RETURN json_build_object('success', true, 'data', json_build_object(
    -- KPIs principales
    'revenue',              v_revenue,
    'total_revenue',        v_revenue,
    'previous_revenue',     v_prev_revenue,
    'revenue_change',       CASE WHEN v_prev_revenue > 0
                              THEN ROUND(((v_revenue - v_prev_revenue) / v_prev_revenue * 100)::NUMERIC, 1)
                              ELSE 0 END,
    'active_customers',     v_active_customers,
    'activeCustomers',      v_active_customers,
    'total_subscriptions',  v_total_subscriptions,
    'totalSubscriptions',   v_total_subscriptions,
    'overdue_count',        v_overdue_count,
    'overdueCount',         v_overdue_count,

    -- Estadísticas de hoy
    'today_entries',        v_today_entries,
    'todayEntries',         v_today_entries,
    'today_exits',          v_today_exits,
    'todayExits',           v_today_exits,
    'today_payments',       v_today_payments,
    'todayPayments',        v_today_payments,
    'today_revenue',        v_today_revenue,
    'todayRevenue',         v_today_revenue,

    -- Tasa de cobro
    'sessions_paid',        v_sessions_paid,
    'sessionsPaid',         v_sessions_paid,
    'sessions_completed',   v_sessions_completed,
    'sessionsCompleted',    v_sessions_completed,

    -- Gastos
    'expense_total',        v_expense_total,
    'expense_itbis',        v_expense_itbis
  ));
END;
$$;

-- ============================================
-- RPC: list_active_sessions
-- Sesiones de parqueo activas con duración y monto actual
-- ============================================

CREATE OR REPLACE FUNCTION list_active_sessions(p_token TEXT)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id UUID;
  v_sessions JSON;
BEGIN
  SELECT r.user_id INTO v_user_id
  FROM require_role(p_token, ARRAY['admin', 'super_admin', 'operator']) r;

  SELECT COALESCE(json_agg(row_to_json(sub) ORDER BY sub.entry_time DESC), '[]'::json)
  INTO v_sessions
  FROM (
    SELECT
      ps.id,
      ps.vehicle_plate,
      ps.plan_id,
      ps.customer_id,
      ps.entry_time,
      ps.status,
      ps.assigned_spot,
      p.name AS plan_name,
      COALESCE(c.first_name || ' ' || c.last_name, 'Visitante') AS customer_name,
      EXTRACT(EPOCH FROM (NOW() - ps.entry_time)) / 60 AS minutes_elapsed,
      -- Calcular monto actual basado en horas transcurridas
      COALESCE(NULLIF(ps.calculated_amount, 0),
        (SELECT COALESCE(SUM(
          COALESCE(
            (SELECT rate FROM hourly_rates WHERE plan_id = ps.plan_id AND hour_number = h.n AND is_active = true),
            (SELECT rate FROM hourly_rates WHERE plan_id = ps.plan_id AND is_active = true ORDER BY hour_number DESC LIMIT 1),
            0
          )
        ), 0)
        FROM generate_series(1, GREATEST(1, CEIL(
          GREATEST(0, EXTRACT(EPOCH FROM (NOW() - ps.entry_time)) / 60 - COALESCE(p.tolerance_minutes, 5)) / 60
        )::INT)) AS h(n)
        WHERE EXTRACT(EPOCH FROM (NOW() - ps.entry_time)) / 60 > COALESCE(p.tolerance_minutes, 5)
        ), 0
      ) AS current_amount
    FROM parking_sessions ps
    LEFT JOIN plans p ON ps.plan_id = p.id
    LEFT JOIN customers c ON ps.customer_id = c.id
    WHERE ps.status = 'active'
  ) sub;

  RETURN json_build_object('success', true, 'data', v_sessions);
END;
$$;
