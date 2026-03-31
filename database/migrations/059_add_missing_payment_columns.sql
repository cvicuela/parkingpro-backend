-- Migration 059: Add missing columns to payments table
-- The billing RPCs (039, 053, 055) insert invoice_number, ncf, and description
-- into payments but these columns were never added to the schema.

ALTER TABLE public.payments
    ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(50),
    ADD COLUMN IF NOT EXISTS ncf VARCHAR(50),
    ADD COLUMN IF NOT EXISTS description TEXT,
    ADD COLUMN IF NOT EXISTS refund_reason TEXT;
