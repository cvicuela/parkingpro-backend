-- ============================================
-- SEED DATA - PARKINGPRO
-- ============================================

-- Limpiar datos existentes (en orden inverso por dependencias)
TRUNCATE TABLE 
    notifications,
    audit_logs,
    settings,
    incidents,
    parking_sessions,
    access_events,
    invoices,
    payments,
    subscriptions,
    hourly_rates,
    plans,
    vehicles,
    customers,
    sessions,
    otp_codes,
    users
CASCADE;

-- ============================================
-- USUARIOS
-- ============================================

-- Super Admin (password: admin123)
INSERT INTO users (id, email, phone, password_hash, role, verified, verified_at) VALUES
('00000000-0000-0000-0000-000000000001', 'admin@parkingpro.com', '+18095551000', '$2a$10$YourHashedPasswordHere', 'super_admin', true, NOW());

-- Operador (password: operator123)
INSERT INTO users (id, email, phone, password_hash, role, verified, verified_at) VALUES
('00000000-0000-0000-0000-000000000002', 'operator@parkingpro.com', '+18095551001', '$2a$10$YourHashedPasswordHere', 'operator', true, NOW());

-- Cliente 1 - Carlos
INSERT INTO users (id, email, phone, password_hash, role, verified, verified_at) VALUES
('00000000-0000-0000-0000-000000000101', 'carlos@email.com', '+18095551234', '$2a$10$YourHashedPasswordHere', 'customer', true, NOW());

-- Cliente 2 - María
INSERT INTO users (id, email, phone, password_hash, role, verified, verified_at) VALUES
('00000000-0000-0000-0000-000000000102', 'maria@email.com', '+18095555678', '$2a$10$YourHashedPasswordHere', 'customer', true, NOW());

-- Cliente 3 - Tech Solutions SRL
INSERT INTO users (id, email, phone, password_hash, role, verified, verified_at) VALUES
('00000000-0000-0000-0000-000000000103', 'info@techsolutions.com', '+18095559999', '$2a$10$YourHashedPasswordHere', 'customer', true, NOW());

-- ============================================
-- CLIENTES
-- ============================================

INSERT INTO customers (id, user_id, first_name, last_name, id_document, is_company) VALUES
('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000101', 'Carlos', 'Fernández', '001-1234567-8', false);

INSERT INTO customers (id, user_id, first_name, last_name, id_document, is_company) VALUES
('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000102', 'María', 'González', '001-9876543-2', false);

INSERT INTO customers (id, user_id, first_name, last_name, rnc, is_company, company_name) VALUES
('00000000-0000-0000-0000-000000000203', '00000000-0000-0000-0000-000000000103', 'Tech Solutions', 'SRL', '130-12345-6', true, 'Tech Solutions SRL');

-- ============================================
-- VEHÍCULOS
-- ============================================

INSERT INTO vehicles (id, customer_id, plate, make, model, color, year, is_primary) VALUES
('00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000201', 'A123456', 'Honda', 'Civic', 'Gris', 2022, true);

INSERT INTO vehicles (id, customer_id, plate, make, model, color, year, is_primary) VALUES
('00000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-000000000202', 'B789012', 'Toyota', 'Corolla', 'Blanco', 2023, true);

INSERT INTO vehicles (id, customer_id, plate, make, model, color, year, is_primary) VALUES
('00000000-0000-0000-0000-000000000303', '00000000-0000-0000-0000-000000000203', 'C345678', 'Nissan', 'Sentra', 'Negro', 2021, true);

-- ============================================
-- PLANES
-- ============================================

-- Plan Diurno
INSERT INTO plans (
    id, name, type, description, base_price, weekly_price,
    start_hour, end_hour, crosses_midnight, tolerance_minutes,
    max_capacity, daily_entry_limit, display_order
) VALUES (
    '00000000-0000-0000-0000-000000000401',
    'Diurno',
    'diurno',
    'Acceso de 6:00 AM a 6:00 PM',
    2500.00,
    650.00,
    6,
    18,
    false,
    15,
    60,
    5,
    1
);

-- Plan Nocturno
INSERT INTO plans (
    id, name, type, description, base_price, weekly_price,
    start_hour, end_hour, crosses_midnight, tolerance_minutes,
    max_capacity, daily_entry_limit, display_order
) VALUES (
    '00000000-0000-0000-0000-000000000402',
    'Nocturno',
    'nocturno',
    'Acceso de 6:00 PM a 6:00 AM',
    2000.00,
    520.00,
    18,
    6,
    true,
    15,
    70,
    5,
    2
);

