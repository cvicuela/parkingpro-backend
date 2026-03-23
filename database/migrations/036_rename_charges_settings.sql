-- Migration 036: Rename charge settings and remove additional_vehicle_monthly
-- charges.overage_hour → charges.lost_ticket (Ticket Perdido)
-- charges.replacement_qr → charges.nfc_replacement (Reposición Tarjeta NFC/RFID)
-- charges.additional_vehicle_monthly → REMOVED

BEGIN;

-- Rename overage_hour to lost_ticket
UPDATE settings SET key = 'charges.lost_ticket', description = 'Cargo por ticket perdido (RD$)'
WHERE key = 'charges.overage_hour';

-- Rename replacement_qr to nfc_replacement
UPDATE settings SET key = 'charges.nfc_replacement', description = 'Cargo por reposición de tarjeta NFC/RFID (RD$)'
WHERE key = 'charges.replacement_qr';

-- Remove additional_vehicle_monthly (not used)
DELETE FROM settings WHERE key = 'charges.additional_vehicle_monthly';

-- Insert if they don't exist yet (fresh installs that ran new seed)
INSERT INTO settings (key, value, description, category)
VALUES ('charges.lost_ticket', '"500"', 'Cargo por ticket perdido (RD$)', 'charges')
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value, description, category)
VALUES ('charges.nfc_replacement', '"150"', 'Cargo por reposición de tarjeta NFC/RFID (RD$)', 'charges')
ON CONFLICT (key) DO NOTHING;

-- Add lost_ticket_fee and nfc_replacement_fee columns to plans table
ALTER TABLE plans ADD COLUMN IF NOT EXISTS lost_ticket_fee DECIMAL(10,2) DEFAULT 500.00;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS nfc_replacement_fee DECIMAL(10,2) DEFAULT 150.00;

-- Remove additional_vehicle_monthly column from plans if it exists
ALTER TABLE plans DROP COLUMN IF EXISTS additional_vehicle_monthly;

COMMIT;
