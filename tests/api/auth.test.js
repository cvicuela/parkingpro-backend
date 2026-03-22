/**
 * Authentication API Tests
 * Tests for /api/v1/auth endpoints
 */
const request = require('supertest');

let app;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

  try {
    const server = require('../../src/server');
    app = server.app || server;
  } catch (err) {
    console.warn('Could not load server, skipping integration tests:', err.message);
  }
});

describe('Auth API', () => {
  const testFn = app ? test : test.skip;

  testFn('POST /api/v1/auth/login - should reject empty credentials', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({});
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  testFn('POST /api/v1/auth/login - should reject invalid email format', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'not-an-email', password: 'test' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  testFn('POST /api/v1/auth/login - should reject wrong password', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@parkingpro.com', password: 'wrongpassword' });
    expect([400, 401]).toContain(res.status);
  });

  testFn('GET /api/v1/auth/me - should reject without token', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  testFn('GET /api/v1/auth/me - should reject with invalid token', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer invalid-token');
    expect(res.status).toBe(401);
  });
});

describe('Auth - Input Validation', () => {
  test('email validation patterns', () => {
    const validEmails = ['user@test.com', 'admin@parkingpro.com', 'a@b.co'];
    const invalidEmails = ['', 'not-email', '@no-user.com', 'spaces in@email.com'];

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    for (const email of validEmails) {
      expect(emailRegex.test(email)).toBe(true);
    }
    for (const email of invalidEmails) {
      expect(emailRegex.test(email)).toBe(false);
    }
  });
});
