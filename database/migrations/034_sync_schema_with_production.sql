-- ============================================================
-- MIGRATION 034: Sync schema with Supabase production database
-- Project: ppxjjsfacbepctslyrma
-- Date: 2026-03-22
--
-- Documents column differences found between schema.sql and
-- the production Supabase database. All statements use IF EXISTS
-- / IF NOT EXISTS guards so they are safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. plans table
--    Production uses `base_price` (not `price`) and `type` as a
--    USER-DEFINED enum.  The local schema.sql already had base_price
--    and the plan_type enum; this migration is a no-op for plans
--    but documents the expected column set for clarity.
-- ------------------------------------------------------------
DO $$
BEGIN
    -- Rename `price` -> `base_price` if the old column still exists
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'plans' AND column_name = 'price'
    ) THEN
        ALTER TABLE plans RENAME COLUMN price TO base_price;
    END IF;
END $$;

-- ------------------------------------------------------------
-- 2. parking_sessions table
--    Production has `vehicle_plate` (confirmed) and an extra
--    `verification_code` column.
-- ------------------------------------------------------------
DO $$
BEGIN
    -- Add verification_code if missing
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'parking_sessions' AND column_name = 'verification_code'
    ) THEN
        ALTER TABLE parking_sessions ADD COLUMN verification_code VARCHAR(50);
    END IF;
END $$;

-- ------------------------------------------------------------
-- 3. payments table
--    Production has no `session_id`; uses `subscription_id`.
--    Production also has: card_last_four, authorization_code,
--    transaction_ref, webhook_verified.
-- ------------------------------------------------------------
DO $$
BEGIN
    -- Drop session_id if it exists (production does not have it)
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'payments' AND column_name = 'session_id'
    ) THEN
        ALTER TABLE payments DROP COLUMN session_id;
    END IF;

    -- Add card_last_four if missing
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'payments' AND column_name = 'card_last_four'
    ) THEN
        ALTER TABLE payments ADD COLUMN card_last_four VARCHAR(4);
    END IF;

    -- Add authorization_code if missing
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'payments' AND column_name = 'authorization_code'
    ) THEN
        ALTER TABLE payments ADD COLUMN authorization_code VARCHAR(100);
    END IF;

    -- Add transaction_ref if missing
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'payments' AND column_name = 'transaction_ref'
    ) THEN
        ALTER TABLE payments ADD COLUMN transaction_ref VARCHAR(255);
    END IF;

    -- Add webhook_verified if missing
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'payments' AND column_name = 'webhook_verified'
    ) THEN
        ALTER TABLE payments ADD COLUMN webhook_verified BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

-- ------------------------------------------------------------
-- 4. ncf_sequences table
--    Production uses: ncf_type, series, prefix, current_number,
--    range_from, range_to, expiration_date.
--    (Was previously created in migration 012 with correct names.)
--    This block ensures the table exists with production columns.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ncf_sequences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ncf_type VARCHAR(10) NOT NULL,
    series VARCHAR(5),
    prefix VARCHAR(10),
    current_number BIGINT NOT NULL DEFAULT 1,
    range_from BIGINT NOT NULL DEFAULT 1,
    range_to BIGINT NOT NULL,
    alert_threshold INT NOT NULL DEFAULT 100,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    description VARCHAR(255),
    authorized_date DATE,
    expiration_date DATE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(ncf_type, series, is_active)
);

-- Rename legacy column names if present (old schema used different names)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ncf_sequences' AND column_name = 'tipo_comprobante'
    ) THEN
        ALTER TABLE ncf_sequences RENAME COLUMN tipo_comprobante TO ncf_type;
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ncf_sequences' AND column_name = 'serie'
    ) THEN
        ALTER TABLE ncf_sequences RENAME COLUMN serie TO series;
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ncf_sequences' AND column_name = 'secuencia_actual'
    ) THEN
        ALTER TABLE ncf_sequences RENAME COLUMN secuencia_actual TO current_number;
    END IF;
END $$;

-- ------------------------------------------------------------
-- 5. settings table
--    Production uses `updated_at TIMESTAMP WITH TIME ZONE`.
-- ------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'settings'
          AND column_name = 'updated_at'
          AND data_type = 'timestamp without time zone'
    ) THEN
        ALTER TABLE settings
            ALTER COLUMN updated_at TYPE TIMESTAMP WITH TIME ZONE
            USING updated_at AT TIME ZONE 'UTC';
    END IF;
END $$;