-- Plan 24 Horas
INSERT INTO plans (
    id, name, type, description, base_price, weekly_price,
    start_hour, end_hour, crosses_midnight, tolerance_minutes,
    max_capacity, daily_entry_limit, display_order
) VALUES (
    '00000000-0000-0000-0000-000000000403',
    '24 Horas',
    '24h',
    'Acceso ilimitado 24/7',
    3500.00,
    910.00,
    NULL,
    NULL,
    false,
    15,
    60,
    10,
    3
);

-- Plan Por Hora (NUEVO)
INSERT INTO plans (
    id, name, type, description, base_price, weekly_price,
    start_hour, end_hour, crosses_midnight, tolerance_minutes,
    max_capacity, daily_entry_limit, display_order
) VALUES (
    '00000000-0000-0000-0000-000000000404',
    'Por Hora',
    'hourly',
    'Pago por hora de uso (1ra hora: RD$50, 2da: RD$70, 3ra+: RD$100)',
    50.00, -- Base price es la primera hora
    NULL,
    NULL,
    NULL,
    false,
    5, -- 5 minutos de tolerancia
    40, -- 40 espacios dedicados a por hora
    999, -- Sin límite de entradas
    4
);

-- ============================================
-- TARIFAS POR HORA (NUEVO)
-- ============================================

-- Tarifas para el plan "Por Hora"
INSERT INTO hourly_rates (plan_id, hour_number, rate, description) VALUES
('00000000-0000-0000-0000-000000000404', 1, 50.00, 'Primera hora'),
('00000000-0000-0000-0000-000000000404', 2, 70.00, 'Segunda hora'),
('00000000-0000-0000-0000-000000000404', 3, 100.00, 'Tercera hora en adelante');

-- Nota: Para hora 4, 5, 6, etc. se usa la tarifa de la hora 3 (100.00)

-- ============================================
-- SUSCRIPCIONES
-- ============================================

-- Carlos - Plan 24 Horas (activo)
INSERT INTO subscriptions (
    id, customer_id, vehicle_id, plan_id,
    status, started_at, activated_at, next_billing_date,
    current_period_start, current_period_end,
    billing_frequency, price_per_period, tax_rate,
    qr_code, qr_code_url
) VALUES (
    '00000000-0000-0000-0000-000000000501',
    '00000000-0000-0000-0000-000000000201',
    '00000000-0000-0000-0000-000000000301',
    '00000000-0000-0000-0000-000000000403',
    'active',
    '2024-01-15',
    '2024-01-15',
    '2024-02-15',
    '2024-01-15',
    '2024-02-15',
    'monthly',
    3500.00,
    0.18,
    'QR-SUB-1-A123456',
    'https://api.qrserver.com/v1/create-qr-code/?data=QR-SUB-1-A123456&size=300x300'
);

-- María - Plan Diurno (activo)
INSERT INTO subscriptions (
    id, customer_id, vehicle_id, plan_id,
    status, started_at, activated_at, next_billing_date,
    current_period_start, current_period_end,
    billing_frequency, price_per_period, tax_rate,
    qr_code, qr_code_url
) VALUES (
    '00000000-0000-0000-0000-000000000502',
    '00000000-0000-0000-0000-000000000202',
    '00000000-0000-0000-0000-000000000302',
    '00000000-0000-0000-0000-000000000401',
    'active',
    '2024-01-20',
    '2024-01-20',
    '2024-02-20',
    '2024-01-20',
    '2024-02-20',
    'monthly',
    2500.00,
    0.18,
    'QR-SUB-2-B789012',
    'https://api.qrserver.com/v1/create-qr-code/?data=QR-SUB-2-B789012&size=300x300'
);

-- Tech Solutions - Plan Nocturno (vencido para testing)
INSERT INTO subscriptions (
    id, customer_id, vehicle_id, plan_id,
    status, started_at, activated_at, next_billing_date,
    current_period_start, current_period_end,
    billing_frequency, price_per_period, tax_rate,
    qr_code, qr_code_url
) VALUES (
    '00000000-0000-0000-0000-000000000503',
    '00000000-0000-0000-0000-000000000203',
    '00000000-0000-0000-0000-000000000303',
    '00000000-0000-0000-0000-000000000402',
    'past_due',
    '2024-01-01',
    '2024-01-01',
    '2024-02-01',
    '2024-01-01',
    '2024-02-01',
    'monthly',
    2000.00,
    0.18,
    'QR-SUB-3-C345678',
    'https://api.qrserver.com/v1/create-qr-code/?data=QR-SUB-3-C345678&size=300x300'
);

-- ============================================
-- PAGOS
-- ============================================

