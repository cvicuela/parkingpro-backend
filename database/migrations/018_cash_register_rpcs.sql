-- =====================================================
-- MIGRACIÓN: RPCs para Cuadre de Caja (usado por PWA)
-- Funciones: open, active, close, approve, transactions, history, limits
-- =====================================================

-- ============================================================
-- open_cash_register: Abrir sesión de caja
-- ============================================================
CREATE OR REPLACE FUNCTION public.open_cash_register(p_token TEXT, p_data JSON)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_user_id UUID;
  v_role VARCHAR;
  v_operator_id UUID;
  v_opening_balance DECIMAL(10,2);
  v_name VARCHAR(100);
  v_existing UUID;
  v_register JSON;
BEGIN
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM require_role(p_token, ARRAY['operator','admin','super_admin']) r;

  v_opening_balance := COALESCE(
    (p_data->>'openingBalance')::DECIMAL,
    (p_data->>'opening_balance')::DECIMAL,
    0
  );
  v_name := COALESCE(p_data->>'name', 'Caja Principal');

  -- Si es admin y envía operatorId, abrir para ese operador
  IF v_role IN ('admin', 'super_admin') AND (p_data->>'operatorId') IS NOT NULL AND (p_data->>'operatorId') != '' THEN
    v_operator_id := (p_data->>'operatorId')::UUID;
  ELSE
    v_operator_id := v_user_id;
  END IF;

  -- Verificar si ya tiene caja abierta
  SELECT id INTO v_existing FROM cash_registers
  WHERE operator_id = v_operator_id AND status = 'open';

  IF v_existing IS NOT NULL THEN
    -- Retornar la caja existente
    SELECT row_to_json(cr) INTO v_register
    FROM (
      SELECT c.*,
        COALESCE(SUM(CASE WHEN t.direction = 'in' THEN t.amount ELSE 0 END), 0) as total_in,
        COALESCE(SUM(CASE WHEN t.direction = 'out' THEN t.amount ELSE 0 END), 0) as total_out,
        COALESCE(SUM(CASE WHEN t.direction = 'in' AND (t.payment_method = 'cash' OR t.payment_method IS NULL) THEN t.amount ELSE 0 END), 0) as cash_in,
        COALESCE(SUM(CASE WHEN t.direction = 'in' AND t.payment_method = 'card' THEN t.amount ELSE 0 END), 0) as total_card,
        COALESCE(SUM(CASE WHEN t.direction = 'in' AND t.payment_method = 'transfer' THEN t.amount ELSE 0 END), 0) as total_transfer,
        COUNT(CASE WHEN t.type = 'payment' THEN 1 END) as payment_count
      FROM cash_registers c
      LEFT JOIN cash_register_transactions t ON t.cash_register_id = c.id
      WHERE c.id = v_existing
      GROUP BY c.id
    ) cr;
    RETURN json_build_object('success', true, 'data', v_register, 'already_open', true);
  END IF;

  -- Crear nueva caja
  INSERT INTO cash_registers (name, operator_id, status, opened_at, opening_balance, opened_by)
  VALUES (v_name, v_operator_id, 'open', NOW(), v_opening_balance, v_user_id);

  -- Obtener la caja recién creada
  SELECT id INTO v_existing FROM cash_registers
  WHERE operator_id = v_operator_id AND status = 'open';

  -- Registrar fondo inicial
  IF v_opening_balance > 0 THEN
    INSERT INTO cash_register_transactions (cash_register_id, type, amount, direction, operator_id, description, payment_method)
    VALUES (v_existing, 'opening_float', v_opening_balance, 'in', v_operator_id, 'Fondo inicial de caja', 'cash');
  END IF;

  -- Log audit
  INSERT INTO audit_logs (user_id, action, entity_type, entity_id, changes)
  VALUES (v_user_id, 'cash_register_opened', 'cash_register', v_existing,
    json_build_object('opening_balance', v_opening_balance, 'operator_id', v_operator_id)::jsonb);

  SELECT row_to_json(c) INTO v_register FROM cash_registers c WHERE c.id = v_existing;
  RETURN json_build_object('success', true, 'data', v_register);
EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$function$;

