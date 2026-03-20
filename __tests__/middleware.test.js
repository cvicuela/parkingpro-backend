const jwt = require('jsonwebtoken');

const mockQuery = jest.fn();
jest.mock('../src/config/database', () => ({
  query: mockQuery,
}));

const { authenticate, authorize } = require('../src/middleware/auth');
const errorHandler = require('../src/middleware/errorHandler');
const { AppError, notFound } = require('../src/middleware/errorHandler');
const sanitizer = require('../src/middleware/sanitizer');

// ─── Helpers ────────────────────────────────────────────────────────────────

const mockReq = (overrides = {}) => ({
  headers: {},
  body: {},
  query: {},
  params: {},
  originalUrl: '/test',
  method: 'GET',
  ...overrides,
});

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const mockNext = jest.fn();

// ─── Auth Middleware ────────────────────────────────────────────────────────

describe('Auth Middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret';
  });

  describe('authenticate', () => {
    it('returns 401 when no token is provided', async () => {
      const req = mockReq();
      const res = mockRes();

      await authenticate(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Token no proporcionado' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('returns 401 when token is invalid', async () => {
      const req = mockReq({
        headers: { authorization: 'Bearer invalid-token' },
      });
      const res = mockRes();

      await authenticate(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Token inválido' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('returns 401 when token is expired', async () => {
      const expiredToken = jwt.sign({ userId: 1 }, 'test-secret', { expiresIn: '-1s' });
      const req = mockReq({
        headers: { authorization: `Bearer ${expiredToken}` },
      });
      const res = mockRes();

      await authenticate(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Token inválido' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('returns 401 when session is not found in database', async () => {
      const token = jwt.sign({ userId: 1 }, 'test-secret');
      const req = mockReq({
        headers: { authorization: `Bearer ${token}` },
      });
      const res = mockRes();

      mockQuery.mockResolvedValueOnce({ rows: [] }); // session query returns empty

      await authenticate(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Sesión expirada o inválida' });
    });

    it('returns 401 when user is not found or inactive', async () => {
      const token = jwt.sign({ userId: 1 }, 'test-secret');
      const req = mockReq({
        headers: { authorization: `Bearer ${token}` },
      });
      const res = mockRes();

      mockQuery
        .mockResolvedValueOnce({ rows: [{ token }] }) // session exists
        .mockResolvedValueOnce({ rows: [] }); // user not found

      await authenticate(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Usuario no encontrado' });
    });

    it('sets req.user and calls next on valid token', async () => {
      const token = jwt.sign({ userId: 42 }, 'test-secret');
      const fakeUser = { id: 42, name: 'Test User', role: 'admin', status: 'active' };
      const req = mockReq({
        headers: { authorization: `Bearer ${token}` },
      });
      const res = mockRes();
      const next = jest.fn();

      mockQuery
        .mockResolvedValueOnce({ rows: [{ token }] }) // session valid
        .mockResolvedValueOnce({ rows: [fakeUser] }); // user found

      await authenticate(req, res, next);

      expect(req.user).toEqual(fakeUser);
      expect(req.token).toBe(token);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('authorize', () => {
    it('calls next when user has the correct role', () => {
      const req = mockReq({ user: { role: 'admin' } });
      const res = mockRes();
      const next = jest.fn();

      const middleware = authorize(['admin', 'manager']);
      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('returns 403 when user does not have the required role', () => {
      const req = mockReq({ user: { role: 'viewer' } });
      const res = mockRes();
      const next = jest.fn();

      const middleware = authorize(['admin', 'manager']);
      middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Acceso denegado' });
      expect(next).not.toHaveBeenCalled();
    });
  });
});

// ─── Error Handler ──────────────────────────────────────────────────────────

describe('Error Handler', () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'production';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('returns 500 for a generic error', () => {
    const err = new Error('Something broke');
    const req = mockReq();
    const res = mockRes();

    errorHandler(err, req, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Something broke',
        code: 'INTERNAL_ERROR',
      })
    );
  });

  it('returns the custom status code from AppError', () => {
    const err = new AppError('Bad request', 422, 'CUSTOM_CODE');
    const req = mockReq();
    const res = mockRes();

    errorHandler(err, req, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Bad request',
        code: 'CUSTOM_CODE',
      })
    );
  });

  it('returns 409 for PostgreSQL duplicate key error (23505)', () => {
    const err = { code: '23505', message: 'duplicate key', detail: 'Key (email)=(a@b.com) already exists' };
    const req = mockReq();
    const res = mockRes();

    errorHandler(err, req, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'DUPLICATE_ENTRY' })
    );
  });

  it('returns 400 for PostgreSQL foreign key error (23503)', () => {
    const err = { code: '23503', message: 'foreign key violation' };
    const req = mockReq();
    const res = mockRes();

    errorHandler(err, req, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INVALID_REFERENCE' })
    );
  });

  it('returns 401 for JsonWebTokenError', () => {
    const err = new Error('jwt malformed');
    err.name = 'JsonWebTokenError';
    const req = mockReq();
    const res = mockRes();

    errorHandler(err, req, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INVALID_TOKEN' })
    );
  });

  it('returns 401 for TokenExpiredError', () => {
    const err = new Error('jwt expired');
    err.name = 'TokenExpiredError';
    const req = mockReq();
    const res = mockRes();

    errorHandler(err, req, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'TOKEN_EXPIRED' })
    );
  });

  describe('notFound', () => {
    it('calls next with a 404 AppError', () => {
      const req = mockReq({ originalUrl: '/api/missing' });
      const res = mockRes();
      const next = jest.fn();

      notFound(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      const passedError = next.mock.calls[0][0];
      expect(passedError.statusCode).toBe(404);
      expect(passedError.code).toBe('NOT_FOUND');
      expect(passedError.message).toContain('/api/missing');
    });
  });
});

// ─── Sanitizer ──────────────────────────────────────────────────────────────

describe('Sanitizer Middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('strips HTML/XSS tags from body fields', () => {
    const req = mockReq({
      body: {
        name: '<script>alert("xss")</script>John',
        comment: '<img onerror="hack()">Nice',
      },
    });
    const res = mockRes();
    const next = jest.fn();

    sanitizer(req, res, next);

    expect(req.body.name).toBe('alert("xss")John');
    expect(req.body.comment).toBe('Nice');
    expect(next).toHaveBeenCalled();
  });

  it('handles nested objects', () => {
    const req = mockReq({
      body: {
        user: {
          name: '<b>Bold</b>',
          address: {
            city: '<em>Lima</em>',
          },
        },
      },
    });
    const res = mockRes();
    const next = jest.fn();

    sanitizer(req, res, next);

    expect(req.body.user.name).toBe('Bold');
    expect(req.body.user.address.city).toBe('Lima');
    expect(next).toHaveBeenCalled();
  });

  it('leaves clean strings unchanged', () => {
    const req = mockReq({
      body: { name: 'John Doe', age: 30, active: true },
    });
    const res = mockRes();
    const next = jest.fn();

    sanitizer(req, res, next);

    expect(req.body.name).toBe('John Doe');
    expect(req.body.age).toBe(30);
    expect(req.body.active).toBe(true);
    expect(next).toHaveBeenCalled();
  });

  it('removes keys starting with $ to prevent NoSQL injection', () => {
    const req = mockReq({
      body: { $gt: 100, name: 'valid' },
    });
    const res = mockRes();
    const next = jest.fn();

    sanitizer(req, res, next);

    expect(req.body.$gt).toBeUndefined();
    expect(req.body.name).toBe('valid');
  });

  it('sanitizes query and params as well', () => {
    const req = mockReq({
      query: { search: '<script>x</script>safe' },
      params: { id: '<b>123</b>' },
    });
    const res = mockRes();
    const next = jest.fn();

    sanitizer(req, res, next);

    expect(req.query.search).toBe('xsafe');
    expect(req.params.id).toBe('123');
  });
});
