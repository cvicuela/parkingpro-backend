// Mock database before requiring anything else
const mockQuery = jest.fn();
jest.mock('../src/config/database', () => ({
  query: mockQuery,
  transaction: jest.fn(),
  supabase: {},
  pool: { end: jest.fn() },
  testConnection: jest.fn().mockResolvedValue(true)
}));

jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, res, next) => {
    req.user = { id: 'test-user-id', role: 'admin', email: 'admin@test.com' };
    next();
  },
  authorize: () => (req, res, next) => next()
}));

const request = require('supertest');
const express = require('express');

const reportRoutes = require('../src/routes/report.routes');
const errorHandler = require('../src/middleware/errorHandler');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/reports', reportRoutes);
  app.use(errorHandler);
  return app;
}

describe('Report Routes', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ==================== GET /dashboard ====================

  describe('GET /api/v1/reports/dashboard', () => {
    it('should return dashboard KPIs', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ total_revenue: '15000.50' }] })          // revenue
        .mockResolvedValueOnce({ rows: [{ active_customers: '42' }] })              // customers
        .mockResolvedValueOnce({ rows: [{ total_subscriptions: '55' }] })           // subscriptions
        .mockResolvedValueOnce({ rows: [{ plan_name: 'Monthly', occupied: 30, capacity: 50 }] }) // occupancy
        .mockResolvedValueOnce({ rows: [{ overdue_count: '3' }] });                 // overdue

      const res = await request(app).get('/api/v1/reports/dashboard');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.revenue).toBe(15000.50);
      expect(res.body.data.activeCustomers).toBe(42);
      expect(res.body.data.active_customers).toBe(42);
      expect(res.body.data.totalSubscriptions).toBe(55);
      expect(res.body.data.total_subscriptions).toBe(55);
      expect(res.body.data.overdueCount).toBe(3);
      expect(res.body.data.overdue_count).toBe(3);
      expect(res.body.data.occupancyByPlan).toBeDefined();
    });

    it('should handle database errors', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));

      const res = await request(app).get('/api/v1/reports/dashboard');

      expect(res.status).toBe(500);
    });
  });

  // ==================== GET /active-vehicles ====================

  describe('GET /api/v1/reports/active-vehicles', () => {
    it('should return active vehicles with summary', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            { plate: 'ABC123', make: 'Toyota', model: 'Corolla', customer_name: 'John Doe', plan_name: 'Monthly', access_type: 'subscription', entry_time: '2026-03-20T08:00:00Z' }
          ]
        })
        .mockResolvedValueOnce({
          rows: [
            { plate: 'XYZ789', make: 'Honda', model: 'Civic', customer_name: null, plan_name: 'Hourly', access_type: 'hourly', entry_time: '2026-03-20T10:00:00Z', minutes_elapsed: 45, calculated_amount: 5.00 }
          ]
        });

      const res = await request(app).get('/api/v1/reports/active-vehicles');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.count).toBe(2);
      expect(res.body.summary).toEqual({
        subscription: 1,
        hourly: 1,
        total: 2
      });
    });

    it('should return empty when no active vehicles', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(app).get('/api/v1/reports/active-vehicles');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
      expect(res.body.summary.total).toBe(0);
    });

    it('should handle database errors', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));

      const res = await request(app).get('/api/v1/reports/active-vehicles');

      expect(res.status).toBe(500);
    });
  });

  // ==================== GET /executive-summary ====================

  describe('GET /api/v1/reports/executive-summary', () => {
    function mockExecutiveSummaryQueries() {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ current_month: '20000', previous_month: '15000' }] })
        .mockResolvedValueOnce({ rows: [{ new_this_month: '10', new_last_month: '8', cancelled_this_month: '2', total_active: '55' }] })
        .mockResolvedValueOnce({ rows: [{ sessions_this_month: '200', avg_duration_min: '45.5', hourly_revenue: '3000' }] })
        .mockResolvedValueOnce({ rows: [{ total_closures: '15', total_expected: '50000', total_counted: '49800', total_abs_difference: '200', requiring_approval: '2' }] })
        .mockResolvedValueOnce({ rows: [{ paid_count: '90', total_count: '100', collected: '18000', total_billed: '20000' }] })
        .mockResolvedValueOnce({ rows: [{ refund_count: '3', refund_total: '500' }] });
    }

    it('should return executive summary with all sections', async () => {
      mockExecutiveSummaryQueries();

      const res = await request(app).get('/api/v1/reports/executive-summary');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const data = res.body.data;
      expect(data.revenue.currentMonth).toBe(20000);
      expect(data.revenue.previousMonth).toBe(15000);
      expect(data.revenue.changePercent).toBeCloseTo(33.33, 1);
      expect(data.revenue.trend).toBe('up');

      expect(data.subscriptions.totalActive).toBe(55);
      expect(data.subscriptions.newThisMonth).toBe(10);
      expect(data.subscriptions.cancelledThisMonth).toBe(2);

      expect(data.sessions.totalThisMonth).toBe(200);
      expect(data.sessions.avgDurationMinutes).toBe(46);
      expect(data.sessions.hourlyRevenue).toBe(3000);

      expect(data.cashRegisters.totalClosures).toBe(15);
      expect(data.cashRegisters.requiringApproval).toBe(2);

      expect(data.collection.rate).toBe(90);
      expect(data.collection.collected).toBe(18000);

      expect(data.refunds.count).toBe(3);
      expect(data.refunds.total).toBe(500);
    });

    it('should show downward trend when revenue decreases', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ current_month: '10000', previous_month: '15000' }] })
        .mockResolvedValueOnce({ rows: [{ new_this_month: '5', new_last_month: '8', cancelled_this_month: '3', total_active: '40' }] })
        .mockResolvedValueOnce({ rows: [{ sessions_this_month: '100', avg_duration_min: '30', hourly_revenue: '1500' }] })
        .mockResolvedValueOnce({ rows: [{ total_closures: '10', total_expected: '30000', total_counted: '29500', total_abs_difference: '500', requiring_approval: '1' }] })
        .mockResolvedValueOnce({ rows: [{ paid_count: '80', total_count: '100', collected: '16000', total_billed: '20000' }] })
        .mockResolvedValueOnce({ rows: [{ refund_count: '1', refund_total: '100' }] });

      const res = await request(app).get('/api/v1/reports/executive-summary');

      expect(res.status).toBe(200);
      expect(res.body.data.revenue.trend).toBe('down');
      expect(res.body.data.revenue.changePercent).toBeCloseTo(-33.33, 1);
    });

    it('should handle database errors', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));

      const res = await request(app).get('/api/v1/reports/executive-summary');

      expect(res.status).toBe(500);
    });
  });

  // ==================== GET /revenue ====================

  describe('GET /api/v1/reports/revenue', () => {
    function mockRevenueQueries() {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ period: '2026-03-01', transaction_count: '10', total: '5000', subtotal: '4500', tax: '500' }]
        })
        .mockResolvedValueOnce({
          rows: [
            { method: 'cash', count: '5', total: '2500' },
            { method: 'card', count: '5', total: '2500' },
          ]
        })
        .mockResolvedValueOnce({
          rows: [{ plan_name: 'Monthly', plan_type: 'monthly', count: '8', total: '4000' }]
        })
        .mockResolvedValueOnce({
          rows: [{ total_transactions: '10', gross_revenue: '5000', net_revenue: '4500', total_tax: '500', avg_ticket: '500.00' }]
        });
    }

    it('should return revenue report with default period', async () => {
      mockRevenueQueries();

      const res = await request(app).get('/api/v1/reports/revenue');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const data = res.body.data;
      expect(data.period).toHaveProperty('from');
      expect(data.period).toHaveProperty('to');
      expect(data.totals.transactions).toBe(10);
      expect(data.totals.grossRevenue).toBe(5000);
      expect(data.totals.netRevenue).toBe(4500);
      expect(data.totals.totalTax).toBe(500);
      expect(data.totals.avgTicket).toBe(500.00);
      expect(data.timeline).toHaveLength(1);
      expect(data.byMethod).toHaveLength(2);
      expect(data.byPlan).toHaveLength(1);
    });

    it('should accept custom period and groupBy', async () => {
      mockRevenueQueries();

      const res = await request(app).get('/api/v1/reports/revenue?period=week&groupBy=hour');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should handle database errors', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));

      const res = await request(app).get('/api/v1/reports/revenue');

      expect(res.status).toBe(500);
    });
  });

  // ==================== GET /revenue-by-operator ====================

  describe('GET /api/v1/reports/revenue-by-operator', () => {
    it('should return revenue grouped by operator', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            operator_id: 'op-1', operator_email: 'op1@test.com', operator_name: 'Operator One',
            transaction_count: '20', total_income: '10000', total_expenses: '500',
            shifts_count: '5', avg_transaction: '500.00'
          }
        ]
      });

      const res = await request(app).get('/api/v1/reports/revenue-by-operator');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.operators).toHaveLength(1);

      const op = res.body.data.operators[0];
      expect(op.operatorId).toBe('op-1');
      expect(op.operatorName).toBe('Operator One');
      expect(op.transactionCount).toBe(20);
      expect(op.totalIncome).toBe(10000);
      expect(op.totalExpenses).toBe(500);
      expect(op.netIncome).toBe(9500);
      expect(op.shiftsCount).toBe(5);
    });

    it('should handle database errors', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));

      const res = await request(app).get('/api/v1/reports/revenue-by-operator');

      expect(res.status).toBe(500);
    });
  });

  // ==================== GET /cash-reconciliation ====================

  describe('GET /api/v1/reports/cash-reconciliation', () => {
    it('should return cash reconciliation report', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            total_closures: '10', total_expected: '50000', total_counted: '49800',
            net_difference: '-200', abs_difference: '300', avg_difference: '30.00',
            max_difference: '100', surplus_count: '2', shortage_count: '5',
            exact_count: '3', flagged_count: '2', approved_count: '1'
          }]
        })
        .mockResolvedValueOnce({
          rows: [{
            id: 'cr-1', register_name: 'Caja 1', opened_at: '2026-03-20T06:00:00Z',
            closed_at: '2026-03-20T18:00:00Z', opening_balance: '1000', expected_balance: '5000',
            counted_balance: '4950', difference: '-50', requires_approval: true, is_approved: false,
            operator_email: 'op@test.com', operator_name: 'Operator One',
            payment_count: '20', refund_count: '1', total_in: '4500', total_out: '500'
          }]
        })
        .mockResolvedValueOnce({
          rows: [{
            operator_id: 'op-1', operator_name: 'Operator One', closures: '5',
            total_abs_diff: '150', avg_diff: '30.00', exact_closures: '2', flagged_closures: '1'
          }]
        });

      const res = await request(app).get('/api/v1/reports/cash-reconciliation');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const data = res.body.data;
      expect(data.summary.totalClosures).toBe(10);
      expect(data.summary.netDifference).toBe(-200);
      expect(data.summary.surplusCount).toBe(2);
      expect(data.summary.shortageCount).toBe(5);
      expect(data.closures).toHaveLength(1);
      expect(data.closures[0].difference).toBe(-50);
      expect(data.byOperator).toHaveLength(1);
    });

    it('should handle database errors', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));

      const res = await request(app).get('/api/v1/reports/cash-reconciliation');

      expect(res.status).toBe(500);
    });
  });

  // ==================== GET /customers ====================

  describe('GET /api/v1/reports/customers', () => {
    it('should return customer metrics', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ period: '2026-03-10', count: '5' }] })       // newCustomersTrend
        .mockResolvedValueOnce({ rows: [{ status: 'active', count: '40' }, { status: 'cancelled', count: '5' }] }) // statusDistribution
        .mockResolvedValueOnce({
          rows: [{
            customer_id: 'c-1', customer_name: 'John Doe', id_document: '001-1234567-8',
            payment_count: '10', total_paid: '5000', subscription_count: '1', customer_since: '2025-01-01'
          }]
        })
        .mockResolvedValueOnce({
          rows: [{
            customer_id: 'c-2', customer_name: 'Jane Doe', status: 'past_due',
            plan_name: 'Monthly', next_billing_date: '2026-03-01', price_per_period: '150', days_overdue: '19'
          }]
        })
        .mockResolvedValueOnce({ rows: [{ period: '2026-03-10', count: '1' }] })       // churnTrend
        .mockResolvedValueOnce({ rows: [{ active: '40', cancelled: '5', total: '45' }] }); // retention

      const res = await request(app).get('/api/v1/reports/customers');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const data = res.body.data;
      expect(data.newCustomersTrend).toHaveLength(1);
      expect(data.statusDistribution).toHaveLength(2);
      expect(data.topCustomers).toHaveLength(1);
      expect(data.topCustomers[0].totalPaid).toBe(5000);
      expect(data.delinquent).toHaveLength(1);
      expect(data.delinquent[0].daysOverdue).toBe(19);
      expect(data.churnTrend).toHaveLength(1);
      expect(data.retentionRate).toBeCloseTo(88.89, 1);
    });

    it('should handle database errors', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));

      const res = await request(app).get('/api/v1/reports/customers');

      expect(res.status).toBe(500);
    });
  });

  // ==================== GET /occupancy ====================

  describe('GET /api/v1/reports/occupancy', () => {
    it('should return occupancy report', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ plan_name: 'Monthly', occupied: 30, capacity: 50 }] })  // currentOccupancy
        .mockResolvedValueOnce({ rows: [{ hour: '8', entry_count: '15' }, { hour: '17', entry_count: '20' }] }) // peakHours
        .mockResolvedValueOnce({ rows: [{ day_of_week: '1', entry_count: '50' }] })                // peakDays
        .mockResolvedValueOnce({ rows: [{ date: '2026-03-19', entries: '30', exits: '25' }] })     // occupancyTrend
        .mockResolvedValueOnce({ rows: [{ plan_name: 'Hourly', session_count: '100', avg_minutes: '60', min_minutes: '10', max_minutes: '480' }] }) // avgDuration
        .mockResolvedValueOnce({ rows: [{ method: 'qr', count: '50', entries: '30', exits: '20' }] }); // accessMethods

      const res = await request(app).get('/api/v1/reports/occupancy');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const data = res.body.data;
      expect(data.currentOccupancy).toHaveLength(1);
      expect(data.peakHours).toHaveLength(2);
      expect(data.peakHours[0].hour).toBe(8);
      expect(data.peakHours[0].label).toBe('08:00');
      expect(data.peakDays).toHaveLength(1);
      expect(data.peakDays[0].dayName).toBe('Lunes');
      expect(data.dailyTrend).toHaveLength(1);
      expect(data.dailyTrend[0].net).toBe(5);
      expect(data.avgDuration).toHaveLength(1);
      expect(data.accessMethods).toHaveLength(1);
    });

    it('should accept custom period parameters', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(app).get('/api/v1/reports/occupancy?period=month');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should handle database errors', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));

      const res = await request(app).get('/api/v1/reports/occupancy');

      expect(res.status).toBe(500);
    });
  });

  // ==================== GET /sessions ====================

  describe('GET /api/v1/reports/sessions', () => {
    it('should return sessions report', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            total: '100', active: '5', paid: '80', closed: '10', abandoned: '5',
            total_revenue: '4000', avg_duration: '55.5', avg_ticket: '50.00'
          }]
        })
        .mockResolvedValueOnce({
          rows: [{ date: '2026-03-19', total: '20', paid: '18', abandoned: '1', revenue: '900' }]
        })
        .mockResolvedValueOnce({
          rows: [{ method: 'qr', count: '60', revenue: '3000' }]
        })
        .mockResolvedValueOnce({
          rows: [{ bucket: '0-30 min', count: '30', avg_paid: '15.50' }]
        });

      const res = await request(app).get('/api/v1/reports/sessions');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const data = res.body.data;
      expect(data.summary.total).toBe(100);
      expect(data.summary.active).toBe(5);
      expect(data.summary.paid).toBe(80);
      expect(data.summary.totalRevenue).toBe(4000);
      expect(data.summary.avgDuration).toBe(56);
      expect(data.summary.avgTicket).toBe(50.00);
      expect(data.timeline).toHaveLength(1);
      expect(data.byAccessMethod).toHaveLength(1);
      expect(data.durationDistribution).toHaveLength(1);
    });

    it('should handle database errors', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));

      const res = await request(app).get('/api/v1/reports/sessions');

      expect(res.status).toBe(500);
    });
  });

  // ==================== GET /invoices ====================

  describe('GET /api/v1/reports/invoices', () => {
    it('should return invoices report', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ total_invoices: '50', total_amount: '75000', total_subtotal: '67500', total_tax: '7500', unique_customers: '30' }]
        })
        .mockResolvedValueOnce({
          rows: [
            { ncf_type: 'Consumidor Final (B01)', count: '40', total: '60000' },
            { ncf_type: 'Credito Fiscal (B14)', count: '10', total: '15000' },
          ]
        })
        .mockResolvedValueOnce({
          rows: [{ date: '2026-03-19', count: '5', total: '7500' }]
        });

      const res = await request(app).get('/api/v1/reports/invoices');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const data = res.body.data;
      expect(data.summary.totalInvoices).toBe(50);
      expect(data.summary.totalAmount).toBe(75000);
      expect(data.summary.totalTax).toBe(7500);
      expect(data.summary.uniqueCustomers).toBe(30);
      expect(data.byNCFType).toHaveLength(2);
      expect(data.timeline).toHaveLength(1);
    });

    it('should handle database errors', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));

      const res = await request(app).get('/api/v1/reports/invoices');

      expect(res.status).toBe(500);
    });
  });

  // ==================== GET /incidents ====================

  describe('GET /api/v1/reports/incidents', () => {
    it('should return incidents report', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ total: '10', open_count: '3', resolved_count: '7', high_severity: '2' }]
        })
        .mockResolvedValueOnce({
          rows: [{ type: 'unauthorized_access', count: '5' }, { type: 'damage', count: '3' }]
        })
        .mockResolvedValueOnce({
          rows: [{ severity: 'high', count: '2' }, { severity: 'low', count: '8' }]
        });

      const res = await request(app).get('/api/v1/reports/incidents');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const data = res.body.data;
      expect(data.summary.total).toBe(10);
      expect(data.summary.open).toBe(3);
      expect(data.summary.resolved).toBe(7);
      expect(data.summary.highSeverity).toBe(2);
      expect(data.byType).toHaveLength(2);
      expect(data.bySeverity).toHaveLength(2);
    });

    it('should handle database errors', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));

      const res = await request(app).get('/api/v1/reports/incidents');

      expect(res.status).toBe(500);
    });
  });

  // ==================== GET /revenue-daily ====================

  describe('GET /api/v1/reports/revenue-daily', () => {
    it('should return daily revenue for default 7 days', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            { date: '2026-03-19', revenue: '1500', count: '10' },
            { date: '2026-03-20', revenue: '2000', count: '15' },
          ]
        })
        .mockResolvedValueOnce({
          rows: [
            { date: '2026-03-19', method: 'cash', amount: '800' },
            { date: '2026-03-19', method: 'card', amount: '700' },
            { date: '2026-03-20', method: 'cash', amount: '1200' },
            { date: '2026-03-20', method: 'card', amount: '800' },
          ]
        });

      const res = await request(app).get('/api/v1/reports/revenue-daily');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0].revenue).toBe(1500);
      expect(res.body.data[0]).toHaveProperty('day_label');
      expect(res.body.data[0]).toHaveProperty('by_method');
    });

    it('should accept custom days parameter', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(app).get('/api/v1/reports/revenue-daily?days=14');

      expect(res.status).toBe(200);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        [14]
      );
    });

    it('should cap days at 30', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(app).get('/api/v1/reports/revenue-daily?days=100');

      expect(res.status).toBe(200);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        [30]
      );
    });

    it('should handle database errors', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));

      const res = await request(app).get('/api/v1/reports/revenue-daily');

      expect(res.status).toBe(500);
    });
  });

  // ==================== GET /today-summary ====================

  describe('GET /api/v1/reports/today-summary', () => {
    it('should return today summary', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ entries: '25', exits: '20' }] })
        .mockResolvedValueOnce({ rows: [{ payments_count: '15', revenue_today: '3500' }] })
        .mockResolvedValueOnce({ rows: [{ method: 'cash', amount: '2000' }, { method: 'card', amount: '1500' }] })
        .mockResolvedValueOnce({ rows: [{ total_sessions: '20', paid_sessions: '18' }] });

      const res = await request(app).get('/api/v1/reports/today-summary');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const data = res.body.data;
      expect(data.entries).toBe(25);
      expect(data.exits).toBe(20);
      expect(data.payments_count).toBe(15);
      expect(data.revenue_today).toBe(3500);
      expect(data.collection_rate).toBe(90);
      expect(data.by_method).toEqual({ cash: 2000, card: 1500 });
    });

    it('should return 0 collection rate when no sessions', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ entries: '0', exits: '0' }] })
        .mockResolvedValueOnce({ rows: [{ payments_count: '0', revenue_today: '0' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ total_sessions: '0', paid_sessions: '0' }] });

      const res = await request(app).get('/api/v1/reports/today-summary');

      expect(res.status).toBe(200);
      expect(res.body.data.collection_rate).toBe(0);
    });

    it('should handle database errors', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));

      const res = await request(app).get('/api/v1/reports/today-summary');

      expect(res.status).toBe(500);
    });
  });

  // ==================== GET /export/:type ====================

  describe('GET /api/v1/reports/export/:type', () => {
    it('should export payments as JSON when format=json', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { fecha: '2026-03-20', cliente: 'John Doe', monto: 150, metodo_pago: 'cash', estado: 'paid', plan: 'Monthly' }
        ]
      });

      const res = await request(app).get('/api/v1/reports/export/payments?format=json');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.headers).toEqual(['fecha', 'cliente', 'monto', 'metodo_pago', 'estado', 'plan']);
      expect(res.body.data.rows).toHaveLength(1);
      expect(res.body.data.filename).toBe('pagos');
    });

    it('should export payments as CSV by default', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { fecha: '2026-03-20', cliente: 'John Doe', monto: 150, metodo_pago: 'cash', estado: 'paid', plan: 'Monthly' }
        ]
      });

      const res = await request(app).get('/api/v1/reports/export/payments');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('pagos_');
    });

    it('should export cash-registers as JSON', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          fecha_cierre: '2026-03-20', operador: 'Op One', saldo_apertura: 1000,
          saldo_esperado: 5000, saldo_contado: 4950, diferencia: -50, requiere_aprobacion: 'No'
        }]
      });

      const res = await request(app).get('/api/v1/reports/export/cash-registers?format=json');

      expect(res.status).toBe(200);
      expect(res.body.data.filename).toBe('cuadre_caja');
    });

    it('should export sessions as JSON', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          entrada: '2026-03-20T08:00:00Z', salida: '2026-03-20T10:00:00Z',
          placa: 'ABC123', plan: 'Hourly', duracion_min: 120, monto_pagado: 10, estado: 'paid'
        }]
      });

      const res = await request(app).get('/api/v1/reports/export/sessions?format=json');

      expect(res.status).toBe(200);
      expect(res.body.data.filename).toBe('sesiones_parqueo');
    });

    it('should export customers as JSON', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          nombre: 'John Doe', documento: '001-1234567-8', email: 'john@test.com',
          telefono: '+18095551234', fecha_registro: '2025-01-01',
          suscripciones_activas: 1, total_pagado: 5000
        }]
      });

      const res = await request(app).get('/api/v1/reports/export/customers?format=json');

      expect(res.status).toBe(200);
      expect(res.body.data.filename).toBe('clientes');
    });

    it('should return 400 for invalid export type', async () => {
      const res = await request(app).get('/api/v1/reports/export/invalid');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('no valido');
    });

    it('should handle database errors', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));

      const res = await request(app).get('/api/v1/reports/export/payments?format=json');

      expect(res.status).toBe(500);
    });
  });
});
