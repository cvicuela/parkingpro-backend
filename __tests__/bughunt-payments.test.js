/**
 * Bug-hunt regression suite — payments + fiscal.
 * Assertions now encode CORRECT behavior: a green run means the fix holds.
 * Deferred items (need DB-side work) are marked it.skip with a TODO.
 * No database required (config/database is mocked).
 */
const mockQuery = jest.fn();
const mockTransaction = jest.fn((cb) => cb({ query: mockQuery }));
const mockRpc = jest.fn().mockResolvedValue({ data: { success: true }, error: null });

jest.mock('../src/config/database', () => ({
  query: mockQuery, transaction: mockTransaction,
  supabase: { rpc: mockRpc }, pool: { end: jest.fn() }, testConnection: jest.fn()
}));
jest.mock('../src/middleware/audit', () => ({
  logAudit: jest.fn(), auditMiddleware: () => (req, res, next) => next()
}));

const request = require('supertest');
const express = require('express');
const crypto = require('crypto');
const PaymentService = require('../src/services/payment.service');
const invoiceService = require('../src/services/invoice.service');
const webhookRoutes = require('../src/routes/webhook.routes');
const errorHandler = require('../src/middleware/errorHandler');

function lastPaymentInsert() {
  const call = mockQuery.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('INSERT INTO payments'));
  if (!call) return null;
  const p = call[1];
  return { baseAmount: p[2], taxAmount: p[3], totalAmount: p[4] };
}
function webhookApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/webhooks', webhookRoutes);
  app.use(errorHandler);
  return app;
}
afterEach(() => jest.clearAllMocks());

describe('[BUG 1][CRITICAL fixed] processPayment defaults to tax-inclusive', () => {
  it('charges 118 (not 139.24) for a 118.00 DOP tax-inclusive price when flag omitted', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'pay-1', status: 'paid' }] });
    await PaymentService.processPayment({ amount: 118, provider: 'cash', customerId: 'c1' });
    const ins = lastPaymentInsert();
    expect(ins.totalAmount).toBe(118);
    expect(ins.baseAmount).toBeCloseTo(100.0, 2);
    expect(ins.taxAmount).toBeCloseTo(18.0, 2);
  });
  it('still correct when priceIncludesTax=true is explicit', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'pay-2', status: 'paid' }] });
    await PaymentService.processPayment({ amount: 118, provider: 'cash', priceIncludesTax: true, customerId: 'c1' });
    const ins = lastPaymentInsert();
    expect(ins.totalAmount).toBe(118);
    expect(ins.baseAmount).toBeCloseTo(100.0, 2);
    expect(ins.taxAmount).toBeCloseTo(18.0, 2);
  });
  it('tax-exclusive path still works when explicitly requested', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'pay-2b', status: 'paid' }] });
    await PaymentService.processPayment({ amount: 100, provider: 'cash', priceIncludesTax: false, customerId: 'c1' });
    const ins = lastPaymentInsert();
    expect(ins.baseAmount).toBe(100);
    expect(ins.taxAmount).toBeCloseTo(18.0, 2);
    expect(ins.totalAmount).toBe(118);
  });
});

describe('[BUG 2][MEDIUM fixed] tax-exclusive total is re-rounded to cents', () => {
  it('stores 118.12 (not 118.11999999999999) for amount=100.10', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'pay-3', status: 'paid' }] });
    await PaymentService.processPayment({ amount: 100.1, provider: 'cash', priceIncludesTax: false, customerId: 'c1' });
    const ins = lastPaymentInsert();
    expect(ins.totalAmount).toBe(118.12);
  });
});

