const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { query } = require('../config/database');

// ==================== HELPERS ====================

function getDateRange(period, customFrom, customTo) {
    const now = new Date();
    let from, to;
    to = customTo ? new Date(customTo) : now;

    switch (period) {
        case 'today':
            from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            break;
        case 'yesterday':
            from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
            to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            break;
        case 'week':
            from = new Date(now);
            from.setDate(from.getDate() - 7);
            break;
        case 'month':
            from = new Date(now.getFullYear(), now.getMonth(), 1);
            break;
        case 'quarter':
            from = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
            break;
        case 'year':
            from = new Date(now.getFullYear(), 0, 1);
            break;
        case 'custom':
            from = customFrom ? new Date(customFrom) : new Date(now.getFullYear(), now.getMonth(), 1);
            break;
        default:
            from = new Date(now.getFullYear(), now.getMonth(), 1);
    }
    return { from: from.toISOString(), to: to.toISOString() };
}

// ==================== DASHBOARD KPIs ====================

/**
 * @route   GET /api/v1/reports/dashboard
 * @desc    KPIs principales del dashboard
 * @access  Private (Admin)
 */
router.get('/dashboard', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const revenueResult = await query(
            `SELECT COALESCE(SUM(total_amount), 0) as total_revenue
             FROM payments
             WHERE status = 'paid'
               AND created_at >= CURRENT_DATE - INTERVAL '30 days'`
        );

        const customersResult = await query(
            `SELECT COUNT(DISTINCT customer_id) as active_customers
             FROM subscriptions
             WHERE status = 'active'`
        );

        const subscriptionsResult = await query(
            `SELECT COUNT(*) as total_subscriptions
             FROM subscriptions
             WHERE status = 'active'`
        );

        const occupancyResult = await query(
            `SELECT * FROM current_occupancy_by_plan`
        );

        const overdueResult = await query(
            `SELECT COUNT(*) as overdue_count
             FROM subscriptions
             WHERE status = 'past_due'`
        );

        const revenue = parseFloat(revenueResult.rows[0].total_revenue);
        const activeCustomers = parseInt(customersResult.rows[0].active_customers);
        const totalSubscriptions = parseInt(subscriptionsResult.rows[0].total_subscriptions);
        const overdueCount = parseInt(overdueResult.rows[0].overdue_count);

        res.json({
            success: true,
            data: {
                revenue,
                activeCustomers,
                active_customers: activeCustomers,
                totalSubscriptions,
                total_subscriptions: totalSubscriptions,
                overdueCount,
                overdue_count: overdueCount,
                occupancyByPlan: occupancyResult.rows
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   GET /api/v1/reports/active-vehicles
 * @desc    Vehiculos activos (dentro del parqueo ahora)
 * @access  Private (Operator, Admin)
 */
router.get('/active-vehicles', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        const subscriptionVehicles = await query(
            `SELECT DISTINCT ON (ae.vehicle_plate)
                ae.vehicle_plate as plate,
                v.make, v.model, v.color, v.year,
                c.first_name || ' ' || c.last_name as customer_name,
                p.name as plan_name,
                p.type as plan_type,
                ae.timestamp as entry_time,
                'subscription' as access_type
             FROM access_events ae
             JOIN subscriptions s ON ae.subscription_id = s.id
             JOIN vehicles v ON v.plate = ae.vehicle_plate
             JOIN customers c ON s.customer_id = c.id
             JOIN plans p ON s.plan_id = p.id
             WHERE ae.type = 'entry'
               AND NOT EXISTS (
                   SELECT 1 FROM access_events ae2
                   WHERE ae2.vehicle_plate = ae.vehicle_plate
                     AND ae2.type = 'exit'
                     AND ae2.timestamp > ae.timestamp
               )
             ORDER BY ae.vehicle_plate, ae.timestamp DESC`
        );

        const hourlyVehicles = await query(
            `SELECT
                ps.vehicle_plate as plate,
                v.make, v.model, v.color, v.year,
                NULL as customer_name,
                p.name as plan_name,
                'hourly' as plan_type,
                ps.entry_time,
                'hourly' as access_type,
                EXTRACT(EPOCH FROM (NOW() - ps.entry_time)) / 60 as minutes_elapsed,
                ps.calculated_amount
             FROM parking_sessions ps
             LEFT JOIN vehicles v ON v.plate = ps.vehicle_plate
             LEFT JOIN plans p ON ps.plan_id = p.id
             WHERE ps.status = 'active'
             ORDER BY ps.entry_time DESC`
        );

        const allActive = [...subscriptionVehicles.rows, ...hourlyVehicles.rows];

        res.json({
            success: true,
            data: allActive,
            count: allActive.length,
            summary: {
                subscription: subscriptionVehicles.rows.length,
                hourly: hourlyVehicles.rows.length,
                total: allActive.length
            }
        });
    } catch (error) {
        next(error);
    }
});

// ==================== RESUMEN EJECUTIVO ====================

/**
 * @route   GET /api/v1/reports/executive-summary
 * @desc    Resumen ejecutivo con comparativas de periodos
 * @access  Private (Admin)
 */
router.get('/executive-summary', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        // Revenue current month vs previous month
        const revenueComparison = await query(`
            SELECT
                COALESCE(SUM(CASE WHEN created_at >= DATE_TRUNC('month', CURRENT_DATE) THEN total_amount END), 0) as current_month,
                COALESCE(SUM(CASE WHEN created_at >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
                    AND created_at < DATE_TRUNC('month', CURRENT_DATE) THEN total_amount END), 0) as previous_month
            FROM payments WHERE status = 'paid'
        `);

        // Subscriptions current vs previous
        const subComparison = await query(`
            SELECT
                COUNT(*) FILTER (WHERE activated_at >= DATE_TRUNC('month', CURRENT_DATE)) as new_this_month,
                COUNT(*) FILTER (WHERE activated_at >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
                    AND activated_at < DATE_TRUNC('month', CURRENT_DATE)) as new_last_month,
                COUNT(*) FILTER (WHERE cancelled_at >= DATE_TRUNC('month', CURRENT_DATE)) as cancelled_this_month,
                COUNT(*) FILTER (WHERE status = 'active') as total_active
            FROM subscriptions
        `);

        // Sessions summary
        const sessionsSum = await query(`
            SELECT
                COUNT(*) FILTER (WHERE entry_time >= DATE_TRUNC('month', CURRENT_DATE)) as sessions_this_month,
                COALESCE(AVG(duration_minutes) FILTER (WHERE exit_time IS NOT NULL AND entry_time >= DATE_TRUNC('month', CURRENT_DATE)), 0) as avg_duration_min,
                COALESCE(SUM(paid_amount) FILTER (WHERE payment_status = 'paid' AND entry_time >= DATE_TRUNC('month', CURRENT_DATE)), 0) as hourly_revenue
            FROM parking_sessions
        `);

        // Cash register summary this month
        const cashSum = await query(`
            SELECT
                COUNT(*) as total_closures,
                COALESCE(SUM(expected_balance), 0) as total_expected,
                COALESCE(SUM(counted_balance), 0) as total_counted,
                COALESCE(SUM(ABS(difference)), 0) as total_abs_difference,
                COUNT(*) FILTER (WHERE requires_approval = true) as requiring_approval
            FROM cash_registers
            WHERE status = 'closed' AND closed_at >= DATE_TRUNC('month', CURRENT_DATE)
        `);

        // Payment collection rate
        const collectionRate = await query(`
            SELECT
                COUNT(*) FILTER (WHERE status = 'paid') as paid_count,
                COUNT(*) as total_count,
                COALESCE(SUM(total_amount) FILTER (WHERE status = 'paid'), 0) as collected,
                COALESCE(SUM(total_amount), 0) as total_billed
            FROM payments
            WHERE created_at >= DATE_TRUNC('month', CURRENT_DATE)
        `);

        // Refunds this month
        const refunds = await query(`
            SELECT
                COUNT(*) as refund_count,
                COALESCE(SUM(total_amount), 0) as refund_total
            FROM payments
            WHERE status = 'refunded' AND refunded_at >= DATE_TRUNC('month', CURRENT_DATE)
        `);

        const rev = revenueComparison.rows[0];
        const currentRev = parseFloat(rev.current_month);
        const prevRev = parseFloat(rev.previous_month);
        const revenueChange = prevRev > 0 ? ((currentRev - prevRev) / prevRev * 100) : 0;

        const col = collectionRate.rows[0];
        const rate = parseInt(col.total_count) > 0
            ? (parseInt(col.paid_count) / parseInt(col.total_count) * 100) : 100;

        res.json({
            success: true,
            data: {
                revenue: {
                    currentMonth: currentRev,
                    previousMonth: prevRev,
                    changePercent: Math.round(revenueChange * 100) / 100,
                    trend: revenueChange >= 0 ? 'up' : 'down'
                },
                subscriptions: {
                    totalActive: parseInt(subComparison.rows[0].total_active),
                    newThisMonth: parseInt(subComparison.rows[0].new_this_month),
                    newLastMonth: parseInt(subComparison.rows[0].new_last_month),
                    cancelledThisMonth: parseInt(subComparison.rows[0].cancelled_this_month)
                },
                sessions: {
                    totalThisMonth: parseInt(sessionsSum.rows[0].sessions_this_month),
                    avgDurationMinutes: Math.round(parseFloat(sessionsSum.rows[0].avg_duration_min)),
                    hourlyRevenue: parseFloat(sessionsSum.rows[0].hourly_revenue)
                },
                cashRegisters: {
                    totalClosures: parseInt(cashSum.rows[0].total_closures),
                    totalExpected: parseFloat(cashSum.rows[0].total_expected),
                    totalCounted: parseFloat(cashSum.rows[0].total_counted),
                    totalAbsDifference: parseFloat(cashSum.rows[0].total_abs_difference),
                    requiringApproval: parseInt(cashSum.rows[0].requiring_approval)
                },
                collection: {
                    rate: Math.round(rate * 100) / 100,
                    collected: parseFloat(col.collected),
                    totalBilled: parseFloat(col.total_billed),
                    paidCount: parseInt(col.paid_count),
                    totalCount: parseInt(col.total_count)
                },
                refunds: {
                    count: parseInt(refunds.rows[0].refund_count),
                    total: parseFloat(refunds.rows[0].refund_total)
                }
            }
        });
    } catch (error) {
        next(error);
    }
});

