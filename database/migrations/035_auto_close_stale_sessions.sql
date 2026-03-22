-- ============================================================
-- Auto-close stale parking sessions (active > 48 hours)
-- Runs as a scheduled function
-- ============================================================

-- ============================================================
-- CRON JOB SETUP (via Supabase Dashboard)
-- ============================================================
-- pg_cron must be enabled through the Supabase dashboard before
-- scheduling this function. To do so:
--
-- 1. Go to your Supabase project dashboard.
-- 2. Navigate to Database > Extensions.
-- 3. Search for "pg_cron" and enable it.
-- 4. Then run the following SQL in the SQL Editor to schedule
--    the job (runs every hour at :00):
--
--    SELECT cron.schedule(
--      'auto-close-stale-sessions',   -- job name
--      '0 * * * *',                   -- every hour
--      $$SELECT public.auto_close_stale_sessions()$$
--    );
--
-- To view scheduled jobs:
--    SELECT * FROM cron.job;
--
-- To remove the job:
--    SELECT cron.unschedule('auto-close-stale-sessions');
-- ============================================================

CREATE OR REPLACE FUNCTION public.auto_close_stale_sessions()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_count INT;
BEGIN
  UPDATE parking_sessions
  SET
    status = 'closed',
    exit_time = NOW(),
    payment_status = CASE
      WHEN payment_status = 'pending' THEN 'refunded'
      ELSE payment_status
    END,
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'auto_closed', true,
      'auto_closed_at', NOW()::text,
      'reason', 'Session exceeded 48 hours without exit'
    ),
    updated_at = NOW()
  WHERE status = 'active'
    AND entry_time < NOW() - INTERVAL '48 hours';

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Log to audit if any were closed
  IF v_count > 0 THEN
    INSERT INTO audit_logs (action, entity_type, changes, created_at)
    VALUES ('auto_close_stale_sessions', 'parking_sessions',
            jsonb_build_object('sessions_closed', v_count, 'threshold', '48 hours'),
            NOW());
  END IF;

  RETURN json_build_object('success', true, 'sessions_closed', v_count);
END;
$function$;
