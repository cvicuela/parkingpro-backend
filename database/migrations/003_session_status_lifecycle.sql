-- =====================================================
-- MIGRACIÓN 003: Sistema de estados de sesión
-- Estados: active → paid → closed → abandoned
-- Reemplaza is_active BOOLEAN por status ENUM
-- =====================================================

-- 1. Drop vista que depende de is_active
DROP VIEW IF EXISTS active_parking_sessions CASCADE;

-- 2. Crear enum session_status
DO $$ BEGIN
  CREATE TYPE session_status AS ENUM ('active', 'paid', 'closed', 'abandoned');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 3. Agregar columna status
ALTER TABLE parking_sessions ADD COLUMN IF NOT EXISTS status session_status NOT NULL DEFAULT 'active';

-- 4. Migrar datos existentes
UPDATE parking_sessions SET status =
  CASE
    WHEN is_active = true THEN 'active'::session_status
    WHEN payment_status = 'paid' THEN 'paid'::session_status
    ELSE 'closed'::session_status
  END
WHERE status = 'active' AND is_active = false;

-- 5. Crear índice
CREATE INDEX IF NOT EXISTS idx_parking_sessions_status ON parking_sessions(status);

-- 6. Eliminar columna vieja
DROP INDEX IF EXISTS idx_parking_sessions_is_active;
ALTER TABLE parking_sessions DROP COLUMN IF EXISTS is_active;

-- 7. Recrear vista
CREATE VIEW active_parking_sessions AS
SELECT
    ps.id,
    ps.vehicle_plate,
    c.first_name || ' ' || c.last_name AS customer_name,
    p.name AS plan_name,
    ps.entry_time,
    ps.status,
    EXTRACT(EPOCH FROM (NOW() - ps.entry_time))/60 AS minutes_elapsed,
    ps.assigned_spot,
    ps.calculated_amount,
    ps.verification_code
FROM parking_sessions ps
LEFT JOIN customers c ON ps.customer_id = c.id
LEFT JOIN plans p ON ps.plan_id = p.id
WHERE ps.status = 'active'
ORDER BY ps.entry_time DESC;

-- 8. Función auto_close: >24h → abandoned
CREATE OR REPLACE FUNCTION auto_close_stale_sessions()
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_count INT;
BEGIN
  UPDATE parking_sessions SET
    status = 'abandoned',
    exit_time = NOW(),
    duration_minutes = EXTRACT(EPOCH FROM (NOW() - entry_time))::int / 60,
    payment_status = 'pending',
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'auto_closed', true,
      'auto_closed_at', NOW()::text,
      'closed_reason', 'abandoned',
      'threshold_hours', 24
    ),
    updated_at = NOW()
  WHERE status = 'active'
    AND exit_time IS NULL
    AND entry_time < NOW() - INTERVAL '24 hours';

  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count > 0 THEN
    INSERT INTO audit_logs (user_id, action, entity_type, changes, created_at)
    VALUES (NULL, 'sessions_abandoned', 'parking_session',
      jsonb_build_object('count', v_count, 'threshold', '24 hours'),
      NOW());
  END IF;

  RETURN json_build_object('success', true, 'data', json_build_object('abandoned_count', v_count));
END;
$$;

-- 9. Stats por status
CREATE OR REPLACE FUNCTION session_stats(p_token text)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id UUID;
  v_stats JSON;
BEGIN
  v_user_id := verify_token(p_token);
  IF v_user_id IS NULL THEN RETURN json_build_object('success', false, 'error', 'No autorizado'); END IF;

  SELECT json_build_object(
    'active', (SELECT COUNT(*) FROM parking_sessions WHERE status = 'active'),
    'paid', (SELECT COUNT(*) FROM parking_sessions WHERE status = 'paid' AND updated_at > NOW() - INTERVAL '24 hours'),
    'closed', (SELECT COUNT(*) FROM parking_sessions WHERE status = 'closed' AND updated_at > NOW() - INTERVAL '24 hours'),
    'abandoned', (SELECT COUNT(*) FROM parking_sessions WHERE status = 'abandoned' AND updated_at > NOW() - INTERVAL '7 days'),
    'total_today', (SELECT COUNT(*) FROM parking_sessions WHERE created_at::date = CURRENT_DATE),
    'revenue_today', (SELECT COALESCE(SUM(paid_amount), 0) FROM parking_sessions WHERE payment_status = 'paid' AND updated_at::date = CURRENT_DATE)
  ) INTO v_stats;

  RETURN json_build_object('success', true, 'data', v_stats);
END;
$$;
