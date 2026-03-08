-- Migration 004: RFID Hybrid Access Support
-- Adds RFID card management alongside existing QR-based access

BEGIN;

-- =============================================================================
-- 1. Create access_method enum
-- =============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'access_method') THEN
        CREATE TYPE access_method AS ENUM ('qr', 'rfid', 'manual');
    END IF;
END
$$;

-- =============================================================================
-- 2. Create rfid_cards table
-- =============================================================================

CREATE TABLE IF NOT EXISTS rfid_cards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    card_uid VARCHAR(20) UNIQUE NOT NULL,
    card_type VARCHAR(20) NOT NULL CHECK (card_type IN ('permanent', 'temporary')),
    status VARCHAR(20) NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'assigned', 'in_use', 'lost', 'disabled')),
    subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    assigned_at TIMESTAMP,
    returned_at TIMESTAMP,
    label VARCHAR(100),
    lost_penalty DECIMAL(10,2),
    metadata JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- 3. Add columns to existing tables
-- =============================================================================

-- parking_sessions
ALTER TABLE parking_sessions
    ADD COLUMN IF NOT EXISTS access_method access_method DEFAULT 'qr',
    ADD COLUMN IF NOT EXISTS rfid_card_id UUID REFERENCES rfid_cards(id) ON DELETE SET NULL;

-- access_events
ALTER TABLE access_events
    ADD COLUMN IF NOT EXISTS access_method access_method,
    ADD COLUMN IF NOT EXISTS rfid_card_id UUID REFERENCES rfid_cards(id) ON DELETE SET NULL;

-- subscriptions
ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS rfid_card_id UUID REFERENCES rfid_cards(id) ON DELETE SET NULL;

-- =============================================================================
-- 4. Migrate existing data
-- =============================================================================

UPDATE access_events
SET access_method = CASE
    WHEN validation_method = 'manual' THEN 'manual'::access_method
    ELSE 'qr'::access_method
END
WHERE access_method IS NULL;

-- =============================================================================
-- 5. Add system settings for RFID
-- =============================================================================

INSERT INTO settings (key, value, description, category)
VALUES ('rfid_lost_card_penalty', '500.00', 'Penalización por tarjeta RFID perdida (RD$)', 'parqueo')
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value, description, category)
VALUES ('rfid_max_temporary_cards', '100', 'Cantidad máxima de tarjetas temporales en el pool', 'parqueo')
ON CONFLICT (key) DO NOTHING;

-- =============================================================================
-- 6. Create indexes on rfid_cards
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_rfid_cards_card_uid ON rfid_cards (card_uid);
CREATE INDEX IF NOT EXISTS idx_rfid_cards_card_type ON rfid_cards (card_type);
CREATE INDEX IF NOT EXISTS idx_rfid_cards_status ON rfid_cards (status);
CREATE INDEX IF NOT EXISTS idx_rfid_cards_subscription_id ON rfid_cards (subscription_id);
CREATE INDEX IF NOT EXISTS idx_rfid_cards_customer_id ON rfid_cards (customer_id);

-- =============================================================================
-- 7. Add updated_at trigger for rfid_cards
-- =============================================================================

CREATE OR REPLACE FUNCTION update_rfid_cards_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_rfid_cards_updated_at ON rfid_cards;

CREATE TRIGGER trg_rfid_cards_updated_at
    BEFORE UPDATE ON rfid_cards
    FOR EACH ROW
    EXECUTE FUNCTION update_rfid_cards_updated_at();

-- =============================================================================
-- 8. Create rfid_pool_status view
-- =============================================================================

CREATE OR REPLACE VIEW rfid_pool_status AS
SELECT
    rc.id,
    rc.card_uid,
    rc.card_type,
    rc.status,
    rc.label,
    rc.assigned_at,
    rc.returned_at,
    rc.lost_penalty,
    c.name AS customer_name,
    s.id AS subscription_id,
    p.name AS plan_name
FROM rfid_cards rc
LEFT JOIN customers c ON rc.customer_id = c.id
LEFT JOIN subscriptions s ON rc.subscription_id = s.id
LEFT JOIN plans p ON s.plan_id = p.id;

COMMIT;
