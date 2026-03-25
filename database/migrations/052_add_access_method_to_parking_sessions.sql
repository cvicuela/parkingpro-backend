ALTER TABLE parking_sessions ADD COLUMN IF NOT EXISTS access_method VARCHAR(20) DEFAULT 'qr';
COMMENT ON COLUMN parking_sessions.access_method IS 'How the vehicle entered: qr, rfid, or manual';
