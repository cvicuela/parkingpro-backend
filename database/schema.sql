-- ============================================
-- PARKINGPRO DATABASE SCHEMA
-- Incluye sistema de parqueo por horas configurable
-- ============================================

-- ============================================
-- EXTENSIONES
-- ============================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- Para búsqueda full-text

-- ============================================
-- TIPOS ENUMERADOS
-- ============================================
CREATE TYPE user_role AS ENUM ('customer', 'operator', 'admin', 'super_admin');
CREATE TYPE subscription_status AS ENUM ('pending', 'active', 'past_due', 'cancelled', 'suspended');
CREATE TYPE payment_status AS ENUM ('pending', 'paid', 'failed', 'refunded', 'chargeback');
CREATE TYPE access_event_type AS ENUM ('entry', 'exit');
CREATE TYPE plan_type AS ENUM ('diurno', 'nocturno', '24h', 'hourly');
CREATE TYPE billing_frequency AS ENUM ('monthly', 'weekly', 'hourly');
CREATE TYPE session_status AS ENUM ('active', 'paid', 'closed', 'abandoned');

-- ============================================
-- TABLAS DE USUARIOS Y AUTENTICACIÓN
-- ============================================

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    phone VARCHAR(20) UNIQUE NOT NULL,
    password_hash VARCHAR(255),
    role user_role NOT NULL DEFAULT 'customer',
    verified BOOLEAN DEFAULT FALSE,
    verified_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    last_login_at TIMESTAMP,
    status VARCHAR(20) DEFAULT 'active',
    
    CONSTRAINT email_format CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
    CONSTRAINT phone_format CHECK (phone ~* '^\+?[1-9]\d{1,14}$')
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_phone ON users(phone);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_status ON users(status);

CREATE TABLE otp_codes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    code VARCHAR(6) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    email VARCHAR(255),
    type VARCHAR(20) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    verified BOOLEAN DEFAULT FALSE,
    verified_at TIMESTAMP,
    attempts INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    
    CONSTRAINT max_attempts CHECK (attempts <= 5)
);

CREATE INDEX idx_otp_user_id ON otp_codes(user_id);
CREATE INDEX idx_otp_code_phone ON otp_codes(code, phone);
CREATE INDEX idx_otp_expires_at ON otp_codes(expires_at);

CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(500) UNIQUE NOT NULL,
    refresh_token VARCHAR(500) UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    last_activity_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

-- ============================================
-- TABLAS DE CLIENTES Y VEHÍCULOS
-- ============================================

CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    id_document VARCHAR(50),
    rnc VARCHAR(50),
    is_company BOOLEAN DEFAULT FALSE,
    company_name VARCHAR(255),
    address TEXT,
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_customers_user_id ON customers(user_id);
CREATE INDEX idx_customers_id_document ON customers(id_document);
CREATE INDEX idx_customers_rnc ON customers(rnc);
CREATE INDEX idx_customers_fulltext ON customers USING gin(to_tsvector('spanish', 
    first_name || ' ' || last_name || ' ' || COALESCE(company_name, '')));

CREATE TABLE vehicles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
    plate VARCHAR(20) UNIQUE NOT NULL,
    make VARCHAR(50),
    model VARCHAR(50),
    color VARCHAR(30),
    year INT,
    photo_url VARCHAR(500),
    is_primary BOOLEAN DEFAULT TRUE,
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    CONSTRAINT valid_year CHECK (year >= 1900 AND year <= EXTRACT(YEAR FROM NOW()) + 1)
);

CREATE INDEX idx_vehicles_customer_id ON vehicles(customer_id);
CREATE INDEX idx_vehicles_plate ON vehicles(plate);

-- ============================================
-- TABLAS DE PLANES Y TARIFAS
-- ============================================

