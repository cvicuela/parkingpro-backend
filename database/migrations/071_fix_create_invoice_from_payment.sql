-- Migration 071: Fix create_invoice_from_payment NCF fabrication
-- Bug: built NCF as 'B01' || (SELECT COUNT(*)+1 FROM invoices) — bypassed get_next_ncf /
--   ncf_sequences entirely (race-prone, collides after deletes, untracked DGII range),
--   and those fake-but-fiscal-looking 'B01...' NCFs would even pass the 607 fiscal filter.
-- Fix: idempotent (return existing invoice); respect invoice_mode — fiscal uses the real
--   get_next_ncf sequence, internal uses the locked internal counter with ncf = NULL.

CREATE OR REPLACE FUNCTION public.create_invoice_from_payment(p_token text, p_payment_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_user_id UUID;
  v_payment RECORD;
  v_invoice RECORD;
  v_invoice_mode TEXT;
  v_invoice_number TEXT;
  v_ncf TEXT;
  v_inv_prefix TEXT;
  v_inv_next BIGINT;
BEGIN
  v_user_id := verify_token(p_token);
  IF v_user_id IS NULL THEN RETURN json_build_object('success', false, 'error', 'No autorizado'); END IF;

  SELECT * INTO v_payment FROM payments WHERE id = p_payment_id;
  IF v_payment IS NULL THEN RETURN json_build_object('success', false, 'error', 'Pago no encontrado'); END IF;

  -- Idempotent: return the existing invoice if one already exists for this payment.
  SELECT * INTO v_invoice FROM invoices WHERE payment_id = p_payment_id LIMIT 1;
  IF v_invoice IS NOT NULL THEN
    RETURN json_build_object('success', true, 'data', row_to_json(v_invoice));
  END IF;

  SELECT COALESCE(value#>>'{}', 'interno') INTO v_invoice_mode FROM settings WHERE key = 'invoice_mode';
  v_invoice_mode := COALESCE(v_invoice_mode, 'interno');

  IF v_invoice_mode = 'fiscal' THEN
    BEGIN
      v_ncf := get_next_ncf('02', 'manual_invoice', v_user_id);
      v_invoice_number := v_ncf;
    EXCEPTION WHEN OTHERS THEN
      v_ncf := NULL; v_invoice_number := NULL;
    END;
  END IF;

  IF v_invoice_number IS NULL THEN
    SELECT COALESCE(value#>>'{}', 'FAC') INTO v_inv_prefix FROM settings WHERE key = 'internal_invoice_prefix';
    SELECT COALESCE((value#>>'{}')::BIGINT, 1) INTO v_inv_next FROM settings WHERE key = 'internal_invoice_next' FOR UPDATE;
    v_inv_prefix := COALESCE(v_inv_prefix, 'FAC');
    v_inv_next := COALESCE(v_inv_next, 1);
    v_invoice_number := v_inv_prefix || LPAD(v_inv_next::TEXT, 8, '0');
    v_ncf := NULL;
    UPDATE settings SET value = to_jsonb((v_inv_next + 1)::TEXT) WHERE key = 'internal_invoice_next';
    IF NOT FOUND THEN
      INSERT INTO settings (key, value, description, category)
      VALUES ('internal_invoice_next', to_jsonb('2'), 'Proximo numero secuencial de factura interna', 'facturacion');
    END IF;
  END IF;

  INSERT INTO invoices (payment_id, customer_id, invoice_number, ncf, subtotal, tax_amount, total, currency, items)
  VALUES (v_payment.id, v_payment.customer_id, v_invoice_number, v_ncf,
    v_payment.amount, v_payment.tax_amount, v_payment.total_amount, 'DOP',
    json_build_array(json_build_object('description', 'Pago de servicio', 'quantity', 1,
      'unit_price', v_payment.amount, 'amount', v_payment.amount))::jsonb)
  RETURNING * INTO v_invoice;

  RETURN json_build_object('success', true, 'data', row_to_json(v_invoice));
END;
$function$;
