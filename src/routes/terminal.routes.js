const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { query } = require('../config/database');

// List all terminals
router.get('/', authenticate, async (req, res, next) => {
  try {
    const result = await query('SELECT * FROM terminals WHERE is_active = true ORDER BY code');
    res.json({ data: result.rows });
  } catch (err) { next(err); }
});

// Stats per terminal (must be before /:id routes to avoid conflicts)
router.get('/stats', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
  try {
    const result = await query(`
      SELECT t.id, t.name, t.code, t.type, t.is_active, t.last_heartbeat,
        (SELECT COUNT(*) FROM parking_sessions ps WHERE ps.terminal_entry_id = t.id AND ps.entry_time::date = CURRENT_DATE) as sessions_today,
        (SELECT COUNT(*) FROM parking_sessions ps WHERE ps.terminal_entry_id = t.id AND ps.status = 'active') as active_sessions,
        CASE WHEN t.last_heartbeat > NOW() - INTERVAL '5 minutes' THEN 'online' ELSE 'offline' END as connection_status
      FROM terminals t WHERE t.is_active = true ORDER BY t.code
    `);
    res.json({ data: result.rows });
  } catch (err) { next(err); }
});

// Create terminal (admin only)
router.post('/', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
  try {
    const { name, code, type, location, ip_address, device_serial, settings } = req.body;
    if (!name || !code || !type) return res.status(400).json({ error: 'name, code, type son requeridos' });
    const result = await query(
      `INSERT INTO terminals (name, code, type, location, ip_address, device_serial, settings)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [name, code.toUpperCase(), type, location, ip_address, device_serial, settings || {}]
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Código de terminal ya existe' });
    next(err);
  }
});

// Update terminal
router.put('/:id', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
  try {
    const { name, type, location, ip_address, device_serial, settings, is_active } = req.body;
    const result = await query(
      `UPDATE terminals SET
        name = COALESCE($2, name), type = COALESCE($3, type), location = COALESCE($4, location),
        ip_address = COALESCE($5, ip_address), device_serial = COALESCE($6, device_serial),
        settings = COALESCE($7, settings), is_active = COALESCE($8, is_active),
        updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id, name, type, location, ip_address, device_serial, settings, is_active]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Terminal no encontrada' });
    res.json({ data: result.rows[0] });
  } catch (err) { next(err); }
});

// Delete (soft) terminal
router.delete('/:id', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
  try {
    await query('UPDATE terminals SET is_active = false, updated_at = NOW() WHERE id = $1', [req.params.id]);
    res.json({ message: 'Terminal desactivada' });
  } catch (err) { next(err); }
});

// Heartbeat
router.post('/:code/heartbeat', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      'UPDATE terminals SET last_heartbeat = NOW() WHERE code = $1 AND is_active = true RETURNING id, name, code',
      [req.params.code.toUpperCase()]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Terminal no encontrada' });
    res.json({ data: result.rows[0], timestamp: new Date().toISOString() });
  } catch (err) { next(err); }
});

module.exports = router;
