-- Migration 078: fix dgii_search_rnc statement timeout on the 768K-row RNC registry
-- Applied to prod (ppxjjsfacbepctslyrma) 2026-05-24.
--
-- The old function did:
--   WHERE rnc LIKE q||'%' OR business_name ILIKE '%'||q||'%' OR trade_name ILIKE '%'||q||'%'
-- The two leading-wildcard ILIKEs are not indexable by btree, and the OR forced a full
-- seq scan of 768K rows for EVERY search (even a pure RNC-number lookup) -> "canceling
-- statement due to statement timeout".
--
-- Fix:
--  1) Split the query path: numeric input (an RNC) searches ONLY rnc by prefix (btree);
--     text input searches business_name/trade_name with pg_trgm.
--  2) Add a varchar_pattern_ops btree for rnc prefix LIKE (the PK btree can't serve
--     LIKE 'x%' unless the DB collation is C), and GIN trigram indexes for the name
--     substring search (added in a follow-up step to keep build times bounded).

SET statement_timeout = '120s';

CREATE INDEX IF NOT EXISTS idx_dgii_rnc_rnc_prefix
  ON public.dgii_rnc_registry (rnc varchar_pattern_ops);

CREATE OR REPLACE FUNCTION public.dgii_search_rnc(p_token text, p_query text, p_limit integer DEFAULT 20)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_user_id UUID;
  v_results JSON;
  v_clean   TEXT;
BEGIN
  SELECT r.user_id INTO v_user_id
  FROM require_role(p_token, ARRAY['operator','admin','super_admin']) r;

  v_clean := TRIM(COALESCE(p_query, ''));
  IF LENGTH(v_clean) < 3 THEN
    RETURN json_build_object('success', false, 'error', 'Mínimo 3 caracteres para buscar');
  END IF;

  IF v_clean ~ '^[0-9]+$' THEN
    -- RNC number: prefix search on the indexed rnc column (fast)
    SELECT json_agg(row_to_json(t)) INTO v_results FROM (
      SELECT rnc, business_name, trade_name, economic_activity, status
      FROM dgii_rnc_registry
      WHERE rnc LIKE v_clean || '%'
      ORDER BY CASE WHEN rnc = v_clean THEN 0 ELSE 1 END, rnc
      LIMIT p_limit
    ) t;
  ELSE
    -- Name / trade-name search (pg_trgm GIN indexes)
    SELECT json_agg(row_to_json(t)) INTO v_results FROM (
      SELECT rnc, business_name, trade_name, economic_activity, status
      FROM dgii_rnc_registry
      WHERE business_name ILIKE '%' || v_clean || '%'
         OR trade_name    ILIKE '%' || v_clean || '%'
      ORDER BY business_name
      LIMIT p_limit
    ) t;
  END IF;

  RETURN json_build_object('success', true, 'data', COALESCE(v_results, '[]'::json));
END;
$function$;

-- pg_trgm GIN indexes for the text-search path (pg_trgm already installed)
CREATE INDEX IF NOT EXISTS idx_dgii_rnc_business_trgm
  ON public.dgii_rnc_registry USING gin (business_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_dgii_rnc_trade_trgm
  ON public.dgii_rnc_registry USING gin (trade_name gin_trgm_ops);
