-- ============================================================
-- list_system_users: List all users for admin panel
-- ============================================================
CREATE OR REPLACE FUNCTION public.list_system_users(p_token text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_user_id UUID;
  v_user_role VARCHAR;
  v_results JSON;
BEGIN
  SELECT user_id, user_role INTO v_user_id, v_user_role
  FROM verify_token_with_role(p_token);

  IF v_user_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'No autorizado');
  END IF;

  IF v_user_role NOT IN ('admin', 'super_admin') THEN
    RETURN json_build_object('success', false, 'error', 'No tiene permisos para ver usuarios');
  END IF;

  SELECT json_agg(row_to_json(t)) INTO v_results FROM (
    SELECT u.id, u.email, u.phone, u.role, u.status,
      u.created_at, u.last_login_at,
      c.first_name, c.last_name
    FROM users u
    LEFT JOIN customers c ON c.user_id = u.id
    ORDER BY u.created_at DESC
  ) t;

  RETURN json_build_object('success', true, 'data', COALESCE(v_results, '[]'::json));
END;
$function$;

-- ============================================================
-- create_system_user: Create a new system user (admin action)
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_system_user(p_token text, p_data json)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_user_id UUID;
  v_user_role VARCHAR;
  v_email TEXT;
  v_phone TEXT;
  v_password TEXT;
  v_role VARCHAR;
  v_first_name TEXT;
  v_last_name TEXT;
  v_hash TEXT;
  v_new_user RECORD;
BEGIN
  SELECT user_id, user_role INTO v_user_id, v_user_role
  FROM verify_token_with_role(p_token);

  IF v_user_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'No autorizado');
  END IF;

  IF v_user_role NOT IN ('admin', 'super_admin') THEN
    RETURN json_build_object('success', false, 'error', 'No tiene permisos para crear usuarios');
  END IF;

  v_email := p_data->>'email';
  v_phone := p_data->>'phone';
  v_password := p_data->>'password';
  v_role := p_data->>'role';
  v_first_name := p_data->>'firstName';
  v_last_name := p_data->>'lastName';

  IF v_email IS NULL OR v_phone IS NULL OR v_password IS NULL OR v_role IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Email, telefono, contraseña y rol son requeridos');
  END IF;

  IF v_role NOT IN ('operator', 'admin', 'super_admin') THEN
    RETURN json_build_object('success', false, 'error', 'Rol invalido');
  END IF;

  IF v_role = 'super_admin' AND v_user_role != 'super_admin' THEN
    RETURN json_build_object('success', false, 'error', 'Solo super_admin puede crear usuarios super_admin');
  END IF;

  IF EXISTS (SELECT 1 FROM users WHERE email = v_email) THEN
    RETURN json_build_object('success', false, 'error', 'Email ya registrado');
  END IF;

  v_hash := extensions.crypt(v_password, extensions.gen_salt('bf', 10));

  INSERT INTO users (email, phone, password_hash, role)
  VALUES (v_email, v_phone, v_hash, v_role::user_role)
  RETURNING * INTO v_new_user;

  IF v_first_name IS NOT NULL OR v_last_name IS NOT NULL THEN
    INSERT INTO customers (user_id, first_name, last_name)
    VALUES (v_new_user.id, v_first_name, v_last_name);
  END IF;

  RETURN json_build_object('success', true, 'message', 'Usuario creado exitosamente', 'data',
    json_build_object('id', v_new_user.id, 'email', v_new_user.email, 'phone', v_new_user.phone,
      'role', v_new_user.role, 'status', v_new_user.status, 'first_name', v_first_name, 'last_name', v_last_name));
END;
$function$;

-- ============================================================
-- update_system_user: Update user (status, role, etc.)
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_system_user(p_token text, p_id uuid, p_data json)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_user_id UUID;
  v_user_role VARCHAR;
  v_target RECORD;
  v_status TEXT;
  v_role TEXT;
  v_email TEXT;
  v_phone TEXT;
  v_first_name TEXT;
  v_last_name TEXT;
  v_result RECORD;
BEGIN
  SELECT user_id, user_role INTO v_user_id, v_user_role
  FROM verify_token_with_role(p_token);

  IF v_user_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'No autorizado');
  END IF;

  IF v_user_role NOT IN ('admin', 'super_admin') THEN
    RETURN json_build_object('success', false, 'error', 'No tiene permisos');
  END IF;

  SELECT * INTO v_target FROM users WHERE id = p_id;
  IF v_target IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Usuario no encontrado');
  END IF;

  v_status := p_data->>'status';
  v_role := p_data->>'role';
  v_email := p_data->>'email';
  v_phone := p_data->>'phone';
  v_first_name := p_data->>'firstName';
  v_last_name := p_data->>'lastName';

  IF v_role = 'super_admin' AND v_user_role != 'super_admin' THEN
    RETURN json_build_object('success', false, 'error', 'Solo super_admin puede asignar rol super_admin');
  END IF;

  UPDATE users SET
    status = COALESCE(v_status, status),
    email = COALESCE(v_email, email),
    phone = COALESCE(v_phone, phone),
    role = COALESCE(v_role::user_role, role),
    updated_at = NOW()
  WHERE id = p_id;

  IF v_first_name IS NOT NULL OR v_last_name IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM customers WHERE user_id = p_id) THEN
      UPDATE customers SET
        first_name = COALESCE(v_first_name, first_name),
        last_name = COALESCE(v_last_name, last_name)
      WHERE user_id = p_id;
    ELSE
      INSERT INTO customers (user_id, first_name, last_name)
      VALUES (p_id, v_first_name, v_last_name);
    END IF;
  END IF;

  SELECT u.id, u.email, u.phone, u.role, u.status, u.created_at, u.last_login_at,
    c.first_name, c.last_name
  INTO v_result
  FROM users u LEFT JOIN customers c ON c.user_id = u.id
  WHERE u.id = p_id;

  RETURN json_build_object('success', true, 'message', 'Usuario actualizado', 'data', row_to_json(v_result));
END;
$function$;

-- ============================================================
-- reset_user_password: Reset a user's password (admin action)
-- ============================================================
CREATE OR REPLACE FUNCTION public.reset_user_password(p_token text, p_id uuid, p_new_password text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_user_id UUID;
  v_user_role VARCHAR;
  v_hash TEXT;
BEGIN
  SELECT user_id, user_role INTO v_user_id, v_user_role
  FROM verify_token_with_role(p_token);

  IF v_user_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'No autorizado');
  END IF;

  IF v_user_role NOT IN ('admin', 'super_admin') THEN
    RETURN json_build_object('success', false, 'error', 'No tiene permisos');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_id) THEN
    RETURN json_build_object('success', false, 'error', 'Usuario no encontrado');
  END IF;

  IF length(p_new_password) < 6 THEN
    RETURN json_build_object('success', false, 'error', 'La contraseña debe tener al menos 6 caracteres');
  END IF;

  v_hash := extensions.crypt(p_new_password, extensions.gen_salt('bf', 10));

  UPDATE users SET password_hash = v_hash, updated_at = NOW() WHERE id = p_id;

  DELETE FROM sessions WHERE user_id = p_id;

  RETURN json_build_object('success', true, 'message', 'Contraseña actualizada exitosamente');
END;
$function$;
