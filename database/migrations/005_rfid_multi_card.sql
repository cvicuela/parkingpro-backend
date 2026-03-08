-- Migration 005: Support multiple RFID cards per subscription
-- The rfid_cards table already supports this via subscription_id/customer_id (many-to-one)
-- We just deprecate the subscriptions.rfid_card_id column (keep for backwards compat but don't rely on it)

BEGIN;

-- Add a comment to indicate this column is deprecated
COMMENT ON COLUMN subscriptions.rfid_card_id IS 'DEPRECATED: Use rfid_cards.subscription_id instead. Multiple cards per subscription now supported.';

-- Add index for fast lookups by customer
CREATE INDEX IF NOT EXISTS idx_rfid_cards_customer_status ON rfid_cards (customer_id, status);

COMMIT;
