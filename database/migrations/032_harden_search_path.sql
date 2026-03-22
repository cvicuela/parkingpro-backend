-- ============================================
-- MIGRACIÓN 032: Harden all functions with fixed search_path
-- Prevents object shadowing and ensures deterministic behavior
-- Uses safe DO blocks to skip functions that don't exist yet
-- ============================================

DO $do$
DECLARE
  fn RECORD;
  alter_cmds TEXT[] := ARRAY[
    -- Auth / token
    'ALTER FUNCTION public.verify_token_with_role(text) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.require_role(text, text[]) SET search_path = pg_catalog, public',
    -- User management
    'ALTER FUNCTION public.list_system_users(text) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.create_system_user(text, json) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.update_system_user(text, uuid, json) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.reset_user_password(text, uuid, text) SET search_path = pg_catalog, public',
    -- Session / parking
    'ALTER FUNCTION public.session_stats(text) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.lock_session_for_payment(text, uuid) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.atomic_session_exit(text, json) SET search_path = pg_catalog, public',
    -- Cash register
    'ALTER FUNCTION public.open_cash_register(text, json) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.safe_open_cash_register(text, json) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.get_active_register(text) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.close_cash_register(text, uuid, json) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.approve_cash_register(text, uuid, json) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.get_register_transactions(text, uuid) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.cash_register_history(text, int) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.get_cash_limits(text) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.process_parking_payment(text, json) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.list_operators(text) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.create_operator(text, json) SET search_path = pg_catalog, public',
    -- Expenses
    'ALTER FUNCTION public.list_expenses(text, text, text, text, text) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.create_expense(text, json) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.update_expense(text, uuid, json) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.delete_expense(text, uuid) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.expense_stats(text, text, text, text) SET search_path = pg_catalog, public',
    -- Fiscal / NCF
    'ALTER FUNCTION public.get_next_ncf(varchar) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.assign_ncf_to_invoice(uuid, varchar) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.list_ncf_sequences(text) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.update_ncf_sequence(text, uuid, json) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.generate_607_report(text, text, text) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.generate_606_report(text, text, text) SET search_path = pg_catalog, public',
    -- Reports
    'ALTER FUNCTION public.report_executive_summary(text) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.report_revenue(text, text, text, text, text) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.report_revenue_by_operator(text, text, text, text) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.report_cash_reconciliation(text, text, text, text) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.report_customers(text, text, text, text) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.report_occupancy(text, text, text, text) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.report_sessions(text, text, text, text) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.report_invoices(text, text, text, text) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.report_export_csv(text, text, text, text, text) SET search_path = pg_catalog, public',
    -- Notifications
    'ALTER FUNCTION public.list_notifications(text, text, int) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.notification_stats(text) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.send_notification(text, json) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.get_active_notification_emails(text) SET search_path = pg_catalog, public',
    -- Incidents
    'ALTER FUNCTION public.list_incidents(text, text, int) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.create_incident(text, json) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.resolve_incident(text, uuid, json) SET search_path = pg_catalog, public',
    -- Terminals
    'ALTER FUNCTION public.list_terminals(text) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.create_terminal(text, jsonb) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.update_terminal(text, uuid, jsonb) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.delete_terminal(text, uuid) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.terminal_heartbeat(text, text) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.get_terminal_stats(text) SET search_path = pg_catalog, public',
    -- Hourly rates & parking fee
    'ALTER FUNCTION public.get_hourly_rates(text, uuid) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.update_hourly_rates(text, uuid, json) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.calculate_hourly(text, json) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.calculate_parking_fee(text, json) SET search_path = pg_catalog, public',
    -- Validation helpers
    'ALTER FUNCTION public.validate_plate_format(text) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.validate_rnc(text) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.validate_phone_do(text) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.validate_email(text) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.sanitize_plate(text) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.validate_payment_amount(decimal) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.validate_input(text, text) SET search_path = pg_catalog, public',
    -- Reset data
    'ALTER FUNCTION public.reset_data_preview(text) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.reset_operational_data(text, text) SET search_path = pg_catalog, public',
    -- DGII
    'ALTER FUNCTION public.dgii_validate_rnc(text, text) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.dgii_import_rnc_batch(text, jsonb) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.dgii_rnc_stats(text) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.dgii_search_rnc(text, text, int) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.dgii_log_import(text, int, int, int, text, int) SET search_path = pg_catalog, public',
    -- Dashboard
    'ALTER FUNCTION public.get_dashboard_stats(text) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.list_active_sessions(text) SET search_path = pg_catalog, public',
    -- Tax helpers
    'ALTER FUNCTION public.extract_subtotal(decimal, decimal) SET search_path = pg_catalog, public',
    'ALTER FUNCTION public.extract_tax(decimal, decimal) SET search_path = pg_catalog, public',
    -- Date range helper
    'ALTER FUNCTION public.get_date_range(text, text, text) SET search_path = pg_catalog, public'
  ];
  cmd TEXT;
BEGIN
  FOREACH cmd IN ARRAY alter_cmds LOOP
    BEGIN
      EXECUTE cmd;
      RAISE NOTICE 'OK: %', cmd;
    EXCEPTION WHEN undefined_function THEN
      RAISE NOTICE 'SKIPPED (not found): %', cmd;
    END;
  END LOOP;
END;
$do$;