// ==================== INGRESOS / VENTAS ====================

/**
 * @route   GET /api/v1/reports/revenue
 * @desc    Ingresos desglosados por periodo, metodo, plan, cajero
 * @access  Private (Admin)
 */
router.get('/revenue', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const { period = 'month', from: customFrom, to: customTo, groupBy = 'day' } = req.query;
        const { from, to } = getDateRange(period, customFrom, customTo);

        // Determine SQL date truncation
        const truncMap = { hour: 'hour', day: 'day', week: 'week', month: 'month', year: 'year' };
        const trunc = truncMap[groupBy] || 'day';

        // Revenue over time
        const revenueTimeline = await query(`
            SELECT
                DATE_TRUNC($3, created_at) as period,
                COUNT(*) as transaction_count,
                COALESCE(SUM(total_amount), 0) as total,
                COALESCE(SUM(amount), 0) as subtotal,
                COALESCE(SUM(tax_amount), 0) as tax
            FROM payments
            WHERE status = 'paid' AND created_at >= $1 AND created_at <= $2
            GROUP BY DATE_TRUNC($3, created_at)
            ORDER BY period ASC
        `, [from, to, trunc]);

        // Revenue by payment method
        const byMethod = await query(`
            SELECT
                COALESCE(payment_method, 'unknown') as method,
                COUNT(*) as count,
                COALESCE(SUM(total_amount), 0) as total
            FROM payments
            WHERE status = 'paid' AND created_at >= $1 AND created_at <= $2
            GROUP BY payment_method
            ORDER BY total DESC
        `, [from, to]);

        // Revenue by plan
        const byPlan = await query(`
            SELECT
                COALESCE(p.name, 'Parqueo por hora') as plan_name,
                COALESCE(p.type, 'hourly') as plan_type,
                COUNT(*) as count,
                COALESCE(SUM(pay.total_amount), 0) as total
            FROM payments pay
            LEFT JOIN subscriptions s ON pay.subscription_id = s.id
            LEFT JOIN plans p ON s.plan_id = p.id
            WHERE pay.status = 'paid' AND pay.created_at >= $1 AND pay.created_at <= $2
            GROUP BY p.name, p.type
            ORDER BY total DESC
        `, [from, to]);

        // Total summary
        const totals = await query(`
            SELECT
                COUNT(*) as total_transactions,
                COALESCE(SUM(total_amount), 0) as gross_revenue,
                COALESCE(SUM(amount), 0) as net_revenue,
                COALESCE(SUM(tax_amount), 0) as total_tax,
                COALESCE(AVG(total_amount), 0) as avg_ticket
            FROM payments
            WHERE status = 'paid' AND created_at >= $1 AND created_at <= $2
        `, [from, to]);

        res.json({
            success: true,
            data: {
                period: { from, to, groupBy },
                totals: {
                    transactions: parseInt(totals.rows[0].total_transactions),
                    grossRevenue: parseFloat(totals.rows[0].gross_revenue),
                    netRevenue: parseFloat(totals.rows[0].net_revenue),
                    totalTax: parseFloat(totals.rows[0].total_tax),
                    avgTicket: parseFloat(parseFloat(totals.rows[0].avg_ticket).toFixed(2))
                },
                timeline: revenueTimeline.rows.map(r => ({
                    period: r.period,
                    count: parseInt(r.transaction_count),
                    total: parseFloat(r.total),
                    subtotal: parseFloat(r.subtotal),
                    tax: parseFloat(r.tax)
                })),
                byMethod: byMethod.rows.map(r => ({
                    method: r.method,
                    count: parseInt(r.count),
                    total: parseFloat(r.total)
                })),
                byPlan: byPlan.rows.map(r => ({
                    planName: r.plan_name,
                    planType: r.plan_type,
                    count: parseInt(r.count),
                    total: parseFloat(r.total)
                }))
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   GET /api/v1/reports/revenue-by-operator
 * @desc    Ingresos por operador/cajero
 * @access  Private (Admin)
 */
router.get('/revenue-by-operator', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const { period = 'month', from: customFrom, to: customTo } = req.query;
        const { from, to } = getDateRange(period, customFrom, customTo);

        const result = await query(`
            SELECT
                u.id as operator_id,
                u.email as operator_email,
                COALESCE(c.first_name || ' ' || c.last_name, u.email) as operator_name,
                COUNT(crt.id) as transaction_count,
                COALESCE(SUM(CASE WHEN crt.direction = 'in' THEN crt.amount ELSE 0 END), 0) as total_income,
                COALESCE(SUM(CASE WHEN crt.direction = 'out' THEN crt.amount ELSE 0 END), 0) as total_expenses,
                COUNT(DISTINCT cr.id) as shifts_count,
                COALESCE(AVG(CASE WHEN crt.direction = 'in' THEN crt.amount END), 0) as avg_transaction
            FROM cash_register_transactions crt
            JOIN cash_registers cr ON crt.cash_register_id = cr.id
            JOIN users u ON cr.operator_id = u.id
            LEFT JOIN customers c ON c.user_id = u.id
            WHERE crt.created_at >= $1 AND crt.created_at <= $2
            GROUP BY u.id, u.email, c.first_name, c.last_name
            ORDER BY total_income DESC
        `, [from, to]);

        res.json({
            success: true,
            data: {
                period: { from, to },
                operators: result.rows.map(r => ({
                    operatorId: r.operator_id,
                    operatorName: r.operator_name,
                    operatorEmail: r.operator_email,
                    transactionCount: parseInt(r.transaction_count),
                    totalIncome: parseFloat(r.total_income),
                    totalExpenses: parseFloat(r.total_expenses),
                    netIncome: parseFloat(r.total_income) - parseFloat(r.total_expenses),
                    shiftsCount: parseInt(r.shifts_count),
                    avgTransaction: parseFloat(parseFloat(r.avg_transaction).toFixed(2))
                }))
            }
        });
    } catch (error) {
        next(error);
    }
});

// ==================== CUADRE DE CAJA ====================

/**
 * @route   GET /api/v1/reports/cash-reconciliation
 * @desc    Reporte detallado de cuadres de caja
 * @access  Private (Admin)
 */
router.get('/cash-reconciliation', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const { period = 'month', from: customFrom, to: customTo } = req.query;
        const { from, to } = getDateRange(period, customFrom, customTo);

        // Summary
        const summary = await query(`
            SELECT
                COUNT(*) as total_closures,
                COALESCE(SUM(expected_balance), 0) as total_expected,
                COALESCE(SUM(counted_balance), 0) as total_counted,
                COALESCE(SUM(difference), 0) as net_difference,
                COALESCE(SUM(ABS(difference)), 0) as abs_difference,
                COALESCE(AVG(ABS(difference)), 0) as avg_difference,
                MAX(ABS(difference)) as max_difference,
                COUNT(*) FILTER (WHERE difference > 0) as surplus_count,
                COUNT(*) FILTER (WHERE difference < 0) as shortage_count,
                COUNT(*) FILTER (WHERE difference = 0) as exact_count,
                COUNT(*) FILTER (WHERE requires_approval = true) as flagged_count,
                COUNT(*) FILTER (WHERE approved_by IS NOT NULL) as approved_count
            FROM cash_registers
            WHERE status = 'closed' AND closed_at >= $1 AND closed_at <= $2
        `, [from, to]);

        // Detail per closure
        const closures = await query(`
            SELECT
                cr.id, cr.name as register_name,
                cr.opened_at, cr.closed_at,
                cr.opening_balance, cr.expected_balance, cr.counted_balance,
                cr.difference, cr.requires_approval,
                cr.approved_by IS NOT NULL as is_approved,
                u_op.email as operator_email,
                COALESCE(c_op.first_name || ' ' || c_op.last_name, u_op.email) as operator_name,
                (SELECT COUNT(*) FROM cash_register_transactions t WHERE t.cash_register_id = cr.id AND t.type = 'payment') as payment_count,
                (SELECT COUNT(*) FROM cash_register_transactions t WHERE t.cash_register_id = cr.id AND t.type = 'refund') as refund_count,
                (SELECT COALESCE(SUM(t.amount), 0) FROM cash_register_transactions t WHERE t.cash_register_id = cr.id AND t.direction = 'in') as total_in,
                (SELECT COALESCE(SUM(t.amount), 0) FROM cash_register_transactions t WHERE t.cash_register_id = cr.id AND t.direction = 'out') as total_out
            FROM cash_registers cr
            JOIN users u_op ON cr.operator_id = u_op.id
            LEFT JOIN customers c_op ON c_op.user_id = u_op.id
            WHERE cr.status = 'closed' AND cr.closed_at >= $1 AND cr.closed_at <= $2
            ORDER BY cr.closed_at DESC
        `, [from, to]);

        // By operator
        const byOperator = await query(`
            SELECT
                u.id as operator_id,
                COALESCE(c.first_name || ' ' || c.last_name, u.email) as operator_name,
                COUNT(*) as closures,
                COALESCE(SUM(ABS(cr.difference)), 0) as total_abs_diff,
                COALESCE(AVG(ABS(cr.difference)), 0) as avg_diff,
                COUNT(*) FILTER (WHERE cr.difference = 0) as exact_closures,
                COUNT(*) FILTER (WHERE cr.requires_approval = true) as flagged_closures
            FROM cash_registers cr
            JOIN users u ON cr.operator_id = u.id
            LEFT JOIN customers c ON c.user_id = u.id
            WHERE cr.status = 'closed' AND cr.closed_at >= $1 AND cr.closed_at <= $2
            GROUP BY u.id, u.email, c.first_name, c.last_name
            ORDER BY total_abs_diff DESC
        `, [from, to]);

        const s = summary.rows[0];
        res.json({
            success: true,
            data: {
                period: { from, to },
                summary: {
                    totalClosures: parseInt(s.total_closures),
                    totalExpected: parseFloat(s.total_expected),
                    totalCounted: parseFloat(s.total_counted),
                    netDifference: parseFloat(s.net_difference),
                    absDifference: parseFloat(s.abs_difference),
                    avgDifference: parseFloat(parseFloat(s.avg_difference).toFixed(2)),
                    maxDifference: parseFloat(s.max_difference || 0),
                    surplusCount: parseInt(s.surplus_count),
                    shortageCount: parseInt(s.shortage_count),
                    exactCount: parseInt(s.exact_count),
                    flaggedCount: parseInt(s.flagged_count),
                    approvedCount: parseInt(s.approved_count)
                },
                closures: closures.rows.map(r => ({
                    id: r.id,
                    registerName: r.register_name,
                    operatorName: r.operator_name,
                    openedAt: r.opened_at,
                    closedAt: r.closed_at,
                    openingBalance: parseFloat(r.opening_balance),
                    expectedBalance: parseFloat(r.expected_balance),
                    countedBalance: parseFloat(r.counted_balance),
                    difference: parseFloat(r.difference),
                    requiresApproval: r.requires_approval,
                    isApproved: r.is_approved,
                    paymentCount: parseInt(r.payment_count),
                    refundCount: parseInt(r.refund_count),
                    totalIn: parseFloat(r.total_in),
                    totalOut: parseFloat(r.total_out)
                })),
                byOperator: byOperator.rows.map(r => ({
                    operatorId: r.operator_id,
                    operatorName: r.operator_name,
                    closures: parseInt(r.closures),
                    totalAbsDiff: parseFloat(r.total_abs_diff),
                    avgDiff: parseFloat(parseFloat(r.avg_diff).toFixed(2)),
                    exactClosures: parseInt(r.exact_closures),
                    flaggedClosures: parseInt(r.flagged_closures)
                }))
            }
        });
    } catch (error) {
        next(error);
    }
});

