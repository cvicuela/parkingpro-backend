-- Track card payment details for reconciliation
ALTER TABLE payments ADD COLUMN IF NOT EXISTS card_brand VARCHAR(20);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS card_last_four VARCHAR(4);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS authorization_code VARCHAR(50);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS transaction_ref VARCHAR(100);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS webhook_verified BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_payments_transaction_ref ON payments(transaction_ref);
CREATE INDEX IF NOT EXISTS idx_payments_card_brand ON payments(card_brand);