-- Pago de Carlos (exitoso)
INSERT INTO payments (
    id, subscription_id, customer_id,
    amount, tax_amount, total_amount,
    status, payment_method, card_brand, card_last4,
    paid_at
) VALUES (
    '00000000-0000-0000-0000-000000000601',
    '00000000-0000-0000-0000-000000000501',
    '00000000-0000-0000-0000-000000000201',
    3500.00,
    630.00,
    4130.00,
    'paid',
    'card',
    'visa',
    '4242',
    '2024-01-15 10:30:00'
);

-- Pago de María (exitoso)
INSERT INTO payments (
    id, subscription_id, customer_id,
    amount, tax_amount, total_amount,
    status, payment_method, card_brand, card_last4,
    paid_at
) VALUES (
    '00000000-0000-0000-0000-000000000602',
    '00000000-0000-0000-0000-000000000502',
    '00000000-0000-0000-0000-000000000202',
    2500.00,
    450.00,
    2950.00,
    'paid',
    'card',
    'mastercard',
    '5555',
    '2024-01-20 14:15:00'
);

-- Pago fallido de Tech Solutions
INSERT INTO payments (
    id, subscription_id, customer_id,
    amount, tax_amount, total_amount,
    status, payment_method, card_brand, card_last4,
    failed_at, failure_reason, attempt_number
) VALUES (
    '00000000-0000-0000-0000-000000000603',
    '00000000-0000-0000-0000-000000000503',
    '00000000-0000-0000-0000-000000000203',
    2000.00,
    360.00,
    2360.00,
    'failed',
    'card',
    'visa',
    '1234',
    '2024-02-01 08:00:00',
    'insufficient_funds',
    1
);

-- ============================================
-- FACTURAS
-- ============================================

INSERT INTO invoices (
    id, payment_id, customer_id,
    invoice_number, subtotal, tax_amount, total,
    items
) VALUES (
    '00000000-0000-0000-0000-000000000701',
    '00000000-0000-0000-0000-000000000601',
    '00000000-0000-0000-0000-000000000201',
    '00001',
    3500.00,
    630.00,
    4130.00,
    '[{"description": "Plan 24 Horas (mensual)", "quantity": 1, "unit_price": 3500.00, "total": 3500.00}]'
);

INSERT INTO invoices (
    id, payment_id, customer_id,
    invoice_number, subtotal, tax_amount, total,
    items
) VALUES (
    '00000000-0000-0000-0000-000000000702',
    '00000000-0000-0000-0000-000000000602',
    '00000000-0000-0000-0000-000000000202',
    '00002',
    2500.00,
    450.00,
    2950.00,
    '[{"description": "Plan Diurno (mensual)", "quantity": 1, "unit_price": 2500.00, "total": 2500.00}]'
);

-- ============================================
-- EVENTOS DE ACCESO
-- ============================================

-- Carlos - Entradas y salidas recientes
INSERT INTO access_events (
    subscription_id, vehicle_id, vehicle_plate,
    type, timestamp, validation_method, was_valid
) VALUES
('00000000-0000-0000-0000-000000000501', '00000000-0000-0000-0000-000000000301', 'A123456', 'entry', NOW() - INTERVAL '8 hours', 'qr', true),
('00000000-0000-0000-0000-000000000501', '00000000-0000-0000-0000-000000000301', 'A123456', 'exit', NOW() - INTERVAL '2 hours', 'qr', true);

-- María - Solo entrada (aún en el parqueo)
INSERT INTO access_events (
    subscription_id, vehicle_id, vehicle_plate,
    type, timestamp, validation_method, was_valid
) VALUES
('00000000-0000-0000-0000-000000000502', '00000000-0000-0000-0000-000000000302', 'B789012', 'entry', NOW() - INTERVAL '3 hours', 'qr', true);

-- ============================================
-- SESIONES DE PARQUEO POR HORA (NUEVO)
-- ============================================

-- Ejemplo: Vehículo en parqueo por hora (activo)
INSERT INTO parking_sessions (
    vehicle_plate, plan_id, entry_time,
    is_active, assigned_spot
) VALUES (
    'X999888', -- Vehículo sin suscripción, usando parqueo por hora
    '00000000-0000-0000-0000-000000000404',
    NOW() - INTERVAL '1 hour 30 minutes',
    true,
    'H-15'
);

-- Ejemplo: Sesión completada y pagada
INSERT INTO parking_sessions (
    vehicle_plate, plan_id, entry_time, exit_time,
    duration_minutes, calculated_amount, paid_amount,
    payment_status, is_active, assigned_spot
) VALUES (
    'Y777666',
    '00000000-0000-0000-0000-000000000404',
    NOW() - INTERVAL '5 hours',
    NOW() - INTERVAL '2 hours',
    180, -- 3 horas
    220.00, -- 50 + 70 + 100
    220.00,
    'paid',
    false,
    'H-08'
);

