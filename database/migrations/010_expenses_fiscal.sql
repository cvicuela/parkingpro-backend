-- ============================================================
-- EXPENSES TABLE: Feeds DGII 606 report (purchases/expenses)
-- ============================================================

CREATE TABLE IF NOT EXISTS expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Supplier info
  supplier_name TEXT NOT NULL,
  supplier_rnc VARCHAR(11),                    -- RNC or Cedula
  supplier_id_type VARCHAR(1) DEFAULT '1',     -- 1=RNC, 2=Cedula, 3=Pasaporte

  -- DGII classification
  expense_type VARCHAR(2) NOT NULL DEFAULT '02', -- 01=Gastos de Personal, 02=Gastos por trabajos/suministros, 03=Arrendamientos, 04=Gastos de activos fijos, 05=Gastos de representación, 06=Otras deducciones, 07=Gastos financieros, 08=Gastos extraordinarios, 09=Compras y gastos que formarán parte del costo de venta, 10=Adquisición de activos, 11=Gastos de seguros

  -- NCF / Invoice
  ncf VARCHAR(19),                             -- B01, B11, B14, B15
  ncf_modified VARCHAR(19),                    -- NCF que modifica (notas de crédito)

  -- Dates
  expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
  payment_date DATE,

  -- Amounts (DOP)
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
  itbis_amount NUMERIC(12,2) NOT NULL DEFAULT 0,     -- ITBIS facturado
  itbis_retenido NUMERIC(12,2) DEFAULT 0,            -- ITBIS retenido
  itbis_sujeto_proporcionalidad NUMERIC(12,2) DEFAULT 0,
  itbis_llevado_costo NUMERIC(12,2) DEFAULT 0,
  itbis_por_adelantar NUMERIC(12,2) DEFAULT 0,
  itbis_percibido NUMERIC(12,2) DEFAULT 0,
  isr_retencion_type VARCHAR(2) DEFAULT '00',        -- Tipo de retención ISR
  isr_retenido NUMERIC(12,2) DEFAULT 0,
  impuesto_selectivo NUMERIC(12,2) DEFAULT 0,
  otros_impuestos NUMERIC(12,2) DEFAULT 0,
  propina_legal NUMERIC(12,2) DEFAULT 0,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,

  -- Payment method (DGII codes)
  payment_method VARCHAR(2) DEFAULT '04',      -- 01=Efectivo, 02=Cheque/transferencia, 03=Tarjeta débito/crédito, 04=Compra a crédito, 05=Permuta, 06=Nota de crédito, 07=Mixto

  -- Internal categorization
  category VARCHAR(50),                        -- Internal category for reporting
  description TEXT,                            -- Notes

  -- Metadata
  created_by UUID REFERENCES users(id),
  status VARCHAR(20) DEFAULT 'active',         -- active, cancelled, voided
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
CREATE INDEX IF NOT EXISTS idx_expenses_supplier_rnc ON expenses(supplier_rnc);
CREATE INDEX IF NOT EXISTS idx_expenses_status ON expenses(status);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category);
CREATE INDEX IF NOT EXISTS idx_expenses_created_by ON expenses(created_by);

