-- ZKTeco device persistence
CREATE TABLE IF NOT EXISTS zkteco_devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    serial_number VARCHAR(100) UNIQUE NOT NULL,
    name VARCHAR(200) NOT NULL,
    type VARCHAR(50) NOT NULL DEFAULT 'barrier', -- barrier, lpr_camera, controller, reader
    model VARCHAR(100) DEFAULT 'PB4000',
    ip_address INET,
    port INTEGER DEFAULT 4370,
    location VARCHAR(100) DEFAULT 'entrada_principal',
    direction VARCHAR(20) DEFAULT 'entry', -- entry, exit, bidirectional
    protocol VARCHAR(20) DEFAULT 'push', -- push, tcp, wiegand
    status VARCHAR(20) DEFAULT 'offline', -- online, offline, maintenance
    firmware_version VARCHAR(50),
    config JSONB DEFAULT '{}',
    connected_devices JSONB DEFAULT '[]',
    last_seen TIMESTAMPTZ,
    last_event JSONB,
    reading_mode BOOLEAN DEFAULT false,
    reading_requested_at TIMESTAMPTZ,
    reading_requested_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_zkteco_devices_serial ON zkteco_devices(serial_number);
CREATE INDEX idx_zkteco_devices_type ON zkteco_devices(type);
CREATE INDEX idx_zkteco_devices_status ON zkteco_devices(status);
CREATE INDEX idx_zkteco_devices_location ON zkteco_devices(location);

-- Device event log table
CREATE TABLE IF NOT EXISTS zkteco_device_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    serial_number VARCHAR(100) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    data JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_zkteco_events_serial ON zkteco_device_events(serial_number);
CREATE INDEX idx_zkteco_events_type ON zkteco_device_events(event_type);
CREATE INDEX idx_zkteco_events_created ON zkteco_device_events(created_at DESC);

-- Auto-purge old events (keep 30 days)
-- Can be called via cron or Supabase scheduled function
CREATE OR REPLACE FUNCTION purge_old_device_events()
RETURNS void AS $$
BEGIN
    DELETE FROM zkteco_device_events WHERE created_at < NOW() - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
