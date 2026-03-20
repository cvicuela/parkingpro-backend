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

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret';
process.env.JWT_EXPIRES_IN = '1h';

const authRoutes = require('../src/routes/auth.routes');
const errorHandler = require('../src/middleware/errorHandler');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', authRoutes);
  app.use(errorHandler);
  return app;
}

describe('Auth Routes', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/auth/register', () => {
    it('should register a new user', async () => {
      const userId = '123e4567-e89b-12d3-a456-426614174000';
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: userId, email: 'test@test.com', phone: '+18095551234', role: 'customer' }]
      }).mockResolvedValueOnce({ rows: [] }); // session insert

      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email: 'test@test.com', phone: '+18095551234', password: 'Pass123!' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.token).toBeDefined();
      expect(res.body.data.user.email).toBe('test@test.com');
    });

    it('should return 400 if missing fields', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email: 'test@test.com' });

      expect(res.status).toBe(400);
    });

    it('should return 409 for duplicate email', async () => {
      mockQuery.mockRejectedValueOnce({ code: '23505', detail: 'Key (email)' });

      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email: 'dup@test.com', phone: '+18095551234', password: 'Pass123!' });

      expect(res.status).toBe(409);
    });
  });

  describe('POST /api/v1/auth/login', () => {
    it('should login with valid credentials', async () => {
      const hash = await bcrypt.hash('Pass123!', 10);
      const userId = '123e4567-e89b-12d3-a456-426614174000';

      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: userId, email: 'test@test.com', phone: '+18095551234', role: 'operator', password_hash: hash, status: 'active', verified: true }] })
        .mockResolvedValueOnce({ rows: [] }) // session insert
        .mockResolvedValueOnce({ rows: [] }); // update last_login

      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'test@test.com', password: 'Pass123!' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.token).toBeDefined();
    });

    it('should return 401 for invalid credentials', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'bad@test.com', password: 'wrongpassword123' });

      expect(res.status).toBe(401);
    });

    it('should return 400 if missing fields', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({});

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v1/auth/me', () => {
    it('should return 401 without token', async () => {
      const res = await request(app).get('/api/v1/auth/me');
      expect(res.status).toBe(401);
    });

    it('should return user with valid token', async () => {
      const userId = '123e4567-e89b-12d3-a456-426614174000';
      const token = jwt.sign({ userId }, process.env.JWT_SECRET);

      // authenticate middleware: session lookup
      mockQuery.mockResolvedValueOnce({ rows: [{ token: token }] });
      // authenticate middleware: user lookup
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: userId, email: 'test@test.com', role: 'operator', status: 'active' }]
      });
      // /me route: user + customer join
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: userId, email: 'test@test.com', role: 'operator', first_name: 'Test', last_name: 'User' }]
      });

      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.email).toBe('test@test.com');
    });
  });
});
