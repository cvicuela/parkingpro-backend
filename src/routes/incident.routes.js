const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { query } = require('../config/database');
const { logAudit } = require('../middleware/audit');

router.get('/', authenticate, async (req, res, next) => {
  try {
    const { status, severity, type, limit = 50, offset = 0 } = req.query;
    let sql = `SELECT i.*, op.email AS operator_email, rb.email AS resolved_by_email
      FROM incidents i
      LEFT JOIN users op ON op.id = i.operator_id
      LEFT JOIN users rb ON rb.id = i.resolved_by WHERE 1=1`;
    const params = [];
    let idx = 1;
    if (status) { sql += ` AND i.status = $${idx++}`; params.push(status); }
    if (severity) { sql += ` AND i.severity = $${idx++}`; params.push(severity); }
    if (type) { sql += ` AND i.type = $${idx++}`; params.push(type); }

    const countSql = sql.replace(/SELECT i\.\*.*FROM/, 'SELECT COUNT(*) FROM');
    const countRes = await query(countSql, params);

    sql += ` ORDER BY CASE i.status WHEN 'open' THEN 0 WHEN 'investigating' THEN 1 ELSE 2 END,
      CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      i.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(parseInt(limit), parseInt(offset));
    const result = await query(sql, params);

    res.json({ success: true, data: { incidents: result.rows, total: parseInt(countRes.rows[0].count) } });
  } catch (error) { next(error); }
});

router.post('/', authenticate, async (req, res, next) => {
  try {
    const { type, title, description, severity = 'medium', vehiclePlate, subscriptionId, photos } = req.body;
    const result = await query(
      `INSERT INTO incidents (type, vehicle_plate, subscription_id, operator_id, title, description, severity, status, photos)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8) RETURNING *`,
      [type, vehiclePlate, subscriptionId, req.user.id, title, description, severity, photos ? JSON.stringify(photos) : null]
    );
    await logAudit({ userId: req.user.id, action: 'incident_created', entityType: 'incident',
      entityId: result.rows[0].id, details: { type, severity, title }, req });
    const incident = result.rows[0];
    res.status(201).json({ success: true, data: incident });

    // Emit real-time update after creating incident
    try {
      const io = req.app.get('io');
      if (io) {
        io.to('dashboard').emit('incident_created', {
          id: incident.id,
          type: incident.type,
          title: incident.title,
          description: incident.description,
          severity: incident.severity,
          priority: incident.severity,
          time: new Date().toISOString()
        });
      }
    } catch (e) { /* non-critical */ }

  } catch (error) { next(error); }
});

router.put('/:id/resolve', authenticate, async (req, res, next) => {
  try {
    const { notes, status = 'resolved' } = req.body;
    await query(
      `UPDATE incidents SET status = $1,
        resolved_at = CASE WHEN $1 = 'resolved' THEN NOW() ELSE resolved_at END,
        resolved_by = CASE WHEN $1 = 'resolved' THEN $2::uuid ELSE resolved_by END,
        resolution_notes = COALESCE($3, resolution_notes), updated_at = NOW()
      WHERE id = $4`,
      [status, req.user.id, notes, req.params.id]
    );
    await logAudit({ userId: req.user.id, action: `incident_${status}`, entityType: 'incident',
      entityId: req.params.id, details: { status, notes }, req });
    res.json({ success: true });
  } catch (error) { next(error); }
});

module.exports = router;
