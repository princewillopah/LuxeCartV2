/**
 * Notification Service — Port 3009
 *
 * CONSUMES events from RabbitMQ:
 *   user.registered    → welcome notification
 *   order.created      → order confirmation
 *   payment.completed  → payment receipt
 *   payment.failed     → payment failure alert
 *   order.status_updated → shipping/delivery update
 */

const express = require('express');
const { logger, requestLogger } = require('./shared/logger')('notification-service');

const cors    = require('cors');
const { Pool } = require('pg');
const { consumeEvents } = require('./shared/eventBus');
// Prometheus metrics
const promClient = require('prom-client');
const register = new promClient.Registry();

const app  = express();
const PORT = process.env.PORT || 3009;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.use(cors());
app.use(express.json());

app.use(requestLogger);

// ── Helper: persist to PostgreSQL ──────────────────────────
async function saveNotification(userId, type, title, message, data = {}) {
  try {
    const result = await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, data)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [userId, type, title, message, JSON.stringify(data)]
    );
    console.log(`[Notification] Saved → user ${userId}: "${title}"`);
    return result.rows[0];
  } catch (err) {
    console.error('[Notification] DB save error:', err.message);
  }
}

// ── Start RabbitMQ consumers ────────────────────────────────
async function startEventConsumers() {
  await consumeEvents('user.registered', async (data) => {
    await saveNotification(
      data.userId, 'welcome',
      'Welcome to LuxeCart! 🎉',
      `Hi ${data.firstName}, your account has been created. Start shopping!`,
      { email: data.email }
    );
  }, 'notification_user_registered');

  await consumeEvents('order.created', async (data) => {
    const itemCount = data.items?.length || 0;
    const summary = data.items?.map(i => `${i.name || i.product_name} x${i.quantity}`).join(', ') || 'items';
    await saveNotification(
      data.userId, 'order_confirmation',
      `Order #${data.id} Confirmed ✅`,
      `Your order of ${itemCount} item(s) (${summary}) for $${parseFloat(data.total).toFixed(2)} has been placed.`,
      { orderId: data.id, total: data.total }
    );
  }, 'notification_order_created');

  await consumeEvents('payment.completed', async (data) => {
    await saveNotification(
      data.userId, 'payment_success',
      'Payment Successful 💳',
      `Payment of $${parseFloat(data.amount).toFixed(2)} via ${data.method} was successful. Txn: ${data.transactionId}`,
      { orderId: data.orderId, transactionId: data.transactionId }
    );
  }, 'notification_payment_completed');

  await consumeEvents('payment.failed', async (data) => {
    await saveNotification(
      data.userId, 'payment_failed',
      'Payment Failed ❌',
      `Your payment of $${parseFloat(data.amount).toFixed(2)} for Order #${data.orderId} failed. Please try again.`,
      { orderId: data.orderId, reason: data.reason }
    );
  }, 'notification_payment_failed');

  await consumeEvents('order.status_updated', async (data) => {
    const msgs = {
      processing: 'Your order is being processed.',
      shipped:    'Your order has been shipped! 🚚',
      delivered:  'Your order has been delivered! 📦',
      cancelled:  'Your order has been cancelled.',
      refunded:   'Your refund has been processed.'
    };
    await saveNotification(
      data.userId, 'order_update',
      `Order #${data.orderId} — ${data.status}`,
      msgs[data.status] || `Order status updated to: ${data.status}`,
      { orderId: data.orderId, status: data.status }
    );
  }, 'notification_order_status');

  console.log('[Notification] All event consumers registered ✅');
}

// ── HTTP endpoints ──────────────────────────────────────────
app.get('/health', (req, res) =>
  res.json({ status: 'Notification Service running', consumers: 'active' })
);


///// prometheus
register.setDefaultLabels({
  service: 'notification-service'
});

promClient.collectDefaultMetrics({ register });

const httpRequestCounter = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['service', 'method', 'route', 'status']
});

const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['service', 'method', 'route'],
  buckets: [0.1, 0.3, 0.5, 1, 2, 5]
});

register.registerMetric(httpRequestCounter);
register.registerMetric(httpRequestDuration);

// ✅ middleware
app.use((req, res, next) => {
  if (req.path === '/metrics') return next(); 

  const start = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;

    const route = req.route?.path || req.path || 'unknown';

    httpRequestCounter.inc({
      service: 'notification-service',
      method: req.method,
      route,
      status: res.statusCode
    });

    httpRequestDuration.observe(
      {
        service: 'notification-service',
        method: req.method,
        route
      },
      duration
    );
  });

  next();
});


app.get('/user/:userId', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.params.userId]
    );
    res.json(r.rows);
  } catch { res.status(500).json({ error: 'Failed to fetch' }); }
});

app.get('/user/:userId/unread-count', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND read = false',
      [req.params.userId]
    );
    res.json({ count: parseInt(r.rows[0].count) });
  } catch { res.status(500).json({ error: 'Failed to fetch count' }); }
});

app.patch('/:id/read', async (req, res) => {
  try {
    const r = await pool.query(
      'UPDATE notifications SET read = true WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch { res.status(500).json({ error: 'Failed to update' }); }
});

app.patch('/user/:userId/read-all', async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET read = true WHERE user_id = $1', [req.params.userId]);
    res.json({ message: 'All marked as read' });
  } catch { res.status(500).json({ error: 'Failed to update' }); }
});

app.post('/send', async (req, res) => {
  const { userId, type, title, message, data } = req.body;
  if (!userId || !type || !title || !message)
    return res.status(400).json({ error: 'Missing required fields' });
  const n = await saveNotification(userId, type, title, message, data);
  res.status(201).json(n);
});



app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.listen(PORT, () => {
  console.log(`Notification Service running on port ${PORT}`);
  setTimeout(startEventConsumers, 5000);
});
