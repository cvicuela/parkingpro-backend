-- NCF Sequences Table
CREATE TABLE IF NOT EXISTS ncf_sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ncf_type VARCHAR(2) NOT NULL,
  series VARCHAR(1) NOT NULL DEFAULT 'B',
  prefix VARCHAR(4) NOT NULL,
  current_number BIGINT NOT NULL DEFAULT 0,
  range_from BIGINT NOT NULL DEFAULT 1,
  range_to BIGINT NOT NULL,
  alert_threshold INT NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT true,
  description VARCHAR(255),
  authorized_date DATE,
  expiration_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(ncf_type, series, is_active)
);

INSERT INTO ncf_sequences (ncf_type, series, prefix, range_from, range_to, description) VALUES
  ('02', 'B', 'B02', 1, 50000, 'Factura de Consumo - ventas a consumidores finales'),
  ('01', 'B', 'B01', 1, 10000, 'Factura de Crédito Fiscal - ventas B2B con ITBIS deducible'),
  ('14', 'B', 'B14', 1, 5000, 'Comprobante para Regímenes Especiales'),
  ('15', 'B', 'B15', 1, 5000, 'Comprobante Gubernamental'),
  ('11', 'B', 'B11', 1, 5000, 'Comprobante de Compras - proveedores informales'),
  ('03', 'B', 'B03', 1, 5000, 'Nota de Débito'),
  ('04', 'B', 'B04', 1, 5000, 'Nota de Crédito'),
  ('13', 'B', 'B13', 1, 10000, 'Comprobante para Gastos Menores')
ON CONFLICT DO NOTHING;

-- Atomic NCF generation function
CREATE OR REPLACE FUNCTION public.get_next_ncf(p_ncf_type VARCHAR DEFAULT '02')
RETURNS TEXT LANGUAGE plpgsql AS $function$
DECLARE
  v_seq RECORD; v_next BIGINT; v_ncf TEXT;
BEGIN
  SELECT * INTO v_seq FROM ncf_sequences
  WHERE ncf_type = p_ncf_type AND is_active = true FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No active NCF sequence for type %', p_ncf_type; END IF;
  v_next := v_seq.current_number + 1;
  IF v_next > v_seq.range_to THEN RAISE EXCEPTION 'NCF sequence exhausted for type %', p_ncf_type; END IF;
  IF v_seq.expiration_date IS NOT NULL AND v_seq.expiration_date < CURRENT_DATE THEN
    RAISE EXCEPTION 'NCF sequence expired for type %', p_ncf_type;
  END IF;
  UPDATE ncf_sequences SET current_number = v_next, updated_at = NOW() WHERE id = v_seq.id;
  IF v_seq.series = 'E' THEN v_ncf := v_seq.prefix || LPAD(v_next::TEXT, 10, '0');
  ELSE v_ncf := v_seq.prefix || LPAD(v_next::TEXT, 8, '0'); END IF;
  RETURN v_ncf;
END; $function$;

-- Assign NCF to invoice
CREATE OR REPLACE FUNCTION public.assign_ncf_to_invoice(
  p_token TEXT, p_invoice_id UUID, p_ncf_type VARCHAR DEFAULT '02'
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE v_user_id UUID; v_role VARCHAR; v_ncf TEXT; v_existing TEXT;
BEGIN
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM require_role(p_token, ARRAY['operator','admin','super_admin']) r;
  SELECT ncf INTO v_existing FROM invoices WHERE id = p_invoice_id;
  IF v_existing IS NOT NULL AND v_existing != '' THEN
    RETURN json_build_object('success', false, 'error', 'Ya tiene NCF: ' || v_existing);
  END IF;
  v_ncf := get_next_ncf(p_ncf_type);
  UPDATE invoices SET ncf = v_ncf WHERE id = p_invoice_id;
  INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
  VALUES (v_user_id, 'ncf_assigned', 'invoice', p_invoice_id,
    jsonb_build_object('ncf', v_ncf, 'ncf_type', p_ncf_type));
  RETURN json_build_object('success', true, 'data', json_build_object('ncf', v_ncf, 'invoice_id', p_invoice_id));
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', SQLERRM);
END; $function$;

-- List NCF sequences with status
CREATE OR REPLACE FUNCTION public.list_ncf_sequences(p_token TEXT)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE v_user_id UUID; v_role VARCHAR; v_results JSON;
BEGIN
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM require_role(p_token, ARRAY['admin','super_admin']) r;
  SELECT json_agg(row_to_json(t)) INTO v_results FROM (
    SELECT id, ncf_type, series, prefix, current_number, range_from, range_to,
      alert_threshold, is_active, description, authorized_date, expiration_date,
      (range_to - current_number) AS remaining,
      ROUND((current_number::NUMERIC / range_to) * 100, 1) AS usage_pct,
      (range_to - current_number) <= alert_threshold AS needs_alert,
      created_at, updated_at
    FROM ncf_sequences ORDER BY ncf_type
  ) t;
  RETURN json_build_object('success', true, 'data', COALESCE(v_results, '[]'::json));
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', SQLERRM);
END; $function$;

-- Update NCF sequence
CREATE OR REPLACE FUNCTION public.update_ncf_sequence(
  p_token TEXT, p_id UUID, p_range_from BIGINT DEFAULT NULL,
  p_range_to BIGINT DEFAULT NULL,
  p_alert_threshold INT DEFAULT NULL, p_is_active BOOLEAN DEFAULT NULL,
  p_authorized_date DATE DEFAULT NULL, p_expiration_date DATE DEFAULT NULL
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE v_user_id UUID; v_role VARCHAR;
BEGIN
  SELECT r.user_id, r.user_role INTO v_user_id, v_role
  FROM require_role(p_token, ARRAY['admin','super_admin']) r;
  UPDATE ncf_sequences SET
    range_from = COALESCE(p_range_from, range_from),
    range_to = COALESCE(p_range_to, range_to),
    alert_threshold = COALESCE(p_alert_threshold, alert_threshold),
    is_active = COALESCE(p_is_active, is_active),
    authorized_date = COALESCE(p_authorized_date, authorized_date),
    expiration_date = COALESCE(p_expiration_date, expiration_date),
    updated_at = NOW()
  WHERE id = p_id;
  INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
  VALUES (v_user_id, 'ncf_sequence_updated', 'ncf_sequences', p_id,
    jsonb_build_object('range_from', p_range_from, 'range_to', p_range_to, 'alert_threshold', p_alert_threshold));
  RETURN json_build_object('success', true);
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', SQLERRM);
END; $function$;
