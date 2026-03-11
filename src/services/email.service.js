/**
 * ParkingPro Email Service
 * Centralized email sending via nodemailer + template system
 */

const nodemailer = require('nodemailer');
const { query } = require('../config/database');
const { renderTemplate } = require('./emailTemplates');

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user) {
    console.warn('[EmailService] SMTP no configurado');
    return null;
  }

  _transporter = nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: { user, pass },
  });

  return _transporter;
}

/**
 * Get active notification email addresses from settings
 */
async function getActiveEmails() {
  const emails = [];
  for (let i = 1; i <= 3; i++) {
    try {
      const enabledRes = await query(
        `SELECT value FROM settings WHERE key = $1`,
        [`notification_email_${i}_enabled`]
      );
      const enabled = enabledRes.rows[0]?.value;
      if (enabled === true || enabled === 'true' || enabled === '"true"') {
        const emailRes = await query(
          `SELECT value FROM settings WHERE key = $1`,
          [`notification_email_${i}`]
        );
        const raw = emailRes.rows[0]?.value;
        const email = typeof raw === 'string' ? raw.replace(/^"|"$/g, '') : raw;
        if (email && email.includes('@')) {
          emails.push(email);
        }
      }
    } catch (err) {
      console.error(`[EmailService] Error reading email ${i}:`, err.message);
    }
  }
  return emails;
}

/**
 * Send an email using a template
 * @param {object} opts
 * @param {string} opts.to - Recipient email (or 'all' to send to all active notification emails)
 * @param {string} opts.templateId - Template ID: cash_alert, payment_confirm, subscription_expiry
 * @param {object} opts.templateData - Data for the template
 * @param {string} [opts.userId] - User ID for audit logging
 * @returns {Promise<{success: boolean, sentTo: string[]}>}
 */
async function sendTemplateEmail({ to, templateId, templateData, userId }) {
  const transporter = getTransporter();
  if (!transporter) {
    return { success: false, error: 'SMTP no configurado', sentTo: [] };
  }

  const { html, subject } = renderTemplate(templateId, templateData);

  // Determine recipients
  let recipients;
  if (to === 'all' || !to) {
    recipients = await getActiveEmails();
  } else if (Array.isArray(to)) {
    recipients = to;
  } else {
    recipients = [to];
  }

  if (recipients.length === 0) {
    return { success: false, error: 'No hay emails configurados', sentTo: [] };
  }

  const sentTo = [];
  const errors = [];

  for (const recipient of recipients) {
    try {
      await transporter.sendMail({
        from: process.env.SMTP_USER,
        to: recipient,
        subject,
        html,
      });
      sentTo.push(recipient);

      // Log to notifications table
      try {
        await query(
          `INSERT INTO notifications (user_id, type, channel, recipient, subject, body, status, sent_at, template_id, template_data)
           VALUES ($1, $2, 'email', $3, $4, $5, 'sent', NOW(), $6, $7)`,
          [
            userId || null,
            templateId === 'cash_alert' ? 'general' : (templateId === 'payment_confirm' ? 'payment_reminder' : 'subscription_expiry'),
            recipient,
            subject,
            `Email enviado usando template: ${templateId}`,
            templateId,
            JSON.stringify(templateData),
          ]
        );
      } catch (logErr) {
        console.error('[EmailService] Error logging notification:', logErr.message);
      }
    } catch (err) {
      errors.push({ recipient, error: err.message });

      // Log failure
      try {
        await query(
          `INSERT INTO notifications (user_id, type, channel, recipient, subject, body, status, failed_at, failure_reason, template_id, template_data)
           VALUES ($1, $2, 'email', $3, $4, $5, 'failed', NOW(), $6, $7, $8)`,
          [
            userId || null,
            'general',
            recipient,
            subject,
            `Fallo al enviar template: ${templateId}`,
            err.message,
            templateId,
            JSON.stringify(templateData),
          ]
        );
      } catch (logErr) {
        console.error('[EmailService] Error logging failure:', logErr.message);
      }
    }
  }

  return {
    success: sentTo.length > 0,
    sentTo,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Send a raw HTML/text email (no template)
 */
async function sendRawEmail({ to, subject, html, text, userId }) {
  const transporter = getTransporter();
  if (!transporter) {
    return { success: false, error: 'SMTP no configurado' };
  }

  try {
    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to,
      subject,
      html,
      text,
    });

    // Log to notifications table
    try {
      await query(
        `INSERT INTO notifications (user_id, type, channel, recipient, subject, body, status, sent_at)
         VALUES ($1, 'manual', 'email', $2, $3, $4, 'sent', NOW())`,
        [userId || null, to, subject, text || html?.substring(0, 500)]
      );
    } catch (logErr) {
      console.error('[EmailService] Error logging:', logErr.message);
    }

    return { success: true };
  } catch (err) {
    // Log failure
    try {
      await query(
        `INSERT INTO notifications (user_id, type, channel, recipient, subject, body, status, failed_at, failure_reason)
         VALUES ($1, 'manual', 'email', $2, $3, $4, 'failed', NOW(), $5)`,
        [userId || null, to, subject, text || '', err.message]
      );
    } catch (logErr) {
      console.error('[EmailService] Error logging failure:', logErr.message);
    }

    return { success: false, error: err.message };
  }
}

/**
 * Process pending email notifications in the queue
 */
async function processPendingEmails(limit = 10) {
  const transporter = getTransporter();
  if (!transporter) return { processed: 0 };

  const result = await query(
    `SELECT id, recipient, subject, body, template_id, template_data
     FROM notifications
     WHERE channel = 'email' AND status = 'pending'
     ORDER BY created_at ASC LIMIT $1`,
    [limit]
  );

  let processed = 0;
  for (const notif of result.rows) {
    try {
      let html = notif.body;
      let subject = notif.subject;

      // If template exists, render it
      if (notif.template_id && notif.template_data) {
        const rendered = renderTemplate(notif.template_id, notif.template_data);
        html = rendered.html;
        subject = subject || rendered.subject;
      }

      await transporter.sendMail({
        from: process.env.SMTP_USER,
        to: notif.recipient,
        subject: subject || '[ParkingPro] Notificacion',
        html,
      });

      await query(
        `UPDATE notifications SET status = 'sent', sent_at = NOW() WHERE id = $1`,
        [notif.id]
      );
      processed++;
    } catch (err) {
      await query(
        `UPDATE notifications SET status = 'failed', failed_at = NOW(), failure_reason = $2 WHERE id = $1`,
        [notif.id, err.message]
      );
    }
  }

  return { processed };
}

module.exports = {
  sendTemplateEmail,
  sendRawEmail,
  getActiveEmails,
  processPendingEmails,
  getTransporter,
};