// ==================== CLIENTES ====================

/**
 * @route   GET /api/v1/reports/customers
 * @desc    Metricas de clientes: nuevos, cancelados, top clientes, morosidad
 * @access  Private (Admin)
 */
router.get('/customers', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const { period = 'month', from: customFrom, to: customTo } = req.query;
        const { from, to } = getDateRange(period, customFrom, customTo);

        // New customers trend (by week)
        const newCustomersTrend = await query(`
            SELECT
                DATE_TRUNC('week', c.created_at) as period,
                COUNT(*) as count
            FROM customers c
            WHERE c.created_at >= $1 AND c.created_at <= $2
            GROUP BY DATE_TRUNC('week', c.created_at)
            ORDER BY period ASC
        `, [from, to]);

        // Subscription status distribution
        const statusDistribution = await query(`
            SELECT
                status,
                COUNT(*) as count
            FROM subscriptions
            GROUP BY status
            ORDER BY count DESC
        `);

        // Top customers by revenue
        const topCustomers = await query(`
            SELECT
                c.id as customer_id,
                c.first_name || ' ' || c.last_name as customer_name,
                c.id_document,
                COUNT(p.id) as payment_count,
                COALESCE(SUM(p.total_amount), 0) as total_paid,
                COUNT(DISTINCT s.id) as subscription_count,
                MIN(c.created_at) as customer_since
            FROM customers c
            LEFT JOIN payments p ON p.customer_id = c.id AND p.status = 'paid' AND p.created_at >= $1 AND p.created_at <= $2
            LEFT JOIN subscriptions s ON s.customer_id = c.id AND s.status = 'active'
            GROUP BY c.id, c.first_name, c.last_name, c.id_document
            HAVING COALESCE(SUM(p.total_amount), 0) > 0
            ORDER BY total_paid DESC
            LIMIT 20
        `, [from, to]);

        // Delinquent accounts
        const delinquent = await query(`
            SELECT
                c.id as customer_id,
                c.first_name || ' ' || c.last_name as customer_name,
                s.status,
                p.name as plan_name,
                s.next_billing_date,
                s.price_per_period,
                CURRENT_DATE - s.next_billing_date as days_overdue
            FROM subscriptions s
            JOIN customers c ON s.customer_id = c.id
            JOIN plans p ON s.plan_id = p.id
            WHERE s.status IN ('past_due', 'suspended')
            ORDER BY days_overdue DESC NULLS LAST
        `);

        // Churn: cancelled this period
        const churned = await query(`
            SELECT
                DATE_TRUNC('week', cancelled_at) as period,
                COUNT(*) as count
            FROM subscriptions
            WHERE cancelled_at >= $1 AND cancelled_at <= $2
            GROUP BY DATE_TRUNC('week', cancelled_at)
            ORDER BY period ASC
        `, [from, to]);

        // Retention rate
        const retention = await query(`
            SELECT
                COUNT(*) FILTER (WHERE status = 'active') as active,
                COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
                COUNT(*) as total
            FROM subscriptions
            WHERE activated_at IS NOT NULL
        `);

        const ret = retention.rows[0];
        const retentionRate = parseInt(ret.total) > 0
            ? (parseInt(ret.active) / parseInt(ret.total) * 100) : 100;

        res.json({
            success: true,
            data: {
                period: { from, to },
                newCustomersTrend: newCustomersTrend.rows.map(r => ({
                    period: r.period,
                    count: parseInt(r.count)
                })),
                statusDistribution: statusDistribution.rows.map(r => ({
                    status: r.status,
                    count: parseInt(r.count)
                })),
                topCustomers: topCustomers.rows.map(r => ({
                    customerId: r.customer_id,
                    customerName: r.customer_name,
                    idDocument: r.id_document,
                    paymentCount: parseInt(r.payment_count),
                    totalPaid: parseFloat(r.total_paid),
                    subscriptionCount: parseInt(r.subscription_count),
                    customerSince: r.customer_since
                })),
                delinquent: delinquent.rows.map(r => ({
                    customerId: r.customer_id,
                    customerName: r.customer_name,
                    status: r.status,
                    planName: r.plan_name,
                    nextBillingDate: r.next_billing_date,
                    pricePerPeriod: parseFloat(r.price_per_period),
                    daysOverdue: parseInt(r.days_overdue || 0)
                })),
                churnTrend: churned.rows.map(r => ({
                    period: r.period,
                    count: parseInt(r.count)
                })),
                retentionRate: Math.round(retentionRate * 100) / 100
            }
        });
    } catch (error) {
        next(error);
    }
});