CREATE TABLE plans (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(50) UNIQUE NOT NULL,
    type plan_type NOT NULL,
    description TEXT,
    base_price DECIMAL(10,2) NOT NULL,
    weekly_price DECIMAL(10,2),
    currency VARCHAR(3) DEFAULT 'DOP',
    
    -- Horarios (NULL para 24h y hourly)
    start_hour INT,
    end_hour INT,
    crosses_midnight BOOLEAN DEFAULT FALSE,
    tolerance_minutes INT DEFAULT 15,
    
    -- Capacidad
    max_capacity INT NOT NULL,
    current_occupancy INT DEFAULT 0,
    
    -- Límites
    daily_entry_limit INT DEFAULT 5,
    included_vehicles INT DEFAULT 1,
    
    -- Cargos extras
    overage_hourly_rate DECIMAL(10,2) DEFAULT 100.00,
    additional_vehicle_monthly DECIMAL(10,2) DEFAULT 500.00,
    
    -- Metadata
    is_active BOOLEAN DEFAULT TRUE,
    display_order INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    CONSTRAINT valid_hours CHECK (
        (start_hour IS NULL AND end_hour IS NULL) OR 
        (start_hour >= 0 AND start_hour <= 23 AND end_hour >= 0 AND end_hour <= 23)
    ),
    CONSTRAINT positive_capacity CHECK (max_capacity > 0),
    CONSTRAINT valid_occupancy CHECK (current_occupancy >= 0 AND current_occupancy <= max_capacity)
);

CREATE INDEX idx_plans_type ON plans(type);
CREATE INDEX idx_plans_is_active ON plans(is_active);

-- NUEVA TABLA: Tarifas por hora configurables
CREATE TABLE hourly_rates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    plan_id UUID REFERENCES plans(id) ON DELETE CASCADE,
    hour_number INT NOT NULL, -- 1 = primera hora, 2 = segunda, etc.
    rate DECIMAL(10,2) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    CONSTRAINT positive_hour CHECK (hour_number > 0),
    CONSTRAINT positive_rate CHECK (rate >= 0),
    UNIQUE(plan_id, hour_number)
);

CREATE INDEX idx_hourly_rates_plan_id ON hourly_rates(plan_id);
CREATE INDEX idx_hourly_rates_hour_number ON hourly_rates(hour_number);

-- ============================================
-- TABLAS DE SUSCRIPCIONES
-- ============================================

CREATE TABLE subscriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
    vehicle_id UUID REFERENCES vehicles(id) ON DELETE SET NULL,
    plan_id UUID REFERENCES plans(id) ON DELETE RESTRICT,
    
    -- Stripe
    stripe_customer_id VARCHAR(100),
    stripe_subscription_id VARCHAR(100) UNIQUE,
    stripe_price_id VARCHAR(100),
    
    -- Estado
    status subscription_status NOT NULL DEFAULT 'pending',
    
    -- Fechas
    started_at TIMESTAMP,
    activated_at TIMESTAMP,
    next_billing_date DATE,
    current_period_start DATE,
    current_period_end DATE,
    cancelled_at TIMESTAMP,
    suspended_at TIMESTAMP,
    
    -- Pricing
    billing_frequency billing_frequency DEFAULT 'monthly',
    price_per_period DECIMAL(10,2) NOT NULL,
    tax_rate DECIMAL(5,4) DEFAULT 0.1800,
    
    -- QR Code
    qr_code VARCHAR(255) UNIQUE,
    qr_code_url VARCHAR(500),
    
    -- Metadata
    metadata JSONB,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    CONSTRAINT positive_price CHECK (price_per_period >= 0)
);

CREATE INDEX idx_subscriptions_customer_id ON subscriptions(customer_id);
CREATE INDEX idx_subscriptions_vehicle_id ON subscriptions(vehicle_id);
CREATE INDEX idx_subscriptions_plan_id ON subscriptions(plan_id);
CREATE INDEX idx_subscriptions_status ON subscriptions(status);
CREATE INDEX idx_subscriptions_stripe_id ON subscriptions(stripe_subscription_id);
CREATE INDEX idx_subscriptions_next_billing ON subscriptions(next_billing_date);
CREATE INDEX idx_subscriptions_qr_code ON subscriptions(qr_code);

-- ============================================
-- TABLAS DE PAGOS Y FACTURACIÓN
-- ============================================

CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    
    -- Stripe
    stripe_payment_intent_id VARCHAR(100) UNIQUE,
    stripe_invoice_id VARCHAR(100) UNIQUE,
    stripe_charge_id VARCHAR(100),
    
    -- Montos
    amount DECIMAL(10,2) NOT NULL,
    tax_amount DECIMAL(10,2) DEFAULT 0,
    total_amount DECIMAL(10,2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'DOP',
    
    -- Estado
    status payment_status NOT NULL,
    
    -- Método
    payment_method VARCHAR(50),
    card_brand VARCHAR(20),
    card_last4 VARCHAR(4),
    
    -- Fechas
    paid_at TIMESTAMP,
    failed_at TIMESTAMP,
    refunded_at TIMESTAMP,
    
    -- Reintentos
    attempt_number INT DEFAULT 1,
    failure_reason TEXT,
    
    -- Metadata
    metadata JSONB,
    created_at TIMESTAMP DEFAULT NOW(),
    
    CONSTRAINT positive_amounts CHECK (
        amount >= 0 AND 
        tax_amount >= 0 AND 
        total_amount >= 0
    )
);

