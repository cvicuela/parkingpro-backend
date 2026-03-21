const webPush = require('web-push');
const { query } = require('../config/database');

// Configure VAPID keys from env, or auto-generate if not set
let VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
let VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL = process.env.VAPID_EMAIL || 'mailto:admin@parkingpro.do';

if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
  // Auto-generate VAPID keys for development/first-run
  const generated = webPush.generateVAPIDKeys();
  VAPID_PUBLIC = generated.publicKey;
  VAPID_PRIVATE = generated.privateKey;
  console.log('[PushService] VAPID keys auto-generated (set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY env vars for production)');
  console.log('[PushService] VAPID_PUBLIC_KEY=' + VAPID_PUBLIC);
  console.log('[PushService] VAPID_PRIVATE_KEY=' + VAPID_PRIVATE);
}

webPush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
console.log('[PushService] VAPID keys configured');

/**
 * Save a push subscription for a user
 */
async function saveSubscription(userId, subscription, userAgent) {
  // Upsert based on endpoint to avoid duplicates
  const result = await query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE SET
       user_id = $1, p256dh = $3, auth = $4, user_agent = $5, updated_at = NOW()
     RETURNING id`,
    [userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, userAgent || null]
  );
  return result.rows[0];
}

/**
 * Remove a push subscription
 */
async function removeSubscription(endpoint) {
  await query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
}

/**
 * Send push to a specific user
 */
async function sendToUser(userId, payload) {
  const subs = await query(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`,
    [userId]
  );

  const results = { sent: 0, failed: 0, cleaned: 0 };

  for (const sub of subs.rows) {
    try {
      await webPush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload)
      );
      results.sent++;
    } catch (err) {
      results.failed++;
      // Remove expired/invalid subscriptions (410 Gone, 404 Not Found)
      if (err.statusCode === 410 || err.statusCode === 404) {
        await query(`DELETE FROM push_subscriptions WHERE id = $1`, [sub.id]);
        results.cleaned++;
      }
    }
  }
  return results;
}

/**
 * Send push to all users with a specific role
 */
async function sendToRole(role, payload) {
  const subs = await query(
    `SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth
     FROM push_subscriptions ps
     JOIN users u ON u.id = ps.user_id
     WHERE u.role = $1 AND u.status = 'active'`,
    [role]
  );

  const results = { sent: 0, failed: 0, cleaned: 0 };

  for (const sub of subs.rows) {
    try {
      await webPush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload)
      );
      results.sent++;
    } catch (err) {
      results.failed++;
      if (err.statusCode === 410 || err.statusCode === 404) {
        await query(`DELETE FROM push_subscriptions WHERE id = $1`, [sub.id]);
        results.cleaned++;
      }
    }
  }
  return results;
}

/**
 * Send push to ALL subscribed users
 */
async function sendToAll(payload) {
  const subs = await query(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions`
  );

  const results = { sent: 0, failed: 0, cleaned: 0 };

  for (const sub of subs.rows) {
    try {
      await webPush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload)
      );
      results.sent++;
    } catch (err) {
      results.failed++;
      if (err.statusCode === 410 || err.statusCode === 404) {
        await query(`DELETE FROM push_subscriptions WHERE id = $1`, [sub.id]);
        results.cleaned++;
      }
    }
  }
  return results;
}

/**
 * Get VAPID public key for client registration
 */
function getPublicKey() {
  return VAPID_PUBLIC || null;
}

module.exports = {
  saveSubscription,
  removeSubscription,
  sendToUser,
  sendToRole,
  sendToAll,
  getPublicKey,
};
