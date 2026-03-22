-- ============================================
-- MIGRACIÓN 031: Actualizar vista active_parking_sessions
-- Agregar current_amount calculado en tiempo real
-- ============================================

CREATE OR REPLACE VIEW active_parking_sessions AS
SELECT
    ps.id,
    ps.vehicle_plate,
    COALESCE(c.first_name || ' ' || c.last_name, 'Visitante') AS customer_name,
    p.name AS plan_name,
    ps.entry_time,
    ps.status,
    EXTRACT(EPOCH FROM (NOW() - ps.entry_time))/60 AS minutes_elapsed,
    ps.assigned_spot,
    ps.calculated_amount,
    ps.verification_code,
    -- current_amount: use calculated_amount if set, otherwise compute from hourly_rates
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
      )
    , 0) AS current_amount
FROM parking_sessions ps
LEFT JOIN customers c ON ps.customer_id = c.id
LEFT JOIN plans p ON ps.plan_id = p.id
WHERE ps.status = 'active'
ORDER BY ps.entry_time DESC;

-- Re-apply security_invoker
ALTER VIEW public.active_parking_sessions SET (security_invoker = on);