// ==================== OCUPACION ====================

/**
 * @route   GET /api/v1/reports/occupancy
 * @desc    Ocupacion historica, horas pico, tendencias
 * @access  Private (Admin)
 */
router.get('/occupancy', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const { period = 'week', from: customFrom, to: customTo } = req.query;
        const { from, to } = getDateRange(period, customFrom, customTo);

        // Current occupancy by plan
        const currentOccupancy = await query(`SELECT * FROM current_occupancy_by_plan`);

        // Peak hours analysis (entries by hour of day)
        const peakHours = await query(`
            SELECT
                EXTRACT(HOUR FROM timestamp) as hour,
                COUNT(*) as entry_count
            FROM access_events
            WHERE type = 'entry' AND timestamp >= $1 AND timestamp <= $2
            GROUP BY EXTRACT(HOUR FROM timestamp)
            ORDER BY hour ASC
        `, [from, to]);

        // Peak days of week
        const peakDays = await query(`
            SELECT
                EXTRACT(DOW FROM timestamp) as day_of_week,
                COUNT(*) as entry_count
            FROM access_events
            WHERE type = 'entry' AND timestamp >= $1 AND timestamp <= $2
            GROUP BY EXTRACT(DOW FROM timestamp)
            ORDER BY day_of_week ASC
        `, [from, to]);

        // Daily occupancy trend
        const occupancyTrend = await query(`
            SELECT
                DATE_TRUNC('day', ae.timestamp)::date as date,
                COUNT(*) FILTER (WHERE ae.type = 'entry') as entries,
                COUNT(*) FILTER (WHERE ae.type = 'exit') as exits
            FROM access_events ae
            WHERE ae.timestamp >= $1 AND ae.timestamp <= $2
            GROUP BY DATE_TRUNC('day', ae.timestamp)::date
            ORDER BY date ASC
        `, [from, to]);

        // Average session duration by plan
        const avgDuration = await query(`
            SELECT
                COALESCE(p.name, 'Parqueo por hora') as plan_name,
                COUNT(*) as session_count,
                COALESCE(AVG(ps.duration_minutes), 0) as avg_minutes,
                COALESCE(MIN(ps.duration_minutes), 0) as min_minutes,
                COALESCE(MAX(ps.duration_minutes), 0) as max_minutes
            FROM parking_sessions ps
            LEFT JOIN plans p ON ps.plan_id = p.id
            WHERE ps.exit_time IS NOT NULL AND ps.entry_time >= $1 AND ps.entry_time <= $2
            GROUP BY p.name
            ORDER BY session_count DESC
        `, [from, to]);

        // Access method distribution
        const accessMethods = await query(`
            SELECT
                COALESCE(access_method, validation_method, 'unknown') as method,
                COUNT(*) as count,
                COUNT(*) FILTER (WHERE type = 'entry') as entries,
                COUNT(*) FILTER (WHERE type = 'exit') as exits
            FROM access_events
            WHERE timestamp >= $1 AND timestamp <= $2
            GROUP BY COALESCE(access_method, validation_method, 'unknown')
            ORDER BY count DESC
        `, [from, to]);

        const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado'];

        res.json({
            success: true,
            data: {
                period: { from, to },
                currentOccupancy: currentOccupancy.rows,
                peakHours: peakHours.rows.map(r => ({
                    hour: parseInt(r.hour),
                    label: `${String(parseInt(r.hour)).padStart(2, '0')}:00`,
                    entryCount: parseInt(r.entry_count)
                })),
                peakDays: peakDays.rows.map(r => ({
                    dayOfWeek: parseInt(r.day_of_week),
                    dayName: dayNames[parseInt(r.day_of_week)],
                    entryCount: parseInt(r.entry_count)
                })),
                dailyTrend: occupancyTrend.rows.map(r => ({
                    date: r.date,
                    entries: parseInt(r.entries),
                    exits: parseInt(r.exits),
                    net: parseInt(r.entries) - parseInt(r.exits)
                })),
                avgDuration: avgDuration.rows.map(r => ({
                    planName: r.plan_name,
                    sessionCount: parseInt(r.session_count),
                    avgMinutes: Math.round(parseFloat(r.avg_minutes)),
                    minMinutes: parseInt(r.min_minutes),
                    maxMinutes: parseInt(r.max_minutes)
                })),
                accessMethods: accessMethods.rows.map(r => ({
                    method: r.method,
                    count: parseInt(r.count),
                    entries: parseInt(r.entries),
                    exits: parseInt(r.exits)
                }))
            }
        });
    } catch (error) {
        next(error);
    }
});

