-- Migration 067: Add 'free' to payment_status enum
--
-- Problem: register_exit (migrations/044) sets
--   payment_status = COALESCE(payment_status, 'free')
-- when a vehicle exits in grace period (no charge), but the
-- payment_status enum from schema.sql only declares
-- ('pending', 'paid', 'failed', 'refunded', 'chargeback').
--
-- Result: any grace-period exit fails with
--   "invalid input value for enum payment_status: 'free'"
-- which blocks operators from registering free exits.
--
-- Fix: extend the enum to accept 'free' so the existing
-- COALESCE in register_exit becomes valid. We use IF NOT EXISTS
-- so re-running is safe.

ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'free';

-- Note: ALTER TYPE ADD VALUE in PostgreSQL cannot run inside an
-- explicit transaction block in older versions, but Supabase's SQL
-- editor handles statement-level autocommit, so this works as-is.
