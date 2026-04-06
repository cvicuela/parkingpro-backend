-- Migration 063: Login attempts table and rate limiting functions
-- Applied to Supabase as: login_attempts_rate_limiting

-- Login attempts table for rate limiting
CREATE TABLE IF NOT EXISTS login_attempts (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  success BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_login_attempts_email_time ON login_attempts (email, attempted_at);
CREATE INDEX idx_login_attempts_ip_time ON login_attempts (ip_address, attempted_at);

-- Enable RLS and block public access
ALTER TABLE login_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Block public access on login_attempts"
  ON login_attempts FOR ALL TO public USING (false);

-- Rate limit check: raises exception if >= 5 failed attempts in last 10 minutes
CREATE OR REPLACE FUNCTION check_login_rate_limit(p_email TEXT, p_ip TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM login_attempts
  WHERE (email = p_email OR ip_address = p_ip)
    AND success = FALSE
    AND attempted_at > NOW() - INTERVAL '10 minutes';

  IF v_count >= 5 THEN
    RAISE EXCEPTION 'Demasiados intentos fallidos. Intente de nuevo en 10 minutos.'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- Record a login attempt
CREATE OR REPLACE FUNCTION record_login_attempt(p_email TEXT, p_ip TEXT, p_success BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO login_attempts (email, ip_address, success)
  VALUES (p_email, p_ip, p_success);

  -- Cleanup: delete attempts older than 24 hours to prevent table bloat
  DELETE FROM login_attempts WHERE attempted_at < NOW() - INTERVAL '24 hours';
END;
$$;

-- Admin function to reset lockout for a specific email
CREATE OR REPLACE FUNCTION admin_reset_login_lockout(p_token TEXT, p_email TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user_id UUID;
  v_role VARCHAR;
BEGIN
  SELECT user_id, user_role INTO v_user_id, v_role
  FROM verify_token_with_role(p_token);

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Token invalido o sesion expirada' USING ERRCODE = 'P0001';
  END IF;

  IF v_role NOT IN ('admin', 'superadmin') THEN
    RAISE EXCEPTION 'Se requiere rol de administrador' USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM login_attempts
  WHERE email = p_email AND success = FALSE;
END;
$$;
