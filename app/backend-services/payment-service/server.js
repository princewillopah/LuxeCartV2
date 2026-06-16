/**
 * Payment Service — Paystack integration
 *
 * Flow:
 *   1. Frontend posts the order to order-service, gets back orderId + total.
 *   2. Frontend calls POST /initialize { orderId, amount, email }.
 *      We create a 'pending' payment row, call Paystack to open a
 *      transaction, and return Paystack's authorization_url.
 *   3. Frontend redirects the browser to authorization_url.
 *   4. Customer pays on Paystack's hosted page.
 *   5. Paystack redirects the browser to /checkout/callback?reference=...
 *      The frontend calls GET /verify/:reference. We re-check Paystack's
 *      records, mark the payment + order as paid/failed, publish the event.
 *   6. In parallel (server-to-server), Paystack POSTs /webhook with the
 *      same status. This is the source of truth — webhook fires even if
 *      the user closes the browser.
 *
 * Why two confirmation channels?
 *   `/verify` is for instant UI feedback. `/webhook` is for reliability.
 *   Both call the same internal `settlePayment()` helper which is
 *   idempotent on `reference` so duplicate calls are a no-op.
 *
 * Currency:
 *   Paystack quotes amounts in the lowest unit of the currency. For NGN
 *   that's kobo (1 NGN = 100 kobo). We accept NGN from our DB and convert
 *   at the boundary.
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
const { logger, requestLogger } = require('./shared/logger')('payment-service');
const { publishEvent } = require('./shared/eventBus');
const promClient = require('prom-client');

const app = express();
const PORT = process.env.PORT || 3008;

// Paystack config
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const PAYSTACK_BASE_URL = 'https://api.paystack.co';
const PUBLIC_FRONTEND_URL =
  process.env.PUBLIC_FRONTEND_URL || 'http://localhost:18081';

if (!PAYSTACK_SECRET_KEY) {
  console.warn('[Payment] PAYSTACK_SECRET_KEY is not set; payments will fail.');
}

// Database
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgresql://ecommerce:ecommerce123@postgres:5432/ecommerce'
});

app.use(cors());

// CRITICAL: keep raw bytes for the webhook so we can HMAC-verify the body.
// `express.json()` would consume the stream and re-serialise; the resulting
// bytes would NOT match Paystack's signature. So we mount the JSON parser
// on every path EXCEPT /webhook.
app.use((req, res, next) => {
  if (req.path === '/webhook') return next();
  return express.json()(req, res, next);
});

app.use(requestLogger);

// ── Prometheus metrics ────────────────────────────────────────────────────
const register = new promClient.Registry();
register.setDefaultLabels({ service: 'payment-service' });
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

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.use((req, res, next) => {
  if (req.path === '/metrics') return next();
  const start = Date.now();
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const route = req.route?.path || req.path || 'unknown';
    httpRequestCounter.inc({
      service: 'payment-service',
      method: req.method,
      route,
      status: res.statusCode
    });
    httpRequestDuration.observe(
      { service: 'payment-service', method: req.method, route },
      duration
    );
  });
  next();
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'Payment Service running',
      database: 'connected',
      paystack: PAYSTACK_SECRET_KEY ? 'configured' : 'missing-key'
    });
  } catch (err) {
    res
      .status(503)
      .json({ status: 'Payment Service running', database: 'disconnected' });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Convert a major-unit amount (e.g. NGN 1500) to the lowest unit Paystack
 * expects (kobo: 150000). We round to avoid floating-point drift on amounts
 * like 19.99 × 100 = 1998.9999999999998.
 */
function toMinorUnits(amount) {
  return Math.round(Number(amount) * 100);
}

/**
 * Build the URL Paystack should redirect the customer back to once they
 * complete (or abandon) payment. The frontend page at /checkout/callback
 * picks up `?reference=...` and calls /verify.
 */
function buildCallbackUrl() {
  // strip trailing slash for clean concat
  const base = PUBLIC_FRONTEND_URL.replace(/\/$/, '');
  return `${base}/checkout/callback`;
}

/**
 * Wrap the Paystack REST API. Throws on non-2xx so callers can map to a 502.
 */
async function paystackRequest(method, path, body) {
  const res = await fetch(`${PAYSTACK_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === false) {
    const msg = data.message || `Paystack ${path} failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.paystack = data;
    throw err;
  }
  return data;
}

/**
 * Idempotent settlement: given a verified Paystack transaction, update the
 * matching payment row + parent order, then publish the lifecycle event.
 * Safe to call multiple times — the second call is a no-op once status
 * is already 'completed' or 'failed'.
 */