-- ============================================
-- CONFIGURACIÓN
-- ============================================

INSERT INTO settings (key, value, description, category) VALUES
('billing.grace_period_hours', '72', 'Horas de gracia antes de suspender suscripción', 'billing'),
('billing.retry_attempts', '3', 'Número de reintentos automáticos de pago', 'billing'),
('billing.retry_interval_hours', '24', 'Horas entre reintentos', 'billing'),
('billing.late_fee', '200', 'Cargo por mora en DOP', 'billing'),
('billing.tax_rate', '0.18', 'ITBIS (18%)', 'billing'),

('capacity.total_spaces', '170', 'Espacios totales del parqueo', 'capacity'),
('capacity.floating_reserve', '20', 'Espacios de reserva flotante', 'capacity'),

('limits.daily_entries', '5', 'Entradas permitidas por día (planes regulares)', 'limits'),
('limits.vehicles_per_customer', '1', 'Vehículos incluidos en plan base', 'limits'),

('charges.overage_hour', '100', 'Cargo por hora fuera de horario', 'charges'),
('charges.additional_vehicle_monthly', '500', 'Costo mensual por vehículo adicional', 'charges'),
('charges.replacement_qr', '150', 'Costo de reemplazo de QR/tarjeta', 'charges'),

('hourly.first_hour_rate', '50', 'Tarifa primera hora', 'hourly'),
('hourly.second_hour_rate', '70', 'Tarifa segunda hora', 'hourly'),
('hourly.additional_hour_rate', '100', 'Tarifa hora 3 en adelante', 'hourly'),
('hourly.tolerance_minutes', '5', 'Minutos de tolerancia gratis', 'hourly'),

('notifications.whatsapp_enabled', 'true', 'Habilitar notificaciones WhatsApp', 'notifications'),
('notifications.email_enabled', 'true', 'Habilitar notificaciones Email', 'notifications'),
('notifications.sms_enabled', 'false', 'Habilitar notificaciones SMS', 'notifications'),

('cash.diff_threshold', '200', 'Umbral diferencia de caja para aprobación supervisor (RD$)', 'cash'),
('cash.refund_limit_operator', '500', 'Monto máximo reembolso operador sin aprobación (RD$)', 'cash'),
('cash.refund_daily_multiplier', '3', 'Multiplicador límite diario reembolsos', 'cash'),
('cash.multi_register_enabled', 'false', 'Permitir múltiples cajas simultáneas', 'cash'),
('cash.alert_email', 'alonsoveloz@gmail.com', 'Email para alertas de caja', 'cash'),
('invoice.ncf_series_consumer', 'B01', 'Serie NCF consumidor final (provisional)', 'invoice'),
('invoice.ncf_series_fiscal', 'B14', 'Serie NCF valor fiscal (provisional)', 'invoice'),
('invoice.ncf_series_credit', 'B04', 'Serie NCF notas de crédito (provisional)', 'invoice'),
('invoice.business_name', 'ParkingPro', 'Nombre del negocio en facturas', 'invoice'),
('invoice.business_rnc', '', 'RNC del negocio (completar en producción)', 'invoice');

-- ============================================
-- ACTUALIZAR OCUPACIÓN DE PLANES
-- ============================================

-- Actualizar current_occupancy basado en suscripciones activas
UPDATE plans p
SET current_occupancy = (
    SELECT COUNT(*)
    FROM subscriptions s
    WHERE s.plan_id = p.id AND s.status = 'active'
);

-- ============================================
-- VERIFICACIÓN
-- ============================================

-- Mostrar resumen
SELECT 
    'Users' as table_name, COUNT(*) as count FROM users
UNION ALL
SELECT 'Customers', COUNT(*) FROM customers
UNION ALL
SELECT 'Vehicles', COUNT(*) FROM vehicles
UNION ALL
SELECT 'Plans', COUNT(*) FROM plans
UNION ALL
SELECT 'Hourly Rates', COUNT(*) FROM hourly_rates
UNION ALL
SELECT 'Subscriptions', COUNT(*) FROM subscriptions
UNION ALL
SELECT 'Payments', COUNT(*) FROM payments
UNION ALL
SELECT 'Invoices', COUNT(*) FROM invoices
UNION ALL
SELECT 'Access Events', COUNT(*) FROM access_events
UNION ALL
SELECT 'Parking Sessions', COUNT(*) FROM parking_sessions
UNION ALL
SELECT 'Settings', COUNT(*) FROM settings
UNION ALL
SELECT 'Cash Registers', COUNT(*) FROM cash_registers;
