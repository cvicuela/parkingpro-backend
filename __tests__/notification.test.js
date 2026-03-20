// Mock database before requiring anything else
const mockQuery = jest.fn();
jest.mock('../src/config/database', () => ({
  query: mockQuery,
  transaction: jest.fn(),
  supabase: {},
  pool: { end: jest.fn() },
  testConnection: jest.fn().mockResolvedValue(true)
}));

jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, res, next) => {
    req.user = { id: 'test-user-id', role: 'admin', email: 'admin@test.com' };
    next();
  },
  authorize: () => (req, res, next) => next()
}));

jest.mock('../src/middleware/audit', () => ({
  logAudit: jest.fn()
}));

jest.mock('../src/services/email.service', () => ({
  sendTemplateEmail: jest.fn().mockResolvedValue({ success: true, sentTo: ['test@test.com'] }),
  sendRawEmail: jest.fn().mockResolvedValue({ success: true }),
  processPendingEmails: jest.fn().mockResolvedValue({ processed: 5 }),
  getActiveEmails: jest.fn().mockResolvedValue(['test@test.com']),
}));

jest.mock('../src/services/push.service', () => ({
  sendToAll: jest.fn().mockResolvedValue({ sent: 1, failed: 0, cleaned: 0 }),
  sendToUser: jest.fn().mockResolvedValue({ sent: 1, failed: 0, cleaned: 0 }),
  sendToRole: jest.fn().mockResolvedValue({ sent: 1, failed: 0, cleaned: 0 }),
  saveSubscription: jest.fn().mockResolvedValue({ id: 'sub-id' }),
  removeSubscription: jest.fn().mockResolvedValue(),
  getPublicKey: jest.fn().mockReturnValue('fake-vapid-key'),
}));

jest.mock('../src/services/emailTemplates', () => ({
  TEMPLATES: {
    cash_alert: { subject: 'Test', html: '<p>Test</p>' },
    payment_confirm: { subject: 'Test', html: '<p>Test</p>' },
    subscription_expiry: { subject: 'Test', html: '<p>Test</p>' },
  },
  renderTemplate: jest.fn().mockReturnValue({ html: '<p>Test</p>', subject: 'Test Subject' }),
}));

const request = require('supertest');
const express = require('express');
const notificationRoutes = require('../src/routes/notification.routes');
const errorHandler = require('../src/middleware/errorHandler');
const emailService = require('../src/services/email.service');
const pushService = require('../src/services/push.service');
const { logAudit } = require('../src/middleware/audit');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/notifications', notificationRoutes);
  app.use(errorHandler);
  return app;
}

