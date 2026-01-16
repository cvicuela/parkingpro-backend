const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { query } = require('../config/database');

/**
 * @route   GET /api/v1/reports/dashboard
 * @desc    Obtener KPIs del dashboard
 * @access  Private (Admin)
 */
router.get('/dashboard', authenticate, authorize(['admin', 'super_admin']), async (req, res, next) => {
    try {
        // Total Revenue
        const revenueResult = await query(
            `SELECT COALESCE(SUM(total_amount), 0) as total_revenue
             FROM payments
             WHERE status = 'paid'
               AND created_at >= CURRENT_DATE - INTERVAL '30 days'`
        );
        
        // Active Customers
        const customersResult = await query(
            `SELECT COUNT(DISTINCT customer_id) as active_customers
             FROM subscriptions
             WHERE status = 'active'`
        );
        
        // Total Subscriptions
        const subscriptionsResult = await query(
            `SELECT COUNT(*) as total_subscriptions
             FROM subscriptions
             WHERE status = 'active'`
        );
        
        // Occupancy by Plan
        const occupancyResult = await query(
            `SELECT * FROM current_occupancy_by_plan`
        );
        
        // Overdue
        const overdueResult = await query(
            `SELECT COUNT(*) as overdue_count
             FROM subscriptions
             WHERE status = 'past_due'`
        );
        
        res.json({
            success: true,
            data: {
                revenue: parseFloat(revenueResult.rows[0].total_revenue),
                activeCustomers: parseInt(customersResult.rows[0].active_customers),
                totalSubscriptions: parseInt(subscriptionsResult.rows[0].total_subscriptions),
                overdueCount: parseInt(overdueResult.rows[0].overdue_count),
                occupancyByPlan: occupancyResult.rows
            }
        });
        
    } catch (error) {
        next(error);
    }
});

module.exports = router;