async function settlePayment(transaction) {
  const reference = transaction.reference;
  const succeeded = transaction.status === 'success';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT * FROM payments WHERE reference = $1 FOR UPDATE',
      [reference]
    );
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return { handled: false, reason: 'unknown_reference' };
    }
    const payment = existing.rows[0];

    // Already terminal? Don't double-publish events.
    if (payment.status === 'completed' || payment.status === 'failed') {
      await client.query('ROLLBACK');
      return { handled: true, alreadySettled: true, payment };
    }

    const nextStatus = succeeded ? 'completed' : 'failed';
    const failureReason = succeeded
      ? null
      : transaction.gateway_response || 'Payment not successful';
    // Compute paid_at in JS rather than via CASE-on-$1, otherwise Postgres
    // can't deduce the type of $1 when the same parameter appears in both
    // `SET status = $1` and a CASE comparison (errors as
    // "inconsistent types deduced for parameter $1").
    const paidAt = succeeded ? new Date() : null;

    const updated = await client.query(
      `UPDATE payments
         SET status = $1,
             failure_reason = $2,
             paid_at = COALESCE($3, paid_at),
             metadata = $4,
             transaction_id = COALESCE($5, transaction_id)
       WHERE id = $6
       RETURNING *`,
      [
        nextStatus,
        failureReason,
        paidAt,
        transaction,
        transaction.id ? String(transaction.id) : null,
        payment.id
      ]
    );

    if (succeeded && payment.order_id) {
      await client.query(
        `UPDATE orders SET status = 'processing', updated_at = NOW() WHERE id = $1 AND status = 'pending'`,
        [payment.order_id]
      );
    }

    await client.query('COMMIT');

    // Fetch buyer contact so downstream email-service can address them.
    const buyerLookup = await pool.query(
      'SELECT email, first_name FROM users WHERE id = $1',
      [payment.user_id]
    );
    const buyer = buyerLookup.rows[0] || {};

    const eventPayload = {
      paymentId: payment.id,
      orderId: payment.order_id,
      userId: payment.user_id,
      email: buyer.email || null,
      firstName: buyer.first_name || 'Customer',
      amount: parseFloat(payment.amount),
      reference,
      transactionId: transaction.id ? String(transaction.id) : null
    };

    if (succeeded) {
      publishEvent('payment.completed', {
        ...eventPayload,
        method: 'paystack',
        processedAt: updated.rows[0].paid_at
      }).catch((err) =>
        console.error('[Payment] payment.completed publish error:', err.message)
      );
    } else {
      publishEvent('payment.failed', {
        ...eventPayload,
        reason: failureReason,
        processedAt: new Date().toISOString()
      }).catch((err) =>
        console.error('[Payment] payment.failed publish error:', err.message)
      );
    }

    return { handled: true, alreadySettled: false, payment: updated.rows[0] };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Routes ────────────────────────────────────────────────────────────────

/**
 * POST /initialize
 * Body: { orderId, amount, email }
 *
 * Creates a 'pending' payment row, opens a Paystack transaction, and
 * returns the URL the frontend should redirect the browser to.
 */
