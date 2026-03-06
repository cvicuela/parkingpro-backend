const mockQuery = jest.fn();
const mockTransaction = jest.fn((cb) => cb({ query: mockQuery }));
jest.mock('../src/config/database', () => ({
  query: mockQuery,
  transaction: mockTransaction,
  supabase: {},
  pool: { end: jest.fn() },
  testConnection: jest.fn()
}));

const PaymentService = require('../src/services/payment.service');

describe('PaymentService', () => {
  afterEach(() => jest.clearAllMocks());

  describe('processPayment', () => {
    it('should process cash payment', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'pay-1', amount: 100, total_amount: 118, status: 'paid' }]
      });

      const result = await PaymentService.processPayment({
        amount: 100,
        taxRate: 0.18,
        provider: 'cash',
        customerId: 'cust-1'
      });

      expect(result.status).toBe('paid');
      expect(mockTransaction).toHaveBeenCalled();
    });

    it('should throw for unsupported provider', async () => {
      await expect(
        PaymentService.processPayment({ amount: 100, provider: 'bitcoin' })
      ).rejects.toThrow('Proveedor de pago no soportado');
    });
  });

  describe('processCashPayment', () => {
    it('should return paid status', async () => {
      const result = await PaymentService.processCashPayment({ amount: 50 });
      expect(result.status).toBe('paid');
      expect(result.transaction_id).toMatch(/^CASH-/);
    });
  });

  describe('processCardNetPayment', () => {
    it('should simulate when not configured', async () => {
      delete process.env.CARDNET_API_URL;
      delete process.env.CARDNET_API_KEY;

      const result = await PaymentService.processCardNetPayment({ amount: 100 });
      expect(result.status).toBe('paid');
      expect(result.simulated).toBe(true);
    });
  });

  describe('refundPayment', () => {
    it('should refund a paid payment', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'pay-1', status: 'paid' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'pay-1', status: 'refunded' }] });

      const result = await PaymentService.refundPayment('pay-1');
      expect(result.status).toBe('refunded');
    });

    it('should throw for non-paid payment', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'pay-1', status: 'pending' }] });

      await expect(PaymentService.refundPayment('pay-1')).rejects.toThrow('Solo se pueden reembolsar pagos completados');
    });

    it('should throw for non-existent payment', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await expect(PaymentService.refundPayment('nope')).rejects.toThrow('Pago no encontrado');
    });
  });
});
