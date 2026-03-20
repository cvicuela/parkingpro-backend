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

const expenseRoutes = require('../src/routes/expense.routes');
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
  app.use('/api/v1/expenses', expenseRoutes);
  app.use(errorHandler);
  return app;
}

describe('Expense Routes', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── GET / ─────────────────────────────────────────────────────────────────

  describe('GET /api/v1/expenses', () => {
    it('should list expenses with default pagination', async () => {
      const expenseService = require('../src/services/expense.service');
      jest.spyOn(expenseService, 'list').mockResolvedValueOnce({
        expenses: [
          { id: 'exp-1', category: 'utilities', total: 5000, supplier_name: 'EDENORTE' },
          { id: 'exp-2', category: 'supplies', total: 1200, supplier_name: 'Ferreteria ABC' }
        ],
        total: 2
      });

      const res = await request(app).get('/api/v1/expenses');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.expenses).toHaveLength(2);
      expect(expenseService.list).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 50, offset: 0 })
      );
    });

    it('should pass filter query parameters to the service', async () => {
      const expenseService = require('../src/services/expense.service');
      jest.spyOn(expenseService, 'list').mockResolvedValueOnce({ expenses: [], total: 0 });

      const res = await request(app)
        .get('/api/v1/expenses')
        .query({
          limit: '20', offset: '10', category: 'utilities',
          status: 'active', fromDate: '2026-01-01', toDate: '2026-03-01', search: 'EDENORTE'
        });

      expect(res.status).toBe(200);
      expect(expenseService.list).toHaveBeenCalledWith({
        limit: 20,
        offset: 10,
        category: 'utilities',
        status: 'active',
        fromDate: '2026-01-01',
        toDate: '2026-03-01',
        search: 'EDENORTE'
      });
    });

    it('should handle service errors on list', async () => {
      const expenseService = require('../src/services/expense.service');
      jest.spyOn(expenseService, 'list').mockRejectedValueOnce(new Error('DB error'));

      const res = await request(app).get('/api/v1/expenses');

      expect(res.status).toBe(500);
    });
  });

  // ── POST / ────────────────────────────────────────────────────────────────

  describe('POST /api/v1/expenses', () => {
    const validExpense = {
      category: 'utilities',
      supplierName: 'EDENORTE',
      supplierRnc: '101234567',
      ncf: 'B0100000055',
      description: 'Electricity bill - March 2026',
      expenseDate: '2026-03-15',
      subtotal: 8500,
      itbisAmount: 1530,
      total: 10030,
      paymentMethod: '02'
    };

    it('should create an expense successfully', async () => {
      const expenseService = require('../src/services/expense.service');
      jest.spyOn(expenseService, 'create').mockResolvedValueOnce({
        id: 'exp-new',
        ...validExpense,
        status: 'active',
        created_by: 'test-user-id'
      });

      const res = await request(app)
        .post('/api/v1/expenses')
        .send(validExpense);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('exp-new');
      expect(expenseService.create).toHaveBeenCalledWith(validExpense, {
        userId: 'test-user-id',
        req: expect.any(Object)
      });
    });

    it('should handle service errors on create', async () => {
      const expenseService = require('../src/services/expense.service');
      jest.spyOn(expenseService, 'create').mockRejectedValueOnce(new Error('Validation failed'));

      const res = await request(app)
        .post('/api/v1/expenses')
        .send(validExpense);

      expect(res.status).toBe(500);
    });

    it('should handle foreign key violation when supplier does not exist', async () => {
      const expenseService = require('../src/services/expense.service');
      const err = new Error('foreign key violation');
      err.code = '23503';
      jest.spyOn(expenseService, 'create').mockRejectedValueOnce(err);

      const res = await request(app)
        .post('/api/v1/expenses')
        .send(validExpense);

      expect(res.status).toBe(400);
    });

    it('should handle not null violation', async () => {
      const expenseService = require('../src/services/expense.service');
      const err = new Error('not null violation');
      err.code = '23502';
      err.column = 'category';
      jest.spyOn(expenseService, 'create').mockRejectedValueOnce(err);

      const res = await request(app)
        .post('/api/v1/expenses')
        .send({});

      expect(res.status).toBe(400);
    });
  });

  // ── PUT /:id ──────────────────────────────────────────────────────────────

  describe('PUT /api/v1/expenses/:id', () => {
    it('should update an expense successfully', async () => {
      const expenseService = require('../src/services/expense.service');
      jest.spyOn(expenseService, 'update').mockResolvedValueOnce({
        id: 'exp-1',
        category: 'supplies',
        total: 6000,
        supplier_name: 'Ferreteria XYZ'
      });

      const res = await request(app)
        .put('/api/v1/expenses/exp-1')
        .send({ category: 'supplies', total: 6000 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.total).toBe(6000);
      expect(expenseService.update).toHaveBeenCalledWith(
        'exp-1',
        { category: 'supplies', total: 6000 },
        { userId: 'test-user-id', req: expect.any(Object) }
      );
    });

    it('should handle not found expense on update', async () => {
      const expenseService = require('../src/services/expense.service');
      const err = new Error('Gasto no encontrado');
      err.statusCode = 404;
      jest.spyOn(expenseService, 'update').mockRejectedValueOnce(err);

      const res = await request(app)
        .put('/api/v1/expenses/non-existent')
        .send({ total: 5000 });

      expect(res.status).toBe(404);
    });

    it('should handle service errors on update', async () => {
      const expenseService = require('../src/services/expense.service');
      jest.spyOn(expenseService, 'update').mockRejectedValueOnce(new Error('DB error'));

      const res = await request(app)
        .put('/api/v1/expenses/exp-1')
        .send({ total: 5000 });

      expect(res.status).toBe(500);
    });
  });

  // ── DELETE /:id ───────────────────────────────────────────────────────────

  describe('DELETE /api/v1/expenses/:id', () => {
    it('should delete an expense successfully', async () => {
      const expenseService = require('../src/services/expense.service');
      jest.spyOn(expenseService, 'delete').mockResolvedValueOnce(undefined);

      const res = await request(app).delete('/api/v1/expenses/exp-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(expenseService.delete).toHaveBeenCalledWith(
        'exp-1',
        { userId: 'test-user-id', req: expect.any(Object) }
      );
    });

    it('should handle not found expense on delete', async () => {
      const expenseService = require('../src/services/expense.service');
      const err = new Error('Gasto no encontrado');
      err.statusCode = 404;
      jest.spyOn(expenseService, 'delete').mockRejectedValueOnce(err);

      const res = await request(app).delete('/api/v1/expenses/non-existent');

      expect(res.status).toBe(404);
    });

    it('should handle service errors on delete', async () => {
      const expenseService = require('../src/services/expense.service');
      jest.spyOn(expenseService, 'delete').mockRejectedValueOnce(new Error('DB error'));

      const res = await request(app).delete('/api/v1/expenses/exp-1');

      expect(res.status).toBe(500);
    });
  });

  // ── GET /stats ────────────────────────────────────────────────────────────

  describe('GET /api/v1/expenses/stats', () => {
    it('should return expense statistics', async () => {
      const expenseService = require('../src/services/expense.service');
      jest.spyOn(expenseService, 'stats').mockResolvedValueOnce({
        totalExpenses: 50,
        totalAmount: 250000,
        byCategory: { utilities: 100000, supplies: 150000 }
      });

      const res = await request(app).get('/api/v1/expenses/stats');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.totalExpenses).toBe(50);
    });

    it('should pass date range to stats', async () => {
      const expenseService = require('../src/services/expense.service');
      jest.spyOn(expenseService, 'stats').mockResolvedValueOnce({});

      await request(app)
        .get('/api/v1/expenses/stats')
        .query({ fromDate: '2026-01-01', toDate: '2026-03-01' });

      expect(expenseService.stats).toHaveBeenCalledWith({
        fromDate: '2026-01-01',
        toDate: '2026-03-01'
      });
    });

    it('should handle errors in stats endpoint', async () => {
      const expenseService = require('../src/services/expense.service');
      jest.spyOn(expenseService, 'stats').mockRejectedValueOnce(new Error('Stats error'));

      const res = await request(app).get('/api/v1/expenses/stats');

      expect(res.status).toBe(500);
    });
  });

  // ── Admin-only access checks ──────────────────────────────────────────────

  describe('Admin-only access', () => {
    it('should deny access to operator role for listing expenses', async () => {
      const operatorApp = createApp({ id: 'op-user', role: 'operator', email: 'op@test.com' });

      const res = await request(operatorApp).get('/api/v1/expenses');

      expect(res.status).toBe(403);
    });

    it('should deny access to operator role for creating expenses', async () => {
      const operatorApp = createApp({ id: 'op-user', role: 'operator', email: 'op@test.com' });

      const res = await request(operatorApp)
        .post('/api/v1/expenses')
        .send({ category: 'utilities', total: 1000 });

      expect(res.status).toBe(403);
    });

    it('should deny access to operator role for updating expenses', async () => {
      const operatorApp = createApp({ id: 'op-user', role: 'operator', email: 'op@test.com' });

      const res = await request(operatorApp)
        .put('/api/v1/expenses/exp-1')
        .send({ total: 5000 });

      expect(res.status).toBe(403);
    });

    it('should deny access to operator role for deleting expenses', async () => {
      const operatorApp = createApp({ id: 'op-user', role: 'operator', email: 'op@test.com' });

      const res = await request(operatorApp).delete('/api/v1/expenses/exp-1');

      expect(res.status).toBe(403);
    });

    it('should allow super_admin role for all operations', async () => {
      const superApp = createApp({ id: 'sa-user', role: 'super_admin', email: 'sa@test.com' });
      const expenseService = require('../src/services/expense.service');
      jest.spyOn(expenseService, 'list').mockResolvedValueOnce({ expenses: [], total: 0 });

      const res = await request(superApp).get('/api/v1/expenses');

      expect(res.status).toBe(200);
    });
  });
});
