const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { query } = require('../config/database');
const { logAudit } = require('../middleware/audit');
const emailService = require('../services/email.service');
const { TEMPLATES } = require('../services/emailTemplates');
const pushService = require('../services/push.service');

router.get('/', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
  try {
    const { channel, status, limit = 50, offset = 0 } = req.query;
    let sql = `SELECT n.id, n.type, n.channel, n.recipient, n.subject,
      LEFT(n.body, 200) AS body_preview, n.status, n.sent_at, n.failed_at,
      n.failure_reason, n.provider, n.created_at, n.template_id,
      c.first_name || ' ' || c.last_name AS customer_name
      FROM notifications n
      LEFT JOIN users u ON u.id = n.user_id
      LEFT JOIN customers c ON c.user_id = n.user_id WHERE 1=1`;
    const params = [];
    let idx = 1;
    if (channel) { sql += ` AND n.channel = $${idx++}`; params.push(channel); }
    if (status) { sql += ` AND n.status = $${idx++}`; params.push(status); }

    const countSql = sql.replace(/SELECT n\.id.*FROM/, 'SELECT COUNT(*) FROM');
    const countRes = await query(countSql, params);

    sql += ` ORDER BY n.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(parseInt(limit), parseInt(offset));
    const result = await query(sql, params);

    res.json({ success: true, data: { notifications: result.rows, total: parseInt(countRes.rows[0].count) } });
  } catch (error) { next(error); }
});

router.get('/stats', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
  try {
    const result = await query(`SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'sent') as sent,
      COUNT(*) FILTER (WHERE status = 'failed') as failed,
      COUNT(*) FILTER (WHERE status = 'pending') as pending,
      COUNT(*) FILTER (WHERE channel = 'whatsapp') as whatsapp,
      COUNT(*) FILTER (WHERE channel = 'email') as email,
      COUNT(*) FILTER (WHERE channel = 'sms') as sms,
      COUNT(*) FILTER (WHERE channel = 'push') as push
    FROM notifications`);
    const r = result.rows[0];
    res.json({ success: true, data: {
      total: parseInt(r.total), sent: parseInt(r.sent), failed: parseInt(r.failed),
      pending: parseInt(r.pending),
      by_channel: { whatsapp: parseInt(r.whatsapp), email: parseInt(r.email), sms: parseInt(r.sms), push: parseInt(r.push) }
    }});
  } catch (error) { next(error); }
});

// List available email templates
router.get('/templates', authenticate, authorize(['admin', 'super_admin']), (req, res) => {
  const templates = [
    { id: 'cash_alert', name: 'Alerta de Cuadre de Caja', description: 'Notifica diferencias en cierre de caja', icon: 'AlertTriangle' },
    { id: 'payment_confirm', name: 'Confirmacion de Pago', description: 'Recibo de pago para clientes', icon: 'CheckCircle' },
    { id: 'subscription_expiry', name: 'Vencimiento de Suscripcion', description: 'Recordatorio de renovacion', icon: 'Clock' },
  ];
  res.json({ success: true, data: { templates } });
});

// Send notification (supports templates for email)
router.post('/', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
  try {
    const { channel, recipient, subject, body, type = 'manual', templateId, templateData } = req.body;

    // If email channel with template, use email service directly
    if (channel === 'email' && templateId && TEMPLATES[templateId]) {
      const result = await emailService.sendTemplateEmail({
        to: recipient,
        templateId,
        templateData: templateData || {},
        userId: req.user.id,
      });

      await logAudit({
        userId: req.user.id, action: 'notification_sent', entityType: 'notification',
        details: { channel, recipient, templateId, success: result.success }, req
      });

      if (result.success) {
        return res.status(201).json({ success: true, data: { sentTo: result.sentTo, templateId } });
      }
      return res.status(500).json({ success: false, error: result.error });
    }

    // If email without template, send raw email directly
    if (channel === 'email' && body) {
      const emailResult = await emailService.sendRawEmail({
        to: recipient,
        subject: subject || '[ParkingPro] Notificacion',
        html: `<div style="font-family:sans-serif;padding:20px;"><p>${body.replace(/\n/g, '<br>')}</p></div>`,
        text: body,
        userId: req.user.id,
      });

      await logAudit({
        userId: req.user.id, action: emailResult.success ? 'notification_sent' : 'notification_failed',
        entityType: 'notification', details: { channel, recipient, type }, req
      });

      if (emailResult.success) {
        return res.status(201).json({ success: true, data: { sent: true } });
      }
      return res.status(500).json({ success: false, error: emailResult.error });
    }

    // Push notification channel - send immediately
    if (channel === 'push') {
      const payload = {
        title: subject || 'ParkingPro',
        body,
        icon: '/favicon.svg',
        badge: '/favicon.svg',
        tag: 'parkingpro-notification',
        data: { url: '/' },
      };

      const results = recipient === 'all'
        ? await pushService.sendToAll(payload)
        : await pushService.sendToUser(recipient, payload);

      await query(
        `INSERT INTO notifications (user_id, type, channel, recipient, subject, body, status, sent_at)
         VALUES ($1, $2, 'push', $3, $4, $5, 'sent', NOW())`,
        [req.user.id, type, recipient, subject, body]
      );

      await logAudit({ userId: req.user.id, action: 'notification_sent', entityType: 'notification',
        details: { channel: 'push', recipient, results }, req });

      return res.status(201).json({ success: true, data: results });
    }

    // For other channels (whatsapp, sms) - queue as pending
    const result = await query(
      `INSERT INTO notifications (user_id, type, channel, recipient, subject, body, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING id`,
      [req.user.id, type, channel, recipient, subject, body]
    );
    await logAudit({ userId: req.user.id, action: 'notification_queued', entityType: 'notification',
      entityId: result.rows[0].id, details: { channel, recipient, type }, req });
    res.status(201).json({ success: true, data: { id: result.rows[0].id } });
  } catch (error) { next(error); }
});

// Send template email to all active notification emails
router.post('/send-alert', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
  try {
    const { templateId, templateData } = req.body;
    if (!templateId || !TEMPLATES[templateId]) {
      return res.status(400).json({ success: false, error: `Template invalido. Disponibles: ${Object.keys(TEMPLATES).join(', ')}` });
    }

    const result = await emailService.sendTemplateEmail({
      to: 'all',
      templateId,
      templateData: templateData || {},
      userId: req.user.id,
    });

    await logAudit({
      userId: req.user.id, action: 'alert_sent', entityType: 'notification',
      details: { templateId, sentTo: result.sentTo, success: result.success }, req
    });

    res.json({ success: result.success, data: result });
  } catch (error) { next(error); }
});

// Process pending email queue
router.post('/process-queue', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
  try {
    const result = await emailService.processPendingEmails(req.body.limit || 10);
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
});

// ==================== PUSH NOTIFICATION ENDPOINTS ====================

// Get VAPID public key (any authenticated user)
router.get('/push/vapid-key', authenticate, (req, res) => {
  const key = pushService.getPublicKey();
  if (!key) {
    return res.status(503).json({ success: false, error: 'Push notifications not configured' });
  }
  res.json({ success: true, data: { publicKey: key } });
});

// Subscribe to push notifications (any authenticated user)
router.post('/push/subscribe', authenticate, async (req, res, next) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint || !subscription.keys) {
      return res.status(400).json({ success: false, error: 'Invalid subscription object' });
    }
    const result = await pushService.saveSubscription(
      req.user.id, subscription, req.headers['user-agent']
    );
    await logAudit({
      userId: req.user.id, action: 'push_subscribed', entityType: 'push_subscription',
      entityId: result.id, details: { endpoint: subscription.endpoint.substring(0, 50) }, req
    });
    res.status(201).json({ success: true, data: { id: result.id } });
  } catch (error) { next(error); }
});

// Unsubscribe from push notifications (any authenticated user)
router.post('/push/unsubscribe', authenticate, async (req, res, next) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) {
      return res.status(400).json({ success: false, error: 'Endpoint required' });
    }
    await pushService.removeSubscription(endpoint);
    await logAudit({
      userId: req.user.id, action: 'push_unsubscribed', entityType: 'push_subscription',
      details: { endpoint: endpoint.substring(0, 50) }, req
    });
    res.json({ success: true });
  } catch (error) { next(error); }
});

// Send push notification (admin only)
router.post('/push/send', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
  try {
    const { title, body, target, userId: targetUserId, role, url, tag, requireInteraction } = req.body;
    if (!title || !body) {
      return res.status(400).json({ success: false, error: 'title and body are required' });
    }

    const payload = {
      title,
      body,
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      tag: tag || 'parkingpro-notification',
      data: { url: url || '/' },
      requireInteraction: requireInteraction || false,
    };

    let results;
    if (target === 'user' && targetUserId) {
      results = await pushService.sendToUser(targetUserId, payload);
    } else if (target === 'role' && role) {
      results = await pushService.sendToRole(role, payload);
    } else {
      results = await pushService.sendToAll(payload);
    }

    // Log to notifications table
    await query(
      `INSERT INTO notifications (user_id, type, channel, recipient, subject, body, status, sent_at)
       VALUES ($1, 'push', 'push', $2, $3, $4, 'sent', NOW())`,
      [req.user.id, target === 'user' ? targetUserId : (target === 'role' ? `role:${role}` : 'all'), title, body]
    );

    await logAudit({
      userId: req.user.id, action: 'push_sent', entityType: 'notification',
      details: { target, results }, req
    });

    res.json({ success: true, data: results });
  } catch (error) { next(error); }
});

// Get push subscription status for current user
router.get('/push/status', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, endpoint, user_agent, created_at FROM push_subscriptions WHERE user_id = $1`,
      [req.user.id]
    );
    res.json({ success: true, data: { subscriptions: result.rows, count: result.rows.length } });
  } catch (error) { next(error); }
});

module.exports = router;
