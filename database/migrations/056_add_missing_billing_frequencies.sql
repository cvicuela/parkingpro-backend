-- Migration 056: Add missing billing frequency enum values
-- The original enum only had: monthly, weekly, hourly
-- The UI and RPCs support: quarterly, semiannual, annual

ALTER TYPE billing_frequency ADD VALUE IF NOT EXISTS 'quarterly';
ALTER TYPE billing_frequency ADD VALUE IF NOT EXISTS 'semiannual';
ALTER TYPE billing_frequency ADD VALUE IF NOT EXISTS 'annual';