CREATE INDEX idx_payments_subscription_id ON payments(subscription_id);
CREATE INDEX idx_payments_customer_id ON payments(customer_id);
CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_payments_stripe_intent ON payments(stripe_payment_intent_id);
CREATE INDEX idx_payments_created_at ON payments(created_at);

CREATE TABLE invoices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    payment_id UUID REFERENCES payments(id) ON DELETE CASCADE,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    
    -- Numeración
    invoice_number VARCHAR(20) UNIQUE NOT NULL,
    ncf VARCHAR(50), -- Número Comprobante Fiscal (RD)
    
    -- Montos
    subtotal DECIMAL(10,2) NOT NULL,
    tax_amount DECIMAL(10,2) DEFAULT 0,
    total DECIMAL(10,2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'DOP',
    
    -- Items (JSON)
    items JSONB NOT NULL,
    
    -- Archivos
    pdf_url VARCHAR(500),
    pdf_generated_at TIMESTAMP,
    
    -- Metadata
    notes TEXT,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_invoices_payment_id ON invoices(payment_id);
CREATE INDEX idx_invoices_customer_id ON invoices(customer_id);
CREATE INDEX idx_invoices_number ON invoices(invoice_number);
CREATE INDEX idx_invoices_created_at ON invoices(created_at);

-- ============================================
-- TABLAS DE CONTROL DE ACCESO
-- ============================================

CREATE TABLE access_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
    vehicle_id UUID REFERENCES vehicles(id) ON DELETE SET NULL,
    
    -- Identificación
    vehicle_plate VARCHAR(20) NOT NULL,
    
    -- Tipo
    type access_event_type NOT NULL,
    
    -- Timestamp
    timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
    
    -- Método de validación
    validation_method VARCHAR(20),
    operator_id UUID REFERENCES users(id) ON DELETE SET NULL,
    
    -- Espacio asignado
    assigned_spot VARCHAR(10),
    
    -- Duración (solo para exits)
    duration_minutes INT,
    
    -- Cargos adicionales
    additional_charges DECIMAL(10,2) DEFAULT 0,
    charge_reason VARCHAR(100),
    
    -- Validación
    was_valid BOOLEAN DEFAULT TRUE,
    validation_errors JSONB,
    
    -- Metadata
    metadata JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_access_events_subscription_id ON access_events(subscription_id);
CREATE INDEX idx_access_events_vehicle_id ON access_events(vehicle_id);
CREATE INDEX idx_access_events_plate ON access_events(vehicle_plate);
CREATE INDEX idx_access_events_type ON access_events(type);
CREATE INDEX idx_access_events_timestamp ON access_events(timestamp);
CREATE INDEX idx_access_events_operator_id ON access_events(operator_id);

-- NUEVA TABLA: Sesiones de parqueo por hora
CREATE TABLE parking_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    vehicle_plate VARCHAR(20) NOT NULL,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    plan_id UUID REFERENCES plans(id) ON DELETE RESTRICT,
    
    -- Tiempos
    entry_time TIMESTAMP NOT NULL,
    exit_time TIMESTAMP,
    duration_minutes INT,
    
    -- Pagos
    calculated_amount DECIMAL(10,2),
    paid_amount DECIMAL(10,2),
    payment_status payment_status DEFAULT 'pending',
    payment_id UUID REFERENCES payments(id) ON DELETE SET NULL,
    
    -- Espacio
    assigned_spot VARCHAR(10),
    
    -- Estado
    status session_status DEFAULT 'active',
    
    -- Metadata
    metadata JSONB,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_parking_sessions_plate ON parking_sessions(vehicle_plate);
CREATE INDEX idx_parking_sessions_customer_id ON parking_sessions(customer_id);
CREATE INDEX idx_parking_sessions_status ON parking_sessions(status);
CREATE INDEX idx_parking_sessions_entry_time ON parking_sessions(entry_time);

CREATE TABLE incidents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type VARCHAR(50) NOT NULL,
    vehicle_plate VARCHAR(20),
    subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
    operator_id UUID REFERENCES users(id) ON DELETE SET NULL,
    
    -- Descripción
    title VARCHAR(255) NOT NULL,
    description TEXT,
    severity VARCHAR(20) DEFAULT 'medium',
    
    -- Estado
    status VARCHAR(20) DEFAULT 'open',
    resolved_at TIMESTAMP,
    resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    resolution_notes TEXT,
    
    -- Archivos
    photos JSONB,
    
    -- Metadata
    metadata JSONB,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_incidents_type ON incidents(type);
CREATE INDEX idx_incidents_plate ON incidents(vehicle_plate);
CREATE INDEX idx_incidents_subscription_id ON incidents(subscription_id);
CREATE INDEX idx_incidents_status ON incidents(status);
CREATE INDEX idx_incidents_created_at ON incidents(created_at);

-- ============================================
-- TABLAS DE CONFIGURACIÓN Y SISTEMA
-- ============================================

CREATE TABLE settings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    key VARCHAR(100) UNIQUE NOT NULL,
    value JSONB NOT NULL,
    description TEXT,
    category VARCHAR(50),
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_settings_key ON settings(key);
CREATE INDEX idx_settings_category ON settings(category);
-- ============================================
-- TABLAS DE CUADRE DE CAJA
-- ============================================

CREATE TABLE cash_registers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL DEFAULT 'Caja Principal',
    operator_id UUID REFERENCES users(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'closed' CHECK (status IN ('open', 'closed')),
    opened_at TIMESTAMP,
    opening_balance DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    opened_by UUID REFERENCES users(id) ON DELETE SET NULL,
    closed_at TIMESTAMP,
    expected_balance DECIMAL(10,2),
    counted_balance DECIMAL(10,2),
    difference DECIMAL(10,2),
    requires_approval BOOLEAN DEFAULT FALSE,
    approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_at TIMESTAMP,
    approval_notes TEXT,
    notes TEXT,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_cash_registers_operator ON cash_registers(operator_id);
CREATE INDEX idx_cash_registers_status ON cash_registers(status);
CREATE INDEX idx_cash_registers_opened_at ON cash_registers(opened_at);

CREATE TABLE cash_register_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cash_register_id UUID NOT NULL REFERENCES cash_registers(id) ON DELETE CASCADE,
    type VARCHAR(30) NOT NULL CHECK (type IN ('payment','refund','opening_float','manual_in','manual_out','adjustment')),
    amount DECIMAL(10,2) NOT NULL,
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('in', 'out')),
    payment_id UUID REFERENCES payments(id) ON DELETE SET NULL,
    parking_session_id UUID REFERENCES parking_sessions(id) ON DELETE SET NULL,
    operator_id UUID REFERENCES users(id) ON DELETE SET NULL,
    description TEXT,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_cash_txn_register ON cash_register_transactions(cash_register_id);
CREATE INDEX idx_cash_txn_type ON cash_register_transactions(type);
CREATE INDEX idx_cash_txn_payment ON cash_register_transactions(payment_id);

CREATE TABLE denomination_counts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cash_register_id UUID NOT NULL REFERENCES cash_registers(id) ON DELETE CASCADE,
    denomination DECIMAL(10,2) NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    subtotal DECIMAL(10,2) GENERATED ALWAYS AS (denomination * quantity) STORED,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_denomination_register ON denomination_counts(cash_register_id);


CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50),
    entity_id UUID,
    
    -- Cambios
    changes JSONB,
    
    -- Contexto
    ip_address INET,
    user_agent TEXT,
    metadata JSONB,
    
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);

CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    
    -- Tipo y canal
    type VARCHAR(50) NOT NULL,
    channel VARCHAR(20) NOT NULL,
    
    -- Destinatario
    recipient VARCHAR(255) NOT NULL,
    
    -- Contenido
    subject VARCHAR(255),
    body TEXT NOT NULL,
    template_id VARCHAR(100),
    template_data JSONB,
    
    -- Estado
    status VARCHAR(20) DEFAULT 'pending',
    sent_at TIMESTAMP,
    failed_at TIMESTAMP,
    failure_reason TEXT,
    
    -- Proveedor
    provider VARCHAR(50),
    provider_message_id VARCHAR(255),
    
    -- Metadata
    metadata JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_notifications_user_id ON notifications(user_id);
CREATE INDEX idx_notifications_type ON notifications(type);
CREATE INDEX idx_notifications_status ON notifications(status);
CREATE INDEX idx_notifications_created_at ON notifications(created_at);

-- ============================================
-- FUNCIONES Y TRIGGERS
-- ============================================

-- Actualizar updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = NOW();
   RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Aplicar a todas las tablas relevantes
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_customers_updated_at BEFORE UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_vehicles_updated_at BEFORE UPDATE ON vehicles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_plans_updated_at BEFORE UPDATE ON plans
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_subscriptions_updated_at BEFORE UPDATE ON subscriptions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_incidents_updated_at BEFORE UPDATE ON incidents
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_parking_sessions_updated_at BEFORE UPDATE ON parking_sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Actualizar ocupación de planes
CREATE OR REPLACE FUNCTION update_plan_occupancy()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.status = 'active' AND OLD.status != 'active') THEN
        UPDATE plans 
        SET current_occupancy = current_occupancy + 1 
        WHERE id = NEW.plan_id;
    ELSIF TG_OP = 'UPDATE' AND NEW.status != 'active' AND OLD.status = 'active' THEN
        UPDATE plans 
        SET current_occupancy = GREATEST(current_occupancy - 1, 0)
        WHERE id = OLD.plan_id;
    ELSIF TG_OP = 'DELETE' AND OLD.status = 'active' THEN
        UPDATE plans 
        SET current_occupancy = GREATEST(current_occupancy - 1, 0)
        WHERE id = OLD.plan_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_plan_occupancy_trigger
