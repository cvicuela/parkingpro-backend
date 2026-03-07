const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { query } = require('../config/database');

router.get('/', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const { limit, offset, userId, action, entityType, startDate, endDate } = req.query;
        const params = [];
        let where = 'WHERE 1=1';

        if (userId)     { params.push(userId);     where += ` AND al.user_id = $${params.length}`; }
        if (action)     { params.push(`%${action}%`); where += ` AND al.action ILIKE $${params.length}`; }
        if (entityType) { params.push(entityType); where += ` AND al.entity_type = $${params.length}`; }
        if (startDate)  { params.push(startDate);  where += ` AND al.created_at >= $${params.length}`; }
        if (endDate)    { params.push(endDate);     where += ` AND al.created_at <= $${params.length}`; }

        params.push(parseInt(limit) || 100, parseInt(offset) || 0);

        const result = await query(
            `SELECT al.*,
                COALESCE(u.first_name || ' ' || u.last_name, u.email) as user_name,
                u.role as user_role
             FROM audit_logs al
             LEFT JOIN users u ON al.user_id = u.id
             ${where}
             ORDER BY al.created_at DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );

        const countResult = await query(
            `SELECT COUNT(*) as total FROM audit_logs al ${where}`,
            params.slice(0, -2)
        );

        res.json({
            success: true,
            data: result.rows,
            total: parseInt(countResult.rows[0].total)
        });
    } catch (error) {
        next(error);
    }
});

router.get('/actions', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const result = await query(
            `SELECT DISTINCT action, COUNT(*) as count
             FROM audit_logs
             GROUP BY action
             ORDER BY count DESC`
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
