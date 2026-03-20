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
  logAudit: jest.fn()
}));

const mockGetHourlyRates = jest.fn();
const mockUpdateHourlyRates = jest.fn();
const mockCalculateAmount = jest.fn();

jest.mock('../src/services/hourlyRate.service', () => ({
  getHourlyRates: mockGetHourlyRates,
  updateHourlyRates: mockUpdateHourlyRates,
  calculateAmount: mockCalculateAmount
}));

const request = require('supertest');
const express = require('express');

const planRoutes = require('../src/routes/plan.routes');
const errorHandler = require('../src/middleware/errorHandler');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/plans', planRoutes);
  app.use(errorHandler);
  return app;
}

describe('Plan Routes', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------
  // Shared fixtures
  // -------------------------------------------------------
  const diurnoPlan = {
    id: 'plan-1',
    name: 'Diurno',
    type: 'diurno',
    description: 'Plan diurno 7am-6pm',
    base_price: 3000,
    weekly_price: null,
    start_hour: '07:00',
    end_hour: '18:00',
    crosses_midnight: false,
    tolerance_minutes: 15,
    max_capacity: 50,
    daily_entry_limit: 5,
    is_active: true,
    current_occupancy: 10,
    display_order: 1
  };

  const nocturnoPlan = {
    id: 'plan-2',
    name: 'Nocturno',
    type: 'nocturno',
    description: 'Plan nocturno 6pm-7am',
    base_price: 2500,
    weekly_price: null,
    start_hour: '18:00',
    end_hour: '07:00',
    crosses_midnight: true,
    tolerance_minutes: 15,
    max_capacity: 30,
    daily_entry_limit: 5,
    is_active: true,
    current_occupancy: 5,
    display_order: 2
  };

  const plan24h = {
    id: 'plan-3',
    name: '24 Horas',
    type: '24h',
    description: 'Plan 24 horas completo',
    base_price: 5000,
    weekly_price: 1000,
    start_hour: null,
    end_hour: null,
    crosses_midnight: false,
    tolerance_minutes: 15,
    max_capacity: 20,
    daily_entry_limit: 10,
    is_active: true,
    current_occupancy: 15,
    display_order: 3
  };

  const hourlyPlan = {
    id: 'plan-4',
    name: 'Por Hora',
    type: 'hourly',
    description: 'Parqueo por hora',
    base_price: 100,
    weekly_price: null,
    start_hour: null,
    end_hour: null,
    crosses_midnight: false,
    tolerance_minutes: 5,
    max_capacity: 100,
    daily_entry_limit: null,
    is_active: true,
    current_occupancy: 40,
    display_order: 4
  };

  const mockHourlyRates = [
    { id: 'rate-1', plan_id: 'plan-4', hour_number: 1, rate: 100, description: 'Primera hora', is_active: true },
    { id: 'rate-2', plan_id: 'plan-4', hour_number: 2, rate: 75, description: 'Segunda hora', is_active: true },
    { id: 'rate-3', plan_id: 'plan-4', hour_number: 3, rate: 50, description: 'Tercera hora en adelante', is_active: true }
  ];

  // -------------------------------------------------------
  // GET /api/v1/plans
  // -------------------------------------------------------
  describe('GET /api/v1/plans', () => {
    it('should list all active plans', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [diurnoPlan, nocturnoPlan, plan24h] });

      const res = await request(app).get('/api/v1/plans');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(3);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('is_active = true');
      expect(sql).toContain('ORDER BY display_order ASC');
    });

    it('should return empty array when no active plans exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app).get('/api/v1/plans');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });

    it('should attach hourly_rates for hourly plan types', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [diurnoPlan, hourlyPlan] });
      mockGetHourlyRates.mockResolvedValueOnce(mockHourlyRates);

      const res = await request(app).get('/api/v1/plans');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      // diurno plan should NOT have hourly_rates
      expect(res.body.data[0]).not.toHaveProperty('hourly_rates');
      // hourly plan SHOULD have hourly_rates
      expect(res.body.data[1].hourly_rates).toEqual(mockHourlyRates);
      expect(mockGetHourlyRates).toHaveBeenCalledWith('plan-4');
    });

    it('should not call getHourlyRates for non-hourly plans', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [diurnoPlan, nocturnoPlan] });

      const res = await request(app).get('/api/v1/plans');

      expect(res.status).toBe(200);
      expect(mockGetHourlyRates).not.toHaveBeenCalled();
    });

    it('should handle database errors', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Database error'));

      const res = await request(app).get('/api/v1/plans');

      expect(res.status).toBe(500);
    });

    it('should handle hourlyRateService errors', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [hourlyPlan] });
      mockGetHourlyRates.mockRejectedValueOnce(new Error('Rate service down'));

      const res = await request(app).get('/api/v1/plans');

      expect(res.status).toBe(500);
    });
  });

  // -------------------------------------------------------
  // GET /api/v1/plans/:id
  // -------------------------------------------------------
  describe('GET /api/v1/plans/:id', () => {
    it('should return a single plan by id', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [diurnoPlan] });

      const res = await request(app).get('/api/v1/plans/plan-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('plan-1');
      expect(res.body.data.name).toBe('Diurno');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM plans WHERE id = $1'),
        ['plan-1']
      );
    });

    it('should return 404 if plan not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app).get('/api/v1/plans/nonexistent');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Plan no encontrado');
    });

    it('should attach hourly_rates for hourly plan type', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [hourlyPlan] });
      mockGetHourlyRates.mockResolvedValueOnce(mockHourlyRates);

      const res = await request(app).get('/api/v1/plans/plan-4');

      expect(res.status).toBe(200);
      expect(res.body.data.hourly_rates).toEqual(mockHourlyRates);
      expect(mockGetHourlyRates).toHaveBeenCalledWith('plan-4');
    });

    it('should not fetch hourly_rates for non-hourly plan', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [diurnoPlan] });

      const res = await request(app).get('/api/v1/plans/plan-1');

      expect(res.status).toBe(200);
      expect(res.body.data).not.toHaveProperty('hourly_rates');
      expect(mockGetHourlyRates).not.toHaveBeenCalled();
    });

    it('should handle database errors', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Query failed'));

      const res = await request(app).get('/api/v1/plans/plan-1');

      expect(res.status).toBe(500);
    });
  });

  // -------------------------------------------------------
  // POST /api/v1/plans
  // -------------------------------------------------------
  describe('POST /api/v1/plans', () => {
    const validDiurnoBody = {
      name: 'Diurno',
      type: 'diurno',
      description: 'Plan diurno 7am-6pm',
      basePrice: 3000,
      startHour: '07:00',
      endHour: '18:00',
      crossesMidnight: false,
      toleranceMinutes: 15,
      maxCapacity: 50,
      dailyEntryLimit: 5
    };

    it('should create a diurno plan', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [diurnoPlan] });

      const res = await request(app)
        .post('/api/v1/plans')
        .send(validDiurnoBody);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Plan creado exitosamente');
      expect(res.body.data.name).toBe('Diurno');
      expect(mockQuery).toHaveBeenCalledTimes(1);
      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('INSERT INTO plans');
      expect(sql).toContain('RETURNING *');
    });

    it('should create a nocturno plan with crosses_midnight', async () => {
      const nocturnoBody = {
        name: 'Nocturno',
        type: 'nocturno',
        description: 'Plan nocturno',
        basePrice: 2500,
        startHour: '18:00',
        endHour: '07:00',
        crossesMidnight: true,
        maxCapacity: 30
      };

      mockQuery.mockResolvedValueOnce({ rows: [nocturnoPlan] });

      const res = await request(app)
        .post('/api/v1/plans')
        .send(nocturnoBody);

      expect(res.status).toBe(201);
      expect(res.body.data.crosses_midnight).toBe(true);
    });

    it('should create a 24h plan with weekly_price', async () => {
      const body24h = {
        name: '24 Horas',
        type: '24h',
        description: 'Plan 24 horas',
        basePrice: 5000,
        weeklyPrice: 1000,
        maxCapacity: 20,
        dailyEntryLimit: 10
      };

      mockQuery.mockResolvedValueOnce({ rows: [plan24h] });

      const res = await request(app)
        .post('/api/v1/plans')
        .send(body24h);

      expect(res.status).toBe(201);
      expect(res.body.data.weekly_price).toBe(1000);
    });

    it('should create an hourly plan with hourly rates', async () => {
      const hourlyBody = {
        name: 'Por Hora',
        type: 'hourly',
        description: 'Parqueo por hora',
        basePrice: 100,
        maxCapacity: 100,
        hourlyRates: mockHourlyRates
      };

      mockQuery.mockResolvedValueOnce({ rows: [hourlyPlan] });
      mockUpdateHourlyRates.mockResolvedValueOnce(mockHourlyRates);

      const res = await request(app)
        .post('/api/v1/plans')
        .send(hourlyBody);

      expect(res.status).toBe(201);
      expect(res.body.data.hourly_rates).toEqual(mockHourlyRates);
      expect(mockUpdateHourlyRates).toHaveBeenCalledWith('plan-4', mockHourlyRates);
    });

    it('should not call updateHourlyRates for non-hourly plan', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [diurnoPlan] });

      await request(app)
        .post('/api/v1/plans')
        .send(validDiurnoBody);

      expect(mockUpdateHourlyRates).not.toHaveBeenCalled();
    });

    it('should not call updateHourlyRates for hourly plan without rates', async () => {
      const hourlyNoRates = {
        name: 'Por Hora',
        type: 'hourly',
        basePrice: 100,
        maxCapacity: 100
      };

      mockQuery.mockResolvedValueOnce({ rows: [hourlyPlan] });

      await request(app)
        .post('/api/v1/plans')
        .send(hourlyNoRates);

      expect(mockUpdateHourlyRates).not.toHaveBeenCalled();
    });

    it('should return 400 if name is missing', async () => {
      const res = await request(app)
        .post('/api/v1/plans')
        .send({ type: 'diurno', basePrice: 3000, maxCapacity: 50 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('name');
    });

    it('should return 400 if type is missing', async () => {
      const res = await request(app)
        .post('/api/v1/plans')
        .send({ name: 'Test', basePrice: 3000, maxCapacity: 50 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('type');
    });

    it('should return 400 if basePrice is missing', async () => {
      const res = await request(app)
        .post('/api/v1/plans')
        .send({ name: 'Test', type: 'diurno', maxCapacity: 50 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('basePrice');
    });

    it('should return 400 if maxCapacity is missing', async () => {
      const res = await request(app)
        .post('/api/v1/plans')
        .send({ name: 'Test', type: 'diurno', basePrice: 3000 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('maxCapacity');
    });

    it('should default toleranceMinutes to 15 when not provided', async () => {
      const body = {
        name: 'Test',
        type: 'diurno',
        basePrice: 3000,
        maxCapacity: 50
      };

      mockQuery.mockResolvedValueOnce({ rows: [diurnoPlan] });

      await request(app)
        .post('/api/v1/plans')
        .send(body);

      const params = mockQuery.mock.calls[0][1];
      // toleranceMinutes is the 9th parameter (index 8)
      expect(params[8]).toBe(15);
    });

    it('should default dailyEntryLimit to 5 when not provided', async () => {
      const body = {
        name: 'Test',
        type: 'diurno',
        basePrice: 3000,
        maxCapacity: 50
      };

      mockQuery.mockResolvedValueOnce({ rows: [diurnoPlan] });

      await request(app)
        .post('/api/v1/plans')
        .send(body);

      const params = mockQuery.mock.calls[0][1];
      // dailyEntryLimit is the 11th parameter (index 10)
      expect(params[10]).toBe(5);
    });

    it('should pass all parameters in correct order', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [diurnoPlan] });

      await request(app)
        .post('/api/v1/plans')
        .send(validDiurnoBody);

      const params = mockQuery.mock.calls[0][1];
      expect(params).toEqual([
        'Diurno',         // name
        'diurno',         // type
        'Plan diurno 7am-6pm', // description
        3000,             // basePrice
        undefined,        // weeklyPrice
        '07:00',          // startHour
        '18:00',          // endHour
        false,            // crossesMidnight
        15,               // toleranceMinutes
        50,               // maxCapacity
        5                 // dailyEntryLimit
      ]);
    });

    it('should handle database errors during creation', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Insert failed'));

      const res = await request(app)
        .post('/api/v1/plans')
        .send(validDiurnoBody);

      expect(res.status).toBe(500);
    });

    it('should handle duplicate plan name (unique constraint)', async () => {
      mockQuery.mockRejectedValueOnce({ code: '23505', detail: 'Key (name)' });

      const res = await request(app)
        .post('/api/v1/plans')
        .send(validDiurnoBody);

      expect(res.status).toBe(409);
    });
  });

  // -------------------------------------------------------
  // PATCH /api/v1/plans/:id
  // -------------------------------------------------------
  describe('PATCH /api/v1/plans/:id', () => {
    it('should update plan name', async () => {
      const updatedPlan = { ...diurnoPlan, name: 'Diurno Premium' };
      mockQuery.mockResolvedValueOnce({ rows: [updatedPlan] });

      const res = await request(app)
        .patch('/api/v1/plans/plan-1')
        .send({ name: 'Diurno Premium' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Plan actualizado exitosamente');
      expect(res.body.data.name).toBe('Diurno Premium');
    });

    it('should update base_price', async () => {
      const updatedPlan = { ...diurnoPlan, base_price: 3500 };
      mockQuery.mockResolvedValueOnce({ rows: [updatedPlan] });

      const res = await request(app)
        .patch('/api/v1/plans/plan-1')
        .send({ basePrice: 3500 });

      expect(res.status).toBe(200);
      expect(res.body.data.base_price).toBe(3500);
    });

    it('should update multiple fields at once', async () => {
      const updatedPlan = { ...diurnoPlan, name: 'Updated', base_price: 4000, max_capacity: 60 };
      mockQuery.mockResolvedValueOnce({ rows: [updatedPlan] });

      const res = await request(app)
        .patch('/api/v1/plans/plan-1')
        .send({ name: 'Updated', basePrice: 4000, maxCapacity: 60 });

      expect(res.status).toBe(200);
      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('name = $');
      expect(sql).toContain('base_price = $');
      expect(sql).toContain('max_capacity = $');
      expect(sql).toContain('updated_at = NOW()');
    });

    it('should convert camelCase to snake_case for field names', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [diurnoPlan] });

      await request(app)
        .patch('/api/v1/plans/plan-1')
        .send({ basePrice: 4000 });

      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('base_price = $');
      expect(sql).not.toContain('basePrice');
    });

    it('should update is_active field', async () => {
      const updatedPlan = { ...diurnoPlan, is_active: false };
      mockQuery.mockResolvedValueOnce({ rows: [updatedPlan] });

      const res = await request(app)
        .patch('/api/v1/plans/plan-1')
        .send({ isActive: false });

      expect(res.status).toBe(200);
      expect(res.body.data.is_active).toBe(false);
    });

    it('should return 404 if plan not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .patch('/api/v1/plans/nonexistent')
        .send({ name: 'Updated' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Plan no encontrado');
    });

    it('should return 400 if no valid fields provided', async () => {
      const res = await request(app)
        .patch('/api/v1/plans/plan-1')
        .send({ invalidField: 'value' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('No hay campos válidos para actualizar');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('should return 400 with empty body', async () => {
      const res = await request(app)
        .patch('/api/v1/plans/plan-1')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('No hay campos válidos para actualizar');
    });

    it('should ignore disallowed fields', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [diurnoPlan] });

      await request(app)
        .patch('/api/v1/plans/plan-1')
        .send({ name: 'Valid', type: 'nocturno', hackerField: 'evil' });

      // Only 'name' should be in the update, 'type' is not in allowedFields
      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('name = $');
      expect(sql).not.toContain('type = $');
      expect(sql).not.toContain('hacker');
    });

    it('should update hourly rates for hourly plan type', async () => {
      const updatedHourlyPlan = { ...hourlyPlan, base_price: 120 };
      mockQuery.mockResolvedValueOnce({ rows: [updatedHourlyPlan] });
      const newRates = [{ hour_number: 1, rate: 120, description: 'Primera hora' }];
      mockUpdateHourlyRates.mockResolvedValueOnce(newRates);

      const res = await request(app)
        .patch('/api/v1/plans/plan-4')
        .send({ basePrice: 120, hourlyRates: newRates });

      expect(res.status).toBe(200);
      expect(mockUpdateHourlyRates).toHaveBeenCalledWith('plan-4', newRates);
      expect(res.body.data.hourly_rates).toEqual(newRates);
    });

    it('should not update hourly rates for non-hourly plan type', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [diurnoPlan] });

      const res = await request(app)
        .patch('/api/v1/plans/plan-1')
        .send({ name: 'Updated', hourlyRates: [{ hour_number: 1, rate: 100 }] });

      expect(res.status).toBe(200);
      expect(mockUpdateHourlyRates).not.toHaveBeenCalled();
    });

    it('should always include updated_at = NOW() in update query', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [diurnoPlan] });

      await request(app)
        .patch('/api/v1/plans/plan-1')
        .send({ name: 'Updated' });

      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('updated_at = NOW()');
    });

    it('should handle database errors during update', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Update failed'));

      const res = await request(app)
        .patch('/api/v1/plans/plan-1')
        .send({ name: 'Updated' });

      expect(res.status).toBe(500);
    });
  });

  // -------------------------------------------------------
  // DELETE /api/v1/plans/:id
  // -------------------------------------------------------
  describe('DELETE /api/v1/plans/:id', () => {
    it('should soft-delete (deactivate) a plan', async () => {
      const deactivatedPlan = { ...diurnoPlan, is_active: false };
      mockQuery.mockResolvedValueOnce({ rows: [deactivatedPlan] });

      const res = await request(app).delete('/api/v1/plans/plan-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Plan desactivado exitosamente');
      expect(res.body.data.is_active).toBe(false);
    });

    it('should set is_active = false instead of physically deleting', async () => {
      const deactivatedPlan = { ...diurnoPlan, is_active: false };
      mockQuery.mockResolvedValueOnce({ rows: [deactivatedPlan] });

      await request(app).delete('/api/v1/plans/plan-1');

      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('SET is_active = false');
      expect(sql).toContain('updated_at = NOW()');
      expect(sql).not.toContain('DELETE FROM');
    });

    it('should return 404 if plan not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app).delete('/api/v1/plans/nonexistent');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Plan no encontrado');
    });

    it('should pass the plan id as parameter', async () => {
      const deactivatedPlan = { ...diurnoPlan, is_active: false };
      mockQuery.mockResolvedValueOnce({ rows: [deactivatedPlan] });

      await request(app).delete('/api/v1/plans/plan-1');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        ['plan-1']
      );
    });

    it('should handle database errors during deletion', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Delete failed'));

      const res = await request(app).delete('/api/v1/plans/plan-1');

      expect(res.status).toBe(500);
    });
  });

  // -------------------------------------------------------
  // GET /api/v1/plans/:id/occupancy
  // -------------------------------------------------------
  describe('GET /api/v1/plans/:id/occupancy', () => {
    const occupancyData = {
      id: 'plan-1',
      name: 'Diurno',
      type: 'diurno',
      current_occupancy: 10,
      max_capacity: 50,
      occupancy_percentage: 20.00,
      available_spots: 40
    };

    it('should return occupancy data for a plan', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [occupancyData] });

      const res = await request(app).get('/api/v1/plans/plan-1/occupancy');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.current_occupancy).toBe(10);
      expect(res.body.data.max_capacity).toBe(50);
      expect(res.body.data.occupancy_percentage).toBe(20.00);
      expect(res.body.data.available_spots).toBe(40);
    });

    it('should return 404 if plan not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app).get('/api/v1/plans/nonexistent/occupancy');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Plan no encontrado');
    });

    it('should query with correct plan id parameter', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [occupancyData] });

      await request(app).get('/api/v1/plans/plan-1/occupancy');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('FROM plans'),
        ['plan-1']
      );
    });

    it('should handle database errors', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Query failed'));

      const res = await request(app).get('/api/v1/plans/plan-1/occupancy');

      expect(res.status).toBe(500);
    });
  });

  // -------------------------------------------------------
  // GET /api/v1/plans/hourly/rates/:planId
  // -------------------------------------------------------
  describe('GET /api/v1/plans/hourly/rates/:planId', () => {
    it('should return hourly rates for a plan', async () => {
      mockGetHourlyRates.mockResolvedValueOnce(mockHourlyRates);

      const res = await request(app).get('/api/v1/plans/hourly/rates/plan-4');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(mockHourlyRates);
      expect(mockGetHourlyRates).toHaveBeenCalledWith('plan-4');
    });

    it('should return empty array when no rates configured', async () => {
      mockGetHourlyRates.mockResolvedValueOnce([]);

      const res = await request(app).get('/api/v1/plans/hourly/rates/plan-4');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('should handle service errors', async () => {
      mockGetHourlyRates.mockRejectedValueOnce(new Error('Service error'));

      const res = await request(app).get('/api/v1/plans/hourly/rates/plan-4');

      expect(res.status).toBe(500);
    });
  });

  // -------------------------------------------------------
  // PUT /api/v1/plans/hourly/rates/:planId
  // -------------------------------------------------------
  describe('PUT /api/v1/plans/hourly/rates/:planId', () => {
    const validRates = [
      { hour_number: 1, rate: 100, description: 'Primera hora' },
      { hour_number: 2, rate: 75, description: 'Segunda hora' },
      { hour_number: 3, rate: 50, description: 'Tercera hora en adelante' }
    ];

    it('should update hourly rates successfully', async () => {
      mockUpdateHourlyRates.mockResolvedValueOnce(mockHourlyRates);

      const res = await request(app)
        .put('/api/v1/plans/hourly/rates/plan-4')
        .send({ rates: validRates });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Tarifas actualizadas exitosamente');
      expect(res.body.data).toEqual(mockHourlyRates);
      expect(mockUpdateHourlyRates).toHaveBeenCalledWith('plan-4', validRates);
    });

    it('should return 400 if rates is not provided', async () => {
      const res = await request(app)
        .put('/api/v1/plans/hourly/rates/plan-4')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('rates');
    });

    it('should return 400 if rates is not an array', async () => {
      const res = await request(app)
        .put('/api/v1/plans/hourly/rates/plan-4')
        .send({ rates: 'not-an-array' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('rates');
    });

    it('should return 400 if a rate is missing hour_number', async () => {
      const res = await request(app)
        .put('/api/v1/plans/hourly/rates/plan-4')
        .send({ rates: [{ rate: 100 }] });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('hour_number');
    });

    it('should return 400 if a rate is missing rate value', async () => {
      const res = await request(app)
        .put('/api/v1/plans/hourly/rates/plan-4')
        .send({ rates: [{ hour_number: 1 }] });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('rate');
    });

    it('should handle service errors during update', async () => {
      mockUpdateHourlyRates.mockRejectedValueOnce(new Error('Update failed'));

      const res = await request(app)
        .put('/api/v1/plans/hourly/rates/plan-4')
        .send({ rates: validRates });

      expect(res.status).toBe(500);
    });
  });

  // -------------------------------------------------------
  // POST /api/v1/plans/hourly/calculate
  // -------------------------------------------------------
  describe('POST /api/v1/plans/hourly/calculate', () => {
    const calculationResult = {
      amount: 225,
      breakdown: [
        { hour: 1, rate: 100, description: 'Primera hora' },
        { hour: 2, rate: 75, description: 'Segunda hora' },
        { hour: 3, rate: 50, description: 'Tercera hora' }
      ],
      totalMinutes: 170,
      totalHours: 3,
      toleranceApplied: 5,
      isFree: false
    };

    it('should calculate parking cost with entry and exit times', async () => {
      mockCalculateAmount.mockResolvedValueOnce(calculationResult);

      const res = await request(app)
        .post('/api/v1/plans/hourly/calculate')
        .send({
          planId: 'plan-4',
          entryTime: '2026-03-20T08:00:00Z',
          exitTime: '2026-03-20T11:00:00Z'
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.amount).toBe(225);
      expect(res.body.data.totalHours).toBe(3);
      expect(res.body.data.breakdown).toHaveLength(3);
    });

    it('should calculate with only entryTime (exit defaults to now)', async () => {
      mockCalculateAmount.mockResolvedValueOnce(calculationResult);

      const res = await request(app)
        .post('/api/v1/plans/hourly/calculate')
        .send({
          planId: 'plan-4',
          entryTime: '2026-03-20T08:00:00Z'
        });

      expect(res.status).toBe(200);
      expect(mockCalculateAmount).toHaveBeenCalledWith(
        'plan-4',
        expect.any(Date),
        expect.any(Date)
      );
    });

    it('should return 400 if planId is missing', async () => {
      const res = await request(app)
        .post('/api/v1/plans/hourly/calculate')
        .send({ entryTime: '2026-03-20T08:00:00Z' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('planId');
    });

    it('should return 400 if entryTime is missing', async () => {
      const res = await request(app)
        .post('/api/v1/plans/hourly/calculate')
        .send({ planId: 'plan-4' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('entryTime');
    });

    it('should return 400 if both planId and entryTime are missing', async () => {
      const res = await request(app)
        .post('/api/v1/plans/hourly/calculate')
        .send({});

      expect(res.status).toBe(400);
    });

    it('should handle free parking (within tolerance)', async () => {
      const freeResult = {
        amount: 0,
        breakdown: [{ hour: 0, rate: 0, description: 'Gratis (tolerancia de 5 minutos)' }],
        totalMinutes: 3,
        totalHours: 0,
        isFree: true
      };
      mockCalculateAmount.mockResolvedValueOnce(freeResult);

      const res = await request(app)
        .post('/api/v1/plans/hourly/calculate')
        .send({
          planId: 'plan-4',
          entryTime: '2026-03-20T08:00:00Z',
          exitTime: '2026-03-20T08:03:00Z'
        });

      expect(res.status).toBe(200);
      expect(res.body.data.amount).toBe(0);
      expect(res.body.data.isFree).toBe(true);
    });

    it('should handle service errors during calculation', async () => {
      mockCalculateAmount.mockRejectedValueOnce(new Error('No rates configured'));

      const res = await request(app)
        .post('/api/v1/plans/hourly/calculate')
        .send({
          planId: 'plan-4',
          entryTime: '2026-03-20T08:00:00Z',
          exitTime: '2026-03-20T11:00:00Z'
        });

      expect(res.status).toBe(500);
    });
  });
});