AFTER INSERT OR UPDATE OR DELETE ON subscriptions
FOR EACH ROW EXECUTE FUNCTION update_plan_occupancy();

-- ============================================
-- VISTAS ÚTILES
-- ============================================

-- Suscripciones activas con detalles
CREATE VIEW active_subscriptions_detail AS
SELECT 
    s.id,
    s.qr_code,
    c.first_name || ' ' || c.last_name AS customer_name,
    c.id_document,
    u.email,
    u.phone,
    v.plate AS vehicle_plate,
    v.make || ' ' || v.model || ' ' || v.color AS vehicle_description,
    p.name AS plan_name,
    p.type AS plan_type,
    s.status,
    s.next_billing_date,
    s.price_per_period,
    s.activated_at,
    EXTRACT(DAY FROM (s.next_billing_date - CURRENT_DATE)) AS days_until_renewal
FROM subscriptions s
JOIN customers c ON s.customer_id = c.id
JOIN users u ON c.user_id = u.id
JOIN vehicles v ON s.vehicle_id = v.id
JOIN plans p ON s.plan_id = p.id
WHERE s.status = 'active';

-- Morosidad
CREATE VIEW overdue_subscriptions AS
SELECT 
    s.id AS subscription_id,
    c.first_name || ' ' || c.last_name AS customer_name,
    u.phone,
    u.email,
    v.plate,
    p.name AS plan_name,
    s.next_billing_date,
    CURRENT_DATE - s.next_billing_date AS days_overdue,
    s.price_per_period * (1 + s.tax_rate) AS amount_due,
    (SELECT COUNT(*) FROM payments WHERE subscription_id = s.id AND status = 'failed') AS failed_attempts
FROM subscriptions s
JOIN customers c ON s.customer_id = c.id
JOIN users u ON c.user_id = u.id
JOIN vehicles v ON s.vehicle_id = v.id
JOIN plans p ON s.plan_id = p.id
WHERE s.status IN ('past_due', 'suspended')
    AND s.next_billing_date < CURRENT_DATE
ORDER BY days_overdue DESC;

-- Ocupación actual por plan
CREATE VIEW current_occupancy_by_plan AS
SELECT 
    p.id,
    p.name,
    p.type,
    p.current_occupancy,
    p.max_capacity,
    ROUND((p.current_occupancy::DECIMAL / p.max_capacity) * 100, 2) AS occupancy_percentage,
    p.max_capacity - p.current_occupancy AS available_spots
FROM plans p
WHERE p.is_active = TRUE;

-- Sesiones activas de parqueo por hora
CREATE VIEW active_parking_sessions AS
SELECT 
    ps.id,
    ps.vehicle_plate,
    c.first_name || ' ' || c.last_name AS customer_name,
    p.name AS plan_name,
    ps.entry_time,
    EXTRACT(EPOCH FROM (NOW() - ps.entry_time))/60 AS minutes_elapsed,
    ps.assigned_spot,
    ps.calculated_amount
FROM parking_sessions ps
LEFT JOIN customers c ON ps.customer_id = c.id
JOIN plans p ON ps.plan_id = p.id
WHERE ps.status = 'active'
ORDER BY ps.entry_time DESC;
