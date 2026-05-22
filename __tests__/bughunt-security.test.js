/**
 * Bug-hunt regression suite — security (authorization + error disclosure).
 * Assertions encode CORRECT (secure) behavior after the fixes. No database.
 */
const mockQuery = jest.fn();
jest.mock('../src/config/database', () => ({
  query: mockQuery, transaction: jest.fn(),
  supabase: {}, pool: { end: jest.fn() }, testConnection: jest.fn()
}));
// Stand in for auth: authenticate sets req.user from a header; authorize is the
// REAL contract (deny unless role is in the allow-list). This verifies the route
// actually applies an authorize guard with the right roles.
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, res, next) => { req.user = { id: 'u1', role: req.headers['x-role'] || 'customer' }; next(); },
  authorize: (roles) => (req, res, next) => {
    const allow = Array.isArray(roles) ? roles : [roles];
    if (!req.user || !allow.includes(req.user.role)) return res.status(403).json({ error: 'Acceso denegado' });
    next();
  }
}));

const request = require('supertest');
const express = require('express');
const settingRoutes = require('../src/routes/setting.routes');
const errorHandler = require('../src/middleware/errorHandler');
const { AppError } = errorHandler;

function settingsApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/settings', settingRoutes);
  app.use(errorHandler);
  return app;
}
afterEach(() => jest.clearAllMocks());

describe('[SEC BUG 2][HIGH fixed] GET /settings/:key is role-gated (not just authenticated)', () => {
  it('denies a customer role (403)', async () => {
    const res = await request(settingsApp()).get('/api/v1/settings/tax_rate').set('x-role', 'customer');
    expect(res.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled(); // never reaches the DB read
  });
  it('allows an operator role', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ key: 'tax_rate', value: '0.18' }] });
    const res = await request(settingsApp()).get('/api/v1/settings/tax_rate').set('x-role', 'operator');
    expect(res.status).toBe(200);
    expect(res.body.data.key).toBe('tax_rate');
  });
});

describe('[SEC BUG 1][HIGH fixed] error handler does not leak internal messages', () => {
  const OLD = process.env.NODE_ENV;
  beforeAll(() => { process.env.NODE_ENV = 'production'; });
  afterAll(() => { process.env.NODE_ENV = OLD; });

  function run(err) {
    const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    errorHandler(err, { originalUrl: '/x', method: 'GET', body: {} }, res, () => {});
    return res;
  }

  it('returns generic message for a raw non-operational 500', () => {
    const res = run(new Error('relation "users" violates constraint pk_users at /srv/app'));
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Error interno del servidor');
    expect(res.body.error).not.toMatch(/users|constraint|srv/);
  });

  it('still returns safe operational AppError messages (e.g. validation 400)', () => {
    const res = run(new AppError('El campo value es requerido', 400, 'MISSING_REQUIRED_FIELD'));
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('El campo value es requerido');
  });
});
