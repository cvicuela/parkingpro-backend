-- =====================================================
-- MIGRACIÓN 023: Soporte Multi-terminal
-- Permite escalar a múltiples entradas/salidas (portones)
-- =====================================================

-- =============================================================================
-- 1. Crear tabla terminals
-- =============================================================================

CREATE TABLE IF NOT EXISTS terminals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    code VARCHAR(20) UNIQUE NOT NULL,  -- e.g. 'ENTRY-1', 'EXIT-1', 'ENTRY-2'
    type VARCHAR(20) NOT NULL CHECK (type IN ('entry', 'exit', 'both')),
    location VARCHAR(255),             -- Descripción física de la ubicación
    is_active BOOLEAN DEFAULT TRUE,
    ip_address VARCHAR(45),            -- Para vinculación de dispositivo
    device_serial VARCHAR(100),        -- Dispositivo ZKTeco/barrera vinculado
    settings JSONB DEFAULT '{}',       -- Configuración por terminal (auto_print, default_plan, etc.)
    last_heartbeat TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_terminals_code ON terminals(code);
CREATE INDEX IF NOT EXISTS idx_terminals_type ON terminals(type);
CREATE INDEX IF NOT EXISTS idx_terminals_is_active ON terminals(is_active);

-- =============================================================================
-- 2. Agregar terminal_id a tablas existentes
-- =============================================================================

-- parking_sessions: terminal de entrada y terminal de salida
ALTER TABLE parking_sessions
    ADD COLUMN IF NOT EXISTS terminal_entry_id UUID REFERENCES terminals(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS terminal_exit_id UUID REFERENCES terminals(id) ON DELETE SET NULL;

-- access_events: terminal donde ocurrió el evento
ALTER TABLE access_events
    ADD COLUMN IF NOT EXISTS terminal_id UUID REFERENCES terminals(id) ON DELETE SET NULL;

-- cash_registers: terminal física asociada a la caja
ALTER TABLE cash_registers
    ADD COLUMN IF NOT EXISTS terminal_id UUID REFERENCES terminals(id) ON DELETE SET NULL;

-- cash_register_transactions: terminal donde se realizó la transacción
ALTER TABLE cash_register_transactions
    ADD COLUMN IF NOT EXISTS terminal_id UUID REFERENCES terminals(id) ON DELETE SET NULL;

-- Índices para las nuevas columnas
CREATE INDEX IF NOT EXISTS idx_parking_sessions_terminal_entry ON parking_sessions(terminal_entry_id);
CREATE INDEX IF NOT EXISTS idx_parking_sessions_terminal_exit ON parking_sessions(terminal_exit_id);
CREATE INDEX IF NOT EXISTS idx_access_events_terminal ON access_events(terminal_id);
CREATE INDEX IF NOT EXISTS idx_cash_registers_terminal ON cash_registers(terminal_id);
CREATE INDEX IF NOT EXISTS idx_cash_txn_terminal ON cash_register_transactions(terminal_id);

-- =============================================================================
-- 3. Trigger updated_at para terminals
-- =============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'set_terminals_updated_at'
    ) THEN
        CREATE TRIGGER set_terminals_updated_at
            BEFORE UPDATE ON terminals
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
    END IF;
END;
$$;

-- =============================================================================
-- 4. Insertar terminales por defecto
-- =============================================================================

INSERT INTO terminals (name, code, type, location) VALUES
    ('Entrada Principal', 'ENTRY-1', 'entry', 'Portón principal'),
    ('Salida Principal',  'EXIT-1',  'exit',  'Portón principal')
ON CONFLICT (code) DO NOTHING;

-- =============================================================================
-- 5. RPC: list_terminals
-- =============================================================================

