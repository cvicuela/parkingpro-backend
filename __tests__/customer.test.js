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

const request = require('supertest');
const express = require('express');
const customerRoutes = require('../src/routes/customer.routes');
const errorHandler = require('../src/middleware/errorHandler');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/customers', customerRoutes);
  app.use(errorHandler);
  return app;
}

describe('Customer Routes', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ---------- GET /api/v1/customers ----------
  describe('GET /api/v1/customers', () => {
    it('should return a list of customers', async () => {
      const customers = [
        { id: '1', first_name: 'Juan', last_name: 'Perez', email: 'juan@test.com', phone: '+18095551111', user_status: 'active' },
        { id: '2', first_name: 'Maria', last_name: 'Lopez', email: 'maria@test.com', phone: '+18095552222', user_status: 'active' }
      ];

      mockQuery.mockResolvedValueOnce({ rows: customers });

      const res = await request(app).get('/api/v1/customers');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.count).toBe(2);
      expect(res.body.data[0].first_name).toBe('Juan');
    });

    it('should return an empty list when no customers exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app).get('/api/v1/customers');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(0);
      expect(res.body.count).toBe(0);
    });

    it('should pass database errors to the error handler', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Database connection failed'));

      const res = await request(app).get('/api/v1/customers');

      expect(res.status).toBe(500);
      expect(res.body.error).toBeDefined();
    });
  });

  // ---------- GET /api/v1/customers/:id ----------
  describe('GET /api/v1/customers/:id', () => {
    it('should return a single customer by ID', async () => {
      const customer = {
        id: 'cust-1',
        first_name: 'Juan',
        last_name: 'Perez',
        email: 'juan@test.com',
        phone: '+18095551111',
        role: 'customer',
        verified: true
      };

      mockQuery.mockResolvedValueOnce({ rows: [customer] });

      const res = await request(app).get('/api/v1/customers/cust-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('cust-1');
      expect(res.body.data.first_name).toBe('Juan');
      expect(res.body.data.email).toBe('juan@test.com');
    });

    it('should return 404 when customer is not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app).get('/api/v1/customers/nonexistent-id');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Cliente no encontrado');
    });

    it('should pass the id parameter to the query', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'cust-99' }] });

      await request(app).get('/api/v1/customers/cust-99');

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = mockQuery.mock.calls[0];
      expect(callArgs[1]).toEqual(['cust-99']);
    });

    it('should handle database errors', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));

      const res = await request(app).get('/api/v1/customers/cust-1');

      expect(res.status).toBe(500);
    });
  });

  // ---------- POST /api/v1/customers ----------
  describe('POST /api/v1/customers', () => {
    const validCustomer = {
      email: 'nuevo@test.com',
      phone: '+18095553333',
      firstName: 'Carlos',
      lastName: 'Garcia',
      idDocument: '001-1234567-8',
      rnc: '123456789',
      isCompany: false,
      companyName: null,
      address: 'Calle Principal #1',
      notes: 'VIP client'
    };

    it('should create a customer successfully', async () => {
      const userId = 'user-new-1';
      const customerId = 'cust-new-1';

      // First query: insert user
      mockQuery.mockResolvedValueOnce({ rows: [{ id: userId }] });
      // Second query: insert customer
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: customerId,
          user_id: userId,
          first_name: 'Carlos',
          last_name: 'Garcia',
          id_document: '001-1234567-8'
        }]
      });

      const res = await request(app)
        .post('/api/v1/customers')
        .send(validCustomer);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Cliente creado exitosamente');
      expect(res.body.data.id).toBe(customerId);
    });

    it('should return 400 when email is missing', async () => {
      const res = await request(app)
        .post('/api/v1/customers')
        .send({ phone: '+18095553333', firstName: 'Carlos', lastName: 'Garcia' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/requeridos/);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('should return 400 when phone is missing', async () => {
      const res = await request(app)
        .post('/api/v1/customers')
        .send({ email: 'test@test.com', firstName: 'Carlos', lastName: 'Garcia' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/requeridos/);
    });

    it('should return 400 when firstName is missing', async () => {
      const res = await request(app)
        .post('/api/v1/customers')
        .send({ email: 'test@test.com', phone: '+18095553333', lastName: 'Garcia' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/requeridos/);
    });

    it('should return 400 when lastName is missing', async () => {
      const res = await request(app)
        .post('/api/v1/customers')
        .send({ email: 'test@test.com', phone: '+18095553333', firstName: 'Carlos' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/requeridos/);
    });

    it('should return 400 when body is empty', async () => {
      const res = await request(app)
        .post('/api/v1/customers')
        .send({});

      expect(res.status).toBe(400);
    });

    it('should return 409 for duplicate email (unique constraint violation)', async () => {
      mockQuery.mockRejectedValueOnce({ code: '23505', detail: 'Key (email)=(nuevo@test.com) already exists.' });

      const res = await request(app)
        .post('/api/v1/customers')
        .send(validCustomer);

      expect(res.status).toBe(409);
    });

    it('should pass correct parameters to user insert query', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'user-id' }] });
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'cust-id' }] });

      await request(app)
        .post('/api/v1/customers')
        .send(validCustomer);

      // First call: insert user with email and phone
      expect(mockQuery.mock.calls[0][1]).toEqual(['nuevo@test.com', '+18095553333']);

      // Second call: insert customer with all fields
      expect(mockQuery.mock.calls[1][1]).toEqual([
        'user-id', 'Carlos', 'Garcia', '001-1234567-8',
        '123456789', false, null, 'Calle Principal #1', 'VIP client'
      ]);
    });

    it('should handle database error during user creation', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Insert failed'));

      const res = await request(app)
        .post('/api/v1/customers')
        .send(validCustomer);

      expect(res.status).toBe(500);
    });
  });

  // ---------- PATCH /api/v1/customers/:id ----------
  describe('PATCH /api/v1/customers/:id', () => {
    it('should update a customer successfully', async () => {
      const updated = {
        id: 'cust-1',
        first_name: 'Juan Carlos',
        last_name: 'Perez',
        updated_at: '2026-03-20T00:00:00Z'
      };

      mockQuery.mockResolvedValueOnce({ rows: [updated] });

      const res = await request(app)
        .patch('/api/v1/customers/cust-1')
        .send({ firstName: 'Juan Carlos' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Cliente actualizado exitosamente');
      expect(res.body.data.first_name).toBe('Juan Carlos');
    });

    it('should return 404 when customer to update is not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .patch('/api/v1/customers/nonexistent')
        .send({ firstName: 'Test' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Cliente no encontrado');
    });

    it('should return 400 when no valid fields are provided', async () => {
      const res = await request(app)
        .patch('/api/v1/customers/cust-1')
        .send({ invalidField: 'value', anotherBad: 123 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('No hay campos válidos para actualizar');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('should return 400 when body is empty', async () => {
      const res = await request(app)
        .patch('/api/v1/customers/cust-1')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('No hay campos válidos para actualizar');
    });

    it('should accept multiple allowed fields at once', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'cust-1',
          first_name: 'Updated',
          last_name: 'Name',
          address: 'New Address',
          notes: 'Updated notes'
        }]
      });

      const res = await request(app)
        .patch('/api/v1/customers/cust-1')
        .send({
          firstName: 'Updated',
          lastName: 'Name',
          address: 'New Address',
          notes: 'Updated notes'
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify the query received the correct values
      const callArgs = mockQuery.mock.calls[0];
      const queryValues = callArgs[1];
      // 4 field values + the id at the end
      expect(queryValues).toHaveLength(5);
      expect(queryValues[queryValues.length - 1]).toBe('cust-1');
    });

    it('should convert camelCase keys to snake_case for the query', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'cust-1', id_document: '001-9999999-9' }]
      });

      await request(app)
        .patch('/api/v1/customers/cust-1')
        .send({ idDocument: '001-9999999-9' });

      const queryString = mockQuery.mock.calls[0][0];
      expect(queryString).toContain('id_document');
    });

    it('should allow updating company-related fields', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'cust-1', is_company: true, company_name: 'Acme Corp', rnc: '999888777' }]
      });

      const res = await request(app)
        .patch('/api/v1/customers/cust-1')
        .send({ isCompany: true, companyName: 'Acme Corp', rnc: '999888777' });

      expect(res.status).toBe(200);
    });

    it('should ignore disallowed fields while still updating allowed ones', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'cust-1', first_name: 'Valid' }]
      });

      const res = await request(app)
        .patch('/api/v1/customers/cust-1')
        .send({ firstName: 'Valid', user_id: 'hacker-id', created_at: '2020-01-01' });

      expect(res.status).toBe(200);
      // Only the allowed field should be in the query values (plus the id)
      const queryValues = mockQuery.mock.calls[0][1];
      expect(queryValues).toContain('Valid');
      expect(queryValues).not.toContain('hacker-id');
    });

    it('should handle database errors during update', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Update failed'));

      const res = await request(app)
        .patch('/api/v1/customers/cust-1')
        .send({ firstName: 'Test' });

      expect(res.status).toBe(500);
    });
  });
});
