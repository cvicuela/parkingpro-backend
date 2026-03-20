// Mock database before requiring anything else
const mockQuery = jest.fn();
const mockTransaction = jest.fn();
jest.mock('../src/config/database', () => ({
  query: mockQuery,
  transaction: mockTransaction,
  supabase: {
    rpc: jest.fn()
  },
  pool: { end: jest.fn() },
  testConnection: jest.fn().mockResolvedValue(true)
}));

// Mock auth middleware to inject req.user
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, res, next) => {
    req.user = { id: 'test-user-id', role: 'admin', email: 'admin@test.com' };
    next();
  },
  authorize: () => (req, res, next) => next()
}));

// Mock audit middleware
jest.mock('../src/middleware/audit', () => ({
  logAudit: jest.fn()
}));

// Mock hourlyRate service
const mockHourlyRateService = {
  getActiveSessions: jest.fn(),
  findActiveSessionByPlate: jest.fn(),
  startParkingSession: jest.fn(),
  endParkingSession: jest.fn(),
  recordSessionPayment: jest.fn(),
  calculateAmount: jest.fn(),
  getHourlyRates: jest.fn()
};
jest.mock('../src/services/hourlyRate.service', () => mockHourlyRateService);

// Mock rfid service
jest.mock('../src/services/rfid.service', () => ({
  resolveCardForAccess: jest.fn(),
  activateCard: jest.fn()
}));

// Mock push service
jest.mock('../src/services/push.service', () => ({
  sendToRole: jest.fn()
}));

// Mock qrcode service
jest.mock('../src/services/qrcode.service', () => ({
  generateEntryQR: jest.fn().mockResolvedValue('mock-qr-data')
}));

// Mock cashRegister service
jest.mock('../src/services/cashRegister.service', () => ({
  getActiveRegister: jest.fn().mockResolvedValue(null),
  recordPayment: jest.fn()
}));

const request = require('supertest');
const express = require('express');

const accessRoutes = require('../src/routes/access.routes');
const accessControlService = require('../src/services/accessControl.service');
const errorHandler = require('../src/middleware/errorHandler');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/access', accessRoutes);
  app.use(errorHandler);
  return app;
}