CREATE OR REPLACE FUNCTION public.list_terminals(p_token TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_user_id UUID;
    v_role VARCHAR;
    v_result JSON;
BEGIN
    SELECT r.user_id, r.user_role INTO v_user_id, v_role
    FROM require_role(p_token, ARRAY['operator','admin','super_admin']) r;

    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_result
    FROM (
        SELECT * FROM terminals ORDER BY code
    ) t;

    RETURN json_build_object('success', true, 'data', v_result);
EXCEPTION
    WHEN OTHERS THEN
        RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$function$;

-- =============================================================================
-- 6. RPC: create_terminal
-- =============================================================================

CREATE OR REPLACE FUNCTION public.create_terminal(p_token TEXT, p_data JSONB)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_user_id UUID;
    v_role VARCHAR;
    v_new_id UUID;
    v_result JSON;
BEGIN
    SELECT r.user_id, r.user_role INTO v_user_id, v_role
    FROM require_role(p_token, ARRAY['admin','super_admin']) r;

    IF (p_data->>'name') IS NULL OR (p_data->>'code') IS NULL OR (p_data->>'type') IS NULL THEN
        RETURN json_build_object('success', false, 'error', 'name, code y type son requeridos');
    END IF;

    INSERT INTO terminals (name, code, type, location, ip_address, device_serial, settings)
    VALUES (
        p_data->>'name',
        UPPER(p_data->>'code'),
        p_data->>'type',
        p_data->>'location',
        p_data->>'ip_address',
        p_data->>'device_serial',
        COALESCE(p_data->'settings', '{}'::jsonb)
    )
    RETURNING id INTO v_new_id;

    -- Audit log
    INSERT INTO audit_logs (user_id, action, entity_type, entity_id, changes)
    VALUES (v_user_id, 'terminal_created', 'terminal', v_new_id,
        json_build_object('code', UPPER(p_data->>'code'), 'type', p_data->>'type')::jsonb);

    SELECT row_to_json(t) INTO v_result FROM terminals t WHERE t.id = v_new_id;
    RETURN json_build_object('success', true, 'data', v_result);
EXCEPTION
    WHEN unique_violation THEN
        RETURN json_build_object('success', false, 'error', 'El código de terminal ya existe');
    WHEN OTHERS THEN
        RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$function$;

-- =============================================================================
-- 7. RPC: update_terminal
-- =============================================================================

CREATE OR REPLACE FUNCTION public.update_terminal(p_token TEXT, p_id UUID, p_data JSONB)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_user_id UUID;
    v_role VARCHAR;
    v_result JSON;
BEGIN
    SELECT r.user_id, r.user_role INTO v_user_id, v_role
    FROM require_role(p_token, ARRAY['admin','super_admin']) r;

    UPDATE terminals SET
        name          = COALESCE(p_data->>'name',          name),
        type          = COALESCE(p_data->>'type',          type),
        location      = COALESCE(p_data->>'location',      location),
        ip_address    = COALESCE(p_data->>'ip_address',    ip_address),
        device_serial = COALESCE(p_data->>'device_serial', device_serial),
        settings      = COALESCE(p_data->'settings',       settings),
        is_active     = COALESCE((p_data->>'is_active')::BOOLEAN, is_active),
        updated_at    = NOW()
    WHERE id = p_id;

    IF NOT FOUND THEN
        RETURN json_build_object('success', false, 'error', 'Terminal no encontrada');
    END IF;

    -- Audit log
    INSERT INTO audit_logs (user_id, action, entity_type, entity_id, changes)
    VALUES (v_user_id, 'terminal_updated', 'terminal', p_id, p_data);

    SELECT row_to_json(t) INTO v_result FROM terminals t WHERE t.id = p_id;
    RETURN json_build_object('success', true, 'data', v_result);
EXCEPTION
    WHEN OTHERS THEN
        RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$function$;

-- =============================================================================
-- 8. RPC: delete_terminal (soft delete)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.delete_terminal(p_token TEXT, p_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_user_id UUID;
    v_role VARCHAR;
BEGIN
    SELECT r.user_id, r.user_role INTO v_user_id, v_role
    FROM require_role(p_token, ARRAY['admin','super_admin']) r;

    UPDATE terminals SET is_active = false, updated_at = NOW()
    WHERE id = p_id;

    IF NOT FOUND THEN
        RETURN json_build_object('success', false, 'error', 'Terminal no encontrada');
    END IF;

    -- Audit log
    INSERT INTO audit_logs (user_id, action, entity_type, entity_id, changes)
    VALUES (v_user_id, 'terminal_deactivated', 'terminal', p_id,
        json_build_object('is_active', false)::jsonb);

    RETURN json_build_object('success', true, 'message', 'Terminal desactivada');
EXCEPTION
    WHEN OTHERS THEN
        RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$function$;

-- =============================================================================
-- 9. RPC: terminal_heartbeat
-- =============================================================================

CREATE OR REPLACE FUNCTION public.terminal_heartbeat(p_token TEXT, p_terminal_code TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_user_id UUID;
    v_role VARCHAR;
    v_result JSON;
BEGIN
    SELECT r.user_id, r.user_role INTO v_user_id, v_role
    FROM require_role(p_token, ARRAY['operator','admin','super_admin']) r;

    UPDATE terminals
    SET last_heartbeat = NOW()
    WHERE code = UPPER(p_terminal_code) AND is_active = true;

    IF NOT FOUND THEN
        RETURN json_build_object('success', false, 'error', 'Terminal no encontrada o inactiva');
    END IF;

    SELECT row_to_json(t) INTO v_result
    FROM (
        SELECT id, name, code, type, last_heartbeat FROM terminals
        WHERE code = UPPER(p_terminal_code)
    ) t;

    RETURN json_build_object('success', true, 'data', v_result, 'timestamp', NOW());
EXCEPTION
    WHEN OTHERS THEN
        RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$function$;

-- =============================================================================
-- 10. RPC: get_terminal_stats
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_terminal_stats(p_token TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_user_id UUID;
    v_role VARCHAR;
    v_result JSON;
BEGIN
    SELECT r.user_id, r.user_role INTO v_user_id, v_role
    FROM require_role(p_token, ARRAY['admin','super_admin']) r;

    SELECT COALESCE(json_agg(row_to_json(stats)), '[]'::json) INTO v_result
    FROM (
        SELECT
            t.id,
            t.name,
            t.code,
            t.type,
            t.is_active,
            t.last_heartbeat,
            (
                SELECT COUNT(*)
                FROM parking_sessions ps
                WHERE ps.terminal_entry_id = t.id
                  AND ps.entry_time::date = CURRENT_DATE
            ) AS sessions_today,
            (
                SELECT COUNT(*)
                FROM parking_sessions ps
                WHERE ps.terminal_entry_id = t.id
                  AND ps.status = 'active'
            ) AS active_sessions,
            (
                SELECT COALESCE(SUM(ps.paid_amount), 0)
                FROM parking_sessions ps
                WHERE ps.terminal_entry_id = t.id
                  AND ps.payment_status = 'paid'
                  AND ps.updated_at::date = CURRENT_DATE
            ) AS revenue_today,
            CASE
                WHEN t.last_heartbeat > NOW() - INTERVAL '5 minutes' THEN 'online'
                ELSE 'offline'
            END AS connection_status
        FROM terminals t
        WHERE t.is_active = true
        ORDER BY t.code
    ) stats;

    RETURN json_build_object('success', true, 'data', v_result);
EXCEPTION
    WHEN OTHERS THEN
        RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$function$;
