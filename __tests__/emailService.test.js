const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'test-id' });

jest.mock('nodemailer', () => ({
  createTransport: jest.fn().mockReturnValue({
    sendMail: mockSendMail,
  }),
}));

const mockQuery = jest.fn();
jest.mock('../src/config/database', () => ({
  query: mockQuery,
}));

jest.mock('../src/services/emailTemplates', () => ({
  renderTemplate: jest.fn().mockReturnValue({
    html: '<h1>Test Email</h1>',
    subject: 'Test Subject',
  }),
}));

// Must require AFTER mocks are set up
let emailService;

// ─── Helpers ────────────────────────────────────────────────────────────────

function setupSmtpEnv() {
  process.env.SMTP_HOST = 'smtp.test.com';
  process.env.SMTP_USER = 'test@test.com';
  process.env.SMTP_PASS = 'password';
  process.env.SMTP_PORT = '587';
}

function clearSmtpEnv() {
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.SMTP_PORT;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Email Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset the cached transporter by re-requiring the module
    jest.resetModules();

    // Re-apply mocks after resetModules
    jest.mock('nodemailer', () => ({
      createTransport: jest.fn().mockReturnValue({
        sendMail: mockSendMail,
      }),
    }));
    jest.mock('../src/config/database', () => ({
      query: mockQuery,
    }));
    jest.mock('../src/services/emailTemplates', () => ({
      renderTemplate: jest.fn().mockReturnValue({
        html: '<h1>Test Email</h1>',
        subject: 'Test Subject',
      }),
    }));

    setupSmtpEnv();
    emailService = require('../src/services/email.service');
  });

  afterEach(() => {
    clearSmtpEnv();
  });

  // ─── sendTemplateEmail ──────────────────────────────────────────────────

  describe('sendTemplateEmail', () => {
    it('sends email successfully to a single recipient', async () => {
      mockQuery.mockResolvedValue({ rows: [] }); // for logging

      const result = await emailService.sendTemplateEmail({
        to: 'user@example.com',
        templateId: 'payment_confirm',
        templateData: { amount: 100 },
        userId: 'user-1',
      });

      expect(result.success).toBe(true);
      expect(result.sentTo).toEqual(['user@example.com']);
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@example.com',
          subject: 'Test Subject',
          html: '<h1>Test Email</h1>',
        })
      );
    });

    it('returns error when SMTP is not configured', async () => {
      clearSmtpEnv();
      jest.resetModules();
      jest.mock('nodemailer', () => ({
        createTransport: jest.fn().mockReturnValue({ sendMail: mockSendMail }),
      }));
      jest.mock('../src/config/database', () => ({ query: mockQuery }));
      jest.mock('../src/services/emailTemplates', () => ({
        renderTemplate: jest.fn().mockReturnValue({ html: '<h1>Test</h1>', subject: 'Test' }),
      }));
      emailService = require('../src/services/email.service');

      const result = await emailService.sendTemplateEmail({
        to: 'user@example.com',
        templateId: 'cash_alert',
        templateData: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('SMTP no configurado');
      expect(result.sentTo).toEqual([]);
    });

    it('returns error when no recipients are available', async () => {
      // to = 'all' triggers getActiveEmails which returns []
      // Mock getActiveEmails queries: 3 iterations, all disabled
      for (let i = 0; i < 3; i++) {
        mockQuery.mockResolvedValueOnce({ rows: [{ value: 'false' }] }); // enabled check
      }

      const result = await emailService.sendTemplateEmail({
        to: 'all',
        templateId: 'cash_alert',
        templateData: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('No hay emails configurados');
      expect(result.sentTo).toEqual([]);
    });
  });

  // ─── sendRawEmail ──────────────────────────────────────────────────────

  describe('sendRawEmail', () => {
    it('sends raw email successfully', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await emailService.sendRawEmail({
        to: 'admin@example.com',
        subject: 'Raw Test',
        html: '<p>Hello</p>',
        text: 'Hello',
        userId: 'user-1',
      });

      expect(result.success).toBe(true);
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'admin@example.com',
          subject: 'Raw Test',
          html: '<p>Hello</p>',
          text: 'Hello',
        })
      );
    });

    it('returns error and logs failure when sendMail rejects', async () => {
      mockSendMail.mockRejectedValueOnce(new Error('Connection refused'));
      mockQuery.mockResolvedValue({ rows: [] });

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const result = await emailService.sendRawEmail({
        to: 'admin@example.com',
        subject: 'Fail Test',
        html: '<p>Hello</p>',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Connection refused');
      // The failure should be logged to the notifications table
      expect(mockQuery).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  // ─── processPendingEmails ─────────────────────────────────────────────

  describe('processPendingEmails', () => {
    it('processes queued emails and updates status', async () => {
      const pendingRows = [
        { id: 1, recipient: 'a@test.com', subject: 'Sub1', body: '<p>Body1</p>', template_id: null, template_data: null },
        { id: 2, recipient: 'b@test.com', subject: 'Sub2', body: '<p>Body2</p>', template_id: null, template_data: null },
      ];

      mockQuery
        .mockResolvedValueOnce({ rows: pendingRows }) // SELECT pending
        .mockResolvedValueOnce({ rows: [] }) // UPDATE id=1
        .mockResolvedValueOnce({ rows: [] }); // UPDATE id=2

      const result = await emailService.processPendingEmails(10);

      expect(result.processed).toBe(2);
      expect(mockSendMail).toHaveBeenCalledTimes(2);
      // Verify status updates were called
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE notifications SET status'),
        expect.arrayContaining([1])
      );
    });

    it('handles send failures for individual emails', async () => {
      const pendingRows = [
        { id: 10, recipient: 'fail@test.com', subject: 'Fail', body: '<p>Fail</p>', template_id: null, template_data: null },
      ];

      mockQuery
        .mockResolvedValueOnce({ rows: pendingRows }) // SELECT pending
        .mockResolvedValueOnce({ rows: [] }); // UPDATE failed

      mockSendMail.mockRejectedValueOnce(new Error('SMTP timeout'));

      const result = await emailService.processPendingEmails(10);

      expect(result.processed).toBe(0);
      // Verify failure was recorded
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("status = 'failed'"),
        expect.arrayContaining([10, 'SMTP timeout'])
      );
    });

    it('returns 0 processed when SMTP is not configured', async () => {
      clearSmtpEnv();
      jest.resetModules();
      jest.mock('nodemailer', () => ({
        createTransport: jest.fn().mockReturnValue({ sendMail: mockSendMail }),
      }));
      jest.mock('../src/config/database', () => ({ query: mockQuery }));
      jest.mock('../src/services/emailTemplates', () => ({
        renderTemplate: jest.fn().mockReturnValue({ html: '', subject: '' }),
      }));
      emailService = require('../src/services/email.service');

      const result = await emailService.processPendingEmails();

      expect(result.processed).toBe(0);
    });
  });

  // ─── getActiveEmails ──────────────────────────────────────────────────

  describe('getActiveEmails', () => {
    it('returns configured and enabled email addresses', async () => {
      // Email 1: enabled + valid
      mockQuery
        .mockResolvedValueOnce({ rows: [{ value: 'true' }] })   // email_1_enabled
        .mockResolvedValueOnce({ rows: [{ value: '"admin@park.com"' }] }) // email_1
        // Email 2: enabled + valid
        .mockResolvedValueOnce({ rows: [{ value: true }] })     // email_2_enabled
        .mockResolvedValueOnce({ rows: [{ value: 'ops@park.com' }] }) // email_2
        // Email 3: disabled
        .mockResolvedValueOnce({ rows: [{ value: 'false' }] }); // email_3_enabled

      const emails = await emailService.getActiveEmails();

      expect(emails).toEqual(['admin@park.com', 'ops@park.com']);
    });

    it('filters out disabled emails', async () => {
      // All three disabled
      mockQuery
        .mockResolvedValueOnce({ rows: [{ value: 'false' }] })
        .mockResolvedValueOnce({ rows: [{ value: 'false' }] })
        .mockResolvedValueOnce({ rows: [{ value: 'false' }] });

      const emails = await emailService.getActiveEmails();

      expect(emails).toEqual([]);
    });

    it('handles errors gracefully for individual email lookups', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      // Email 1: throws
      mockQuery
        .mockRejectedValueOnce(new Error('DB error'))
        // Email 2: enabled + valid
        .mockResolvedValueOnce({ rows: [{ value: 'true' }] })
        .mockResolvedValueOnce({ rows: [{ value: 'valid@park.com' }] })
        // Email 3: disabled
        .mockResolvedValueOnce({ rows: [{ value: 'false' }] });

      const emails = await emailService.getActiveEmails();

      expect(emails).toEqual(['valid@park.com']);
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });
});
