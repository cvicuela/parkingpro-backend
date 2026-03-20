const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { query, supabase } = require('../config/database');

/**
 * @route   POST /api/v1/dgii/rnc/validate
 * @desc    Validar RNC contra registro DGII local
 * @access  Private (operator+)
 */
router.post('/rnc/validate', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const { rnc } = req.body;
        if (!rnc) {
            return res.status(400).json({ success: false, error: 'RNC es requerido' });
        }

        const token = req.headers.authorization?.split(' ')[1];
        const { data, error } = await supabase.rpc('dgii_validate_rnc', {
            p_token: token,
            p_rnc: rnc
        });

        if (error) throw new Error(error.message);

        res.json(data);
    } catch (error) {
        next(error);
    }
});

/**
 * @route   GET /api/v1/dgii/rnc/search?q=...&limit=20
 * @desc    Buscar en registro DGII local por nombre o RNC
 * @access  Private (operator+)
 */
router.get('/rnc/search', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const { q, limit } = req.query;
        const token = req.headers.authorization?.split(' ')[1];
        const { data, error } = await supabase.rpc('dgii_search_rnc', {
            p_token: token,
            p_query: q || '',
            p_limit: parseInt(limit) || 20
        });

        if (error) throw new Error(error.message);

        res.json(data);
    } catch (error) {
        next(error);
    }
});

/**
 * @route   GET /api/v1/dgii/rnc/stats
 * @desc    Estadísticas del registro DGII local
 * @access  Private (admin+)
 */
router.get('/rnc/stats', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const { data, error } = await supabase.rpc('dgii_rnc_stats', {
            p_token: token
        });

        if (error) throw new Error(error.message);

        res.json(data);
    } catch (error) {
        next(error);
    }
});

/**
 * @route   POST /api/v1/dgii/rnc/import
 * @desc    Importar archivo DGII de RNCs (pipe-delimited TXT)
 * @access  Private (super_admin only)
 *
 * Expects multipart/form-data with a 'file' field containing the DGII TXT file.
 * The DGII file is pipe-delimited with columns:
 *   RNC/CEDULA | RAZON SOCIAL | NOMBRE COMERCIAL | ACTIVIDAD ECONOMICA | FECHA CONSTITUCION | ESTADO | REGIMEN DE PAGOS
 */
router.post('/rnc/import', authenticate, authorize(['super_admin']), async (req, res, next) => {
    try {
        const { records } = req.body;

        if (!records || !Array.isArray(records)) {
            return res.status(400).json({
                success: false,
                error: 'Se requiere un array de registros. Parsee el archivo DGII en el frontend y envíe los registros en lotes.'
            });
        }

        if (records.length === 0) {
            return res.status(400).json({ success: false, error: 'El array de registros está vacío' });
        }

        if (records.length > 5000) {
            return res.status(400).json({
                success: false,
                error: 'Máximo 5000 registros por lote. Divida el archivo en lotes más pequeños.'
            });
        }

        const token = req.headers.authorization?.split(' ')[1];
        const startTime = Date.now();

        const { data, error } = await supabase.rpc('dgii_import_rnc_batch', {
            p_token: token,
            p_records: records
        });

        if (error) throw new Error(error.message);

        const duration = Date.now() - startTime;

        // Log the import
        await supabase.rpc('dgii_log_import', {
            p_token: token,
            p_records_imported: data?.imported || 0,
            p_records_updated: 0,
            p_records_total: records.length,
            p_source: 'dgii_file',
            p_duration_ms: duration
        });

        res.json({
            success: true,
            imported: data?.imported || 0,
            total: records.length,
            duration_ms: duration
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
