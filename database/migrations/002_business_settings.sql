-- =====================================================
-- MIGRACIÓN: Settings de negocio para ParkingPro
-- =====================================================

INSERT INTO settings (key, value, description, category) VALUES
('cash_diff_threshold', '200', 'Umbral de diferencia de caja que requiere aprobación del supervisor (RD$)', 'caja'),
('refund_limit_operator', '500', 'Monto máximo que un operador puede reembolsar sin aprobación (RD$)', 'antifraude'),
('refund_daily_multiplier', '3', 'Multiplicador del límite para calcular tope diario de reembolsos por operador', 'antifraude'),
('alert_email', 'alonsoveloz@gmail.com', 'Email para recibir alertas del sistema', 'notificaciones'),
('tax_rate', '0.18', 'Tasa de ITBIS (18%)', 'facturacion'),
('currency', 'DOP', 'Moneda del sistema', 'general'),
('business_name', 'ParkingPro', 'Nombre del negocio para facturas', 'general'),
('business_rnc', '', 'RNC del negocio (completar en producción)', 'general'),
('company_rnc', '', 'RNC para Reportes Fiscales DGII (606/607)', 'facturacion'),
('business_address', '', 'Dirección del negocio para facturas', 'general'),
('business_phone', '', 'Teléfono del negocio', 'general'),
('multi_register_enabled', 'false', 'Permitir múltiples cajas registradoras simultáneas', 'caja')
ON CONFLICT (key) DO NOTHING;