-- ============================================================
-- list_expenses: List expenses with optional filters
-- ============================================================
CREATE OR REPLACE FUNCTION public.list_expenses(
  p_token TEXT,
  p_from_date DATE DEFAULT NULL,
  p_to_date DATE DEFAULT NULL,
  p_category TEXT DEFAULT NULL,
  p_status TEXT DEFAULT 'active',
  p_limit INT DEFAULT 50,
  p_offset INT DEFAULT 0
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_user_id UUID;
  v_role VARCHAR;
  v_results JSON;
  v_total INT;
BEGIN
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM require_role(p_token, ARRAY['operator','admin','super_admin']) r;

  SELECT COUNT(*) INTO v_total
  FROM expenses
  WHERE status = COALESCE(p_status, status)
    AND (p_from_date IS NULL OR expense_date >= p_from_date)
    AND (p_to_date IS NULL OR expense_date <= p_to_date)
    AND (p_category IS NULL OR category = p_category);

  SELECT json_agg(row_to_json(t)) INTO v_results
  FROM (
    SELECT e.*, u.email AS created_by_email
    FROM expenses e
    LEFT JOIN users u ON u.id = e.created_by
    WHERE e.status = COALESCE(p_status, e.status)
      AND (p_from_date IS NULL OR e.expense_date >= p_from_date)
      AND (p_to_date IS NULL OR e.expense_date <= p_to_date)
      AND (p_category IS NULL OR e.category = p_category)
    ORDER BY e.expense_date DESC, e.created_at DESC
    LIMIT p_limit OFFSET p_offset
  ) t;

  RETURN json_build_object(
    'success', true,
    'data', COALESCE(v_results, '[]'::json),
    'total', v_total
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$function$;

-- ============================================================
-- create_expense: Register a new expense
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_expense(p_token TEXT, p_data JSON)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_user_id UUID;
  v_role VARCHAR;
  v_new RECORD;
BEGIN
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM require_role(p_token, ARRAY['admin','super_admin']) r;

  INSERT INTO expenses (
    supplier_name, supplier_rnc, supplier_id_type,
    expense_type, ncf, ncf_modified,
    expense_date, payment_date,
    subtotal, itbis_amount, itbis_retenido,
    itbis_sujeto_proporcionalidad, itbis_llevado_costo,
    itbis_por_adelantar, itbis_percibido,
    isr_retencion_type, isr_retenido,
    impuesto_selectivo, otros_impuestos, propina_legal,
    total, payment_method, category, description,
    created_by
  ) VALUES (
    p_data->>'supplier_name',
    p_data->>'supplier_rnc',
    COALESCE(p_data->>'supplier_id_type', '1'),
    COALESCE(p_data->>'expense_type', '02'),
    p_data->>'ncf',
    p_data->>'ncf_modified',
    COALESCE((p_data->>'expense_date')::DATE, CURRENT_DATE),
    (p_data->>'payment_date')::DATE,
    COALESCE((p_data->>'subtotal')::NUMERIC, 0),
    COALESCE((p_data->>'itbis_amount')::NUMERIC, 0),
    COALESCE((p_data->>'itbis_retenido')::NUMERIC, 0),
    COALESCE((p_data->>'itbis_sujeto_proporcionalidad')::NUMERIC, 0),
    COALESCE((p_data->>'itbis_llevado_costo')::NUMERIC, 0),
    COALESCE((p_data->>'itbis_por_adelantar')::NUMERIC, 0),
    COALESCE((p_data->>'itbis_percibido')::NUMERIC, 0),
    COALESCE(p_data->>'isr_retencion_type', '00'),
    COALESCE((p_data->>'isr_retenido')::NUMERIC, 0),
    COALESCE((p_data->>'impuesto_selectivo')::NUMERIC, 0),
    COALESCE((p_data->>'otros_impuestos')::NUMERIC, 0),
    COALESCE((p_data->>'propina_legal')::NUMERIC, 0),
    COALESCE((p_data->>'total')::NUMERIC, 0),
    COALESCE(p_data->>'payment_method', '04'),
    p_data->>'category',
    p_data->>'description',
    v_user_id
  ) RETURNING * INTO v_new;

  -- Audit log
  PERFORM log_audit(v_user_id, 'expense_created', 'expense', v_new.id,
    jsonb_build_object('supplier', v_new.supplier_name, 'total', v_new.total, 'category', v_new.category));

  RETURN json_build_object('success', true, 'data', row_to_json(v_new));
EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$function$;

-- ============================================================
-- update_expense: Update an existing expense
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_expense(p_token TEXT, p_id UUID, p_data JSON)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_user_id UUID;
  v_role VARCHAR;
  v_updated RECORD;
BEGIN
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM require_role(p_token, ARRAY['admin','super_admin']) r;

  IF NOT EXISTS (SELECT 1 FROM expenses WHERE id = p_id AND status = 'active') THEN
    RETURN json_build_object('success', false, 'error', 'Gasto no encontrado o ya cancelado');
  END IF;

  UPDATE expenses SET
    supplier_name = COALESCE(p_data->>'supplier_name', supplier_name),
    supplier_rnc = COALESCE(p_data->>'supplier_rnc', supplier_rnc),
    supplier_id_type = COALESCE(p_data->>'supplier_id_type', supplier_id_type),
    expense_type = COALESCE(p_data->>'expense_type', expense_type),
    ncf = COALESCE(p_data->>'ncf', ncf),
    ncf_modified = COALESCE(p_data->>'ncf_modified', ncf_modified),
    expense_date = COALESCE((p_data->>'expense_date')::DATE, expense_date),
    payment_date = COALESCE((p_data->>'payment_date')::DATE, payment_date),
    subtotal = COALESCE((p_data->>'subtotal')::NUMERIC, subtotal),
    itbis_amount = COALESCE((p_data->>'itbis_amount')::NUMERIC, itbis_amount),
    itbis_retenido = COALESCE((p_data->>'itbis_retenido')::NUMERIC, itbis_retenido),
    itbis_sujeto_proporcionalidad = COALESCE((p_data->>'itbis_sujeto_proporcionalidad')::NUMERIC, itbis_sujeto_proporcionalidad),
    itbis_llevado_costo = COALESCE((p_data->>'itbis_llevado_costo')::NUMERIC, itbis_llevado_costo),
    itbis_por_adelantar = COALESCE((p_data->>'itbis_por_adelantar')::NUMERIC, itbis_por_adelantar),
    itbis_percibido = COALESCE((p_data->>'itbis_percibido')::NUMERIC, itbis_percibido),
    isr_retencion_type = COALESCE(p_data->>'isr_retencion_type', isr_retencion_type),
    isr_retenido = COALESCE((p_data->>'isr_retenido')::NUMERIC, isr_retenido),
    impuesto_selectivo = COALESCE((p_data->>'impuesto_selectivo')::NUMERIC, impuesto_selectivo),
    otros_impuestos = COALESCE((p_data->>'otros_impuestos')::NUMERIC, otros_impuestos),
    propina_legal = COALESCE((p_data->>'propina_legal')::NUMERIC, propina_legal),
    total = COALESCE((p_data->>'total')::NUMERIC, total),
    payment_method = COALESCE(p_data->>'payment_method', payment_method),
    category = COALESCE(p_data->>'category', category),
    description = COALESCE(p_data->>'description', description),
    updated_at = NOW()
  WHERE id = p_id
  RETURNING * INTO v_updated;

  PERFORM log_audit(v_user_id, 'expense_updated', 'expense', p_id,
    jsonb_build_object('supplier', v_updated.supplier_name, 'total', v_updated.total));

  RETURN json_build_object('success', true, 'data', row_to_json(v_updated));
EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$function$;

-- ============================================================
-- delete_expense: Soft-delete (cancel) an expense
-- ============================================================
CREATE OR REPLACE FUNCTION public.delete_expense(p_token TEXT, p_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_user_id UUID;
  v_role VARCHAR;
  v_expense RECORD;
BEGIN
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM require_role(p_token, ARRAY['admin','super_admin']) r;

  SELECT * INTO v_expense FROM expenses WHERE id = p_id;
  IF v_expense IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Gasto no encontrado');
  END IF;

  UPDATE expenses SET status = 'cancelled', updated_at = NOW() WHERE id = p_id;

  PERFORM log_audit(v_user_id, 'expense_deleted', 'expense', p_id,
    jsonb_build_object('supplier', v_expense.supplier_name, 'total', v_expense.total));

  RETURN json_build_object('success', true, 'message', 'Gasto cancelado');
EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$function$;

-- ============================================================
-- expense_stats: Summary stats for expenses
-- ============================================================
CREATE OR REPLACE FUNCTION public.expense_stats(
  p_token TEXT,
  p_from_date DATE DEFAULT NULL,
  p_to_date DATE DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_user_id UUID;
  v_role VARCHAR;
  v_total_amount NUMERIC;
  v_total_itbis NUMERIC;
  v_total_count INT;
  v_by_category JSON;
  v_by_type JSON;
BEGIN
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM require_role(p_token, ARRAY['admin','super_admin']) r;

  SELECT
    COALESCE(SUM(total), 0),
    COALESCE(SUM(itbis_amount), 0),
    COUNT(*)
  INTO v_total_amount, v_total_itbis, v_total_count
  FROM expenses
  WHERE status = 'active'
    AND (p_from_date IS NULL OR expense_date >= p_from_date)
    AND (p_to_date IS NULL OR expense_date <= p_to_date);

  SELECT json_agg(row_to_json(t)) INTO v_by_category
  FROM (
    SELECT category, COUNT(*) as count, SUM(total) as total
    FROM expenses
    WHERE status = 'active'
      AND (p_from_date IS NULL OR expense_date >= p_from_date)
      AND (p_to_date IS NULL OR expense_date <= p_to_date)
    GROUP BY category
    ORDER BY total DESC
  ) t;

  SELECT json_agg(row_to_json(t)) INTO v_by_type
  FROM (
    SELECT expense_type, COUNT(*) as count, SUM(total) as total
    FROM expenses
    WHERE status = 'active'
      AND (p_from_date IS NULL OR expense_date >= p_from_date)
      AND (p_to_date IS NULL OR expense_date <= p_to_date)
    GROUP BY expense_type
    ORDER BY total DESC
  ) t;

  RETURN json_build_object(
    'success', true,
    'data', json_build_object(
      'total_amount', v_total_amount,
      'total_itbis', v_total_itbis,
      'total_count', v_total_count,
      'by_category', COALESCE(v_by_category, '[]'::json),
      'by_type', COALESCE(v_by_type, '[]'::json)
    )
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$function$;
