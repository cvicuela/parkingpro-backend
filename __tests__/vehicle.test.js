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
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'v-new-1' }] });

      await request(app)
        .post('/api/v1/vehicles')
        .send(validVehicle);

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = mockQuery.mock.calls[0];
      expect(callArgs[1]).toEqual(['cust-1', 'A123456', 'Toyota', 'Corolla', 'White', 2022]);
    });

    it('should return 409 for duplicate plate (unique constraint violation)', async () => {
      mockQuery.mockRejectedValueOnce({ code: '23505', detail: 'Key (plate)=(A123456) already exists.' });

      const res = await request(app)
        .post('/api/v1/vehicles')
        .send(validVehicle);

      expect(res.status).toBe(409);
    });

    it('should return 400 for invalid foreign key (non-existent customer)', async () => {
      mockQuery.mockRejectedValueOnce({ code: '23503', detail: 'Key (customer_id)=(bad-id) is not present in table "customers".' });

      const res = await request(app)
        .post('/api/v1/vehicles')
        .send({ ...validVehicle, customerId: 'bad-id' });

      expect(res.status).toBe(400);
    });

    it('should return 400 for not-null constraint violation', async () => {
      mockQuery.mockRejectedValueOnce({ code: '23502', column: 'plate' });

      const res = await request(app)
        .post('/api/v1/vehicles')
        .send({ customerId: 'cust-1' });

      expect(res.status).toBe(400);
    });

    it('should handle missing optional fields gracefully', async () => {
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
      mockQuery.mockRejectedValueOnce(new Error('Insert failed'));

      const res = await request(app)
        .post('/api/v1/vehicles')
        .send(validVehicle);

      expect(res.status).toBe(500);
      expect(res.body.error).toBeDefined();
    });

    it('should handle invalid data format', async () => {
      mockQuery.mockRejectedValueOnce({ code: '22P02' });

      const res = await request(app)
        .post('/api/v1/vehicles')
        .send({ ...validVehicle, year: 'not-a-number' });

      expect(res.status).toBe(400);
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
});
