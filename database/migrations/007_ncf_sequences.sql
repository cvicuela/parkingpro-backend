-- =====================================================
-- MIGRACIÓN: Configuración de facturación (modo, prefijo interno)
-- Las secuencias NCF se gestionan exclusivamente desde la tabla
-- ncf_sequences (migración 012) como fuente única de verdad,
-- cumpliendo con los requisitos de la DGII.
-- =====================================================

INSERT INTO settings (key, value, description, category) VALUES
('invoice_mode', 'fiscal', 'Modo de facturación: fiscal (NCF/DGII) o interno', 'facturacion'),
('internal_invoice_prefix', 'FAC', 'Prefijo para facturas internas', 'facturacion'),
('internal_invoice_next', '1', 'Próximo número secuencial de factura interna', 'facturacion')
ON CONFLICT (key) DO NOTHING;