describe('Notification Routes', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ==================== GET / ====================

  describe('GET /api/v1/notifications', () => {
    it('should list notifications without filters', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '3' }] }) // count query
        .mockResolvedValueOnce({
          rows: [
            { id: '1', type: 'manual', channel: 'email', recipient: 'a@b.com', subject: 'Hi', body_preview: 'Hello', status: 'sent', customer_name: 'John Doe' },
            { id: '2', type: 'manual', channel: 'sms', recipient: '+1234', subject: null, body_preview: 'Test', status: 'pending', customer_name: null },
            { id: '3', type: 'alert', channel: 'push', recipient: 'all', subject: 'Alert', body_preview: 'Alert body', status: 'sent', customer_name: null },
          ]
        });

      const res = await request(app).get('/api/v1/notifications');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.notifications).toHaveLength(3);
      expect(res.body.data.total).toBe(3);
    });

    it('should filter by channel', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({
          rows: [{ id: '1', type: 'manual', channel: 'email', recipient: 'a@b.com', subject: 'Hi', status: 'sent' }]
        });

      const res = await request(app).get('/api/v1/notifications?channel=email');

      expect(res.status).toBe(200);
      expect(res.body.data.notifications).toHaveLength(1);
      expect(res.body.data.total).toBe(1);
    });

    it('should filter by status', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '2' }] })
        .mockResolvedValueOnce({
          rows: [
            { id: '1', status: 'pending' },
            { id: '2', status: 'pending' },
          ]
        });

      const res = await request(app).get('/api/v1/notifications?status=pending');

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(2);
    });

    it('should support limit and offset', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '50' }] })
        .mockResolvedValueOnce({ rows: [{ id: '11' }] });

      const res = await request(app).get('/api/v1/notifications?limit=10&offset=10');

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(50);
    });

    it('should handle database errors', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));

      const res = await request(app).get('/api/v1/notifications');

      expect(res.status).toBe(500);
    });
  });

  // ==================== GET /stats ====================

  describe('GET /api/v1/notifications/stats', () => {
    it('should return notification statistics', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          total: '100', sent: '80', failed: '5', pending: '15',
          whatsapp: '10', email: '60', sms: '20', push: '10'
        }]
      });

      const res = await request(app).get('/api/v1/notifications/stats');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.total).toBe(100);
      expect(res.body.data.sent).toBe(80);
      expect(res.body.data.failed).toBe(5);
      expect(res.body.data.pending).toBe(15);
      expect(res.body.data.by_channel).toEqual({
        whatsapp: 10, email: 60, sms: 20, push: 10
      });
    });

    it('should handle database errors', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));

      const res = await request(app).get('/api/v1/notifications/stats');

      expect(res.status).toBe(500);
    });
  });

  // ==================== GET /templates ====================

  describe('GET /api/v1/notifications/templates', () => {
    it('should return available templates', async () => {
      const res = await request(app).get('/api/v1/notifications/templates');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.templates).toHaveLength(3);
      expect(res.body.data.templates[0]).toHaveProperty('id');
      expect(res.body.data.templates[0]).toHaveProperty('name');
      expect(res.body.data.templates[0]).toHaveProperty('description');
      expect(res.body.data.templates[0]).toHaveProperty('icon');
    });

    it('should include cash_alert template', async () => {
      const res = await request(app).get('/api/v1/notifications/templates');

      const ids = res.body.data.templates.map(t => t.id);
      expect(ids).toContain('cash_alert');
      expect(ids).toContain('payment_confirm');
      expect(ids).toContain('subscription_expiry');
    });
  });

  // ==================== POST / ====================

  describe('POST /api/v1/notifications', () => {
    it('should send email with template', async () => {
      const res = await request(app)
        .post('/api/v1/notifications')
        .send({
          channel: 'email',
          recipient: 'test@test.com',
          templateId: 'cash_alert',
          templateData: { amount: 100 }
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.sentTo).toEqual(['test@test.com']);
      expect(res.body.data.templateId).toBe('cash_alert');
      expect(emailService.sendTemplateEmail).toHaveBeenCalledWith({
        to: 'test@test.com',
        templateId: 'cash_alert',
        templateData: { amount: 100 },
        userId: 'test-user-id',
      });
      expect(logAudit).toHaveBeenCalled();
    });

    it('should handle template email failure', async () => {
      emailService.sendTemplateEmail.mockResolvedValueOnce({ success: false, error: 'SMTP error' });

      const res = await request(app)
        .post('/api/v1/notifications')
        .send({
          channel: 'email',
          recipient: 'test@test.com',
          templateId: 'cash_alert',
        });

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('SMTP error');
    });

    it('should send raw email without template', async () => {
      const res = await request(app)
        .post('/api/v1/notifications')
        .send({
          channel: 'email',
          recipient: 'test@test.com',
          subject: 'Hello',
          body: 'Test message',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.sent).toBe(true);
      expect(emailService.sendRawEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'test@test.com',
          subject: 'Hello',
          text: 'Test message',
          userId: 'test-user-id',
        })
      );
    });

    it('should handle raw email failure', async () => {
      emailService.sendRawEmail.mockResolvedValueOnce({ success: false, error: 'Send failed' });

      const res = await request(app)
        .post('/api/v1/notifications')
        .send({
          channel: 'email',
          recipient: 'test@test.com',
          body: 'Test message',
        });

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
    });

    it('should send push notification to all', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'notif-1' }] }); // INSERT into notifications

      const res = await request(app)
        .post('/api/v1/notifications')
        .send({
          channel: 'push',
          recipient: 'all',
          subject: 'Alert',
          body: 'Emergency alert',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(pushService.sendToAll).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Alert',
          body: 'Emergency alert',
        })
      );
    });

    it('should send push notification to specific user', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'notif-1' }] });

      const res = await request(app)
        .post('/api/v1/notifications')
        .send({
          channel: 'push',
          recipient: 'user-123',
          subject: 'Personal',
          body: 'Your car is ready',
        });

      expect(res.status).toBe(201);
      expect(pushService.sendToUser).toHaveBeenCalledWith(
        'user-123',
        expect.objectContaining({ title: 'Personal', body: 'Your car is ready' })
      );
    });

    it('should queue other channels (whatsapp, sms) as pending', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'queued-1' }] });

      const res = await request(app)
        .post('/api/v1/notifications')
        .send({
          channel: 'whatsapp',
          recipient: '+18095551234',
          subject: 'Reminder',
          body: 'Your subscription expires soon',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('queued-1');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO notifications'),
        expect.arrayContaining(['test-user-id', 'manual', 'whatsapp', '+18095551234', 'Reminder', 'Your subscription expires soon'])
      );
    });

    it('should queue SMS as pending', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'sms-1' }] });

      const res = await request(app)
        .post('/api/v1/notifications')
        .send({
          channel: 'sms',
          recipient: '+18095551234',
          body: 'Your code is 1234',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBe('sms-1');
    });

    it('should handle database errors on queuing', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));

      const res = await request(app)
        .post('/api/v1/notifications')
        .send({
          channel: 'sms',
          recipient: '+18095551234',
          body: 'Test',
        });

      expect(res.status).toBe(500);
    });
  });

  // ==================== POST /send-alert ====================

  describe('POST /api/v1/notifications/send-alert', () => {
    it('should send alert with valid template to all emails', async () => {
      const res = await request(app)
        .post('/api/v1/notifications/send-alert')
        .send({
          templateId: 'cash_alert',
          templateData: { difference: 500 },
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(emailService.sendTemplateEmail).toHaveBeenCalledWith({
        to: 'all',
        templateId: 'cash_alert',
        templateData: { difference: 500 },
        userId: 'test-user-id',
      });
      expect(logAudit).toHaveBeenCalled();
    });

    it('should send alert with empty templateData defaulting to {}', async () => {
      const res = await request(app)
        .post('/api/v1/notifications/send-alert')
        .send({ templateId: 'payment_confirm' });

      expect(res.status).toBe(200);
      expect(emailService.sendTemplateEmail).toHaveBeenCalledWith(
        expect.objectContaining({ templateData: {} })
      );
    });

    it('should return 400 for invalid template', async () => {
      const res = await request(app)
        .post('/api/v1/notifications/send-alert')
        .send({ templateId: 'nonexistent_template' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Template invalido');
    });

    it('should return 400 when templateId is missing', async () => {
      const res = await request(app)
        .post('/api/v1/notifications/send-alert')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should handle email service errors', async () => {
      emailService.sendTemplateEmail.mockRejectedValueOnce(new Error('SMTP down'));

      const res = await request(app)
        .post('/api/v1/notifications/send-alert')
        .send({ templateId: 'cash_alert' });

      expect(res.status).toBe(500);
    });
  });

  // ==================== POST /process-queue ====================

  describe('POST /api/v1/notifications/process-queue', () => {
    it('should process pending email queue with default limit', async () => {
      const res = await request(app)
        .post('/api/v1/notifications/process-queue')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual({ processed: 5 });
      expect(emailService.processPendingEmails).toHaveBeenCalledWith(10);
    });

    it('should process queue with custom limit', async () => {
      const res = await request(app)
        .post('/api/v1/notifications/process-queue')
        .send({ limit: 25 });

      expect(res.status).toBe(200);
      expect(emailService.processPendingEmails).toHaveBeenCalledWith(25);
    });

    it('should handle processing errors', async () => {
      emailService.processPendingEmails.mockRejectedValueOnce(new Error('Queue error'));

      const res = await request(app)
        .post('/api/v1/notifications/process-queue')
        .send({});

      expect(res.status).toBe(500);
    });
  });

  // ==================== PUSH NOTIFICATION ENDPOINTS ====================

  describe('GET /api/v1/notifications/push/vapid-key', () => {
    it('should return VAPID public key', async () => {
      const res = await request(app).get('/api/v1/notifications/push/vapid-key');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.publicKey).toBe('fake-vapid-key');
    });

    it('should return 503 when push not configured', async () => {
      pushService.getPublicKey.mockReturnValueOnce(null);

      const res = await request(app).get('/api/v1/notifications/push/vapid-key');

      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
    });
  });

  describe('POST /api/v1/notifications/push/subscribe', () => {
    it('should subscribe to push notifications', async () => {
      const subscription = {
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
        keys: { p256dh: 'key1', auth: 'key2' },
      };

      const res = await request(app)
        .post('/api/v1/notifications/push/subscribe')
        .send({ subscription });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('sub-id');
      const callArgs = pushService.saveSubscription.mock.calls[0];
      expect(callArgs[0]).toBe('test-user-id');
      expect(callArgs[1]).toEqual(subscription);
    });

    it('should return 400 for missing subscription', async () => {
      const res = await request(app)
        .post('/api/v1/notifications/push/subscribe')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid subscription object');
    });

    it('should return 400 for subscription without keys', async () => {
      const res = await request(app)
        .post('/api/v1/notifications/push/subscribe')
        .send({ subscription: { endpoint: 'https://example.com' } });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/v1/notifications/push/unsubscribe', () => {
    it('should unsubscribe from push notifications', async () => {
      const res = await request(app)
        .post('/api/v1/notifications/push/unsubscribe')
        .send({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc123' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(pushService.removeSubscription).toHaveBeenCalledWith('https://fcm.googleapis.com/fcm/send/abc123');
    });

    it('should return 400 when endpoint is missing', async () => {
      const res = await request(app)
        .post('/api/v1/notifications/push/unsubscribe')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Endpoint required');
    });
  });

  describe('POST /api/v1/notifications/push/send', () => {
    it('should send push to all users', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'notif-1' }] });

      const res = await request(app)
        .post('/api/v1/notifications/push/send')
        .send({ title: 'Broadcast', body: 'Hello everyone' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(pushService.sendToAll).toHaveBeenCalled();
    });

    it('should send push to specific user', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'notif-1' }] });

      const res = await request(app)
        .post('/api/v1/notifications/push/send')
        .send({ title: 'Hey', body: 'Personal msg', target: 'user', userId: 'user-456' });

      expect(res.status).toBe(200);
      expect(pushService.sendToUser).toHaveBeenCalledWith('user-456', expect.objectContaining({ title: 'Hey' }));
    });

    it('should send push to role', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'notif-1' }] });

      const res = await request(app)
        .post('/api/v1/notifications/push/send')
        .send({ title: 'Operators', body: 'Shift change', target: 'role', role: 'operator' });

      expect(res.status).toBe(200);
      expect(pushService.sendToRole).toHaveBeenCalledWith('operator', expect.objectContaining({ title: 'Operators' }));
    });

    it('should return 400 when title is missing', async () => {
      const res = await request(app)
        .post('/api/v1/notifications/push/send')
        .send({ body: 'no title' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('title and body are required');
    });

    it('should return 400 when body is missing', async () => {
      const res = await request(app)
        .post('/api/v1/notifications/push/send')
        .send({ title: 'no body' });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v1/notifications/push/status', () => {
    it('should return push subscription status for current user', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 'sub-1', endpoint: 'https://example.com/push1', user_agent: 'Chrome', created_at: '2025-01-01' },
        ]
      });

      const res = await request(app).get('/api/v1/notifications/push/status');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.subscriptions).toHaveLength(1);
      expect(res.body.data.count).toBe(1);
    });

    it('should return empty when no subscriptions', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app).get('/api/v1/notifications/push/status');

      expect(res.status).toBe(200);
      expect(res.body.data.subscriptions).toHaveLength(0);
      expect(res.body.data.count).toBe(0);
    });
  });
});
