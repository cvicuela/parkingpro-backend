const mockQuery = jest.fn();
jest.mock('../src/config/database', () => ({
  query: mockQuery,
  transaction: jest.fn(),
  supabase: {},
  pool: { end: jest.fn() },
  testConnection: jest.fn()
}));

const HourlyRateService = require('../src/services/hourlyRate.service');

describe('HourlyRateService', () => {
  afterEach(() => jest.clearAllMocks());

  const planId = 'plan-123';
  const rates = [
    { hour_number: 1, rate: 50, is_active: true, description: 'Primera hora' },
    { hour_number: 2, rate: 70, is_active: true, description: 'Segunda hora' },
    { hour_number: 3, rate: 100, is_active: true, description: 'Tercera hora+' }
  ];

  function setupCalcMocks() {
    mockQuery
      .mockResolvedValueOnce({ rows: rates })       // getHourlyRates
      .mockResolvedValueOnce({ rows: [{ tolerance_minutes: 5 }] }); // tolerance
  }

  describe('calculateAmount', () => {
    it('should return free for time within tolerance (4 min)', async () => {
      setupCalcMocks();
      const result = await HourlyRateService.calculateAmount(
        planId, new Date('2024-01-15T10:00:00Z'), new Date('2024-01-15T10:04:00Z')
      );
      expect(result.isFree).toBe(true);
      expect(result.amount).toBe(0);
    });

    it('should calculate 1 hour (45 min - 5 tol = 40 min -> 1h)', async () => {
      setupCalcMocks();
      const result = await HourlyRateService.calculateAmount(
        planId, new Date('2024-01-15T10:00:00Z'), new Date('2024-01-15T10:45:00Z')
      );
      expect(result.amount).toBe(50);
      expect(result.totalHours).toBe(1);
    });

    it('should calculate 2 hours (120 min - 5 tol = 115 min -> 2h)', async () => {
      setupCalcMocks();
      const result = await HourlyRateService.calculateAmount(
        planId, new Date('2024-01-15T10:00:00Z'), new Date('2024-01-15T12:00:00Z')
      );
      expect(result.amount).toBe(120);
      expect(result.totalHours).toBe(2);
    });

    it('should calculate 4 hours (210 min - 5 tol = 205 min -> 4h)', async () => {
      setupCalcMocks();
      const result = await HourlyRateService.calculateAmount(
        planId, new Date('2024-01-15T10:00:00Z'), new Date('2024-01-15T13:30:00Z')
      );
      expect(result.amount).toBe(320); // 50+70+100+100
      expect(result.totalHours).toBe(4);
      expect(result.breakdown).toHaveLength(4);
    });

    it('should round up partial hours (66 min - 5 tol = 61 min -> 2h)', async () => {
      setupCalcMocks();
      const result = await HourlyRateService.calculateAmount(
        planId, new Date('2024-01-15T10:00:00Z'), new Date('2024-01-15T11:06:00Z')
      );
      expect(result.amount).toBe(120);
      expect(result.totalHours).toBe(2);
    });
  });

  describe('getHourlyRates', () => {
    it('should return rates for a plan', async () => {
      mockQuery.mockResolvedValueOnce({ rows: rates });
      const result = await HourlyRateService.getHourlyRates(planId);
      expect(result).toHaveLength(3);
      expect(result[0].rate).toBe(50);
    });
  });
});
