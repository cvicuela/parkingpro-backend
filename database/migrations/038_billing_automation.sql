-- Migration 038: Billing Automation
-- Creates tables for automated billing cycle tracking and accumulation of extra charges.
-- Also seeds default billing configuration into the settings table.

-- ---------------------------------------------------------------------------
-- Table: billing_runs
-- Audit log that records every billing cycle execution with its outcome and
-- aggregate totals.  One row is created at the start of each run and updated
-- when the run completes or fails.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    run_date DATE NOT NULL DEFAULT CURRENT_DATE,
    status VARCHAR(20) NOT NULL DEFAULT 'running', -- running, completed, failed
    total_processed INTEGER DEFAULT 0,
    total_invoiced INTEGER DEFAULT 0,
    total_failed INTEGER DEFAULT 0,
    total_amount DECIMAL(12,2) DEFAULT 0,
    total_extras_amount DECIMAL(12,2) DEFAULT 0,
    details JSONB DEFAULT '[]'::jsonb,
    error_message TEXT,
    started_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Index for querying runs by date (e.g. "show me today's run")
CREATE INDEX IF NOT EXISTS idx_billing_runs_date ON billing_runs(run_date);

-- Index for filtering runs by status (e.g. find all failed runs)
CREATE INDEX IF NOT EXISTS idx_billing_runs_status ON billing_runs(status);

-- ---------------------------------------------------------------------------
-- Table: pending_charges
-- Accumulates extra charges incurred by a subscriber throughout the month
-- (overtime, lost tickets, NFC card replacements, etc.).  Charges are marked
-- 'invoiced' once they are included in a billing run invoice, and 'cancelled'
-- if they are voided before invoicing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pending_charges (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    subscription_id UUID REFERENCES subscriptions(id) ON DELETE CASCADE,
    customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
    type VARCHAR(30) NOT NULL, -- 'overtime', 'lost_ticket', 'nfc_replacement', 'other'
    amount DECIMAL(10,2) NOT NULL,
    tax_amount DECIMAL(10,2) DEFAULT 0,
    description TEXT,
    session_id UUID,
    invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending', 'invoiced', 'cancelled'
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Index for looking up all pending charges belonging to a subscription
CREATE INDEX IF NOT EXISTS idx_pending_charges_subscription ON pending_charges(subscription_id);

-- Index for looking up all pending charges belonging to a customer
CREATE INDEX IF NOT EXISTS idx_pending_charges_customer ON pending_charges(customer_id);

-- Index for filtering charges by status (e.g. find all un-invoiced charges)
CREATE INDEX IF NOT EXISTS idx_pending_charges_status ON pending_charges(status);

-- ---------------------------------------------------------------------------
-- Default billing settings
-- These values control the automated billing behaviour and can be overridden
-- at runtime through the settings table without requiring a new migration.
-- ON CONFLICT DO NOTHING ensures the migration is safely re-runnable.
-- ---------------------------------------------------------------------------
INSERT INTO settings (key, value) VALUES
  ('billing.auto_invoice',                   '"true"'),  -- enable/disable automatic invoice generation
  ('billing.ncf_type_subscription',          '"02"'),    -- NCF fiscal document type for subscription invoices
  ('billing.ncf_type_extras',                '"02"'),    -- NCF fiscal document type for extra-charge invoices
  ('billing.include_extras_in_subscription', '"true"'),  -- bundle extra charges into the subscription invoice
  ('billing.invoice_day',                    '"1"'),     -- day of the month on which invoices are generated
  ('billing.grace_period_days',              '"5"'),     -- days after invoice_day before a subscription is considered overdue
  ('billing.send_email',                     '"true"'),  -- send invoice notification emails to customers
  ('billing.reminder_days_before',           '"3"'),     -- days before due date to send a payment reminder
  ('billing.retry_failed_days',              '"3"'),     -- days between automatic retries for failed billing runs
  ('billing.max_retries',                    '"3"')      -- maximum number of retry attempts per failed invoice
ON CONFLICT (key) DO NOTHING;
