-- =====================================================
-- MIGRACIÓN 025: Validación de Entradas del Servidor
-- Funciones de validación y sanitización reutilizables
-- =====================================================

-- =============================================================================
-- 1. Validación de formato de placa dominicana
-- =============================================================================

CREATE OR REPLACE FUNCTION public.validate_plate_format(p_plate TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $function$
BEGIN
    -- Placas dominicanas: letra + 6 dígitos, o formatos especiales
    RETURN p_plate ~* '^[A-Z][0-9]{6}$'
        OR p_plate ~* '^[A-Z]{2}[0-9]{5}$'
        OR p_plate ~* '^[A-Z]{1,3}-?[0-9]{3,6}$'
        OR p_plate ~* '^SIN-[A-Z0-9]+$';  -- Placas temporales
END;
$function$;

-- =============================================================================
-- 2. Validación de RNC dominicano (9 u 11 dígitos)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.validate_rnc(p_rnc TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $function$
BEGIN
    RETURN p_rnc ~ '^[0-9]{9}$' OR p_rnc ~ '^[0-9]{11}$';
END;
$function$;

-- =============================================================================
-- 3. Validación de teléfono dominicano
-- =============================================================================

CREATE OR REPLACE FUNCTION public.validate_phone_do(p_phone TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $function$
BEGIN
    RETURN p_phone ~ '^\+?1?8[024]9[0-9]{7}$'
        OR p_phone ~ '^\+?[1-9][0-9]{7,14}$';
END;
$function$;

-- =============================================================================
-- 4. Validación de correo electrónico
-- =============================================================================

CREATE OR REPLACE FUNCTION public.validate_email(p_email TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $function$
BEGIN
    RETURN p_email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$';
END;
$function$;

-- =============================================================================
-- 5. Sanitización de placa (mayúsculas, eliminar caracteres no permitidos)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.sanitize_plate(p_plate TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $function$
BEGIN
    RETURN UPPER(TRIM(regexp_replace(p_plate, '[^A-Za-z0-9-]', '', 'g')));
END;
$function$;

-- =============================================================================
-- 6. Validación de monto de pago (positivo, rango razonable)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.validate_payment_amount(p_amount DECIMAL)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $function$
BEGIN
    -- Máximo RD$1,000,000 por transacción
    RETURN p_amount > 0 AND p_amount < 1000000;
END;
$function$;

-- =============================================================================
-- 7. RPC: validate_input — Wrapper de validación con resultado enriquecido
-- =============================================================================

CREATE OR REPLACE FUNCTION public.validate_input(p_type TEXT, p_value TEXT)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
    v_valid     BOOLEAN;
    v_sanitized TEXT;
    v_message   TEXT;
BEGIN
    CASE p_type
        WHEN 'plate' THEN
            v_sanitized := public.sanitize_plate(p_value);
            v_valid     := public.validate_plate_format(v_sanitized);
            v_message   := CASE WHEN v_valid THEN 'Placa válida'
                                ELSE 'Formato de placa no reconocido' END;

        WHEN 'rnc' THEN
            v_sanitized := regexp_replace(TRIM(p_value), '[^0-9]', '', 'g');
            v_valid     := public.validate_rnc(v_sanitized);
            v_message   := CASE WHEN v_valid THEN 'RNC válido'
                                ELSE 'El RNC debe tener 9 u 11 dígitos' END;

        WHEN 'phone' THEN
            v_sanitized := regexp_replace(TRIM(p_value), '[\s\-\(\)]', '', 'g');
            v_valid     := public.validate_phone_do(v_sanitized);
            v_message   := CASE WHEN v_valid THEN 'Teléfono válido'
                                ELSE 'Formato de teléfono no reconocido' END;

        WHEN 'email' THEN
            v_sanitized := LOWER(TRIM(p_value));
            v_valid     := public.validate_email(v_sanitized);
            v_message   := CASE WHEN v_valid THEN 'Correo electrónico válido'
                                ELSE 'Formato de correo electrónico inválido' END;

        ELSE
            RETURN jsonb_build_object(
                'valid',     false,
                'sanitized', p_value,
                'message',   'Tipo de validación desconocido: ' || p_type
            );
    END CASE;

    RETURN jsonb_build_object(
        'valid',     v_valid,
        'sanitized', v_sanitized,
        'message',   v_message
    );
END;
$function$;