-- ============================================================
-- get_active_register: Obtener caja activa del operador actual
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_active_register(p_token TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_user_id UUID;
  v_role VARCHAR;
  v_result JSON;
  v_register_id UUID;
  v_transactions JSON;
BEGIN
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM require_role(p_token, ARRAY['operator','admin','super_admin']) r;

  -- Buscar caja activa del usuario
  SELECT id INTO v_register_id FROM cash_registers
  WHERE operator_id = v_user_id AND status = 'open'
  LIMIT 1;

  IF v_register_id IS NULL THEN
    RETURN json_build_object('success', true, 'data', NULL);
  END IF;

  -- Obtener caja con totales desglosados por método de pago
  SELECT row_to_json(cr) INTO v_result
  FROM (
    SELECT c.*,
      COALESCE(SUM(CASE WHEN t.direction = 'in' THEN t.amount ELSE 0 END), 0) as total_in,
      COALESCE(SUM(CASE WHEN t.direction = 'out' THEN t.amount ELSE 0 END), 0) as total_out,
      COALESCE(SUM(CASE WHEN t.direction = 'in' AND (t.payment_method = 'cash' OR t.payment_method IS NULL) THEN t.amount ELSE 0 END), 0) as cash_in,
      COALESCE(SUM(CASE WHEN t.direction = 'out' AND (t.payment_method = 'cash' OR t.payment_method IS NULL) THEN t.amount ELSE 0 END), 0) as cash_out,
      COALESCE(SUM(CASE WHEN t.direction = 'in' AND t.payment_method = 'card' THEN t.amount ELSE 0 END), 0) as total_card,
      COALESCE(SUM(CASE WHEN t.direction = 'in' AND t.payment_method = 'transfer' THEN t.amount ELSE 0 END), 0) as total_transfer,
      COUNT(CASE WHEN t.type = 'payment' THEN 1 END) as payment_count
    FROM cash_registers c
    LEFT JOIN cash_register_transactions t ON t.cash_register_id = c.id
    WHERE c.id = v_register_id
    GROUP BY c.id
  ) cr;

  -- Obtener transacciones
  SELECT COALESCE(json_agg(row_to_json(tx)), '[]'::json) INTO v_transactions
  FROM (
    SELECT t.*, u.email as operator_name
    FROM cash_register_transactions t
    LEFT JOIN users u ON t.operator_id = u.id
    WHERE t.cash_register_id = v_register_id
    ORDER BY t.created_at ASC
  ) tx;

  RETURN json_build_object('success', true, 'data', json_build_object('register', v_result, 'transactions', v_transactions));
EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$function$;

-- ============================================================
-- close_cash_register: Cerrar caja con cuadre
-- ============================================================
CREATE OR REPLACE FUNCTION public.close_cash_register(p_token TEXT, p_id UUID, p_data JSON)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_user_id UUID;
  v_role VARCHAR;
  v_register RECORD;
  v_totals RECORD;
  v_expected_balance DECIMAL(10,2);
  v_expected_cash DECIMAL(10,2);
  v_total_card DECIMAL(10,2);
  v_total_transfer DECIMAL(10,2);
  v_counted_balance DECIMAL(10,2);
  v_difference DECIMAL(10,2);
  v_threshold DECIMAL(10,2);
  v_requires_approval BOOLEAN;
  v_denom JSON;
  v_result JSON;
BEGIN
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM require_role(p_token, ARRAY['operator','admin','super_admin']) r;

  -- Verificar caja abierta
  SELECT * INTO v_register FROM cash_registers
  WHERE id = p_id AND operator_id = v_user_id AND status = 'open';

  IF v_register IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Caja abierta no encontrada para este operador');
  END IF;

  v_counted_balance := COALESCE((p_data->>'countedBalance')::DECIMAL, 0);

  -- Calcular totales desglosados
  SELECT
    COALESCE(SUM(CASE WHEN direction = 'in' THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN direction = 'out' THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN direction = 'in' AND (payment_method = 'cash' OR payment_method IS NULL) THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN direction = 'out' AND (payment_method = 'cash' OR payment_method IS NULL) THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN direction = 'in' AND payment_method = 'card' THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN direction = 'in' AND payment_method = 'transfer' THEN amount ELSE 0 END), 0)
  INTO v_totals
  FROM cash_register_transactions WHERE cash_register_id = p_id;

  v_expected_balance := v_totals.column1 - v_totals.column2;
  v_expected_cash := v_totals.column3 - v_totals.column4;
  v_total_card := v_totals.column5;
  v_total_transfer := v_totals.column6;

  -- La diferencia se calcula solo contra efectivo esperado
  v_difference := v_counted_balance - v_expected_cash;

  -- Obtener umbral
  SELECT COALESCE(value::DECIMAL, 200) INTO v_threshold
  FROM settings WHERE key = 'cash_diff_threshold';
  IF v_threshold IS NULL THEN v_threshold := 200; END IF;

  v_requires_approval := ABS(v_difference) > v_threshold;

  -- Guardar denominaciones
  IF p_data->'denominations' IS NOT NULL THEN
    FOR v_denom IN SELECT * FROM json_array_elements(p_data->'denominations')
    LOOP
      IF (v_denom->>'quantity')::INT > 0 THEN
        INSERT INTO denomination_counts (cash_register_id, denomination, quantity)
        VALUES (p_id, (v_denom->>'denomination')::DECIMAL, (v_denom->>'quantity')::INT);
      END IF;
    END LOOP;
  END IF;

  -- Actualizar caja
  UPDATE cash_registers SET
    status = 'closed',
    closed_at = NOW(),
    expected_balance = v_expected_balance,
    expected_cash = v_expected_cash,
    counted_balance = v_counted_balance,
    difference = v_difference,
    total_card = v_total_card,
    total_transfer = v_total_transfer,
    requires_approval = v_requires_approval,
    notes = COALESCE(p_data->>'notes', NULL),
    updated_at = NOW()
  WHERE id = p_id;

  -- Audit log
  INSERT INTO audit_logs (user_id, action, entity_type, entity_id, changes)
  VALUES (v_user_id, 'cash_register_closed', 'cash_register', p_id,
    json_build_object(
      'expected_balance', v_expected_balance,
      'expected_cash', v_expected_cash,
      'counted_balance', v_counted_balance,
      'difference', v_difference,
      'total_card', v_total_card,
      'total_transfer', v_total_transfer,
      'requires_approval', v_requires_approval
    )::jsonb);

  SELECT row_to_json(c) INTO v_result FROM cash_registers c WHERE c.id = p_id;
  RETURN json_build_object('success', true, 'data', v_result);
EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$function$;

-- ============================================================
-- approve_cash_register: Aprobación de supervisor
-- ============================================================
CREATE OR REPLACE FUNCTION public.approve_cash_register(p_token TEXT, p_id UUID, p_data JSON)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_user_id UUID;
  v_role VARCHAR;
  v_result JSON;
BEGIN
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM require_role(p_token, ARRAY['admin','super_admin']) r;

  UPDATE cash_registers SET
    approved_by = v_user_id,
    approved_at = NOW(),
    approval_notes = COALESCE(p_data->>'notes', NULL)
  WHERE id = p_id AND requires_approval = TRUE AND approved_by IS NULL;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Caja no encontrada o ya fue aprobada');
  END IF;

  INSERT INTO audit_logs (user_id, action, entity_type, entity_id, changes)
  VALUES (v_user_id, 'cash_register_approved', 'cash_register', p_id,
    json_build_object('approval_notes', COALESCE(p_data->>'notes', ''))::jsonb);

  SELECT row_to_json(c) INTO v_result FROM cash_registers c WHERE c.id = p_id;
  RETURN json_build_object('success', true, 'data', v_result);
EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$function$;

-- ============================================================
-- get_register_transactions: Obtener transacciones de una caja
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_register_transactions(p_token TEXT, p_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_user_id UUID;
  v_role VARCHAR;
  v_result JSON;
BEGIN
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM require_role(p_token, ARRAY['operator','admin','super_admin']) r;

  SELECT COALESCE(json_agg(row_to_json(tx)), '[]'::json) INTO v_result
  FROM (
    SELECT t.*, u.email as operator_name
    FROM cash_register_transactions t
    LEFT JOIN users u ON t.operator_id = u.id
    WHERE t.cash_register_id = p_id
    ORDER BY t.created_at ASC
  ) tx;

  RETURN json_build_object('success', true, 'data', v_result);
EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$function$;

-- ============================================================
-- cash_register_history: Historial de cierres de caja
-- ============================================================
CREATE OR REPLACE FUNCTION public.cash_register_history(p_token TEXT, p_limit INT DEFAULT 50)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_user_id UUID;
  v_role VARCHAR;
  v_result JSON;
BEGIN
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM require_role(p_token, ARRAY['operator','admin','super_admin']) r;

  SELECT COALESCE(json_agg(row_to_json(h)), '[]'::json) INTO v_result
  FROM (
    SELECT * FROM cash_register_summary
    ORDER BY opened_at DESC
    LIMIT p_limit
  ) h;

  RETURN json_build_object('success', true, 'data', v_result);
EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$function$;

-- ============================================================
-- get_cash_limits: Obtener umbrales de configuración
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_cash_limits(p_token TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_user_id UUID;
  v_role VARCHAR;
  v_threshold DECIMAL;
  v_refund_limit DECIMAL;
  v_currency VARCHAR;
BEGIN
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM verify_token_with_role(p_token) r;

  IF v_user_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'No autorizado');
  END IF;

  SELECT COALESCE(value::DECIMAL, 200) INTO v_threshold FROM settings WHERE key = 'cash_diff_threshold';
  SELECT COALESCE(value::DECIMAL, 500) INTO v_refund_limit FROM settings WHERE key = 'refund_limit_operator';
  SELECT COALESCE(value, 'DOP') INTO v_currency FROM settings WHERE key = 'currency';

  RETURN json_build_object(
    'success', true,
    'data', json_build_object(
      'cashDiffThreshold', COALESCE(v_threshold, 200),
      'differenceThreshold', COALESCE(v_threshold, 200),
      'refundLimitOperator', COALESCE(v_refund_limit, 500),
      'currency', COALESCE(v_currency, 'DOP')
    )
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$function$;

-- ============================================================
-- process_parking_payment: Procesar pago de estacionamiento
-- Integra: payment, parking_session, invoice, cash_register
-- ============================================================
CREATE OR REPLACE FUNCTION public.process_parking_payment(p_token TEXT, p_data JSON)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_user_id UUID;
  v_role VARCHAR;
  v_session RECORD;
  v_payment_method VARCHAR(20);
  v_amount DECIMAL(10,2);
  v_tax_rate DECIMAL(5,4);
  v_tax_amount DECIMAL(10,2);
  v_total_amount DECIMAL(10,2);
  v_payment_id UUID;
  v_register_id UUID;
  v_invoice_id UUID;
  v_invoice_number VARCHAR(50);
  v_ncf VARCHAR(30);
  v_receipt JSON;
  v_verification_code VARCHAR(10);
  v_method_normalized VARCHAR(20);
BEGIN
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM require_role(p_token, ARRAY['operator','admin','super_admin']) r;

  -- Obtener sesión
  SELECT ps.*, p.name as plan_name
  INTO v_session
  FROM parking_sessions ps
  LEFT JOIN plans p ON ps.plan_id = p.id
  WHERE ps.id = (p_data->>'sessionId')::UUID;

  IF v_session IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Sesión no encontrada');
  END IF;

  IF v_session.payment_status = 'paid' THEN
    RETURN json_build_object('success', false, 'error', 'Esta sesión ya fue pagada');
  END IF;

  v_payment_method := COALESCE(p_data->>'paymentMethod', 'cash');
  v_amount := v_session.calculated_amount;
  v_tax_rate := 0.18;
  v_tax_amount := ROUND(v_amount * v_tax_rate, 2);
  v_total_amount := v_amount + v_tax_amount;
  v_verification_code := LPAD(FLOOR(RANDOM() * 1000000)::TEXT, 6, '0');

  -- Normalizar método para cash_register (cardnet/stripe -> card)
  IF v_payment_method IN ('cardnet', 'stripe') THEN
    v_method_normalized := 'card';
  ELSE
    v_method_normalized := v_payment_method;
  END IF;

  -- 1. Crear pago
  INSERT INTO payments (
    amount, tax_amount, total_amount, currency, status,
    payment_method, paid_at, metadata
  ) VALUES (
    v_amount, v_tax_amount, v_total_amount, 'DOP', 'paid',
    v_payment_method, NOW(),
    json_build_object(
      'sessionId', v_session.id,
      'plate', v_session.vehicle_plate,
      'cashReceived', (p_data->>'cashReceived')::DECIMAL,
      'cashChange', (p_data->>'cashChange')::DECIMAL,
      'cardType', p_data->>'cardType',
      'transferReference', p_data->>'transferReference',
      'verification_code', v_verification_code
    )::jsonb
  )
  RETURNING id INTO v_payment_id;

  -- 2. Actualizar sesión
  UPDATE parking_sessions SET
    payment_id = v_payment_id,
    paid_amount = v_total_amount,
    payment_status = 'paid',
    status = 'paid',
    exit_time = COALESCE(exit_time, NOW()),
    updated_at = NOW()
  WHERE id = v_session.id;

  -- 3. Generar factura
  SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM '[0-9]+$') AS INT)), 0) + 1
  INTO v_invoice_id FROM invoices;
  v_invoice_number := 'PP-' || TO_CHAR(NOW(), 'YYYY') || '-' || LPAD(v_invoice_id::TEXT, 4, '0');

  -- Obtener NCF si hay secuencia disponible
  BEGIN
    SELECT prefix || LPAD(current_number::TEXT, 8, '0') INTO v_ncf
    FROM ncf_sequences
    WHERE ncf_type = '02' AND status = 'active' AND current_number <= end_number
    LIMIT 1;

    IF v_ncf IS NOT NULL THEN
      UPDATE ncf_sequences SET current_number = current_number + 1
      WHERE ncf_type = '02' AND status = 'active' AND current_number <= end_number;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_ncf := NULL;
  END;

  INSERT INTO invoices (payment_id, invoice_number, ncf, subtotal, tax_amount, total, status, issued_at)
  VALUES (v_payment_id, v_invoice_number, v_ncf, v_amount, v_tax_amount, v_total_amount, 'issued', NOW());

  -- 4. Registrar en caja activa del operador
  SELECT id INTO v_register_id FROM cash_registers
  WHERE operator_id = v_user_id AND status = 'open'
  LIMIT 1;

  IF v_register_id IS NOT NULL THEN
    INSERT INTO cash_register_transactions (
      cash_register_id, type, amount, direction,
      payment_id, parking_session_id, operator_id,
      description, payment_method
    ) VALUES (
      v_register_id, 'payment', v_total_amount, 'in',
      v_payment_id, v_session.id, v_user_id,
      'Cobro estacionamiento ' || v_session.vehicle_plate,
      v_method_normalized
    );
  END IF;

  -- 5. Audit log
  INSERT INTO audit_logs (user_id, action, entity_type, entity_id, changes)
  VALUES (v_user_id, 'payment_created', 'payment', v_payment_id,
    json_build_object(
      'amount', v_total_amount,
      'method', v_payment_method,
      'plate', v_session.vehicle_plate,
      'session_id', v_session.id,
      'register_id', v_register_id
    )::jsonb);

  -- 6. Construir recibo
  v_receipt := json_build_object(
    'plateNumber', v_session.vehicle_plate,
    'invoiceNumber', v_invoice_number,
    'ncf', v_ncf,
    'subtotal', v_amount,
    'tax', v_tax_amount,
    'total', v_total_amount,
    'paymentMethod', v_payment_method,
    'entryTime', v_session.entry_time,
    'exitTime', COALESCE(v_session.exit_time, NOW()),
    'hours', CEIL(EXTRACT(EPOCH FROM (COALESCE(v_session.exit_time, NOW()) - v_session.entry_time)) / 3600),
    'code', 'REC-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD(FLOOR(RANDOM() * 100000)::TEXT, 5, '0'),
    'verification_code', v_verification_code,
    'paymentId', v_payment_id
  );

  RETURN json_build_object('success', true, 'data', json_build_object('receipt', v_receipt));
EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$function$;

-- ============================================================
-- list_operators: Listar operadores para selección
-- ============================================================
CREATE OR REPLACE FUNCTION public.list_operators(p_token TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_user_id UUID;
  v_role VARCHAR;
  v_result JSON;
BEGIN
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM require_role(p_token, ARRAY['operator','admin','super_admin']) r;

  SELECT COALESCE(json_agg(row_to_json(u)), '[]'::json) INTO v_result
  FROM (
    SELECT id, email, first_name, last_name, phone, role::VARCHAR,
      COALESCE(first_name || ' ' || last_name, email) as display_name,
      status
    FROM users
    WHERE role::VARCHAR IN ('operator', 'admin', 'super_admin') AND status = 'active'
    ORDER BY first_name, last_name
  ) u;

  RETURN json_build_object('success', true, 'data', v_result);
EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$function$;

-- ============================================================
-- create_operator: Crear nuevo operador
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_operator(p_token TEXT, p_data JSON)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_user_id UUID;
  v_role VARCHAR;
  v_new_id UUID;
  v_result JSON;
BEGIN
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM require_role(p_token, ARRAY['admin','super_admin']) r;

  INSERT INTO users (email, phone, password_hash, first_name, last_name, role, status)
  VALUES (
    p_data->>'email',
    COALESCE(p_data->>'phone', '000-000-0000'),
    crypt(COALESCE(p_data->>'password', 'operator123'), gen_salt('bf')),
    p_data->>'first_name',
    p_data->>'last_name',
    'operator',
    'active'
  )
  RETURNING id INTO v_new_id;

  SELECT row_to_json(u) INTO v_result
  FROM (
    SELECT id, email, first_name, last_name, phone, role::VARCHAR,
      COALESCE(first_name || ' ' || last_name, email) as display_name
    FROM users WHERE id = v_new_id
  ) u;

  RETURN json_build_object('success', true, 'data', v_result);
EXCEPTION
  WHEN unique_violation THEN
    RETURN json_build_object('success', false, 'error', 'El email o teléfono ya existe');
  WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$function$;
