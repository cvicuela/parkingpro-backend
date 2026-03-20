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
const vehicleRoutes = require('../src/routes/vehicle.routes');
const errorHandler = require('../src/middleware/errorHandler');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/vehicles', vehicleRoutes);
  app.use(errorHandler);
  return app;
}

describe('Vehicle Routes', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ---------- GET /api/v1/vehicles ----------
  describe('GET /api/v1/vehicles', () => {
    it('should return a list of vehicles with customer names', async () => {
      const vehicles = [
        { id: 'v1', plate: 'A123456', make: 'Toyota', model: 'Corolla', color: 'White', year: 2022, customer_name: 'Juan Perez' },
        { id: 'v2', plate: 'B654321', make: 'Honda', model: 'Civic', color: 'Black', year: 2023, customer_name: 'Maria Lopez' }
      ];

      mockQuery.mockResolvedValueOnce({ rows: vehicles });

      const res = await request(app).get('/api/v1/vehicles');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0].plate).toBe('A123456');
      expect(res.body.data[0].customer_name).toBe('Juan Perez');
      expect(res.body.data[1].make).toBe('Honda');
    });

    it('should return an empty list when no vehicles exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app).get('/api/v1/vehicles');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(0);
    });

    it('should call the correct query with JOIN on customers', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await request(app).get('/api/v1/vehicles');

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const queryString = mockQuery.mock.calls[0][0];
      expect(queryString).toContain('vehicles');
      expect(queryString).toContain('JOIN customers');
      expect(queryString).toContain('customer_name');
    });

    it('should handle database errors', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Database failure'));

      const res = await request(app).get('/api/v1/vehicles');

      expect(res.status).toBe(500);
      expect(res.body.error).toBeDefined();
    });
  });

  // ---------- POST /api/v1/vehicles ----------
  describe('POST /api/v1/vehicles', () => {
    const validVehicle = {
      customerId: 'cust-1',
      plate: 'A123456',
      make: 'Toyota',
      model: 'Corolla',
      color: 'White',
      year: 2022
    };

    it('should register a vehicle successfully', async () => {
      const createdVehicle = {
        id: 'v-new-1',
        customer_id: 'cust-1',
        plate: 'A123456',
        make: 'Toyota',
        model: 'Corolla',
        color: 'White',
        year: 2022
      };

      // First call: duplicate check, second call: insert
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [createdVehicle] });

      const res = await request(app)
        .post('/api/v1/vehicles')
        .send(validVehicle);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('v-new-1');
      expect(res.body.data.plate).toBe('A123456');
      expect(res.body.data.make).toBe('Toyota');
    });

    it('should pass correct parameters to the insert query', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // duplicate check
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'v-new-1' }] });

      await request(app)
        .post('/api/v1/vehicles')
        .send(validVehicle);

      // Second call is the INSERT
      expect(mockQuery).toHaveBeenCalledTimes(2);
      const insertCall = mockQuery.mock.calls[1];
      expect(insertCall[1]).toEqual(['cust-1', 'A123456', 'Toyota', 'Corolla', 'White', 2022]);
    });

    it('should return 409 for duplicate plate (pre-check)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'existing' }] }); // duplicate found

      const res = await request(app)
        .post('/api/v1/vehicles')
        .send(validVehicle);

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('A123456');
    });

    it('should return 400 for missing required fields', async () => {
      const res = await request(app)
        .post('/api/v1/vehicles')
        .send({ customerId: 'cust-1' }); // missing plate

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('requeridos');
    });

    it('should return 400 for invalid plate format', async () => {
      const res = await request(app)
        .post('/api/v1/vehicles')
        .send({ customerId: 'cust-1', plate: '123' }); // invalid plate

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('placa');
    });

    it('should return 400 for invalid year', async () => {
      const res = await request(app)
        .post('/api/v1/vehicles')
        .send({ ...validVehicle, year: 1950 }); // too old

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Año');
    });

    it('should handle missing optional fields gracefully', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // duplicate check
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'v-new-2',
          customer_id: 'cust-1',
          plate: 'X999999',
          make: undefined,
          model: undefined,
          color: undefined,
          year: undefined
        }]
      });

      const res = await request(app)
        .post('/api/v1/vehicles')
        .send({ customerId: 'cust-1', plate: 'X999999' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });

    it('should handle database errors during insert', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // duplicate check passes
      mockQuery.mockRejectedValueOnce(new Error('Insert failed'));

      const res = await request(app)
        .post('/api/v1/vehicles')
        .send(validVehicle);

      expect(res.status).toBe(500);
      expect(res.body.error).toBeDefined();
    });

    it('should create vehicle with all fields populated', async () => {
      const fullVehicle = {
        customerId: 'cust-5',
        plate: 'Z000001',
        make: 'BMW',
        model: 'X5',
        color: 'Silver',
        year: 2025
      };

      mockQuery.mockResolvedValueOnce({ rows: [] }); // duplicate check
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'v-new-3',
          customer_id: 'cust-5',
          plate: 'Z000001',
          make: 'BMW',
          model: 'X5',
          color: 'Silver',
          year: 2025
        }]
      });

      const res = await request(app)
        .post('/api/v1/vehicles')
        .send(fullVehicle);

      expect(res.status).toBe(201);
      expect(res.body.data.make).toBe('BMW');
      expect(res.body.data.year).toBe(2025);
    });
  });

  // ---------- GET /api/v1/vehicles/:id ----------
  describe('GET /api/v1/vehicles/:id', () => {
    it('should return a vehicle by ID', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'v1', plate: 'A123456', customer_name: 'Juan Perez' }]
      });

      const res = await request(app).get('/api/v1/vehicles/v1');

      expect(res.status).toBe(200);
      expect(res.body.data.plate).toBe('A123456');
    });

    it('should return 404 for non-existent vehicle', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app).get('/api/v1/vehicles/bad-id');

      expect(res.status).toBe(404);
    });
  });

  // ---------- PATCH /api/v1/vehicles/:id ----------
  describe('PATCH /api/v1/vehicles/:id', () => {
    it('should update a vehicle', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'v1', plate: 'A123456', color: 'Red' }]
      });

      const res = await request(app)
        .patch('/api/v1/vehicles/v1')
        .send({ color: 'Red' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should reject invalid plate format on update', async () => {
      const res = await request(app)
        .patch('/api/v1/vehicles/v1')
        .send({ plate: '123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('placa');
    });

    it('should return 400 if no valid fields', async () => {
      const res = await request(app)
        .patch('/api/v1/vehicles/v1')
        .send({ invalidField: 'test' });

      expect(res.status).toBe(400);
    });
  });

  // ---------- DELETE /api/v1/vehicles/:id ----------
  describe('DELETE /api/v1/vehicles/:id', () => {
    it('should delete a vehicle with no active subscriptions', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // no active subs
      mockQuery.mockResolvedValueOnce({ rows: [{ plate: 'A123456' }] }); // delete

      const res = await request(app).delete('/api/v1/vehicles/v1');

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('A123456');
    });

    it('should reject delete if vehicle has active subscriptions', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'sub-1' }] }); // active sub exists

      const res = await request(app).delete('/api/v1/vehicles/v1');

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('suscripciones activas');
    });

    it('should return 404 for non-existent vehicle', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // no active subs
      mockQuery.mockResolvedValueOnce({ rows: [] }); // not found

      const res = await request(app).delete('/api/v1/vehicles/bad-id');

      expect(res.status).toBe(404);
    });
  });
});
