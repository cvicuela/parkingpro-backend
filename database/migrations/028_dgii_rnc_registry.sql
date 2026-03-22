-- Migration 028: DGII RNC Registry
-- Local database of valid RNC numbers from DGII for B01 invoice validation.
-- Admin can update this via a bulk import from the DGII published file.

-- ============================================
-- TABLE: dgii_rnc_registry
-- ============================================

CREATE TABLE IF NOT EXISTS dgii_rnc_registry (
    rnc VARCHAR(11) PRIMARY KEY,          -- RNC (9 digits) or cédula (11 digits)
    business_name TEXT NOT NULL,           -- Razón social / nombre comercial
    trade_name TEXT,                       -- Nombre comercial
    economic_activity TEXT,                -- Actividad económica
    status VARCHAR(20) DEFAULT 'active',   -- active, inactive, suspended
    payment_regime TEXT,                   -- Régimen de pago
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dgii_rnc_name ON dgii_rnc_registry(business_name);
CREATE INDEX IF NOT EXISTS idx_dgii_rnc_status ON dgii_rnc_registry(status);

-- Metadata table for tracking import history
CREATE TABLE IF NOT EXISTS dgii_rnc_import_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imported_by UUID REFERENCES users(id),
    records_imported INT NOT NULL DEFAULT 0,
    records_updated INT NOT NULL DEFAULT 0,
    records_total INT NOT NULL DEFAULT 0,
    source TEXT,                            -- 'dgii_file', 'manual', etc.
    import_duration_ms INT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- RPC: Validate an RNC against local registry
-- Returns the business info if found, or error if not
-- ============================================

CREATE OR REPLACE FUNCTION dgii_validate_rnc(
    p_token TEXT,
    p_rnc TEXT
)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_user_id UUID;
    v_clean_rnc TEXT;
    v_record RECORD;
BEGIN
    SELECT r.user_id INTO v_user_id
    FROM require_role(p_token, ARRAY['operator','admin','super_admin']) r;

    -- Clean the RNC (remove dashes and spaces)
    v_clean_rnc := REGEXP_REPLACE(COALESCE(p_rnc, ''), '[^0-9]', '', 'g');

    IF LENGTH(v_clean_rnc) NOT IN (9, 11) THEN
        RETURN json_build_object(
            'success', false,
            'valid', false,
            'error', 'RNC debe tener 9 dígitos (empresa) u 11 dígitos (persona física)'
        );
    END IF;

    SELECT * INTO v_record
    FROM dgii_rnc_registry
    WHERE rnc = v_clean_rnc;

    IF NOT FOUND THEN
        RETURN json_build_object(
            'success', true,
            'valid', false,
            'rnc', v_clean_rnc,
            'message', 'RNC no encontrado en el registro DGII local. Puede necesitar actualizar la base de datos.'
        );
    END IF;

    IF v_record.status != 'active' THEN
        RETURN json_build_object(
            'success', true,
            'valid', false,
            'rnc', v_clean_rnc,
            'business_name', v_record.business_name,
            'status', v_record.status,
            'message', 'RNC encontrado pero con estado: ' || v_record.status
        );
    END IF;

    RETURN json_build_object(
        'success', true,
        'valid', true,
        'rnc', v_clean_rnc,
        'business_name', v_record.business_name,
        'trade_name', v_record.trade_name,
        'economic_activity', v_record.economic_activity,
        'status', v_record.status,
        'payment_regime', v_record.payment_regime
    );
END;
$$;

-- ============================================
-- RPC: Bulk import RNC records (batch upsert)
-- Called in chunks from the backend import endpoint
-- ============================================

CREATE OR REPLACE FUNCTION dgii_import_rnc_batch(
    p_token TEXT,
    p_records JSONB
)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_user_id UUID;
    v_imported INT := 0;
    v_updated INT := 0;
    v_rec RECORD;
BEGIN
    SELECT r.user_id INTO v_user_id
    FROM require_role(p_token, ARRAY['super_admin']) r;

    FOR v_rec IN SELECT value FROM jsonb_array_elements(p_records)
    LOOP
        INSERT INTO dgii_rnc_registry (rnc, business_name, trade_name, economic_activity, status, payment_regime, updated_at)
        VALUES (
            v_rec.value->>'rnc',
            COALESCE(v_rec.value->>'business_name', ''),
            v_rec.value->>'trade_name',
            v_rec.value->>'economic_activity',
            COALESCE(v_rec.value->>'status', 'active'),
            v_rec.value->>'payment_regime',
            NOW()
        )
        ON CONFLICT (rnc) DO UPDATE SET
            business_name = EXCLUDED.business_name,
            trade_name = EXCLUDED.trade_name,
            economic_activity = EXCLUDED.economic_activity,
            status = EXCLUDED.status,
            payment_regime = EXCLUDED.payment_regime,
            updated_at = NOW();

        IF FOUND THEN
            v_imported := v_imported + 1;
        END IF;
    END LOOP;

    RETURN json_build_object(
        'success', true,
        'imported', v_imported,
        'batch_size', jsonb_array_length(p_records)
    );
END;
$$;

-- ============================================
-- RPC: Get registry statistics
-- ============================================

CREATE OR REPLACE FUNCTION dgii_rnc_stats(p_token TEXT)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_user_id UUID;
    v_result JSON;
BEGIN
    SELECT r.user_id INTO v_user_id
    FROM require_role(p_token, ARRAY['admin','super_admin']) r;

    SELECT json_build_object(
        'total_records', (SELECT COUNT(*) FROM dgii_rnc_registry),
        'active_records', (SELECT COUNT(*) FROM dgii_rnc_registry WHERE status = 'active'),
        'inactive_records', (SELECT COUNT(*) FROM dgii_rnc_registry WHERE status != 'active'),
        'last_import', (
            SELECT json_build_object(
                'date', il.created_at,
                'records_imported', il.records_imported,
                'records_total', il.records_total,
                'source', il.source,
                'duration_ms', il.import_duration_ms
            )
            FROM dgii_rnc_import_log il
            ORDER BY il.created_at DESC LIMIT 1
        )
    ) INTO v_result;

    RETURN json_build_object('success', true, 'data', v_result);
END;
$$;

-- ============================================
-- RPC: Search RNC registry by name or RNC
-- ============================================

CREATE OR REPLACE FUNCTION dgii_search_rnc(
    p_token TEXT,
    p_query TEXT,
    p_limit INT DEFAULT 20
)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_user_id UUID;
    v_results JSON;
    v_clean TEXT;
BEGIN
    SELECT r.user_id INTO v_user_id
    FROM require_role(p_token, ARRAY['operator','admin','super_admin']) r;

    v_clean := TRIM(COALESCE(p_query, ''));
    IF LENGTH(v_clean) < 3 THEN
        RETURN json_build_object('success', false, 'error', 'Mínimo 3 caracteres para buscar');
    END IF;

    SELECT json_agg(row_to_json(t)) INTO v_results
    FROM (
        SELECT rnc, business_name, trade_name, economic_activity, status
        FROM dgii_rnc_registry
        WHERE rnc LIKE v_clean || '%'
           OR business_name ILIKE '%' || v_clean || '%'
           OR trade_name ILIKE '%' || v_clean || '%'
        ORDER BY
            CASE WHEN rnc = v_clean THEN 0 ELSE 1 END,
            business_name
        LIMIT p_limit
    ) t;

    RETURN json_build_object('success', true, 'data', COALESCE(v_results, '[]'::json));
END;
$$;

-- ============================================
-- RPC: Log an import operation
-- ============================================

CREATE OR REPLACE FUNCTION dgii_log_import(
    p_token TEXT,
    p_records_imported INT,
    p_records_updated INT,
    p_records_total INT,
    p_source TEXT,
    p_duration_ms INT
)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_user_id UUID;
BEGIN
    SELECT r.user_id INTO v_user_id
    FROM require_role(p_token, ARRAY['super_admin']) r;

    INSERT INTO dgii_rnc_import_log (imported_by, records_imported, records_updated, records_total, source, import_duration_ms)
    VALUES (v_user_id, p_records_imported, p_records_updated, p_records_total, p_source, p_duration_ms);

    RETURN json_build_object('success', true);
END;
$$;
