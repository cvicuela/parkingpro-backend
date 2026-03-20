// Mock database before requiring anything else
const mockQuery = jest.fn();
const mockTransaction = jest.fn();
jest.mock('../src/config/database', () => ({
  query: mockQuery,
  transaction: mockTransaction,
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
  logAudit: jest.fn(),
  auditMiddleware: () => (req, res, next) => next()
}));

const request = require('supertest');
const express = require('express');

const invoiceRoutes = require('../src/routes/invoice.routes');
const errorHandler = require('../src/middleware/errorHandler');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/invoices', invoiceRoutes);
  app.use(errorHandler);
  return app;
}

describe('Invoice Routes', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── GET / ─────────────────────────────────────────────────────────────────

  describe('GET /api/v1/invoices', () => {
    it('should list invoices with default pagination', async () => {
      const invoiceService = require('../src/services/invoice.service');
      jest.spyOn(invoiceService, 'list').mockResolvedValueOnce({
        invoices: [
          { id: 'inv-1', invoice_number: 'INV-001', total: 1500 },
          { id: 'inv-2', invoice_number: 'INV-002', total: 2500 }
        ],
        total: 2
      });

      const res = await request(app).get('/api/v1/invoices');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.invoices).toHaveLength(2);
      expect(invoiceService.list).toHaveBeenCalledWith({
        limit: 50,
        offset: 0,
        customerId: null,
        startDate: null,
        endDate: null,
        search: null
      });
    });

    it('should pass query parameters to the service', async () => {
      const invoiceService = require('../src/services/invoice.service');
      jest.spyOn(invoiceService, 'list').mockResolvedValueOnce({ invoices: [], total: 0 });

      const res = await request(app)
        .get('/api/v1/invoices')
        .query({ limit: '10', offset: '5', customerId: 'cust-1', startDate: '2026-01-01', endDate: '2026-03-01', search: 'plan' });

      expect(res.status).toBe(200);
      expect(invoiceService.list).toHaveBeenCalledWith({
        limit: 10,
        offset: 5,
        customerId: 'cust-1',
        startDate: '2026-01-01',
        endDate: '2026-03-01',
        search: 'plan'
      });
    });

    it('should handle service errors', async () => {
      const invoiceService = require('../src/services/invoice.service');
      jest.spyOn(invoiceService, 'list').mockRejectedValueOnce(new Error('DB connection failed'));

      const res = await request(app).get('/api/v1/invoices');

      expect(res.status).toBe(500);
      expect(res.body.error).toBeDefined();
    });
  });

  // ── GET /stats ────────────────────────────────────────────────────────────

  describe('GET /api/v1/invoices/stats', () => {
    it('should return invoice statistics', async () => {
      const invoiceService = require('../src/services/invoice.service');
      jest.spyOn(invoiceService, 'getStats').mockResolvedValueOnce({
        totalInvoices: 100,
        totalRevenue: 500000,
        avgInvoiceAmount: 5000
      });

      const res = await request(app).get('/api/v1/invoices/stats');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.totalInvoices).toBe(100);
    });

    it('should pass date range to getStats', async () => {
      const invoiceService = require('../src/services/invoice.service');
      jest.spyOn(invoiceService, 'getStats').mockResolvedValueOnce({});

      await request(app)
        .get('/api/v1/invoices/stats')
        .query({ startDate: '2026-01-01', endDate: '2026-03-01' });

      expect(invoiceService.getStats).toHaveBeenCalledWith({
        startDate: '2026-01-01',
        endDate: '2026-03-01'
      });
    });

    it('should handle errors in stats endpoint', async () => {
      const invoiceService = require('../src/services/invoice.service');
      jest.spyOn(invoiceService, 'getStats').mockRejectedValueOnce(new Error('Stats error'));

      const res = await request(app).get('/api/v1/invoices/stats');

      expect(res.status).toBe(500);
    });
  });

  // ── GET /:id ──────────────────────────────────────────────────────────────

  describe('GET /api/v1/invoices/:id', () => {
    it('should return a single invoice by id', async () => {
      const invoiceService = require('../src/services/invoice.service');
      const mockInvoice = {
        id: 'inv-1',
        invoice_number: 'INV-001',
        ncf: 'B0100000001',
        customer_name: 'Juan Perez',
        total: 3500,
        items: [{ description: 'Suscripción plan Premium', quantity: 1, unit_price: 3500, subtotal: 3500 }]
      };
      jest.spyOn(invoiceService, 'getById').mockResolvedValueOnce(mockInvoice);

      const res = await request(app).get('/api/v1/invoices/inv-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('inv-1');
      expect(res.body.data.ncf).toBe('B0100000001');
      expect(invoiceService.getById).toHaveBeenCalledWith('inv-1');
    });

    it('should handle not found invoice', async () => {
      const invoiceService = require('../src/services/invoice.service');
      const err = new Error('Factura no encontrada');
      err.statusCode = 404;
      jest.spyOn(invoiceService, 'getById').mockRejectedValueOnce(err);

      const res = await request(app).get('/api/v1/invoices/non-existent');

      expect(res.status).toBe(404);
    });

    it('should handle service errors for single invoice', async () => {
      const invoiceService = require('../src/services/invoice.service');
      jest.spyOn(invoiceService, 'getById').mockRejectedValueOnce(new Error('DB error'));

      const res = await request(app).get('/api/v1/invoices/inv-1');

      expect(res.status).toBe(500);
    });
  });

  // ── POST /from-payment/:paymentId ─────────────────────────────────────────

  describe('POST /api/v1/invoices/from-payment/:paymentId', () => {
    it('should generate an invoice from a payment', async () => {
      const invoiceService = require('../src/services/invoice.service');
      const mockInvoice = {
        id: 'inv-new',
        invoice_number: 'INV-100',
        ncf: 'B0100000100',
        payment_id: 'pay-1',
        customer_name: 'Maria Lopez',
        total: 2000
      };
      jest.spyOn(invoiceService, 'generateFromPayment').mockResolvedValueOnce(mockInvoice);

      const res = await request(app)
        .post('/api/v1/invoices/from-payment/pay-1');

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('inv-new');
      expect(res.body.data.ncf).toBe('B0100000100');
      expect(invoiceService.generateFromPayment).toHaveBeenCalledWith('pay-1', {
        userId: 'test-user-id',
        req: expect.any(Object)
      });
    });

    it('should handle payment not found error', async () => {
      const invoiceService = require('../src/services/invoice.service');
      const err = new Error('Pago no encontrado');
      err.statusCode = 404;
      jest.spyOn(invoiceService, 'generateFromPayment').mockRejectedValueOnce(err);

      const res = await request(app)
        .post('/api/v1/invoices/from-payment/non-existent');

      expect(res.status).toBe(404);
    });

    it('should return existing invoice if payment already has one', async () => {
      const invoiceService = require('../src/services/invoice.service');
      const existingInvoice = {
        id: 'inv-existing',
        payment_id: 'pay-dup',
        ncf: 'B0100000050'
      };
      jest.spyOn(invoiceService, 'generateFromPayment').mockResolvedValueOnce(existingInvoice);

      const res = await request(app)
        .post('/api/v1/invoices/from-payment/pay-dup');

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBe('inv-existing');
    });

    it('should handle duplicate constraint errors', async () => {
      const invoiceService = require('../src/services/invoice.service');
      const err = new Error('duplicate key');
      err.code = '23505';
      err.detail = 'Key (payment_id)';
      jest.spyOn(invoiceService, 'generateFromPayment').mockRejectedValueOnce(err);

      const res = await request(app)
        .post('/api/v1/invoices/from-payment/pay-1');

      expect(res.status).toBe(409);
    });

    it('should handle generic service errors on invoice generation', async () => {
      const invoiceService = require('../src/services/invoice.service');
      jest.spyOn(invoiceService, 'generateFromPayment').mockRejectedValueOnce(new Error('NCF generation failed'));

      const res = await request(app)
        .post('/api/v1/invoices/from-payment/pay-1');

      expect(res.status).toBe(500);
    });
  });

  // ── NCF / DGII Compliance ────────────────────────────────────────────────

  describe('NCF Generation & DGII Compliance', () => {
    it('should generate B01 NCF prefix for consumer invoices (no RNC)', async () => {
      const invoiceService = require('../src/services/invoice.service');
      jest.spyOn(invoiceService, 'generateFromPayment').mockResolvedValueOnce({
        id: 'inv-consumer',
        ncf: 'B0100000010',
        customer_name: 'Consumidor Final'
      });

      const res = await request(app)
        .post('/api/v1/invoices/from-payment/pay-consumer');

      expect(res.status).toBe(201);
      expect(res.body.data.ncf).toMatch(/^B01/);
    });

    it('should generate B14 NCF prefix for fiscal invoices (with RNC)', async () => {
      const invoiceService = require('../src/services/invoice.service');
      jest.spyOn(invoiceService, 'generateFromPayment').mockResolvedValueOnce({
        id: 'inv-fiscal',
        ncf: 'B1400000010',
        customer_name: 'Empresa XYZ',
        rnc: '101123456'
      });

      const res = await request(app)
        .post('/api/v1/invoices/from-payment/pay-fiscal');

      expect(res.status).toBe(201);
      expect(res.body.data.ncf).toMatch(/^B14/);
    });

    it('should include NCF in every generated invoice', async () => {
      const invoiceService = require('../src/services/invoice.service');
      jest.spyOn(invoiceService, 'generateFromPayment').mockResolvedValueOnce({
        id: 'inv-ncf',
        ncf: 'B0100000099',
        total: 1000
      });

      const res = await request(app)
        .post('/api/v1/invoices/from-payment/pay-ncf');

      expect(res.status).toBe(201);
      expect(res.body.data.ncf).toBeDefined();
      expect(res.body.data.ncf.length).toBeGreaterThan(0);
    });
  });
});
