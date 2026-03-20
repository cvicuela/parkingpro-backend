// Mock database before requiring anything else
const mockQuery = jest.fn();
const mockTransaction = jest.fn();
const mockSupabaseRpc = jest.fn();

jest.mock('../src/config/database', () => ({
  query: mockQuery,
  transaction: mockTransaction,
  supabase: {
    rpc: mockSupabaseRpc
  },
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

const request = require('supertest');
const express = require('express');

process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const subscriptionRoutes = require('../src/routes/subscription.routes');
const errorHandler = require('../src/middleware/errorHandler');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/subscriptions', subscriptionRoutes);
  app.use(errorHandler);
  return app;
}

describe('Subscription Routes', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------
  // GET /api/v1/subscriptions
  // -------------------------------------------------------
  describe('GET /api/v1/subscriptions', () => {
    const mockSubscriptions = [
      {
        id: 'sub-1',
        customer_id: 'cust-1',
        vehicle_id: 'veh-1',
        plan_id: 'plan-1',
        status: 'active',
        customer_name: 'Juan Perez',
        customer_phone: '+18095551111',
        customer_email: 'juan@test.com',
        customer_document: '001-1234567-8',
        vehicle_plate: 'A123456',
        vehicle_make: 'Toyota',
        vehicle_model: 'Corolla',
        plan_name: 'Diurno',
        plan_price: 3000
      },
      {
        id: 'sub-2',
        customer_id: 'cust-2',
        vehicle_id: 'veh-2',
        plan_id: 'plan-2',
        status: 'pending',
        customer_name: 'Maria Lopez',
        customer_phone: '+18095552222',
        customer_email: 'maria@test.com',
        customer_document: '002-7654321-0',
        vehicle_plate: 'B654321',
        vehicle_make: 'Honda',
        vehicle_model: 'Civic',
        plan_name: 'Nocturno',
        plan_price: 2500
      }
    ];

    it('should list all subscriptions without filters', async () => {
      mockQuery.mockResolvedValueOnce({ rows: mockSubscriptions });

      const res = await request(app).get('/api/v1/subscriptions');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0].customer_name).toBe('Juan Perez');
      expect(res.body.data[1].customer_name).toBe('Maria Lopez');
      expect(mockQuery).toHaveBeenCalledTimes(1);
      // Should not have WHERE clause
      const sql = mockQuery.mock.calls[0][0];
      expect(sql).not.toContain('WHERE');
    });

    it('should filter subscriptions by search query', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [mockSubscriptions[0]] });

      const res = await request(app)
        .get('/api/v1/subscriptions')
        .query({ search: 'Juan' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('ILIKE');
      expect(params).toEqual(['%Juan%']);
    });

    it('should filter subscriptions by vehicle plate search', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [mockSubscriptions[0]] });

      const res = await request(app)
        .get('/api/v1/subscriptions')
        .query({ search: 'A123' });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('v.plate ILIKE');
      expect(params).toEqual(['%A123%']);
    });

    it('should filter subscriptions by status', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [mockSubscriptions[1]] });

      const res = await request(app)
        .get('/api/v1/subscriptions')
        .query({ status: 'pending' });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('s.status = $');
      expect(params).toEqual(['pending']);
    });

    it('should filter by both search and status', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [mockSubscriptions[0]] });

      const res = await request(app)
        .get('/api/v1/subscriptions')
        .query({ search: 'Juan', status: 'active' });

      expect(res.status).toBe(200);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('WHERE');
      expect(sql).toContain('AND');
      expect(params).toEqual(['%Juan%', 'active']);
    });

    it('should return empty array when no subscriptions found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app).get('/api/v1/subscriptions');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });

    it('should handle database errors', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Database connection failed'));

      const res = await request(app).get('/api/v1/subscriptions');

      expect(res.status).toBe(500);
    });

    it('should order results by created_at DESC', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await request(app).get('/api/v1/subscriptions');

      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('ORDER BY s.created_at DESC');
    });

    it('should join customers, vehicles, and plans tables', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await request(app).get('/api/v1/subscriptions');

      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('JOIN customers c ON s.customer_id = c.id');
      expect(sql).toContain('LEFT JOIN vehicles v ON s.vehicle_id = v.id');
      expect(sql).toContain('JOIN plans p ON s.plan_id = p.id');
    });

    it('should include customer, vehicle, and plan fields in the response', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [mockSubscriptions[0]] });

      const res = await request(app).get('/api/v1/subscriptions');

      const sub = res.body.data[0];
      expect(sub).toHaveProperty('customer_name');
      expect(sub).toHaveProperty('customer_phone');
      expect(sub).toHaveProperty('customer_email');
      expect(sub).toHaveProperty('customer_document');
      expect(sub).toHaveProperty('vehicle_plate');
      expect(sub).toHaveProperty('vehicle_make');
      expect(sub).toHaveProperty('vehicle_model');
      expect(sub).toHaveProperty('plan_name');
      expect(sub).toHaveProperty('plan_price');
    });
  });

  // -------------------------------------------------------
  // POST /api/v1/subscriptions
  // -------------------------------------------------------
  describe('POST /api/v1/subscriptions', () => {
    const validBody = {
      customerId: 'cust-1',
      vehicleId: 'veh-1',
      planId: 'plan-1',
      pricePerPeriod: 3000
    };

    const createdSubscription = {
      id: 'sub-new',
      customer_id: 'cust-1',
      vehicle_id: 'veh-1',
      plan_id: 'plan-1',
      price_per_period: 3000,
      status: 'pending',
      started_at: '2026-03-20T10:00:00Z'
    };

    it('should create a subscription successfully', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [createdSubscription] });

      const res = await request(app)
        .post('/api/v1/subscriptions')
        .send(validBody);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('sub-new');
      expect(res.body.data.status).toBe('pending');
      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('INSERT INTO subscriptions');
      expect(params).toEqual(['cust-1', 'veh-1', 'plan-1', 3000]);
    });

    it('should set status to pending on creation', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [createdSubscription] });

      const res = await request(app)
        .post('/api/v1/subscriptions')
        .send(validBody);

      expect(res.status).toBe(201);
      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain("'pending'");
    });

    it('should set started_at to NOW() on creation', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [createdSubscription] });

      await request(app)
        .post('/api/v1/subscriptions')
        .send(validBody);

      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('NOW()');
    });

    it('should use RETURNING * to get created record', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [createdSubscription] });

      await request(app)
        .post('/api/v1/subscriptions')
        .send(validBody);

      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('RETURNING *');
    });

    it('should handle missing required fields (not null violation)', async () => {
      mockQuery.mockRejectedValueOnce({ code: '23502', column: 'customer_id' });

      const res = await request(app)
        .post('/api/v1/subscriptions')
        .send({});

      expect(res.status).toBe(400);
    });

    it('should handle foreign key violations', async () => {
      mockQuery.mockRejectedValueOnce({ code: '23503' });

      const res = await request(app)
        .post('/api/v1/subscriptions')
        .send({ ...validBody, customerId: 'nonexistent-id' });

      expect(res.status).toBe(400);
    });

    it('should handle duplicate subscriptions (unique constraint)', async () => {
      mockQuery.mockRejectedValueOnce({ code: '23505', detail: 'Key (vehicle_id)' });

      const res = await request(app)
        .post('/api/v1/subscriptions')
        .send(validBody);

      expect(res.status).toBe(409);
    });

    it('should handle database errors on creation', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Insert failed'));

      const res = await request(app)
        .post('/api/v1/subscriptions')
        .send(validBody);

      expect(res.status).toBe(500);
    });

    it('should pass all four parameters in correct order', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [createdSubscription] });

      await request(app)
        .post('/api/v1/subscriptions')
        .send(validBody);

      const params = mockQuery.mock.calls[0][1];
      expect(params[0]).toBe('cust-1');   // customerId
      expect(params[1]).toBe('veh-1');    // vehicleId
      expect(params[2]).toBe('plan-1');   // planId
      expect(params[3]).toBe(3000);       // pricePerPeriod
    });
  });

  // -------------------------------------------------------
  // POST /api/v1/subscriptions/:id/cancel
  // -------------------------------------------------------
  describe('POST /api/v1/subscriptions/:id/cancel', () => {
    const subId = 'sub-123';
    const activeSubscription = {
      id: subId,
      customer_id: 'cust-1',
      status: 'active',
      plan_id: 'plan-1'
    };

    const cancelledSubscription = {
      ...activeSubscription,
      status: 'cancelled',
      cancelled_at: '2026-03-20T15:00:00Z'
    };

    it('should cancel an active subscription with reason', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [activeSubscription] });
      mockSupabaseRpc.mockResolvedValueOnce({ data: true, error: null });
      mockQuery.mockResolvedValueOnce({ rows: [cancelledSubscription] });

      const res = await request(app)
        .post(`/api/v1/subscriptions/${subId}/cancel`)
        .send({ reason: 'Cliente solicitó cancelación' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Suscripción cancelada');
      expect(res.body.data.status).toBe('cancelled');
    });

    it('should cancel without a reason (null)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [activeSubscription] });
      mockSupabaseRpc.mockResolvedValueOnce({ data: true, error: null });
      mockQuery.mockResolvedValueOnce({ rows: [cancelledSubscription] });

      const res = await request(app)
        .post(`/api/v1/subscriptions/${subId}/cancel`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockSupabaseRpc).toHaveBeenCalledWith('cancel_subscription', {
        p_token: 'test-service-key',
        p_id: subId,
        p_reason: null
      });
    });

    it('should pass the reason to supabase rpc', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [activeSubscription] });
      mockSupabaseRpc.mockResolvedValueOnce({ data: true, error: null });
      mockQuery.mockResolvedValueOnce({ rows: [cancelledSubscription] });

      const reason = 'No parking needed';
      await request(app)
        .post(`/api/v1/subscriptions/${subId}/cancel`)
        .send({ reason });

      expect(mockSupabaseRpc).toHaveBeenCalledWith('cancel_subscription', {
        p_token: 'test-service-key',
        p_id: subId,
        p_reason: reason
      });
    });

    it('should pass the SUPABASE_SERVICE_KEY as p_token', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [activeSubscription] });
      mockSupabaseRpc.mockResolvedValueOnce({ data: true, error: null });
      mockQuery.mockResolvedValueOnce({ rows: [cancelledSubscription] });

      await request(app)
        .post(`/api/v1/subscriptions/${subId}/cancel`)
        .send({});

      const rpcArgs = mockSupabaseRpc.mock.calls[0][1];
      expect(rpcArgs.p_token).toBe('test-service-key');
    });

    it('should return 404 if subscription not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/v1/subscriptions/nonexistent-id/cancel')
        .send({});

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Suscripción no encontrada');
      expect(mockSupabaseRpc).not.toHaveBeenCalled();
    });

    it('should return 400 if subscription is already cancelled', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [cancelledSubscription] });

      const res = await request(app)
        .post(`/api/v1/subscriptions/${subId}/cancel`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('La suscripción ya está cancelada');
      expect(mockSupabaseRpc).not.toHaveBeenCalled();
    });

    it('should not call supabase rpc when subscription is not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await request(app)
        .post(`/api/v1/subscriptions/${subId}/cancel`)
        .send({});

      expect(mockSupabaseRpc).not.toHaveBeenCalled();
    });

    it('should not call supabase rpc when subscription is already cancelled', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [cancelledSubscription] });

      await request(app)
        .post(`/api/v1/subscriptions/${subId}/cancel`)
        .send({});

      expect(mockSupabaseRpc).not.toHaveBeenCalled();
    });

    it('should handle supabase rpc errors', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [activeSubscription] });
      mockSupabaseRpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'RPC function error' }
      });

      const res = await request(app)
        .post(`/api/v1/subscriptions/${subId}/cancel`)
        .send({});

      expect(res.status).toBe(500);
    });

    it('should handle database errors during initial lookup', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));

      const res = await request(app)
        .post(`/api/v1/subscriptions/${subId}/cancel`)
        .send({});

      expect(res.status).toBe(500);
    });

    it('should cancel a pending subscription', async () => {
      const pendingSub = { ...activeSubscription, status: 'pending' };
      mockQuery.mockResolvedValueOnce({ rows: [pendingSub] });
      mockSupabaseRpc.mockResolvedValueOnce({ data: true, error: null });
      mockQuery.mockResolvedValueOnce({ rows: [cancelledSubscription] });

      const res = await request(app)
        .post(`/api/v1/subscriptions/${subId}/cancel`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should cancel a suspended subscription', async () => {
      const suspendedSub = { ...activeSubscription, status: 'suspended' };
      mockQuery.mockResolvedValueOnce({ rows: [suspendedSub] });
      mockSupabaseRpc.mockResolvedValueOnce({ data: true, error: null });
      mockQuery.mockResolvedValueOnce({ rows: [cancelledSubscription] });

      const res = await request(app)
        .post(`/api/v1/subscriptions/${subId}/cancel`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should re-fetch subscription after rpc call', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [activeSubscription] });
      mockSupabaseRpc.mockResolvedValueOnce({ data: true, error: null });
      mockQuery.mockResolvedValueOnce({ rows: [cancelledSubscription] });

      await request(app)
        .post(`/api/v1/subscriptions/${subId}/cancel`)
        .send({});

      // Should have called query twice: once for lookup, once for re-fetch
      expect(mockQuery).toHaveBeenCalledTimes(2);
      const refetchSql = mockQuery.mock.calls[1][0];
      expect(refetchSql).toContain('SELECT * FROM subscriptions WHERE id = $1');
      expect(mockQuery.mock.calls[1][1]).toEqual([subId]);
    });

    it('should handle database error during re-fetch', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [activeSubscription] });
      mockSupabaseRpc.mockResolvedValueOnce({ data: true, error: null });
      mockQuery.mockRejectedValueOnce(new Error('Re-fetch failed'));

      const res = await request(app)
        .post(`/api/v1/subscriptions/${subId}/cancel`)
        .send({});

      expect(res.status).toBe(500);
    });
  });
});