describe('[BUG 3][HIGH fixed] invoice/NCF failure is surfaced, not silently swallowed', () => {
  it('keeps payment paid but flags invoice_pending + invoice_error', async () => {
    // INSERT payments, then the invoice_pending UPDATE in the catch block.
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'pay-4', status: 'paid' }] })
      .mockResolvedValueOnce({ rows: [] });
    const spy = jest.spyOn(invoiceService, 'generateFromPayment')
      .mockRejectedValueOnce(new Error('NCF sequence exhausted for type 02'));
    const result = await PaymentService.processPayment({
      amount: 118, provider: 'cash', priceIncludesTax: true, customerId: 'c1', subscriptionId: 's1'
    });
    expect(result.status).toBe('paid');           // payment is not cancelled
    expect(result.invoice_pending).toBe(true);     // but the fiscal gap is signalled
    expect(result.invoice_error).toMatch(/NCF sequence exhausted/);
    // the durable flag write happened
    const flagWrite = mockQuery.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes("'{invoice_pending}'"));
    expect(flagWrite).toBeDefined();
    spy.mockRestore();
  });
});

describe.skip('[BUG 4][HIGH deferred] refund daily cap relies on metadata.refunded_by never written — needs DB-side fix on branch', () => {
  it('TODO: enforce operator daily refund cap inside refund_payment RPC (records refunded_by, accepts operator role)', () => {});
});

describe('[BUG 5][HIGH fixed] CardNet webhook returns 401 (not 500) on bad-length signature', () => {
  const OLD = process.env.CARDNET_API_KEY;
  beforeAll(() => { process.env.CARDNET_API_KEY = 'whk_secret_key'; });
  afterAll(() => { if (OLD === undefined) delete process.env.CARDNET_API_KEY; else process.env.CARDNET_API_KEY = OLD; });
  it('401 for short/garbage signature (no crash)', async () => {
    const res = await request(webhookApp()).post('/api/v1/webhooks/cardnet')
      .send({ transactionId: 'TXN1', status: 'paid', amount: 100, merchantId: 'M1', signature: 'deadbeef' });
    expect(res.status).toBe(401);
  });
  it('401 for wrong-but-right-length signature', async () => {
    const res = await request(webhookApp()).post('/api/v1/webhooks/cardnet')
      .send({ transactionId: 'TXN1', status: 'paid', amount: 100, merchantId: 'M1', signature: 'a'.repeat(64) });
    expect(res.status).toBe(401);
  });
});

describe('[BUG 6][HIGH fixed] CardNet webhook rejects amount mismatch', () => {
  const OLD = process.env.CARDNET_API_KEY;
  beforeAll(() => { process.env.CARDNET_API_KEY = 'whk_secret_key'; });
  afterAll(() => { if (OLD === undefined) delete process.env.CARDNET_API_KEY; else process.env.CARDNET_API_KEY = OLD; });
  it('signed webhook with wrong amount is rejected (400) and not marked paid', async () => {
    const transactionId = 'TXN-AMT', status = 'approved', amount = 1, merchantId = 'M1';
    const payload = transactionId + '|' + status + '|' + amount + '|' + merchantId;
    const signature = crypto.createHmac('sha256', 'whk_secret_key').update(payload).digest('hex');
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'pay-amt', status: 'pending', metadata: {}, total_amount: '5000' }] });
    const res = await request(webhookApp()).post('/api/v1/webhooks/cardnet')
      .send({ transactionId, status, responseCode: '00', amount, merchantId, signature });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mismatch/i);
    const upd = mockQuery.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('UPDATE payments SET status'));
    expect(upd).toBeUndefined(); // never settled
  });
  it('signed webhook with matching amount settles the payment', async () => {
    const transactionId = 'TXN-OK', status = 'approved', amount = 5000, merchantId = 'M1';
    const payload = transactionId + '|' + status + '|' + amount + '|' + merchantId;
    const signature = crypto.createHmac('sha256', 'whk_secret_key').update(payload).digest('hex');
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'pay-ok', status: 'pending', metadata: {}, total_amount: '5000' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(webhookApp()).post('/api/v1/webhooks/cardnet')
      .send({ transactionId, status, responseCode: '00', amount, merchantId, signature });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, matched: true });
    const upd = mockQuery.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('UPDATE payments SET status'));
    expect(upd).toBeDefined();
    expect(upd[1][0]).toBe('paid');
  });
});

describe.skip('[BUG 7][MEDIUM deferred] Stripe/Twilio webhooks are stubs — reconciliation is a follow-up', () => {
  it('TODO: verify Stripe signature and reconcile payment_intent.succeeded -> paid + invoice', () => {});
});
