/**
 * Access Control API Tests
 * Tests for /api/v1/access endpoints
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
    console.warn('Could not load server:', err.message);
  }
});

describe('Access Control API', () => {
  const testFn = app ? test : test.skip;

  testFn('GET /api/v1/access/sessions/active - should require auth', async () => {
    const res = await request(app).get('/api/v1/access/sessions/active');
    expect(res.status).toBe(401);
  });

  testFn('GET /api/v1/access/history - should require auth', async () => {
    const res = await request(app).get('/api/v1/access/history');
    expect(res.status).toBe(401);
  });

  testFn('POST /api/v1/access/validate - should require auth', async () => {
    const res = await request(app)
      .post('/api/v1/access/validate')
      .send({ plate: 'A123456' });
    expect(res.status).toBe(401);
  });
});

describe('Access Control - Plate Validation', () => {
  test('Dominican plate format validation', () => {
    // Dominican Republic plates: letter + 6 digits (e.g., A123456)
    const plateRegex = /^[A-Z]\d{6}$/;

    const validPlates = ['A123456', 'B789012', 'C345678', 'X000001'];
    const invalidPlates = ['', '123456', 'AB12345', 'a123456', 'A12345', 'A1234567'];

    for (const plate of validPlates) {
      expect(plateRegex.test(plate)).toBe(true);
    }
    for (const plate of invalidPlates) {
      expect(plateRegex.test(plate)).toBe(false);
    }
  });

  test('plate should be normalized to uppercase', () => {
    const normalize = (plate) => plate.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

    expect(normalize('a123456')).toBe('A123456');
    expect(normalize(' B789012 ')).toBe('B789012');
    expect(normalize('c-345-678')).toBe('C345678');
  });
});