// ==================== SESIONES DE PARQUEO ====================

/**
 * @route   GET /api/v1/reports/sessions
 * @desc    Reporte de sesiones de parqueo por hora
 * @access  Private (Admin)
 */
router.get('/sessions', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const { period = 'month', from: customFrom, to: customTo } = req.query;
        const { from, to } = getDateRange(period, customFrom, customTo);

        // Summary
        const summary = await query(`
            SELECT
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE status = 'active') as active,
                COUNT(*) FILTER (WHERE status = 'paid') as paid,
                COUNT(*) FILTER (WHERE status = 'closed') as closed,
                COUNT(*) FILTER (WHERE status = 'abandoned') as abandoned,
                COALESCE(SUM(paid_amount) FILTER (WHERE payment_status = 'paid'), 0) as total_revenue,
                COALESCE(AVG(duration_minutes) FILTER (WHERE exit_time IS NOT NULL), 0) as avg_duration,
                COALESCE(AVG(paid_amount) FILTER (WHERE payment_status = 'paid'), 0) as avg_ticket
            FROM parking_sessions
            WHERE entry_time >= $1 AND entry_time <= $2
        `, [from, to]);

        // Sessions timeline (daily)
        const timeline = await query(`
            SELECT
                DATE_TRUNC('day', entry_time)::date as date,
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE payment_status = 'paid') as paid,
                COUNT(*) FILTER (WHERE status = 'abandoned') as abandoned,
                COALESCE(SUM(paid_amount) FILTER (WHERE payment_status = 'paid'), 0) as revenue
            FROM parking_sessions
            WHERE entry_time >= $1 AND entry_time <= $2
            GROUP BY DATE_TRUNC('day', entry_time)::date
            ORDER BY date ASC
        `, [from, to]);

        // By access method
        const byAccessMethod = await query(`
            SELECT
                COALESCE(access_method::text, 'qr') as method,
                COUNT(*) as count,
                COALESCE(SUM(paid_amount) FILTER (WHERE payment_status = 'paid'), 0) as revenue
            FROM parking_sessions
            WHERE entry_time >= $1 AND entry_time <= $2
            GROUP BY access_method
            ORDER BY count DESC
        `, [from, to]);

        // Duration distribution (buckets)
        const durationDist = await query(`
            SELECT
                CASE
                    WHEN duration_minutes <= 30 THEN '0-30 min'
                    WHEN duration_minutes <= 60 THEN '30-60 min'
                    WHEN duration_minutes <= 120 THEN '1-2 horas'
                    WHEN duration_minutes <= 240 THEN '2-4 horas'
                    WHEN duration_minutes <= 480 THEN '4-8 horas'
                    ELSE '8+ horas'
                END as bucket,
                COUNT(*) as count,
                COALESCE(AVG(paid_amount) FILTER (WHERE payment_status = 'paid'), 0) as avg_paid
            FROM parking_sessions
            WHERE exit_time IS NOT NULL AND entry_time >= $1 AND entry_time <= $2
            GROUP BY
                CASE
                    WHEN duration_minutes <= 30 THEN '0-30 min'
                    WHEN duration_minutes <= 60 THEN '30-60 min'
                    WHEN duration_minutes <= 120 THEN '1-2 horas'
                    WHEN duration_minutes <= 240 THEN '2-4 horas'
                    WHEN duration_minutes <= 480 THEN '4-8 horas'
                    ELSE '8+ horas'
                END
            ORDER BY MIN(duration_minutes) ASC
        `, [from, to]);

        const s = summary.rows[0];
        res.json({
            success: true,
            data: {
                period: { from, to },
                summary: {
                    total: parseInt(s.total),
                    active: parseInt(s.active),
                    paid: parseInt(s.paid),
                    closed: parseInt(s.closed),
                    abandoned: parseInt(s.abandoned),
                    totalRevenue: parseFloat(s.total_revenue),
                    avgDuration: Math.round(parseFloat(s.avg_duration)),
                    avgTicket: parseFloat(parseFloat(s.avg_ticket).toFixed(2))
                },
                timeline: timeline.rows.map(r => ({
                    date: r.date,
                    total: parseInt(r.total),
                    paid: parseInt(r.paid),
                    abandoned: parseInt(r.abandoned),
                    revenue: parseFloat(r.revenue)
                })),
                byAccessMethod: byAccessMethod.rows.map(r => ({
                    method: r.method,
                    count: parseInt(r.count),
                    revenue: parseFloat(r.revenue)
                })),
                durationDistribution: durationDist.rows.map(r => ({
                    bucket: r.bucket,
                    count: parseInt(r.count),
                    avgPaid: parseFloat(parseFloat(r.avg_paid).toFixed(2))
                }))
            }
        });
    } catch (error) {
        next(error);
    }
});

