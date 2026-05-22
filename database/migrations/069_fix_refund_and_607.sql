-- Migration 069: Fix broken refund_payment + DGII 607 report contamination
-- Found via read-only prod audit (2026-05-22). Both are CREATE OR REPLACE (data-safe).
--
-- refund_payment bugs fixed:
--   * UPDATE payments SET ... updated_at=NOW()  -> payments has NO updated_at column (errored, refunds 100% broken)
--   * UPDATE invoices SET status='cancelled'    -> invoices has NO status/updated_at column (errored)
--   * cash-out only matched the refunding admin's open register (admins have none) -> refund untracked
-- Fix: reference only real columns; record cancellation in invoice metadata; attach the
--      refund cash-out to the best matching OPEN register and link it via payment_id.
--
-- generate_607_report bug fixed:
--   * Included ALL invoices in range -> cancelled/refunded sales AND non-fiscal/internal
--     invoices (blank or 'INV...'/'FAC...' numbers stamped into ncf) were filed to DGII.
--   * Validated on prod: 17 invoices -> only 2 are real fiscal NCFs; 15 were bogus.
-- Fix: only invoices whose ncf is a real fiscal NCF (^[BE][0-9]) and whose linked payment
--      is not refunded/failed/cancelled.

-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.refund_payment(p_token text, p_id uuid, p_reason text DEFAULT ''::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_user_id UUID;
  v_payment RECORD;
  v_refund_amount DECIMAL;
BEGIN
  SELECT r.user_id INTO v_user_id
  FROM require_role(p_token, ARRAY['admin', 'super_admin']) r;

  SELECT * INTO v_payment FROM payments WHERE id = p_id;
  IF v_payment IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Pago no encontrado');
  END IF;
  IF v_payment.status = 'refunded' THEN
    RETURN json_build_object('success', false, 'error', 'Este pago ya fue reembolsado');
  END IF;
  IF v_payment.status != 'paid' THEN
    RETURN json_build_object('success', false, 'error', 'Solo se pueden reembolsar pagos completados');
  END IF;

  v_refund_amount := v_payment.total_amount;

  -- payments has NO updated_at column (do not reference it).
  UPDATE payments SET
    status = 'refunded',
    refunded_at = NOW(),
    refund_reason = p_reason
  WHERE id = p_id;

  -- Record the refund cash-out against the best matching OPEN register
  -- (acting user's preferred), linked via payment_id so the books reconcile.
  INSERT INTO cash_register_transactions
    (cash_register_id, type, amount, direction, payment_method, operator_id, payment_id, description)
  SELECT cr.id, 'refund', v_refund_amount, 'out',
    COALESCE(v_payment.payment_method, 'cash'),
    v_user_id, p_id,
    'Reembolso: ' || COALESCE(p_reason, 'Sin razon especificada')
  FROM cash_registers cr
  WHERE cr.status = 'open'
  ORDER BY (cr.operator_id = v_user_id) DESC
  LIMIT 1;

  -- invoices has NO status/updated_at column: record cancellation in metadata.
  UPDATE invoices SET metadata = COALESCE(metadata, '{}'::jsonb)
    || jsonb_build_object('cancelled', true, 'cancelled_at', to_jsonb(NOW()), 'refund_reason', p_reason)
  WHERE payment_id = p_id;

  PERFORM log_audit(v_user_id, 'refund_payment', 'payment', p_id,
    jsonb_build_object('amount', v_refund_amount, 'reason', p_reason));

  RETURN json_build_object('success', true, 'data', json_build_object(
    'paymentId', p_id,
    'refundAmount', v_refund_amount,
    'reason', p_reason,
    'status', 'refunded'
  ));
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.generate_607_report(p_token text, p_period text DEFAULT NULL::text, p_from_date date DEFAULT NULL::date, p_to_date date DEFAULT NULL::date)
 RETURNS json
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
      -- FIX: only real fiscal NCFs (exclude blank / internal 'INV'/'FAC'/'PP-' numbers)
      AND i.ncf ~ '^[BE][0-9]'
      -- FIX: exclude cancelled/refunded/failed sales
      AND COALESCE(p.status::text, 'paid') NOT IN ('refunded', 'failed', 'cancelled')
    ORDER BY i.created_at
  ) t;

  SELECT json_build_object(
    'total_subtotal', COALESCE(SUM(i.subtotal), 0),
    'total_itbis', COALESCE(SUM(i.tax_amount), 0),
    'total_amount', COALESCE(SUM(i.total), 0),
    'count', COUNT(*)
  ) INTO v_totals
  FROM invoices i
  LEFT JOIN payments p ON p.id = i.payment_id
  WHERE i.created_at >= v_start_date
    AND i.created_at < (v_end_date + INTERVAL '1 day')
    AND i.ncf ~ '^[BE][0-9]'
    AND COALESCE(p.status::text, 'paid') NOT IN ('refunded', 'failed', 'cancelled');

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
