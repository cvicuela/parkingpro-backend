-- ============================================
-- MIGRACIÓN 045: RPC nfc_replacement_charge
-- Converts REST endpoint /api/v1/access/nfc-replacement-charge to RPC
-- so it works in remote/Supabase deployment mode
-- ============================================

CREATE OR REPLACE FUNCTION public.nfc_replacement_charge(p_token TEXT, p_data JSONB)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id UUID;
  v_plate VARCHAR;
  v_card_id UUID;
  v_customer_id UUID;
  v_nfc_fee DECIMAL;
  v_plan_record RECORD;
  v_subtotal DECIMAL;
  v_tax DECIMAL;
  v_total DECIMAL;
  v_setting_val TEXT;
  v_session RECORD;
BEGIN
  -- Auth
  SELECT r.user_id INTO v_user_id
  FROM require_role(p_token, ARRAY['operator', 'admin', 'super_admin']) r;

  v_plate := UPPER(TRIM(COALESCE(p_data->>'plateNumber', '')));
  v_card_id := (p_data->>'cardId')::UUID;
  v_customer_id := (p_data->>'customerId')::UUID;

  -- 1. Try to get fee from customer's active plan
  IF v_customer_id IS NOT NULL THEN
    SELECT p.nfc_replacement_fee, p.name AS plan_name
    INTO v_plan_record
    FROM subscriptions s
    JOIN plans p ON s.plan_id = p.id
    WHERE s.customer_id = v_customer_id AND s.status = 'active'
    LIMIT 1;

    IF v_plan_record IS NOT NULL AND v_plan_record.nfc_replacement_fee IS NOT NULL THEN
      v_nfc_fee := v_plan_record.nfc_replacement_fee;
    END IF;
  END IF;

  -- 2. Fallback: try from active session by plate
  IF v_nfc_fee IS NULL AND v_plate != '' THEN
    SELECT ps.id, ps.customer_id, p.nfc_replacement_fee
    INTO v_session
    FROM parking_sessions ps
    JOIN plans p ON ps.plan_id = p.id
    WHERE ps.vehicle_plate = v_plate AND ps.status = 'active'
    ORDER BY ps.entry_time DESC LIMIT 1;

    IF v_session IS NOT NULL AND v_session.nfc_replacement_fee IS NOT NULL THEN
      v_nfc_fee := v_session.nfc_replacement_fee;
      v_customer_id := COALESCE(v_customer_id, v_session.customer_id);
    END IF;
  END IF;

  -- 3. Fallback: global setting
  IF v_nfc_fee IS NULL THEN
    SELECT value#>>'{}' INTO v_setting_val FROM settings WHERE key = 'charges.nfc_replacement';
    IF v_setting_val IS NOT NULL AND v_setting_val != '' THEN
      v_nfc_fee := v_setting_val::DECIMAL;
    ELSE
      v_nfc_fee := 150; -- Default RD$150
    END IF;
  END IF;

  -- 4. Mark card as lost if cardId provided
  IF v_card_id IS NOT NULL THEN
    UPDATE rfid_cards
    SET status = 'lost',
        metadata = jsonb_set(COALESCE(metadata, '{}'), '{lost_at}', to_jsonb(NOW()::TEXT))
    WHERE id = v_card_id;
  END IF;

  -- 5. Calculate total with tax
  v_subtotal := v_nfc_fee;
  v_tax := ROUND(v_subtotal * 0.18, 2);
  v_total := v_subtotal + v_tax;

  RETURN json_build_object(
    'success', true,
    'data', json_build_object(
      'type', 'nfc_replacement',
      'cardId', v_card_id,
      'customerId', v_customer_id,
      'plateNumber', v_plate,
      'subtotal', v_subtotal,
      'tax', v_tax,
      'total', v_total,
      'nfc_replacement_fee', v_nfc_fee,
      'charge_reason', 'Cargo por reposición de tarjeta NFC/RFID',
      'payment_status', 'pending'
    )
  );
END;
$$;