// ==================== FACTURAS ====================

/**
 * @route   GET /api/v1/reports/invoices
 * @desc    Reporte de facturacion
 * @access  Private (Admin)
 */
router.get('/invoices', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const { period = 'month', from: customFrom, to: customTo } = req.query;
        const { from, to } = getDateRange(period, customFrom, customTo);

        const summary = await query(`
            SELECT
                COUNT(*) as total_invoices,
                COALESCE(SUM(total), 0) as total_amount,
                COALESCE(SUM(subtotal), 0) as total_subtotal,
                COALESCE(SUM(tax_amount), 0) as total_tax,
                COUNT(DISTINCT customer_id) as unique_customers
            FROM invoices
            WHERE created_at >= $1 AND created_at <= $2
        `, [from, to]);

        const byNCFType = await query(`
            SELECT
                CASE
                    WHEN ncf LIKE 'B01%' THEN 'Consumidor Final (B01)'
                    WHEN ncf LIKE 'B14%' THEN 'Credito Fiscal (B14)'
                    WHEN ncf LIKE 'B04%' THEN 'Nota de Credito (B04)'
                    ELSE 'Sin NCF'
                END as ncf_type,
                COUNT(*) as count,
                COALESCE(SUM(total), 0) as total
            FROM invoices
            WHERE created_at >= $1 AND created_at <= $2
            GROUP BY
                CASE
                    WHEN ncf LIKE 'B01%' THEN 'Consumidor Final (B01)'
                    WHEN ncf LIKE 'B14%' THEN 'Credito Fiscal (B14)'
                    WHEN ncf LIKE 'B04%' THEN 'Nota de Credito (B04)'
                    ELSE 'Sin NCF'
                END
            ORDER BY count DESC
        `, [from, to]);

        const timeline = await query(`
            SELECT
                DATE_TRUNC('day', created_at)::date as date,
                COUNT(*) as count,
                COALESCE(SUM(total), 0) as total
            FROM invoices
            WHERE created_at >= $1 AND created_at <= $2
            GROUP BY DATE_TRUNC('day', created_at)::date
            ORDER BY date ASC
        `, [from, to]);

        const s = summary.rows[0];
        res.json({
            success: true,
            data: {
                period: { from, to },
                summary: {
                    totalInvoices: parseInt(s.total_invoices),
                    totalAmount: parseFloat(s.total_amount),
                    totalSubtotal: parseFloat(s.total_subtotal),
                    totalTax: parseFloat(s.total_tax),
                    uniqueCustomers: parseInt(s.unique_customers)
                },
                byNCFType: byNCFType.rows.map(r => ({
                    type: r.ncf_type,
                    count: parseInt(r.count),
                    total: parseFloat(r.total)
                })),
                timeline: timeline.rows.map(r => ({
                    date: r.date,
                    count: parseInt(r.count),
                    total: parseFloat(r.total)
                }))
            }
        });
    } catch (error) {
        next(error);
    }
});