describe('Access Control Routes & Service', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // =============================================================
  // POST /api/v1/access/validate - Entry validation
  // =============================================================
  describe('POST /api/v1/access/validate (type=entry)', () => {
    it('should return 400 if vehiclePlate or type is missing', async () => {
      const res = await request(app)
        .post('/api/v1/access/validate')
        .send({ vehiclePlate: 'ABC123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/vehiclePlate y type son requeridos/);
    });

    it('should return 400 for invalid type value', async () => {
      const res = await request(app)
        .post('/api/v1/access/validate')
        .send({ vehiclePlate: 'ABC123', type: 'invalid' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/type debe ser/);
    });

    it('should allow entry for vehicle with active subscription', async () => {
      // findActiveSubscription returns active subscription
      mockQuery.mockResolvedValueOnce({
        rows: [{
          subscription_id: 'sub-1',
          status: 'active',
          next_billing_date: '2027-12-31',
          customer_name: 'Juan Perez',
          vehicle_plate: 'ABC123',
          plan_id: 'plan-1',
          plan_name: 'Plan Diurno',
          plan_type: '24h',
          start_hour: 6,
          end_hour: 18,
          crosses_midnight: false,
          tolerance_minutes: 15,
          current_occupancy: 5,
          max_capacity: 50,
          daily_entry_limit: 3,
          overage_hourly_rate: 100
        }]
      });

      // getTodayEntries
      mockQuery.mockResolvedValueOnce({
        rows: [{ count: '0' }]
      });

      const res = await request(app)
        .post('/api/v1/access/validate')
        .send({ vehiclePlate: 'ABC123', type: 'entry' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.allowed).toBe(true);
      expect(res.body.data.accessType).toBe('subscription');
      expect(res.body.data.subscription.customer_name).toBe('Juan Perez');
    });

    it('should allow entry for hourly vehicle (no subscription)', async () => {
      // findActiveSubscription returns null
      mockQuery.mockResolvedValueOnce({ rows: [] });

      // getAvailableHourlyPlan returns a plan
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'hourly-plan-1',
          name: 'Plan Por Hora',
          type: 'hourly',
          is_active: true,
          current_occupancy: 10,
          max_capacity: 100
        }]
      });

      // findActiveSessionByPlate returns null (no existing session)
      mockHourlyRateService.findActiveSessionByPlate.mockResolvedValueOnce(null);

      // getHourlyRates
      mockHourlyRateService.getHourlyRates.mockResolvedValueOnce([
        { hour_number: 1, rate: 50 },
        { hour_number: 2, rate: 40 }
      ]);

      const res = await request(app)
        .post('/api/v1/access/validate')
        .send({ vehiclePlate: 'NEW123', type: 'entry' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.allowed).toBe(true);
      expect(res.body.data.accessType).toBe('hourly');
      expect(res.body.data.plan.id).toBe('hourly-plan-1');
    });

    it('should deny entry when subscription is expired', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          subscription_id: 'sub-1',
          status: 'active',
          next_billing_date: '2020-01-01', // expired
          customer_name: 'Juan Perez',
          vehicle_plate: 'ABC123',
          plan_id: 'plan-1',
          plan_name: 'Plan Diurno',
          plan_type: '24h',
          start_hour: 6,
          end_hour: 18,
          crosses_midnight: false,
          tolerance_minutes: 15,
          current_occupancy: 5,
          max_capacity: 50,
          daily_entry_limit: 3,
          overage_hourly_rate: 100
        }]
      });

      const res = await request(app)
        .post('/api/v1/access/validate')
        .send({ vehiclePlate: 'ABC123', type: 'entry' });

      expect(res.status).toBe(200);
      expect(res.body.data.allowed).toBe(false);
      expect(res.body.data.reason).toBe('SUBSCRIPTION_EXPIRED');
    });

    it('should deny entry when parking is at full capacity', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          subscription_id: 'sub-1',
          status: 'active',
          next_billing_date: '2027-12-31',
          customer_name: 'Juan Perez',
          vehicle_plate: 'ABC123',
          plan_id: 'plan-1',
          plan_name: 'Plan Diurno',
          plan_type: '24h',
          start_hour: 6,
          end_hour: 18,
          crosses_midnight: false,
          tolerance_minutes: 15,
          current_occupancy: 50,
          max_capacity: 50, // full
          daily_entry_limit: 3,
          overage_hourly_rate: 100
        }]
      });

      const res = await request(app)
        .post('/api/v1/access/validate')
        .send({ vehiclePlate: 'ABC123', type: 'entry' });

      expect(res.status).toBe(200);
      expect(res.body.data.allowed).toBe(false);
      expect(res.body.data.reason).toBe('FULL_CAPACITY');
    });

    it('should deny entry when no subscription and no hourly plan available', async () => {
      // findActiveSubscription returns null
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // getAvailableHourlyPlan returns null
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/v1/access/validate')
        .send({ vehiclePlate: 'UNKNOWN1', type: 'entry' });

      expect(res.status).toBe(200);
      expect(res.body.data.allowed).toBe(false);
      expect(res.body.data.reason).toBe('NO_SUBSCRIPTION_NO_HOURLY');
    });

    it('should deny entry when subscription status is not active', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          subscription_id: 'sub-1',
          status: 'suspended',
          next_billing_date: '2027-12-31',
          customer_name: 'Juan Perez',
          vehicle_plate: 'ABC123',
          plan_id: 'plan-1',
          plan_name: 'Plan Diurno',
          plan_type: '24h',
          start_hour: 6,
          end_hour: 18,
          crosses_midnight: false,
          tolerance_minutes: 15,
          current_occupancy: 5,
          max_capacity: 50,
          daily_entry_limit: 3,
          overage_hourly_rate: 100
        }]
      });

      const res = await request(app)
        .post('/api/v1/access/validate')
        .send({ vehiclePlate: 'ABC123', type: 'entry' });

      expect(res.status).toBe(200);
      expect(res.body.data.allowed).toBe(false);
      expect(res.body.data.reason).toBe('SUBSCRIPTION_NOT_ACTIVE');
    });

    it('should deny entry when vehicle already has active session (hourly)', async () => {
      // findActiveSubscription returns null
      mockQuery.mockResolvedValueOnce({ rows: [] });

      // getAvailableHourlyPlan returns a plan
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'hourly-plan-1', name: 'Plan Por Hora', type: 'hourly', is_active: true, current_occupancy: 10, max_capacity: 100 }]
      });

      // findActiveSessionByPlate returns existing session
      mockHourlyRateService.findActiveSessionByPlate.mockResolvedValueOnce({
        id: 'session-1',
        vehicle_plate: 'DUP123',
        entry_time: '2026-03-20T08:00:00Z'
      });

      const res = await request(app)
        .post('/api/v1/access/validate')
        .send({ vehiclePlate: 'DUP123', type: 'entry' });

      expect(res.status).toBe(200);
      expect(res.body.data.allowed).toBe(false);
      expect(res.body.data.reason).toBe('ALREADY_INSIDE');
    });

    it('should deny entry when daily entry limit is exceeded', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          subscription_id: 'sub-1',
          status: 'active',
          next_billing_date: '2027-12-31',
          customer_name: 'Juan Perez',
          vehicle_plate: 'ABC123',
          plan_id: 'plan-1',
          plan_name: 'Plan Diurno',
          plan_type: '24h',
          start_hour: 6,
          end_hour: 18,
          crosses_midnight: false,
          tolerance_minutes: 15,
          current_occupancy: 5,
          max_capacity: 50,
          daily_entry_limit: 3,
          overage_hourly_rate: 100
        }]
      });

      // getTodayEntries returns limit reached
      mockQuery.mockResolvedValueOnce({
        rows: [{ count: '3' }]
      });

      const res = await request(app)
        .post('/api/v1/access/validate')
        .send({ vehiclePlate: 'ABC123', type: 'entry' });

      expect(res.status).toBe(200);
      expect(res.body.data.allowed).toBe(false);
      expect(res.body.data.reason).toBe('DAILY_LIMIT_EXCEEDED');
    });
  });

  // =============================================================
  // POST /api/v1/access/validate - Exit validation
  // =============================================================
  describe('POST /api/v1/access/validate (type=exit)', () => {
    it('should allow exit for subscription vehicle with open entry', async () => {
      const entryTimestamp = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago

      // findOpenEntry returns an entry event
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'event-1',
          subscription_id: 'sub-1',
          vehicle_plate: 'ABC123',
          type: 'entry',
          timestamp: entryTimestamp,
          plan_type: '24h',
          start_hour: 0,
          end_hour: 24,
          crosses_midnight: false,
          tolerance_minutes: 15,
          overage_hourly_rate: 100
        }]
      });

      const res = await request(app)
        .post('/api/v1/access/validate')
        .send({ vehiclePlate: 'ABC123', type: 'exit' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.allowed).toBe(true);
      expect(res.body.data.accessType).toBe('subscription');
      expect(res.body.data.exit).toBeDefined();
      expect(res.body.data.exit.duration_minutes).toBeGreaterThanOrEqual(0);
    });

    it('should allow exit for hourly vehicle with active session', async () => {
      // findOpenEntry returns null (no subscription entry)
      mockQuery.mockResolvedValueOnce({ rows: [] });

      // findActiveSessionByPlate returns a session
      mockHourlyRateService.findActiveSessionByPlate.mockResolvedValueOnce({
        id: 'session-1',
        vehicle_plate: 'HOURLY1',
        plan_id: 'hourly-plan-1',
        entry_time: new Date(Date.now() - 7200000).toISOString() // 2 hours ago
      });

      // calculateAmount returns the cost
      mockHourlyRateService.calculateAmount.mockResolvedValueOnce({
        amount: 90,
        breakdown: [
          { hour: 1, rate: 50 },
          { hour: 2, rate: 40 }
        ],
        totalMinutes: 120,
        totalHours: 2,
        isFree: false
      });

      const res = await request(app)
        .post('/api/v1/access/validate')
        .send({ vehiclePlate: 'HOURLY1', type: 'exit' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.allowed).toBe(true);
      expect(res.body.data.accessType).toBe('hourly');
      expect(res.body.data.payment.amount).toBe(90);
      expect(res.body.data.payment.is_free).toBe(false);
      expect(res.body.data.payment_status).toBe('pending');
    });

    it('should allow free exit for hourly vehicle within tolerance', async () => {
      // findOpenEntry returns null
      mockQuery.mockResolvedValueOnce({ rows: [] });

      // findActiveSessionByPlate returns a session
      mockHourlyRateService.findActiveSessionByPlate.mockResolvedValueOnce({
        id: 'session-2',
        vehicle_plate: 'FREE1',
        plan_id: 'hourly-plan-1',
        entry_time: new Date(Date.now() - 120000).toISOString() // 2 minutes ago
      });

      // calculateAmount returns free
      mockHourlyRateService.calculateAmount.mockResolvedValueOnce({
        amount: 0,
        breakdown: [],
        totalMinutes: 2,
        totalHours: 0,
        isFree: true
      });

      const res = await request(app)
        .post('/api/v1/access/validate')
        .send({ vehiclePlate: 'FREE1', type: 'exit' });

      expect(res.status).toBe(200);
      expect(res.body.data.allowed).toBe(true);
      expect(res.body.data.payment.is_free).toBe(true);
      expect(res.body.data.payment_status).toBe('not_required');
      expect(res.body.data.barrier_allowed).toBe(true);
    });

    it('should deny exit when no entry found for vehicle', async () => {
      // findOpenEntry returns null
      mockQuery.mockResolvedValueOnce({ rows: [] });

      // findActiveSessionByPlate returns null
      mockHourlyRateService.findActiveSessionByPlate.mockResolvedValueOnce(null);

      const res = await request(app)
        .post('/api/v1/access/validate')
        .send({ vehiclePlate: 'GHOST1', type: 'exit' });

      expect(res.status).toBe(200);
      expect(res.body.data.allowed).toBe(false);
      expect(res.body.data.reason).toBe('NO_ENTRY_FOUND');
    });
  });

  // =============================================================
  // GET /api/v1/access/sessions/active
  // =============================================================
  describe('GET /api/v1/access/sessions/active', () => {
    it('should return active sessions', async () => {
      const mockSessions = [
        { id: 'session-1', vehicle_plate: 'ABC123', entry_time: '2026-03-20T08:00:00Z', status: 'active' },
        { id: 'session-2', vehicle_plate: 'DEF456', entry_time: '2026-03-20T09:00:00Z', status: 'active' }
      ];

      mockHourlyRateService.getActiveSessions.mockResolvedValueOnce(mockSessions);

      const res = await request(app)
        .get('/api/v1/access/sessions/active');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.count).toBe(2);
    });

    it('should return empty array when no active sessions', async () => {
      mockHourlyRateService.getActiveSessions.mockResolvedValueOnce([]);

      const res = await request(app)
        .get('/api/v1/access/sessions/active');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
      expect(res.body.count).toBe(0);
    });
  });

  // =============================================================
  // GET /api/v1/access/sessions/:plate
  // =============================================================
  describe('GET /api/v1/access/sessions/:plate', () => {
    it('should return session for a plate', async () => {
      const mockSession = {
        id: 'session-1',
        vehicle_plate: 'ABC123',
        entry_time: '2026-03-20T08:00:00Z',
        status: 'active'
      };

      mockHourlyRateService.findActiveSessionByPlate.mockResolvedValueOnce(mockSession);

      const res = await request(app)
        .get('/api/v1/access/sessions/ABC123');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.vehicle_plate).toBe('ABC123');
    });

    it('should return 404 when no session found for plate', async () => {
      mockHourlyRateService.findActiveSessionByPlate.mockResolvedValueOnce(null);

      const res = await request(app)
        .get('/api/v1/access/sessions/NOTFOUND');

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/No se encontr/);
    });
  });

  // =============================================================
  // GET /api/v1/access/history
  // =============================================================
  describe('GET /api/v1/access/history', () => {
    it('should return access history', async () => {
      const mockHistory = [
        { id: 'event-1', vehicle_plate: 'ABC123', type: 'entry', timestamp: '2026-03-20T08:00:00Z', customer_name: 'Juan Perez', plan_name: 'Plan 24h' },
        { id: 'event-2', vehicle_plate: 'ABC123', type: 'exit', timestamp: '2026-03-20T17:00:00Z', customer_name: 'Juan Perez', plan_name: 'Plan 24h' }
      ];

      mockQuery.mockResolvedValueOnce({ rows: mockHistory });

      const res = await request(app)
        .get('/api/v1/access/history');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.count).toBe(2);
    });

    it('should filter history by vehiclePlate', async () => {
      const mockHistory = [
        { id: 'event-1', vehicle_plate: 'XYZ789', type: 'entry', timestamp: '2026-03-20T08:00:00Z' }
      ];

      mockQuery.mockResolvedValueOnce({ rows: mockHistory });

      const res = await request(app)
        .get('/api/v1/access/history')
        .query({ vehiclePlate: 'XYZ789' });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      // Verify the query was called with plate filter
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('vehicle_plate'),
        expect.arrayContaining(['XYZ789'])
      );
    });

    it('should filter history by date range', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .get('/api/v1/access/history')
        .query({ startDate: '2026-03-01', endDate: '2026-03-20' });

      expect(res.status).toBe(200);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('timestamp >='),
        expect.arrayContaining(['2026-03-01', '2026-03-20'])
      );
    });

    it('should return empty array when no history', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .get('/api/v1/access/history');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
      expect(res.body.count).toBe(0);
    });
  });

  // =============================================================
  // POST /api/v1/access/entry - Register entry
  // =============================================================
  describe('POST /api/v1/access/entry', () => {
    it('should return 400 if vehiclePlate or validationResult is missing', async () => {
      const res = await request(app)
        .post('/api/v1/access/entry')
        .send({ vehiclePlate: 'ABC123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/vehiclePlate y validationResult son requeridos/);
    });

    it('should return 403 when validationResult.allowed is false', async () => {
      const res = await request(app)
        .post('/api/v1/access/entry')
        .send({
          vehiclePlate: 'ABC123',
          validationResult: { allowed: false, reason: 'FULL_CAPACITY' }
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/Acceso no permitido/);
    });

    it('should register subscription entry successfully', async () => {
      const mockEvent = { id: 'event-1', vehicle_plate: 'ABC123', type: 'entry' };

      // Mock the transaction to invoke its callback with a mock client
      mockTransaction.mockImplementationOnce(async (cb) => {
        const mockClient = { query: jest.fn().mockResolvedValue({ rows: [mockEvent] }) };
        return cb(mockClient);
      });

      const res = await request(app)
        .post('/api/v1/access/entry')
        .send({
          vehiclePlate: 'ABC123',
          validationResult: {
            allowed: true,
            accessType: 'subscription',
            subscription: { id: 'sub-1', customer_name: 'Juan Perez', plan_name: 'Plan 24h', vehicle_plate: 'ABC123' }
          }
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toMatch(/Entrada registrada/);
      expect(res.body.qrCode).toBeDefined();
    });

    it('should register hourly entry successfully', async () => {
      const mockSession = { id: 'session-1', vehicle_plate: 'HOUR1', entry_time: '2026-03-20T10:00:00Z' };

      mockTransaction.mockImplementationOnce(async (cb) => {
        const mockClient = { query: jest.fn() };
        // startParkingSession will be called inside registerEntry
        mockHourlyRateService.startParkingSession.mockResolvedValueOnce(mockSession);
        return cb(mockClient);
      });

      const res = await request(app)
        .post('/api/v1/access/entry')
        .send({
          vehiclePlate: 'HOUR1',
          validationResult: {
            allowed: true,
            accessType: 'hourly',
            plan: { id: 'hourly-plan-1', name: 'Plan Por Hora' }
          }
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toMatch(/Entrada registrada/);
    });
  });

  // =============================================================
  // POST /api/v1/access/exit - Register exit
  // =============================================================
  describe('POST /api/v1/access/exit', () => {
    it('should return 400 if vehiclePlate or validationResult is missing', async () => {
      const res = await request(app)
        .post('/api/v1/access/exit')
        .send({ vehiclePlate: 'ABC123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/vehiclePlate y validationResult son requeridos/);
    });

    it('should return 403 when exit is not allowed', async () => {
      const res = await request(app)
        .post('/api/v1/access/exit')
        .send({
          vehiclePlate: 'ABC123',
          validationResult: { allowed: false, reason: 'NO_ENTRY_FOUND' }
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/Salida no permitida/);
    });

    it('should register subscription exit successfully', async () => {
      const mockEvent = { id: 'event-2', vehicle_plate: 'ABC123', type: 'exit' };

      mockTransaction.mockImplementationOnce(async (cb) => {
        const mockClient = { query: jest.fn().mockResolvedValue({ rows: [mockEvent] }) };
        return cb(mockClient);
      });

      const res = await request(app)
        .post('/api/v1/access/exit')
        .send({
          vehiclePlate: 'ABC123',
          validationResult: {
            allowed: true,
            accessType: 'subscription',
            entry: { subscription_id: 'sub-1', vehicle_plate: 'ABC123', timestamp: '2026-03-20T08:00:00Z' },
            exit: { timestamp: new Date().toISOString(), duration_minutes: 120, additional_charges: 0, charge_reason: null }
          }
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toMatch(/Salida registrada/);
    });

    it('should register hourly exit successfully', async () => {
      const mockSessionResult = {
        session: { id: 'session-1', vehicle_plate: 'HOUR1', status: 'ended' },
        calculation: { amount: 90, totalMinutes: 120 }
      };

      mockTransaction.mockImplementationOnce(async (cb) => {
        const mockClient = { query: jest.fn() };
        mockHourlyRateService.endParkingSession.mockResolvedValueOnce(mockSessionResult);
        return cb(mockClient);
      });

      const res = await request(app)
        .post('/api/v1/access/exit')
        .send({
          vehiclePlate: 'HOUR1',
          validationResult: {
            allowed: true,
            accessType: 'hourly',
            session: { id: 'session-1', vehicle_plate: 'HOUR1', entry_time: '2026-03-20T08:00:00Z', exit_time: '2026-03-20T10:00:00Z' }
          }
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toMatch(/Salida registrada/);
    });
  });

  // =============================================================
  // POST /api/v1/access/sessions/:id/end
  // =============================================================
  describe('POST /api/v1/access/sessions/:id/end', () => {
    it('should end a parking session', async () => {
      mockHourlyRateService.endParkingSession.mockResolvedValueOnce({
        session: { id: 'session-1', status: 'ended' },
        calculation: { amount: 50 }
      });

      const res = await request(app)
        .post('/api/v1/access/sessions/session-1/end');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toMatch(/Sesi.*finalizada/);
    });
  });

  // =============================================================
  // POST /api/v1/access/sessions/:id/payment
  // =============================================================
  describe('POST /api/v1/access/sessions/:id/payment', () => {
    it('should record a session payment', async () => {
      mockHourlyRateService.recordSessionPayment.mockResolvedValueOnce({
        id: 'session-1',
        status: 'paid',
        payment_id: 'pay-1'
      });

      const res = await request(app)
        .post('/api/v1/access/sessions/session-1/payment')
        .send({ paymentId: 'pay-1', amount: 90, paymentMethod: 'cash' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toMatch(/Pago registrado/);
    });
  });

  // =============================================================
  // AccessControlService unit tests
  // =============================================================
  describe('AccessControlService', () => {
    describe('isWithinAllowedHours', () => {
      it('should return true when within normal hours', () => {
        // 10:00 is between 6:00 and 18:00
        const result = accessControlService.isWithinAllowedHours(10, 0, 6, 18, false, 0);
        expect(result).toBe(true);
      });

      it('should return false when outside normal hours', () => {
        // 20:00 is outside 6:00-18:00
        const result = accessControlService.isWithinAllowedHours(20, 0, 6, 18, false, 0);
        expect(result).toBe(false);
      });

      it('should handle midnight-crossing schedules', () => {
        // 22:00 is within 18:00-06:00 (crosses midnight)
        const result = accessControlService.isWithinAllowedHours(22, 0, 18, 6, true, 0);
        expect(result).toBe(true);
      });

      it('should handle midnight-crossing - early morning', () => {
        // 3:00 is within 18:00-06:00 (crosses midnight)
        const result = accessControlService.isWithinAllowedHours(3, 0, 18, 6, true, 0);
        expect(result).toBe(true);
      });

      it('should handle midnight-crossing - outside hours', () => {
        // 10:00 is outside 18:00-06:00 (crosses midnight)
        const result = accessControlService.isWithinAllowedHours(10, 0, 18, 6, true, 0);
        expect(result).toBe(false);
      });

      it('should apply tolerance correctly', () => {
        // 5:45 should be within 6:00-18:00 with 30 minutes tolerance
        const result = accessControlService.isWithinAllowedHours(5, 45, 6, 18, false, 30);
        expect(result).toBe(true);
      });

      it('should reject when outside tolerance', () => {
        // 5:00 should be outside 6:00-18:00 even with 15 min tolerance
        const result = accessControlService.isWithinAllowedHours(5, 0, 6, 18, false, 15);
        expect(result).toBe(false);
      });
    });

    describe('calculateOverageHours', () => {
      it('should return 0 when exit is within allowed time', () => {
        const exitTime = new Date('2026-03-20T17:00:00');
        const result = accessControlService.calculateOverageHours(exitTime, 18, 0);
        expect(result).toBe(0);
      });

      it('should calculate overage hours correctly', () => {
        // Exit at 20:00, allowed end is 18:00 + 0 tolerance
        const exitTime = new Date('2026-03-20T20:00:00');
        const result = accessControlService.calculateOverageHours(exitTime, 18, 0);
        expect(result).toBe(2);
      });

      it('should account for tolerance in overage calculation', () => {
        // Exit at 18:30, allowed end is 18:00 + 30 min tolerance = 18.5
        const exitTime = new Date('2026-03-20T18:30:00');
        const result = accessControlService.calculateOverageHours(exitTime, 18, 30);
        expect(result).toBe(0);
      });
    });

    describe('findActiveSubscription', () => {
      it('should return subscription when found', async () => {
        const mockSub = {
          subscription_id: 'sub-1',
          status: 'active',
          customer_name: 'Juan Perez',
          vehicle_plate: 'ABC123',
          plan_name: 'Plan 24h'
        };

        mockQuery.mockResolvedValueOnce({ rows: [mockSub] });

        const result = await accessControlService.findActiveSubscription('ABC123');
        expect(result).toEqual(mockSub);
        expect(mockQuery).toHaveBeenCalledWith(
          expect.stringContaining('subscriptions'),
          ['ABC123']
        );
      });

      it('should return null when no subscription found', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const result = await accessControlService.findActiveSubscription('NOSUB');
        expect(result).toBeNull();
      });
    });

    describe('getAvailableHourlyPlan', () => {
      it('should return hourly plan when available', async () => {
        const mockPlan = { id: 'plan-1', type: 'hourly', is_active: true, current_occupancy: 5, max_capacity: 50 };
        mockQuery.mockResolvedValueOnce({ rows: [mockPlan] });

        const result = await accessControlService.getAvailableHourlyPlan();
        expect(result).toEqual(mockPlan);
      });

      it('should return null when no hourly plan available', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const result = await accessControlService.getAvailableHourlyPlan();
        expect(result).toBeNull();
      });
    });

    describe('getTodayEntries', () => {
      it('should return count of today entries', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ count: '5' }] });

        const result = await accessControlService.getTodayEntries('sub-1');
        expect(result).toBe(5);
      });
    });

    describe('findOpenEntry', () => {
      it('should return open entry event', async () => {
        const mockEntry = { id: 'event-1', vehicle_plate: 'ABC123', type: 'entry', plan_type: '24h' };
        mockQuery.mockResolvedValueOnce({ rows: [mockEntry] });

        const result = await accessControlService.findOpenEntry('ABC123');
        expect(result).toEqual(mockEntry);
      });

      it('should return null when no open entry', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const result = await accessControlService.findOpenEntry('NOPE');
        expect(result).toBeNull();
      });
    });

    describe('getAccessHistory', () => {
      it('should return all history without filters', async () => {
        const mockRows = [{ id: 'event-1' }, { id: 'event-2' }];
        mockQuery.mockResolvedValueOnce({ rows: mockRows });

        const result = await accessControlService.getAccessHistory();
        expect(result).toHaveLength(2);
        expect(mockQuery).toHaveBeenCalledWith(
          expect.stringContaining('ORDER BY ae.timestamp DESC'),
          []
        );
      });

      it('should apply all filters when provided', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });

        await accessControlService.getAccessHistory({
          vehiclePlate: 'ABC123',
          startDate: '2026-01-01',
          endDate: '2026-12-31'
        });

        expect(mockQuery).toHaveBeenCalledWith(
          expect.stringContaining('vehicle_plate'),
          ['ABC123', '2026-01-01', '2026-12-31']
        );
      });
    });

    describe('validateEntry', () => {
      it('should uppercase and trim the plate', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] }); // findActiveSubscription
        mockQuery.mockResolvedValueOnce({ rows: [] }); // getAvailableHourlyPlan

        await accessControlService.validateEntry('  abc123  ');

        expect(mockQuery).toHaveBeenCalledWith(
          expect.any(String),
          ['ABC123']
        );
      });
    });

    describe('validateExit', () => {
      it('should uppercase and trim the plate', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] }); // findOpenEntry
        mockHourlyRateService.findActiveSessionByPlate.mockResolvedValueOnce(null);

        const result = await accessControlService.validateExit('  xyz789  ');

        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('NO_ENTRY_FOUND');
        expect(result.plate).toBe('XYZ789');
      });
    });

    describe('validateSubscriptionEntry', () => {
      it('should deny entry outside allowed hours for non-24h plan', async () => {
        const subscription = {
          subscription_id: 'sub-1',
          status: 'active',
          next_billing_date: '2027-12-31',
          plan_type: 'diurno',
          start_hour: 6,
          end_hour: 18,
          crosses_midnight: false,
          tolerance_minutes: 0,
          current_occupancy: 5,
          max_capacity: 50,
          daily_entry_limit: 3
        };

        // timestamp at 22:00 - outside 6:00-18:00
        const timestamp = new Date('2026-03-20T22:00:00');

        const result = await accessControlService.validateSubscriptionEntry(subscription, timestamp);
        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('OUTSIDE_HOURS');
      });
    });

    describe('validateSubscriptionExit', () => {
      it('should calculate additional charges for exit outside hours', async () => {
        const entryEvent = {
          subscription_id: 'sub-1',
          timestamp: new Date('2026-03-20T08:00:00').toISOString(),
          plan_type: 'diurno',
          start_hour: 6,
          end_hour: 18,
          crosses_midnight: false,
          tolerance_minutes: 0,
          overage_hourly_rate: '100'
        };

        // Exit at 20:00 - 2 hours after allowed end
        const exitTimestamp = new Date('2026-03-20T20:00:00');

        const result = await accessControlService.validateSubscriptionExit(entryEvent, exitTimestamp);
        expect(result.allowed).toBe(true);
        expect(result.exit.additional_charges).toBe(200); // 2 hours * 100
        expect(result.exit.charge_reason).toMatch(/fuera de horario/);
      });

      it('should have no additional charges for exit within hours', async () => {
        const entryEvent = {
          subscription_id: 'sub-1',
          timestamp: new Date('2026-03-20T08:00:00').toISOString(),
          plan_type: '24h',
          start_hour: 0,
          end_hour: 24,
          crosses_midnight: false,
          tolerance_minutes: 0,
          overage_hourly_rate: '100'
        };

        const exitTimestamp = new Date('2026-03-20T17:00:00');

        const result = await accessControlService.validateSubscriptionExit(entryEvent, exitTimestamp);
        expect(result.allowed).toBe(true);
        expect(result.exit.additional_charges).toBe(0);
        expect(result.exit.charge_reason).toBeNull();
      });
    });
  });
});
