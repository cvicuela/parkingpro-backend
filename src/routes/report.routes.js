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

/**
 * @route   GET /api/v1/reports/active-vehicles
 * @desc    Obtener vehiculos activos (dentro del parqueo ahora)
 * @access  Private (Operator, Admin)
 */
router.get('/active-vehicles', authenticate, authorize(['operator', 'admin', 'super_admin']), async (req, res, next) => {
    try {
        // Vehiculos con suscripcion que tienen entrada sin salida
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

        // Vehiculos en sesion por hora activa
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

        const allActive = [
            ...subscriptionVehicles.rows,
            ...hourlyVehicles.rows
        ];

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

module.exports = router;