app.post('/initialize', async (req, res) => {
  try {
    const { orderId, amount, email } = req.body;
    const callerUserId = req.header('x-user-id');

    if (!orderId || !amount || !email) {
      return res
        .status(400)
        .json({ error: 'orderId, amount and email are required' });
    }
    if (!callerUserId) {
      return res.status(401).json({ error: 'Unauthenticated' });
    }
    if (Number(amount) <= 0) {
      return res.status(400).json({ error: 'amount must be > 0' });
    }
    if (!PAYSTACK_SECRET_KEY) {
      return res
        .status(500)
        .json({ error: 'Payment gateway not configured' });
    }

    // Sanity-check: the order must exist and belong to the caller.
    const orderRow = await pool.query(
      'SELECT id, user_id, total, status FROM orders WHERE id = $1',
      [orderId]
    );
    if (orderRow.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    const order = orderRow.rows[0];
    if (String(order.user_id) !== String(callerUserId)) {
      return res
        .status(403)
        .json({ error: 'Order does not belong to this user' });
    }

    // A unique reference per attempt. We prepend the order id so support
    // staff can spot which order a Paystack reference belongs to at a glance.
    const reference = `LC-${order.id}-${Date.now()}-${crypto
      .randomBytes(4)
      .toString('hex')}`;

    // Insert pending payment row BEFORE calling Paystack. If Paystack errors
    // we mark it failed; if we crashed after a successful Paystack call
    // without the row we'd lose track of the customer's money.
    const insert = await pool.query(
      `INSERT INTO payments (order_id, user_id, amount, method, reference, status)
       VALUES ($1, $2, $3, 'paystack', $4, 'pending')
       RETURNING *`,
      [order.id, callerUserId, amount, reference]
    );

    let paystackData;
    try {
      paystackData = await paystackRequest('POST', '/transaction/initialize', {
        email,
        amount: toMinorUnits(amount),
        currency: 'NGN',
        reference,
        callback_url: buildCallbackUrl(),
        metadata: {
          orderId: order.id,
          userId: Number(callerUserId),
          custom_fields: [
            {
              display_name: 'Order ID',
              variable_name: 'order_id',
              value: String(order.id)
            }
          ]
        }
      });
    } catch (err) {
      // Mark the row failed so we don't leak orphaned 'pending' payments.
      await pool.query(
        `UPDATE payments SET status = 'failed', failure_reason = $1 WHERE id = $2`,
        [err.message.slice(0, 500), insert.rows[0].id]
      );
      console.error('[Payment] Paystack initialize failed:', err.message);
      return res
        .status(502)
        .json({ error: 'Could not start payment', details: err.message });
    }

    res.status(201).json({
      paymentId: insert.rows[0].id,
      reference,
      authorizationUrl: paystackData.data.authorization_url,
      accessCode: paystackData.data.access_code
    });
  } catch (err) {
    console.error('[Payment] /initialize error:', err);
    res.status(500).json({ error: 'Failed to initialize payment' });
  }
});

/**
 * GET /verify/:reference
 *
 * Called by the frontend callback page after the user is redirected back
 * from Paystack. Re-checks the transaction with Paystack (never trust the
 * browser) and runs idempotent settlement.
 */
app.get('/verify/:reference', async (req, res) => {
  try {
    const { reference } = req.params;
    if (!reference) {
      return res.status(400).json({ error: 'reference required' });
    }

    const data = await paystackRequest(
      'GET',
      `/transaction/verify/${encodeURIComponent(reference)}`
    );
    const trx = data.data;
    const result = await settlePayment(trx);

    if (!result.handled) {
      return res.status(404).json({ error: 'Unknown payment reference' });
    }

    // If the row was already settled (e.g. via webhook), the DB row is the
    // source of truth — don't let a (possibly later) Paystack response flip
    // a terminal state. Map the row's status onto the same shape as the
    // Paystack one ('completed' -> 'success', 'failed' -> 'failed').
    let status = trx.status;
    if (result.alreadySettled) {
      status = result.payment.status === 'completed' ? 'success' : 'failed';
    }

    res.json({
      reference,
      status, // 'success' | 'failed' | 'abandoned'
      amount: trx.amount / 100,
      currency: trx.currency,
      orderId: result.payment.order_id,
      paymentId: result.payment.id,
      alreadySettled: result.alreadySettled
    });
  } catch (err) {
    console.error('[Payment] /verify error:', err.message);
    res
      .status(err.status === 404 ? 404 : 502)
      .json({ error: 'Payment verification failed', details: err.message });
  }
});

/**
 * POST /webhook
 *
 * Paystack calls this server-to-server when a transaction reaches a
 * terminal state. We verify the HMAC-SHA512 signature against the raw
 * body to make sure it's really from Paystack, then run the same
 * settlement helper as /verify.
 *
 * Always responds 200 once the signature is valid so Paystack stops
 * retrying — settlement is idempotent, retries are safe.
 */
app.post('/webhook', express.raw({ type: '*/*' }), (req, res) => {
  if (!PAYSTACK_SECRET_KEY) {
    return res.status(500).end();
  }
  const signature = req.headers['x-paystack-signature'];
  if (!signature) {
    return res.status(401).end();
  }

  const expected = crypto
    .createHmac('sha512', PAYSTACK_SECRET_KEY)
    .update(req.body)
    .digest('hex');

  // timingSafeEqual on equal-length buffers; fall back to false on length diff
  let valid = false;
  try {
    const sigBuf = Buffer.from(String(signature), 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    valid =
      sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
  } catch {
    valid = false;
  }

  if (!valid) {
    console.warn('[Payment] webhook signature mismatch');
    return res.status(401).end();
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).end();
  }

  // ACK immediately so Paystack doesn't retry while we work.
  res.sendStatus(200);

  // Only one event type we actually care about right now.
  if (event.event === 'charge.success' || event.event === 'charge.failed') {
    settlePayment(event.data).catch((err) =>
      console.error('[Payment] webhook settlement error:', err.message)
    );
  }
});

// Read endpoints — used by the admin panel + account page.

app.get('/:paymentId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM payments WHERE id = $1', [
      req.params.paymentId
    ]);
    if (!result.rows.length)
      return res.status(404).json({ error: 'Payment not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch payment' });
  }
});

app.get('/order/:orderId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM payments WHERE order_id = $1 ORDER BY processed_at DESC',
      [req.params.orderId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Payment Service running on port ${PORT} (Paystack)`);
});
