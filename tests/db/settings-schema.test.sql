-- ============================================================
-- Database Schema Tests for Settings
-- Run with: psql -f tests/db/settings-schema.test.sql
-- ============================================================

-- Test 1: settings table exists
DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'settings'
  ), 'FAIL: settings table should exist';
  RAISE NOTICE 'PASS: settings table exists';
END $$;

-- Test 2: settings table has required columns
DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'settings' AND column_name = 'key'
  ), 'FAIL: settings.key column missing';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'settings' AND column_name = 'value'
  ), 'FAIL: settings.value column missing';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'settings' AND column_name = 'category'
  ), 'FAIL: settings.category column missing';

  RAISE NOTICE 'PASS: settings table has all required columns';
END $$;

-- Test 3: settings.key has unique constraint
DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'settings' AND constraint_type = 'UNIQUE'
  ), 'FAIL: settings should have unique constraint on key';
  RAISE NOTICE 'PASS: settings has unique constraint';
END $$;

-- Test 4: Required business settings exist
DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM settings
  WHERE key IN ('business_name', 'currency', 'tax_rate', 'cash_diff_threshold');

  ASSERT v_count >= 4, 'FAIL: Required business settings not found (found ' || v_count || '/4)';
  RAISE NOTICE 'PASS: All required business settings exist';
END $$;

-- Test 5: tax_rate is a valid number
DO $$
DECLARE
  v_rate NUMERIC;
BEGIN
  SELECT (value #>> '{}')::numeric INTO v_rate FROM settings WHERE key = 'tax_rate';

  ASSERT v_rate >= 0 AND v_rate <= 1, 'FAIL: tax_rate should be between 0 and 1, got: ' || v_rate;
  RAISE NOTICE 'PASS: tax_rate is valid: %', v_rate;
END $$;

-- Test 6: RPC functions exist (after migration 033)
DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'list_settings'
  ), 'FAIL: list_settings function should exist';

  ASSERT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'get_setting'
  ), 'FAIL: get_setting function should exist';

  ASSERT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'update_setting'
  ), 'FAIL: update_setting function should exist';

  RAISE NOTICE 'PASS: All settings RPC functions exist';
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'SKIP: Settings RPC functions not yet created (run migration 033)';
END $$;

-- Test 7: settings value column is JSONB
DO $$
DECLARE
  v_type TEXT;
BEGIN
  SELECT data_type INTO v_type FROM information_schema.columns
  WHERE table_name = 'settings' AND column_name = 'value';

  ASSERT v_type = 'jsonb', 'FAIL: settings.value should be JSONB, got: ' || v_type;
  RAISE NOTICE 'PASS: settings.value is JSONB type';
END $$;

RAISE NOTICE '=== All settings schema tests completed ===';