// ==================== INCIDENTES ====================

/**
 * @route   GET /api/v1/reports/incidents
 * @desc    Reporte de incidentes
 * @access  Private (Admin)
 */
router.get('/incidents', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const { period = 'month', from: customFrom, to: customTo } = req.query;
        const { from, to } = getDateRange(period, customFrom, customTo);

        const summary = await query(`
            SELECT
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE status = 'open') as open_count,
                COUNT(*) FILTER (WHERE status = 'closed' OR status = 'resolved') as resolved_count,
                COUNT(*) FILTER (WHERE severity = 'high' OR severity = 'critical') as high_severity
            FROM incidents
            WHERE created_at >= $1 AND created_at <= $2
        `, [from, to]);

        const byType = await query(`
            SELECT type, COUNT(*) as count
            FROM incidents
            WHERE created_at >= $1 AND created_at <= $2
            GROUP BY type ORDER BY count DESC
        `, [from, to]);

        const bySeverity = await query(`
            SELECT severity, COUNT(*) as count
            FROM incidents
            WHERE created_at >= $1 AND created_at <= $2
            GROUP BY severity ORDER BY count DESC
        `, [from, to]);

        const s = summary.rows[0];
        res.json({
            success: true,
            data: {
                period: { from, to },
                summary: {
                    total: parseInt(s.total),
                    open: parseInt(s.open_count),
                    resolved: parseInt(s.resolved_count),
                    highSeverity: parseInt(s.high_severity)
                },
                byType: byType.rows.map(r => ({ type: r.type, count: parseInt(r.count) })),
                bySeverity: bySeverity.rows.map(r => ({ severity: r.severity, count: parseInt(r.count) }))
            }
        });
    } catch (error) {
        next(error);
    }
});

