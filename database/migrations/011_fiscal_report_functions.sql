-- Add company_rnc setting if not exists
INSERT INTO settings (key, value, description, category)
VALUES ('company_rnc', '"000000000"', 'RNC de la empresa para reportes DGII', 'fiscal')
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value, description, category)
VALUES ('company_name', '"ParkingPro SRL"', 'Nombre de la empresa', 'fiscal')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- generate_607_report: Generate sales report data for DGII 607
-- ============================================================
CREATE OR REPLACE FUNCTION public.generate_607_report(
  p_token TEXT,
  p_period TEXT DEFAULT NULL,
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
  v_results JSON;
  v_count INT;
  v_totals JSON;
  v_start_date DATE;
  v_end_date DATE;
BEGIN
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM require_role(p_token, ARRAY['admin','super_admin']) r;

  IF p_period IS NOT NULL THEN
    v_start_date := (p_period || '01')::DATE;
    v_end_date := (v_start_date + INTERVAL '1 month' - INTERVAL '1 day')::DATE;
  ELSIF p_from_date IS NOT NULL THEN
    v_start_date := p_from_date;
    v_end_date := COALESCE(p_to_date, CURRENT_DATE);
  ELSE
    v_start_date := DATE_TRUNC('month', CURRENT_DATE)::DATE;
    v_end_date := CURRENT_DATE;
  END IF;

  SELECT json_agg(row_to_json(t)), COUNT(*) INTO v_results, v_count
  FROM (
    SELECT
      COALESCE(c.rnc, c.id_document, '') AS buyer_id,
      CASE
        WHEN c.rnc IS NOT NULL AND LENGTH(c.rnc) = 9 THEN '1'
        WHEN c.id_document IS NOT NULL AND LENGTH(c.id_document) = 11 THEN '2'
        WHEN c.id_document IS NOT NULL THEN '3'
        ELSE '2'
      END AS buyer_id_type,
      COALESCE(i.ncf, '') AS ncf,
      '' AS ncf_modified,
      '01' AS income_type,
      TO_CHAR(i.created_at, 'YYYYMMDD') AS invoice_date,
      '' AS retention_date,
      COALESCE(i.subtotal, 0) AS subtotal,
      COALESCE(i.tax_amount, 0) AS itbis,
      0 AS itbis_retenido,
      0 AS itbis_percibido,
      0 AS isr_retenido,
      0 AS impuesto_selectivo,
      0 AS otros_impuestos,
      0 AS propina_legal,
      CASE WHEN p.payment_method = 'cash' THEN COALESCE(i.total, 0) ELSE 0 END AS cash_amount,
      CASE WHEN p.payment_method = 'transfer' THEN COALESCE(i.total, 0) ELSE 0 END AS check_transfer_amount,
      CASE WHEN p.payment_method IN ('card', 'credit_card', 'debit_card') THEN COALESCE(i.total, 0) ELSE 0 END AS card_amount,
      CASE WHEN p.payment_method = 'credit' OR p.payment_method IS NULL THEN COALESCE(i.total, 0) ELSE 0 END AS credit_sale_amount,
      0 AS gift_amount,
      0 AS permuta_amount,
      0 AS other_amount,
      i.id AS invoice_id,
      i.invoice_number,
      i.total AS total_amount,
      COALESCE(c.first_name || ' ' || c.last_name, c.company_name, 'Consumidor Final') AS customer_name,
      p.payment_method
    FROM invoices i
    LEFT JOIN payments p ON p.id = i.payment_id
    LEFT JOIN customers c ON c.id = i.customer_id
    WHERE i.created_at >= v_start_date
      AND i.created_at < (v_end_date + INTERVAL '1 day')
    ORDER BY i.created_at
  ) t;

  SELECT json_build_object(
    'total_subtotal', COALESCE(SUM(i.subtotal), 0),
    'total_itbis', COALESCE(SUM(i.tax_amount), 0),
    'total_amount', COALESCE(SUM(i.total), 0),
    'count', COUNT(*)
  ) INTO v_totals
  FROM invoices i
  WHERE i.created_at >= v_start_date
    AND i.created_at < (v_end_date + INTERVAL '1 day');

  RETURN json_build_object(
    'success', true,
    'data', json_build_object(
      'rows', COALESCE(v_results, '[]'::json),
      'totals', v_totals,
      'period_start', v_start_date,
      'period_end', v_end_date
    )
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$function$;

-- ============================================================
-- generate_606_report: Generate purchases report data for DGII 606
-- ============================================================
CREATE OR REPLACE FUNCTION public.generate_606_report(
  p_token TEXT,
  p_period TEXT DEFAULT NULL,
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
  v_results JSON;
  v_count INT;
  v_totals JSON;
  v_start_date DATE;
  v_end_date DATE;
BEGIN
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM require_role(p_token, ARRAY['admin','super_admin']) r;

  IF p_period IS NOT NULL THEN
    v_start_date := (p_period || '01')::DATE;
    v_end_date := (v_start_date + INTERVAL '1 month' - INTERVAL '1 day')::DATE;
  ELSIF p_from_date IS NOT NULL THEN
    v_start_date := p_from_date;
    v_end_date := COALESCE(p_to_date, CURRENT_DATE);
  ELSE
    v_start_date := DATE_TRUNC('month', CURRENT_DATE)::DATE;
    v_end_date := CURRENT_DATE;
  END IF;

  SELECT json_agg(row_to_json(t)), COUNT(*) INTO v_results, v_count
  FROM (
    SELECT
      COALESCE(e.supplier_rnc, '') AS supplier_id,
      COALESCE(e.supplier_id_type, '1') AS supplier_id_type,
      e.expense_type,
      COALESCE(e.ncf, '') AS ncf,
      COALESCE(e.ncf_modified, '') AS ncf_modified,
      TO_CHAR(e.expense_date, 'YYYYMMDD') AS invoice_date,
      COALESCE(TO_CHAR(e.payment_date, 'YYYYMMDD'), '') AS payment_date,
      0 AS services_amount,
      COALESCE(e.subtotal, 0) AS goods_amount,
      COALESCE(e.subtotal, 0) AS total_invoiced,
      COALESCE(e.itbis_amount, 0) AS itbis,
      COALESCE(e.itbis_retenido, 0) AS itbis_retenido,
      COALESCE(e.itbis_sujeto_proporcionalidad, 0) AS itbis_proporcionalidad,
      COALESCE(e.itbis_llevado_costo, 0) AS itbis_costo,
      COALESCE(e.itbis_por_adelantar, 0) AS itbis_adelantar,
      COALESCE(e.itbis_percibido, 0) AS itbis_percibido,
      COALESCE(e.isr_retencion_type, '00') AS isr_type,
      COALESCE(e.isr_retenido, 0) AS isr_retenido,
      0 AS isr_percibido,
      COALESCE(e.impuesto_selectivo, 0) AS impuesto_selectivo,
      COALESCE(e.otros_impuestos, 0) AS otros_impuestos,
      COALESCE(e.propina_legal, 0) AS propina_legal,
      COALESCE(e.payment_method, '04') AS payment_method,
      e.id AS expense_id,
      e.supplier_name,
      e.category,
      e.total,
      e.description
    FROM expenses e
    WHERE e.status = 'active'
      AND e.expense_date >= v_start_date
      AND e.expense_date <= v_end_date
    ORDER BY e.expense_date
  ) t;

  SELECT json_build_object(
    'total_subtotal', COALESCE(SUM(e.subtotal), 0),
    'total_itbis', COALESCE(SUM(e.itbis_amount), 0),
    'total_amount', COALESCE(SUM(e.total), 0),
    'total_itbis_retenido', COALESCE(SUM(e.itbis_retenido), 0),
    'total_isr_retenido', COALESCE(SUM(e.isr_retenido), 0),
    'count', COUNT(*)
  ) INTO v_totals
  FROM expenses e
  WHERE e.status = 'active'
    AND e.expense_date >= v_start_date
    AND e.expense_date <= v_end_date;

  RETURN json_build_object(
    'success', true,
    'data', json_build_object(
      'rows', COALESCE(v_results, '[]'::json),
      'totals', v_totals,
      'period_start', v_start_date,
      'period_end', v_end_date
    )
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$function$;
