/**
 * Bug-hunt regression suite — access control (timezone, expiry, overage).
 * Assertions encode CORRECT behavior after the fixes. No database required.
 */
const mockQuery = jest.fn();
jest.mock('../src/config/database', () => ({
  query: mockQuery,
  transaction: jest.fn((cb) => cb({ query: mockQuery })),
  supabase: {}, pool: { end: jest.fn() }, testConnection: jest.fn()
}));
jest.mock('../src/services/rfid.service', () => ({ resolveCardForAccess: jest.fn(), activateCard: jest.fn() }));
jest.mock('../src/services/push.service', () => ({ sendToRole: jest.fn() }));

const accessService = require('../src/services/accessControl.service');

const drFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santo_Domingo', year: 'numeric', month: '2-digit', day: '2-digit' });
const drDay = (offsetDays = 0) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return drFmt.format(d); // YYYY-MM-DD
};

function sub(overrides = {}) {
  return {
    subscription_id: 's1', status: 'active',
    next_billing_date: drDay(0),
    plan_type: '24h',
    plan_name: 'Test', vehicle_plate: 'ABC123', customer_name: 'Cliente X',
    start_hour: 6, end_hour: 18, crosses_midnight: false, tolerance_minutes: 15,
    current_occupancy: 0, max_capacity: 10, daily_entry_limit: 5,
    overage_hourly_rate: 50,
    ...overrides
  };
}

afterEach(() => jest.clearAllMocks());

describe('[BUG 4][HIGH fixed] subscriber is NOT locked out on their last paid day', () => {
  it('allows entry when next_billing_date is today (DR)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }); // getTodayEntries
    const res = await accessService.validateSubscriptionEntry(sub({ next_billing_date: drDay(0) }), new Date());
    expect(res.allowed).toBe(true);
  });
  it('still denies entry when next_billing_date is in the past', async () => {
    const res = await accessService.validateSubscriptionEntry(sub({ next_billing_date: drDay(-1) }), new Date());
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('SUBSCRIPTION_EXPIRED');
  });
});

describe('[BUG 5][HIGH fixed] plan-hour window is evaluated in America/Santo_Domingo', () => {
  it('denies 05:30 DR (= 09:30 UTC) for a 06:00-18:00 plan', async () => {
    const res = await accessService.validateSubscriptionEntry(
      sub({ plan_type: 'diurno', next_billing_date: drDay(1) }),
      new Date('2024-01-15T09:30:00Z') // 05:30 in DR
    );
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('OUTSIDE_HOURS');
  });
  it('allows 09:30 DR (= 13:30 UTC) for a 06:00-18:00 plan', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }); // getTodayEntries
    const res = await accessService.validateSubscriptionEntry(
      sub({ plan_type: 'diurno', next_billing_date: drDay(1) }),
      new Date('2024-01-15T13:30:00Z') // 09:30 in DR
    );
    expect(res.allowed).toBe(true);
  });
});

describe('[BUG 6][HIGH fixed] overage is charged for overstays that cross midnight', () => {
  it('Diurno (06-18) entering 10:00 and exiting 02:00 next day -> ~7.75h overage (was 0)', () => {
    const overage = accessService.calculateOverageHours(
      new Date('2024-01-15T14:00:00Z'), // 10:00 DR
      new Date('2024-01-16T06:00:00Z'), // 02:00 DR next day
      18, 15
    );
    expect(overage).toBeGreaterThan(7);
    expect(overage).toBeLessThan(8);
    expect(overage).not.toBe(0);
  });
  it('no overage when exiting before the tolerance boundary same day', () => {
    const overage = accessService.calculateOverageHours(
      new Date('2024-01-15T14:00:00Z'), // 10:00 DR
      new Date('2024-01-15T21:00:00Z'), // 17:00 DR (before 18:15)
      18, 15
    );
    expect(overage).toBe(0);
  });
  it('night plan (ends 06:00) overstay rolls to the next-day boundary', () => {
    const overage = accessService.calculateOverageHours(
      new Date('2024-01-16T00:00:00Z'), // 20:00 DR (Jan 15)
      new Date('2024-01-16T12:00:00Z'), // 08:00 DR (Jan 16)
      6, 15
    );
    expect(overage).toBeGreaterThan(1.5);
    expect(overage).toBeLessThan(2);
  });
});
