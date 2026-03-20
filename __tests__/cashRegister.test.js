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
    if (!req.user) {
      req.user = { id: 'test-user-id', role: 'admin', email: 'admin@test.com' };
    }
    next();
  },
  authorize: (roles) => (req, res, next) => {
    if (roles && !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  }
}));

jest.mock('../src/middleware/audit', () => ({
  logAudit: jest.fn(),
  auditMiddleware: () => (req, res, next) => next()
}));

const request = require('supertest');
const express = require('express');

const cashRegisterRoutes = require('../src/routes/cashRegister.routes');
const errorHandler = require('../src/middleware/errorHandler');

function createApp(userOverride) {
  const app = express();
  app.use(express.json());
  if (userOverride) {
    app.use((req, res, next) => {
      req.user = userOverride;
      next();
    });
  }
  app.use('/api/v1/cash-registers', cashRegisterRoutes);
  app.use(errorHandler);
  return app;
}

describe('Cash Register Routes', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── POST /open - Open register ──────────────────────────────────────────────

  describe('POST /api/v1/cash-registers/open', () => {
    it('should open a new cash register successfully', async () => {
      const cashRegisterService = require('../src/services/cashRegister.service');
      const mockRegister = {
        id: 'reg-1',
        name: 'Caja Principal',
        operator_id: 'test-user-id',
        status: 'open',
        opening_balance: 5000,
        opened_at: '2026-03-20T08:00:00Z'
      };
      jest.spyOn(cashRegisterService, 'openRegister').mockResolvedValueOnce(mockRegister);

      const res = await request(app)
        .post('/api/v1/cash-registers/open')
        .send({ openingBalance: 5000, name: 'Caja Principal' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('reg-1');
      expect(res.body.data.status).toBe('open');
      expect(res.body.already_open).toBe(false);
      expect(cashRegisterService.openRegister).toHaveBeenCalledWith({
        operatorId: 'test-user-id',
        targetOperatorId: null,
        openingBalance: 5000,
        name: 'Caja Principal',
        req: expect.any(Object)
      });
    });

    it('should return 200 if register is already open', async () => {
      const cashRegisterService = require('../src/services/cashRegister.service');
      const existingRegister = {
        id: 'reg-existing',
        name: 'Caja Principal',
        status: 'open',
        already_open: true
      };
      jest.spyOn(cashRegisterService, 'openRegister').mockResolvedValueOnce(existingRegister);

      const res = await request(app)
        .post('/api/v1/cash-registers/open')
        .send({ openingBalance: 5000 });

      expect(res.status).toBe(200);
      expect(res.body.already_open).toBe(true);
    });

    it('should default openingBalance to 0 when not provided', async () => {
      const cashRegisterService = require('../src/services/cashRegister.service');
      jest.spyOn(cashRegisterService, 'openRegister').mockResolvedValueOnce({
        id: 'reg-zero', status: 'open', opening_balance: 0
      });

      await request(app)
        .post('/api/v1/cash-registers/open')
        .send({});

      expect(cashRegisterService.openRegister).toHaveBeenCalledWith(
        expect.objectContaining({ openingBalance: 0 })
      );
    });

    it('should allow admin to open register for another operator via targetOperatorId', async () => {
      const cashRegisterService = require('../src/services/cashRegister.service');
      jest.spyOn(cashRegisterService, 'openRegister').mockResolvedValueOnce({
        id: 'reg-other', operator_id: 'other-op-id', status: 'open'
      });

      const res = await request(app)
        .post('/api/v1/cash-registers/open')
        .send({ openingBalance: 3000, operatorId: 'other-op-id' });

      expect(res.status).toBe(201);
      expect(cashRegisterService.openRegister).toHaveBeenCalledWith(
        expect.objectContaining({ targetOperatorId: 'other-op-id' })
      );
    });

    it('should not pass targetOperatorId for non-admin roles', async () => {
      const operatorApp = createApp({ id: 'op-user', role: 'operator', email: 'op@test.com' });
      const cashRegisterService = require('../src/services/cashRegister.service');
      jest.spyOn(cashRegisterService, 'openRegister').mockResolvedValueOnce({
        id: 'reg-op', status: 'open'
      });

      await request(operatorApp)
        .post('/api/v1/cash-registers/open')
        .send({ openingBalance: 1000, operatorId: 'other-op-id' });

      expect(cashRegisterService.openRegister).toHaveBeenCalledWith(
        expect.objectContaining({ targetOperatorId: null })
      );
    });

    it('should handle service errors on open', async () => {
      const cashRegisterService = require('../src/services/cashRegister.service');
      jest.spyOn(cashRegisterService, 'openRegister').mockRejectedValueOnce(
        new Error('Ya tienes una caja abierta. Ciérrala antes de abrir otra.')
      );

      const res = await request(app)
        .post('/api/v1/cash-registers/open')
        .send({ openingBalance: 5000 });

      expect(res.status).toBe(500);
      expect(res.body.error).toContain('caja abierta');
    });
  });

  // ── GET /active - Get active register ───────────────────────────────────────

  describe('GET /api/v1/cash-registers/active', () => {
    it('should return the active register for the current operator', async () => {
      const cashRegisterService = require('../src/services/cashRegister.service');
      const mockRegister = {
        id: 'reg-active',
        name: 'Caja 1',
        status: 'open',
        opening_balance: 5000,
        total_in: 25000,
        total_out: 3000,
        cash_in: 20000,
        cash_out: 3000,
        total_card: 5000,
        total_transfer: 0,
        payment_count: 12
      };
      jest.spyOn(cashRegisterService, 'getActiveRegister').mockResolvedValueOnce(mockRegister);

      const res = await request(app).get('/api/v1/cash-registers/active');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('reg-active');
      expect(res.body.data.payment_count).toBe(12);
      expect(cashRegisterService.getActiveRegister).toHaveBeenCalledWith('test-user-id');
    });

    it('should return null when no active register exists', async () => {
      const cashRegisterService = require('../src/services/cashRegister.service');
      jest.spyOn(cashRegisterService, 'getActiveRegister').mockResolvedValueOnce(null);

      const res = await request(app).get('/api/v1/cash-registers/active');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeNull();
    });

    it('should handle service errors on active', async () => {
      const cashRegisterService = require('../src/services/cashRegister.service');
      jest.spyOn(cashRegisterService, 'getActiveRegister').mockRejectedValueOnce(new Error('DB error'));

      const res = await request(app).get('/api/v1/cash-registers/active');

      expect(res.status).toBe(500);
    });
  });

  // ── GET /history - Register history ─────────────────────────────────────────

  describe('GET /api/v1/cash-registers/history', () => {
    it('should return register history with default pagination', async () => {
      const cashRegisterService = require('../src/services/cashRegister.service');
      const mockHistory = [
        { id: 'reg-1', name: 'Caja 1', status: 'closed', difference: 0, opened_at: '2026-03-19T08:00:00Z' },
        { id: 'reg-2', name: 'Caja 2', status: 'closed', difference: -150, opened_at: '2026-03-18T08:00:00Z' }
      ];
      jest.spyOn(cashRegisterService, 'getHistory').mockResolvedValueOnce(mockHistory);

      const res = await request(app).get('/api/v1/cash-registers/history');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
      expect(cashRegisterService.getHistory).toHaveBeenCalledWith({
        limit: 50,
        offset: 0,
        operatorId: null,
        startDate: null,
        endDate: null
      });
    });

    it('should pass query parameters to the service', async () => {
      const cashRegisterService = require('../src/services/cashRegister.service');
      jest.spyOn(cashRegisterService, 'getHistory').mockResolvedValueOnce([]);

      await request(app)
        .get('/api/v1/cash-registers/history')
        .query({ limit: '10', offset: '5', operatorId: 'op-1', startDate: '2026-03-01', endDate: '2026-03-31' });

      expect(cashRegisterService.getHistory).toHaveBeenCalledWith({
        limit: 10,
        offset: 5,
        operatorId: 'op-1',
        startDate: '2026-03-01',
        endDate: '2026-03-31'
      });
    });

    it('should deny access to operator role', async () => {
      const operatorApp = createApp({ id: 'op-user', role: 'operator', email: 'op@test.com' });

      const res = await request(operatorApp).get('/api/v1/cash-registers/history');

      expect(res.status).toBe(403);
    });

    it('should handle service errors on history', async () => {
      const cashRegisterService = require('../src/services/cashRegister.service');
      jest.spyOn(cashRegisterService, 'getHistory').mockRejectedValueOnce(new Error('DB error'));

      const res = await request(app).get('/api/v1/cash-registers/history');

      expect(res.status).toBe(500);
    });
  });

  // ── GET /:id/transactions - Get transactions for a register ─────────────────

  describe('GET /api/v1/cash-registers/:id/transactions', () => {
    it('should return transactions for a register', async () => {
      const cashRegisterService = require('../src/services/cashRegister.service');
      const mockTransactions = [
        { id: 'tx-1', type: 'opening_float', amount: 5000, direction: 'in', payment_method: 'cash' },
        { id: 'tx-2', type: 'payment', amount: 350, direction: 'in', payment_method: 'cash' },
        { id: 'tx-3', type: 'payment', amount: 500, direction: 'in', payment_method: 'card' }
      ];
      jest.spyOn(cashRegisterService, 'getTransactions').mockResolvedValueOnce(mockTransactions);

      const res = await request(app).get('/api/v1/cash-registers/reg-1/transactions');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(3);
      expect(cashRegisterService.getTransactions).toHaveBeenCalledWith('reg-1');
    });

    it('should return empty array when no transactions exist', async () => {
      const cashRegisterService = require('../src/services/cashRegister.service');
      jest.spyOn(cashRegisterService, 'getTransactions').mockResolvedValueOnce([]);

      const res = await request(app).get('/api/v1/cash-registers/reg-new/transactions');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('should handle service errors on transactions', async () => {
      const cashRegisterService = require('../src/services/cashRegister.service');
      jest.spyOn(cashRegisterService, 'getTransactions').mockRejectedValueOnce(new Error('DB error'));

      const res = await request(app).get('/api/v1/cash-registers/reg-1/transactions');

      expect(res.status).toBe(500);
    });
  });

  // ── POST /:id/close - Close register ────────────────────────────────────────

  describe('POST /api/v1/cash-registers/:id/close', () => {
    it('should close a register successfully without requiring approval', async () => {
      const cashRegisterService = require('../src/services/cashRegister.service');
      const mockResult = {
        id: 'reg-1',
        status: 'closed',
        expected_balance: 25000,
        expected_cash: 20000,
        counted_balance: 20000,
        difference: 0,
        total_card: 5000,
        total_transfer: 0,
        requires_approval: false,
        requiresApproval: false,
        message: 'Caja cerrada correctamente'
      };
      jest.spyOn(cashRegisterService, 'closeRegister').mockResolvedValueOnce(mockResult);

      const res = await request(app)
        .post('/api/v1/cash-registers/reg-1/close')
        .send({ countedBalance: 20000, notes: 'Cierre normal' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.difference).toBe(0);
      expect(res.body.data.requiresApproval).toBe(false);
      expect(cashRegisterService.closeRegister).toHaveBeenCalledWith({
        registerId: 'reg-1',
        operatorId: 'test-user-id',
        countedBalance: 20000,
        denominations: [],
        notes: 'Cierre normal',
        req: expect.any(Object)
      });
    });

    it('should close a register that requires supervisor approval (large difference)', async () => {
      const cashRegisterService = require('../src/services/cashRegister.service');
      const mockResult = {
        id: 'reg-1',
        status: 'closed',
        expected_cash: 20000,
        counted_balance: 19500,
        difference: -500,
        requires_approval: true,
        requiresApproval: true,
        message: 'Diferencia de RD$500.00 requiere aprobación del supervisor'
      };
      jest.spyOn(cashRegisterService, 'closeRegister').mockResolvedValueOnce(mockResult);

      const res = await request(app)
        .post('/api/v1/cash-registers/reg-1/close')
        .send({ countedBalance: 19500 });

      expect(res.status).toBe(200);
      expect(res.body.data.requiresApproval).toBe(true);
      expect(res.body.data.difference).toBe(-500);
    });

    it('should return 400 when countedBalance is missing', async () => {
      const res = await request(app)
        .post('/api/v1/cash-registers/reg-1/close')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('countedBalance');
    });

    it('should accept countedBalance of 0', async () => {
      const cashRegisterService = require('../src/services/cashRegister.service');
      jest.spyOn(cashRegisterService, 'closeRegister').mockResolvedValueOnce({
        id: 'reg-1', status: 'closed', counted_balance: 0, difference: -5000
      });

      const res = await request(app)
        .post('/api/v1/cash-registers/reg-1/close')
        .send({ countedBalance: 0 });

      // countedBalance of 0 should NOT trigger the 400 check
      expect(res.status).toBe(200);
      expect(cashRegisterService.closeRegister).toHaveBeenCalledWith(
        expect.objectContaining({ countedBalance: 0 })
      );
    });

    it('should pass denominations to the service', async () => {
      const cashRegisterService = require('../src/services/cashRegister.service');
      jest.spyOn(cashRegisterService, 'closeRegister').mockResolvedValueOnce({
        id: 'reg-1', status: 'closed'
      });

      const denominations = [
        { denomination: 1000, quantity: 10 },
        { denomination: 500, quantity: 5 },
        { denomination: 200, quantity: 8 },
        { denomination: 100, quantity: 10 }
      ];

      await request(app)
        .post('/api/v1/cash-registers/reg-1/close')
        .send({ countedBalance: 15100, denominations });

      expect(cashRegisterService.closeRegister).toHaveBeenCalledWith(
        expect.objectContaining({ denominations })
      );
    });

    it('should handle register not found error', async () => {
      const cashRegisterService = require('../src/services/cashRegister.service');
      jest.spyOn(cashRegisterService, 'closeRegister').mockRejectedValueOnce(
        new Error('Caja abierta no encontrada para este operador')
      );

      const res = await request(app)
        .post('/api/v1/cash-registers/non-existent/close')
        .send({ countedBalance: 5000 });

      expect(res.status).toBe(500);
      expect(res.body.error).toContain('Caja abierta no encontrada');
    });

    it('should handle service errors on close', async () => {
      const cashRegisterService = require('../src/services/cashRegister.service');
      jest.spyOn(cashRegisterService, 'closeRegister').mockRejectedValueOnce(new Error('Transaction failed'));

      const res = await request(app)
        .post('/api/v1/cash-registers/reg-1/close')
        .send({ countedBalance: 5000 });

      expect(res.status).toBe(500);
    });
  });

  // ── POST /:id/approve - Supervisor approval ────────────────────────────────

  describe('POST /api/v1/cash-registers/:id/approve', () => {
    it('should approve a register close successfully', async () => {
      const cashRegisterService = require('../src/services/cashRegister.service');
      const mockResult = {
        id: 'reg-1',
        status: 'closed',
        approved_by: 'test-user-id',
        approved_at: '2026-03-20T17:00:00Z',
        approval_notes: 'Difference verified and accepted'
      };
      jest.spyOn(cashRegisterService, 'approveClose').mockResolvedValueOnce(mockResult);

      const res = await request(app)
        .post('/api/v1/cash-registers/reg-1/approve')
        .send({ notes: 'Difference verified and accepted' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.approved_by).toBe('test-user-id');
      expect(cashRegisterService.approveClose).toHaveBeenCalledWith({
        registerId: 'reg-1',
        supervisorId: 'test-user-id',
        notes: 'Difference verified and accepted',
        req: expect.any(Object)
      });
    });

    it('should approve without notes', async () => {
      const cashRegisterService = require('../src/services/cashRegister.service');
      jest.spyOn(cashRegisterService, 'approveClose').mockResolvedValueOnce({
        id: 'reg-1', approved_by: 'test-user-id'
      });

      const res = await request(app)
        .post('/api/v1/cash-registers/reg-1/approve')
        .send({});

      expect(res.status).toBe(200);
      expect(cashRegisterService.approveClose).toHaveBeenCalledWith(
        expect.objectContaining({ notes: undefined })
      );
    });

    it('should handle already approved register', async () => {
      const cashRegisterService = require('../src/services/cashRegister.service');
      jest.spyOn(cashRegisterService, 'approveClose').mockRejectedValueOnce(
        new Error('Caja no encontrada o ya fue aprobada')
      );

      const res = await request(app)
        .post('/api/v1/cash-registers/reg-1/approve')
        .send({ notes: 'Trying again' });

      expect(res.status).toBe(500);
      expect(res.body.error).toContain('ya fue aprobada');
    });

    it('should deny access to operator role for approval', async () => {
      const operatorApp = createApp({ id: 'op-user', role: 'operator', email: 'op@test.com' });

      const res = await request(operatorApp)
        .post('/api/v1/cash-registers/reg-1/approve')
        .send({ notes: 'Approved' });

      expect(res.status).toBe(403);
    });

    it('should handle service errors on approve', async () => {
      const cashRegisterService = require('../src/services/cashRegister.service');
      jest.spyOn(cashRegisterService, 'approveClose').mockRejectedValueOnce(new Error('DB error'));

      const res = await request(app)
        .post('/api/v1/cash-registers/reg-1/approve')
        .send({});

      expect(res.status).toBe(500);
    });
  });

  // ── GET /limits - Settings/thresholds ───────────────────────────────────────

  describe('GET /api/v1/cash-registers/limits', () => {
    it('should return cash register limit settings', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { key: 'cash_diff_threshold', value: '200' },
          { key: 'refund_limit_operator', value: '500' },
          { key: 'currency', value: 'DOP' }
        ]
      });

      const res = await request(app).get('/api/v1/cash-registers/limits');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.cashDiffThreshold).toBe(200);
      expect(res.body.data.refundLimitOperator).toBe(500);
      expect(res.body.data.currency).toBe('DOP');
    });

    it('should return defaults when settings are missing', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app).get('/api/v1/cash-registers/limits');

      expect(res.status).toBe(200);
      expect(res.body.data.cashDiffThreshold).toBe(200);
      expect(res.body.data.refundLimitOperator).toBe(500);
      expect(res.body.data.currency).toBe('DOP');
    });

    it('should handle partial settings', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { key: 'cash_diff_threshold', value: '500' }
        ]
      });

      const res = await request(app).get('/api/v1/cash-registers/limits');

      expect(res.status).toBe(200);
      expect(res.body.data.cashDiffThreshold).toBe(500);
      expect(res.body.data.refundLimitOperator).toBe(500); // default
      expect(res.body.data.currency).toBe('DOP'); // default
    });

    it('should handle JSON value types in settings', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { key: 'cash_diff_threshold', value: { raw: 300 } },
          { key: 'currency', value: 'USD' }
        ]
      });

      const res = await request(app).get('/api/v1/cash-registers/limits');

      expect(res.status).toBe(200);
      // Non-string value should be JSON.stringified and parsed
      expect(res.body.data.currency).toBe('USD');
    });

    it('should handle database errors on limits', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB connection error'));

      const res = await request(app).get('/api/v1/cash-registers/limits');

      expect(res.status).toBe(500);
    });

    it('should be accessible by any authenticated user (operator included)', async () => {
      const operatorApp = createApp({ id: 'op-user', role: 'operator', email: 'op@test.com' });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(operatorApp).get('/api/v1/cash-registers/limits');

      expect(res.status).toBe(200);
    });
  });

  // ── Role-based access checks ────────────────────────────────────────────────

  describe('Role-based access', () => {
    it('should allow operator to open a register', async () => {
      const operatorApp = createApp({ id: 'op-user', role: 'operator', email: 'op@test.com' });
      const cashRegisterService = require('../src/services/cashRegister.service');
      jest.spyOn(cashRegisterService, 'openRegister').mockResolvedValueOnce({
        id: 'reg-op', status: 'open'
      });

      const res = await request(operatorApp)
        .post('/api/v1/cash-registers/open')
        .send({ openingBalance: 1000 });

      expect(res.status).toBe(201);
    });

    it('should allow operator to get active register', async () => {
      const operatorApp = createApp({ id: 'op-user', role: 'operator', email: 'op@test.com' });
      const cashRegisterService = require('../src/services/cashRegister.service');
      jest.spyOn(cashRegisterService, 'getActiveRegister').mockResolvedValueOnce(null);

      const res = await request(operatorApp).get('/api/v1/cash-registers/active');

      expect(res.status).toBe(200);
    });

    it('should allow operator to close a register', async () => {
      const operatorApp = createApp({ id: 'op-user', role: 'operator', email: 'op@test.com' });
      const cashRegisterService = require('../src/services/cashRegister.service');
      jest.spyOn(cashRegisterService, 'closeRegister').mockResolvedValueOnce({
        id: 'reg-1', status: 'closed'
      });

      const res = await request(operatorApp)
        .post('/api/v1/cash-registers/reg-1/close')
        .send({ countedBalance: 5000 });

      expect(res.status).toBe(200);
    });

    it('should allow operator to view transactions', async () => {
      const operatorApp = createApp({ id: 'op-user', role: 'operator', email: 'op@test.com' });
      const cashRegisterService = require('../src/services/cashRegister.service');
      jest.spyOn(cashRegisterService, 'getTransactions').mockResolvedValueOnce([]);

      const res = await request(operatorApp).get('/api/v1/cash-registers/reg-1/transactions');

      expect(res.status).toBe(200);
    });

    it('should deny operator access to history', async () => {
      const operatorApp = createApp({ id: 'op-user', role: 'operator', email: 'op@test.com' });

      const res = await request(operatorApp).get('/api/v1/cash-registers/history');

      expect(res.status).toBe(403);
    });

    it('should deny operator access to approve', async () => {
      const operatorApp = createApp({ id: 'op-user', role: 'operator', email: 'op@test.com' });

      const res = await request(operatorApp)
        .post('/api/v1/cash-registers/reg-1/approve')
        .send({});

      expect(res.status).toBe(403);
    });

    it('should allow super_admin to access all endpoints', async () => {
      const superApp = createApp({ id: 'sa-user', role: 'super_admin', email: 'sa@test.com' });
      const cashRegisterService = require('../src/services/cashRegister.service');

      jest.spyOn(cashRegisterService, 'getHistory').mockResolvedValueOnce([]);
      const historyRes = await request(superApp).get('/api/v1/cash-registers/history');
      expect(historyRes.status).toBe(200);

      jest.spyOn(cashRegisterService, 'approveClose').mockResolvedValueOnce({ id: 'reg-1' });
      const approveRes = await request(superApp)
        .post('/api/v1/cash-registers/reg-1/approve')
        .send({});
      expect(approveRes.status).toBe(200);
    });
  });
});
