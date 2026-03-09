-- =====================================================
-- MIGRACIÓN: NCF sequence fields (Desde, Hasta, Vencimiento)
-- =====================================================

INSERT INTO settings (key, value, description, category) VALUES
('ncf_seq_from_consumer', '1', 'Secuencia NCF Consumidor Final - Desde', 'facturacion'),
('ncf_seq_from_fiscal', '1', 'Secuencia NCF Crédito Fiscal - Desde', 'facturacion'),
('ncf_seq_from_credit', '1', 'Secuencia NCF Nota de Crédito - Desde', 'facturacion'),
('ncf_seq_to_consumer', '', 'Secuencia NCF Consumidor Final - Hasta', 'facturacion'),
('ncf_seq_to_fiscal', '', 'Secuencia NCF Crédito Fiscal - Hasta', 'facturacion'),
('ncf_seq_to_credit', '', 'Secuencia NCF Nota de Crédito - Hasta', 'facturacion'),
('ncf_expiry_consumer', '', 'Fecha vencimiento NCF Consumidor Final', 'facturacion'),
('ncf_expiry_fiscal', '', 'Fecha vencimiento NCF Crédito Fiscal', 'facturacion'),
('ncf_expiry_credit', '', 'Fecha vencimiento NCF Nota de Crédito', 'facturacion'),
('invoice_mode', 'fiscal', 'Modo de facturación: fiscal (NCF/DGII) o interno', 'facturacion'),
('internal_invoice_prefix', 'FAC', 'Prefijo para facturas internas', 'facturacion'),
('internal_invoice_next', '1', 'Próximo número secuencial de factura interna', 'facturacion'),
('terminal_sequence_start', '1', 'Inicio del rango de secuencia terminal', 'facturacion'),
('terminal_sequence_end', '999999', 'Final del rango de secuencia terminal', 'facturacion'),
('terminal_sequence_current', '1', 'Número actual de secuencia terminal', 'facturacion')
ON CONFLICT (key) DO NOTHING;