// ==================== EXPORT CSV ====================

/**
 * @route   GET /api/v1/reports/export/:type
 * @desc    Exportar reporte en CSV
 * @access  Private (Admin)
 */
router.get('/export/:type', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        const { type } = req.params;
        const { period = 'month', from: customFrom, to: customTo } = req.query;
        const { from, to } = getDateRange(period, customFrom, customTo);

        let rows = [];
        let filename = '';
        let headers = [];

        switch (type) {
            case 'payments': {
                const result = await query(`
                    SELECT
                        p.created_at as fecha,
                        COALESCE(c.first_name || ' ' || c.last_name, 'N/A') as cliente,
                        p.total_amount as monto,
                        p.payment_method as metodo_pago,
                        p.status as estado,
                        COALESCE(pl.name, 'Parqueo por hora') as plan
                    FROM payments p
                    LEFT JOIN customers c ON p.customer_id = c.id
                    LEFT JOIN subscriptions s ON p.subscription_id = s.id
                    LEFT JOIN plans pl ON s.plan_id = pl.id
                    WHERE p.created_at >= $1 AND p.created_at <= $2
                    ORDER BY p.created_at DESC
                `, [from, to]);
                rows = result.rows;
                headers = ['fecha', 'cliente', 'monto', 'metodo_pago', 'estado', 'plan'];
                filename = 'pagos';
                break;
            }
            case 'cash-registers': {
                const result = await query(`
                    SELECT
                        cr.closed_at as fecha_cierre,
                        COALESCE(co.first_name || ' ' || co.last_name, u.email) as operador,
                        cr.opening_balance as saldo_apertura,
                        cr.expected_balance as saldo_esperado,
                        cr.counted_balance as saldo_contado,
                        cr.difference as diferencia,
                        CASE WHEN cr.requires_approval THEN 'Si' ELSE 'No' END as requiere_aprobacion
                    FROM cash_registers cr
                    JOIN users u ON cr.operator_id = u.id
                    LEFT JOIN customers co ON co.user_id = u.id
                    WHERE cr.status = 'closed' AND cr.closed_at >= $1 AND cr.closed_at <= $2
                    ORDER BY cr.closed_at DESC
                `, [from, to]);
                rows = result.rows;
                headers = ['fecha_cierre', 'operador', 'saldo_apertura', 'saldo_esperado', 'saldo_contado', 'diferencia', 'requiere_aprobacion'];
                filename = 'cuadre_caja';
                break;
            }
            case 'sessions': {
                const result = await query(`
                    SELECT
                        ps.entry_time as entrada,
                        ps.exit_time as salida,
                        ps.vehicle_plate as placa,
                        COALESCE(p.name, 'N/A') as plan,
                        COALESCE(ps.duration_minutes, 0) as duracion_min,
                        COALESCE(ps.paid_amount, 0) as monto_pagado,
                        ps.status as estado
                    FROM parking_sessions ps
                    LEFT JOIN plans p ON ps.plan_id = p.id
                    WHERE ps.entry_time >= $1 AND ps.entry_time <= $2
                    ORDER BY ps.entry_time DESC
                `, [from, to]);
                rows = result.rows;
                headers = ['entrada', 'salida', 'placa', 'plan', 'duracion_min', 'monto_pagado', 'estado'];
                filename = 'sesiones_parqueo';
                break;
            }
            case 'customers': {
                const result = await query(`
                    SELECT
                        c.first_name || ' ' || c.last_name as nombre,
                        c.id_document as documento,
                        u.email,
                        u.phone as telefono,
                        c.created_at as fecha_registro,
                        COUNT(DISTINCT s.id) as suscripciones_activas,
                        COALESCE(SUM(p.total_amount), 0) as total_pagado
                    FROM customers c
                    JOIN users u ON c.user_id = u.id
                    LEFT JOIN subscriptions s ON s.customer_id = c.id AND s.status = 'active'
                    LEFT JOIN payments p ON p.customer_id = c.id AND p.status = 'paid'
                    GROUP BY c.id, c.first_name, c.last_name, c.id_document, u.email, u.phone, c.created_at
                    ORDER BY total_pagado DESC
                `, []);
                rows = result.rows;
                headers = ['nombre', 'documento', 'email', 'telefono', 'fecha_registro', 'suscripciones_activas', 'total_pagado'];
                filename = 'clientes';
                break;
            }
            default:
                return res.status(400).json({ success: false, error: 'Tipo de reporte no valido' });
        }

        // If format=json requested (for frontend Excel/CSV generation), return JSON
        if (req.query.format === 'json') {
            return res.json({ success: true, data: { headers, rows, filename } });
        }

        // Otherwise return raw CSV download
        const escapeCsv = (val) => {
            if (val === null || val === undefined) return '';
            const str = String(val);
            if (str.includes(',') || str.includes('"') || str.includes('\n')) {
                return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
        };

        const csvHeader = headers.join(',');
        const csvRows = rows.map(row => headers.map(h => escapeCsv(row[h])).join(','));
        const csv = [csvHeader, ...csvRows].join('\n');

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}_${new Date().toISOString().split('T')[0]}.csv"`);
        res.send('\uFEFF' + csv); // BOM for Excel UTF-8
    } catch (error) {
        next(error);
    }
});

module.exports = router;
