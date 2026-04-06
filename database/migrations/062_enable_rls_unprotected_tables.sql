-- Migration 062: Enable RLS on all unprotected tables
-- Applied to Supabase as: enable_rls_unprotected_tables

-- 1. terminals
ALTER TABLE terminals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow authenticated select on terminals"
  ON terminals FOR SELECT TO authenticated USING (true);
CREATE POLICY "Block public access on terminals"
  ON terminals FOR ALL TO public USING (false);

-- 2. billing_runs
ALTER TABLE billing_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow authenticated select on billing_runs"
  ON billing_runs FOR SELECT TO authenticated USING (true);
CREATE POLICY "Block public access on billing_runs"
  ON billing_runs FOR ALL TO public USING (false);

-- 3. pending_charges
ALTER TABLE pending_charges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow authenticated select on pending_charges"
  ON pending_charges FOR SELECT TO authenticated USING (true);
CREATE POLICY "Block public access on pending_charges"
  ON pending_charges FOR ALL TO public USING (false);

-- 4. rfid_cards
ALTER TABLE rfid_cards ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow authenticated select on rfid_cards"
  ON rfid_cards FOR SELECT TO authenticated USING (true);
CREATE POLICY "Block public access on rfid_cards"
  ON rfid_cards FOR ALL TO public USING (false);

-- 5. ncf_audit_log
ALTER TABLE ncf_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow authenticated select on ncf_audit_log"
  ON ncf_audit_log FOR SELECT TO authenticated USING (true);
CREATE POLICY "Block public access on ncf_audit_log"
  ON ncf_audit_log FOR ALL TO public USING (false);

-- 6. zkteco_devices
ALTER TABLE zkteco_devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow authenticated select on zkteco_devices"
  ON zkteco_devices FOR SELECT TO authenticated USING (true);
CREATE POLICY "Block public access on zkteco_devices"
  ON zkteco_devices FOR ALL TO public USING (false);

-- 7. zkteco_device_events
ALTER TABLE zkteco_device_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow authenticated select on zkteco_device_events"
  ON zkteco_device_events FOR SELECT TO authenticated USING (true);
CREATE POLICY "Block public access on zkteco_device_events"
  ON zkteco_device_events FOR ALL TO public USING (false);
