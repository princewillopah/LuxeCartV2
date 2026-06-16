const express = require('express');
const { logger, requestLogger } = require('./shared/logger')('order-service');
const { createHttpClient, HttpClientError } = require('./shared/httpClient');

const cors = require('cors');
const { Pool } = require('pg');
const { publishEvent, consumeEvents } = require('./shared/eventBus');
// Prometheus metrics
const promClient = require('prom-client');
const register = new promClient.Registry();

const app = express();
const PORT = process.env.PORT || 3005;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Inventory service is queried synchronously during checkout to reserve
// stock. We keep the call short — if inventory is unreachable the customer
// gets a clean failure rather than a 10-second spinner.
const INVENTORY_SERVICE_URL = process.env.INVENTORY_SERVICE_URL || 'http://inventory-service:3011';
const INVENTORY_TIMEOUT_MS  = parseInt(process.env.INVENTORY_TIMEOUT_MS || '5000');

// Hardened HTTP client to inventory-service. POST /reserve is idempotent
// in inventory-service (INSERT ... ON CONFLICT (order_id, product_id) DO
// NOTHING after a per-product SELECT FOR UPDATE), so we opt-in to retry
// on transient network/5xx failures — a retried reserve for the same
// orderId+productId is a no-op.
const inventoryHttp = createHttpClient({
  target: 'inventory-service',
  baseUrl: INVENTORY_SERVICE_URL,
  register,
  promClient,
  logger,
  timeoutMs: INVENTORY_TIMEOUT_MS,
  retry:   { attempts: 2, baseDelayMs: 200, maxDelayMs: 1500 },
  breaker: {
    timeout:                  INVENTORY_TIMEOUT_MS + 500,
    errorThresholdPercentage: 50,
    resetTimeout:             10_000,
    volumeThreshold:          5,
    rollingCountTimeout:      30_000,
    rollingCountBuckets:      10,
  },
});

// Returns either { ok: true, body } or { ok: false, status, body }. We
// keep the call-site shape stable (status + body) so the orchestration
// inside the create-order route doesn't need to change.
async function reserveStock(orderId, items, requestId) {
  try {
    const body = await inventoryHttp.postJson(
      '/reserve',
      {
        orderId,
        items: items.map(i => ({
          productId: i.id || i.productId || i.product_id,
          quantity:  i.quantity || 1,
        })),
      },
      { idempotent: true, requestId }
    );
    return { status: 200, body: body || {} };
  } catch (err) {
    if (err instanceof HttpClientError && err.status) {
      let body = {};
      try { body = err.body ? JSON.parse(err.body) : {}; } catch (_) { /* leave {} */ }
      return { status: err.status, body };
    }
    throw err; // network/timeout/circuit-open — surface as 503 in caller
  }
}

app.use(cors());
app.use(express.json());

app.use(requestLogger);

app.get('/health', (req, res) => {
  res.json({ status: 'Order Service is running' });
});


///// prometheus
register.setDefaultLabels({
  service: 'order-service'
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
      service: 'order-service',
      method: req.method,
      route,
      status: res.statusCode
    });

    httpRequestDuration.observe(
      {
        service: 'order-service',
        method: req.method,
        route
      },
      duration
    );
  });

  next();
});

// Create order
app.post('/', async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { userId, items, total, shippingAddress, paymentMethod, userEmail, userFirstName, userLastName } = req.body;
    
    if (!userId || !items || !total) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Capture buyer info from the request (frontend has it post-login). The
    // gateway also forwards x-user-email when available, so we accept either
    // source. Under the database-per-service split, orders_db has NO access
    // to the users table (which lives in auth_db) — so we snapshot the
    // identity at order-create time and use the snapshot for every
    // subsequent enrichment (email payloads, status updates, etc).
    const buyerEmail     = userEmail     || req.headers['x-user-email'] || null;
    const buyerFirstName = userFirstName || null;
    const buyerLastName  = userLastName  || null;

    // Create order
    const orderResult = await client.query(
      `INSERT INTO orders (user_id, total, shipping_address, payment_method, status,
                           user_email, user_first_name, user_last_name)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7)
       RETURNING *`,
      [userId, total, JSON.stringify(shippingAddress), paymentMethod,
       buyerEmail, buyerFirstName, buyerLastName]
    );
    
    const order = orderResult.rows[0];

    // ── Reserve stock synchronously ──────────────────────────
    // Inventory-service is the sole owner of products.stock; it locks each
    // product row and writes a reservation. If any line is short we get 409
    // with the per-product breakdown and the whole order gets rolled back —
    // no orphan rows in orders/order_items.
    //
    // IMPORTANT: this MUST run before INSERT order_items below. Inserting
    // order_items takes an implicit KEY SHARE lock on the referenced
    // products row (FK validation), which would block inventory-service's
    // SELECT-FOR-UPDATE call inside this transaction and deadlock until our
    // fetch times out.
    let reservation;
    try {
      reservation = await reserveStock(order.id, items, req.id);
    } catch (err) {
      await client.query('ROLLBACK');
      req.log?.error({ err: { message: err?.message, code: err?.code } }, 'Inventory reserve call failed');
      return res.status(503).json({
        error: 'Inventory service unavailable, please retry in a moment',
        code:  err?.code || 'UPSTREAM',
      });
    }
    if (reservation.status === 409) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'insufficient_stock',
        message: 'One or more items are out of stock',
        details: reservation.body?.insufficient || [],
      });
    }
    if (reservation.status >= 400) {
      await client.query('ROLLBACK');
      return res.status(502).json({
        error: reservation.body?.error || 'Failed to reserve stock',
      });
    }

    // Create order items (after reservation succeeded)
    for (const item of items) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, price, quantity)
         VALUES ($1, $2, $3, $4, $5)`,
        [order.id, item.id, item.name, item.price, item.quantity]
      );
    }
    
    await client.query('COMMIT');

    // Buyer contact comes from the snapshot we wrote into the order row
    // at INSERT time — no cross-DB JOIN needed.
    const buyer = {
      email:      order.user_email      || null,
      first_name: order.user_first_name || 'Customer',
    };

    const orderPayload = {
      id: order.id,
      userId: order.user_id,
      email: buyer.email || null,
      firstName: buyer.first_name || 'Customer',
      total: parseFloat(order.total),
      status: order.status,
      items,
      shippingAddress,
      paymentMethod,
      createdAt: order.created_at
    };

    // ── Publish event to RabbitMQ ──────────────────────────
    // Notification Service will send confirmation email.
    // (Stock is NO LONGER deducted from this event — Phase 4 moved that
    //  into the synchronous /reserve call above.)
    await publishEvent('order.created', orderPayload);

    res.status(201).json(orderPayload);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create order error:', error);
    res.status(500).json({ error: 'Failed to create order' });
  } finally {
    client.release();
  }
});

// Get the authenticated caller's own orders.
// This is the personal "My Orders" endpoint — ALWAYS scoped to the caller,
// even if the caller has role=admin. Admins use GET /admin/all for the
// god-view list used by the admin dashboard.
app.get('/', async (req, res) => {
  try {
    const callerId = req.header('x-user-id') || req.query.userId;
    if (!callerId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const result = await pool.query(
      `SELECT o.*,
              json_agg(json_build_object(
                'id', oi.id,
                'productId', oi.product_id,
                'productName', oi.product_name,
                'price', oi.price,
                'quantity', oi.quantity
              )) as items
       FROM orders o
       LEFT JOIN order_items oi ON o.id = oi.order_id
       WHERE o.user_id = $1
       GROUP BY o.id
       ORDER BY o.created_at DESC`,
      [callerId]
    );

    const orders = result.rows.map(o => ({
      id: o.id,
      userId: o.user_id,
      total: parseFloat(o.total),
      status: o.status,
      shippingAddress: o.shipping_address,
      paymentMethod: o.payment_method,
      items: o.items,
      createdAt: o.created_at
    }));

    res.json(orders);
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Admin-only: list every order in the system. Used by the admin dashboard.
// Supports pagination (?page=&limit=) and status filtering (?status=).
// Backwards-compatible: when no pagination params are supplied, returns
// the legacy array shape; otherwise wraps as { items, total, page, limit }.
app.get('/admin/all', async (req, res) => {
  try {
    if (req.header('x-user-role') !== 'admin') {
      return res.status(403).json({ error: 'Admin role required' });
    }

    const hasPagination = req.query.page != null || req.query.limit != null;
    const page  = Math.max(parseInt(req.query.page, 10)  || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
    const offset = (page - 1) * limit;
    const status = (req.query.status || '').toString().trim();

    const where = [];
    const params = [];
    if (status && status !== 'all') {
      params.push(status);
      where.push(`o.status = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const totalQ = await pool.query(
      `SELECT COUNT(*)::int AS total FROM orders o ${whereSql}`,
      params
    );
    const total = totalQ.rows[0].total;

    const dataParams = [...params, limit, offset];
    const result = await pool.query(
      `SELECT o.*,
              COALESCE(json_agg(json_build_object(
                'id', oi.id,
                'productId', oi.product_id,
                'productName', oi.product_name,
                'price', oi.price,
                'quantity', oi.quantity
              )) FILTER (WHERE oi.id IS NOT NULL), '[]'::json) as items
       FROM orders o
       LEFT JOIN order_items oi ON o.id = oi.order_id
       ${whereSql}
       GROUP BY o.id
       ORDER BY o.created_at DESC
       LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );

    const orders = result.rows.map(o => ({
      id: o.id,
      userId: o.user_id,
      total: parseFloat(o.total),
      status: o.status,
      shippingAddress: o.shipping_address,
      paymentMethod: o.payment_method,
      trackingNumber: o.tracking_number,
      items: o.items,
      createdAt: o.created_at
    }));

    if (hasPagination) {
      res.json({ items: orders, total, page, limit });
    } else {
      res.json(orders);
    }
  } catch (error) {
    console.error('Admin list orders error:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Get orders for a specific user. Caller must be that user OR an admin.
app.get('/user/:userId', async (req, res) => {
  try {
    const callerId   = req.header('x-user-id');
    const callerRole = req.header('x-user-role');
    if (!callerId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (String(callerId) !== String(req.params.userId) && callerRole !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const result = await pool.query(
      `SELECT o.*, 
              json_agg(json_build_object(
                'id', oi.id,
                'productId', oi.product_id,
                'productName', oi.product_name,
                'price', oi.price,
                'quantity', oi.quantity
              )) as items
       FROM orders o
       LEFT JOIN order_items oi ON o.id = oi.order_id
       WHERE o.user_id = $1
       GROUP BY o.id
       ORDER BY o.created_at DESC`,
      [req.params.userId]
    );
    
    const orders = result.rows.map(o => ({
      id: o.id,
      userId: o.user_id,
      total: parseFloat(o.total),
      status: o.status,
      items: o.items,
      createdAt: o.created_at
    }));
    
    res.json(orders);
  } catch (error) {
    console.error('Get user orders error:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// ── Phase 3: order lifecycle state machine ───────────────────────────────
// All status transitions go through this map. Anything not listed is
// rejected with 422 — including same-status no-ops, which would otherwise
// spam the customer's inbox with duplicate "your order shipped" emails.
//
// Customer can cancel ONLY while the order is pending or processing (the
// admin-cancel path is more permissive because admins may need to cancel a
// shipped order that got lost in transit).
const ADMIN_TRANSITIONS = {
  pending:    ['processing', 'shipped', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped:    ['delivered', 'cancelled'],
  delivered:  ['refunded'],
  cancelled:  [],
  refunded:   [],
};

const CUSTOMER_TRANSITIONS = {
  pending:    ['cancelled'],
  processing: ['cancelled'],
};

function isAdmin(req) {
  return req.header('x-user-role') === 'admin';
}

// Helper: load the order, check transition, run the state change inside a
// transaction (orders row + order_status_history row), then enrich + publish.
// Returns { code, body } where code is the HTTP status to send.
async function transitionOrder({ orderId, toStatus, actorId, actorRole, note, allowedTransitions }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the order row so two concurrent transitions can't race.
    const cur = await client.query(
      'SELECT * FROM orders WHERE id = $1 FOR UPDATE',
      [orderId]
    );
    if (cur.rows.length === 0) {
      await client.query('ROLLBACK');
      return { code: 404, body: { error: 'Order not found' } };
    }
    const order = cur.rows[0];
    const fromStatus = order.status;
    const legal = allowedTransitions[fromStatus] || [];
    if (!legal.includes(toStatus)) {
      await client.query('ROLLBACK');
      return {
        code: 422,
        body: {
          error: 'invalid_transition',
          message: `Cannot move order from "${fromStatus}" to "${toStatus}"`,
          from: fromStatus,
          to: toStatus,
          allowed: legal,
        },
      };
    }

    // Status-specific timestamp columns. Tracking number is auto-generated on
    // first move to shipped; admins can overwrite via the request body later
    // if they want a real carrier code.
    // Build SQL with values pushed in order so $N indexing stays correct.
    const setClauses = ['status = $1', 'updated_at = NOW()'];
    const values = [toStatus];
    if (toStatus === 'shipped' && !order.tracking_number) {
      values.push(`TRK-${orderId}-${Date.now().toString(36).toUpperCase()}`);
      setClauses.push(`tracking_number = $${values.length}`);
    } else if (toStatus === 'delivered') {
      setClauses.push('delivered_at = NOW()');
    } else if (toStatus === 'cancelled') {
      setClauses.push('cancelled_at = NOW()');
    } else if (toStatus === 'refunded') {
      setClauses.push('refunded_at = NOW()');
    }
    values.push(orderId);

    const upd = await client.query(
      `UPDATE orders SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );
    const updatedOrder = upd.rows[0];

    await client.query(
      `INSERT INTO order_status_history (order_id, from_status, to_status, actor_id, actor_role, note)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [orderId, fromStatus, toStatus, actorId || null, actorRole || 'system', note || null]
    );

    await client.query('COMMIT');

    // Enrich payload for downstream consumers (email-service needs the
    // buyer's contact and the order items; inventory-service uses status
    // for cancel/refund stock-release, and on refund needs productId +
    // quantity to send compensating stock-adjust calls to product-service).
    //
    // Under the database-per-service split, orders_db can no longer JOIN
    // against users (which lives in auth_db). We read the snapshot columns
    // (user_email, user_first_name) that were captured at order-create
    // time, and gather order_items locally (same DB).
    const meta = await pool.query(
      `SELECT COALESCE(
                json_agg(json_build_object(
                  'productId', oi.product_id,
                  'name', oi.product_name,
                  'price', oi.price,
                  'quantity', oi.quantity
                )) FILTER (WHERE oi.id IS NOT NULL),
                '[]'
              ) AS items
         FROM order_items oi
        WHERE oi.order_id = $1`,
      [orderId]
    );
    const buyer = {
      email:      updatedOrder.user_email      || null,
      first_name: updatedOrder.user_first_name || 'Customer',
      items:      meta.rows[0]?.items || [],
    };

    await publishEvent('order.status_updated', {
      orderId:        updatedOrder.id,
      userId:         updatedOrder.user_id,
      email:          buyer.email || null,
      firstName:      buyer.first_name || 'Customer',
      status:         updatedOrder.status,
      previousStatus: fromStatus,
      total:          parseFloat(updatedOrder.total),
      items:          buyer.items || [],
      trackingNumber: updatedOrder.tracking_number || null,
      note:           note || null,
      updatedAt:      updatedOrder.updated_at,
    });

    return { code: 200, body: updatedOrder };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`Transition error for order ${orderId}:`, err.message);
    return { code: 500, body: { error: 'Failed to update status' } };
  } finally {
    client.release();
  }
}

// Admin status change. Locked down to role=admin at the service so that
// even if the gateway misroutes a header a customer can't ship their own
// order to themselves.
app.patch('/:id/status', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ error: 'Admin role required' });
  }
  const { status, note } = req.body || {};
  if (!status) return res.status(400).json({ error: 'status is required' });

  const result = await transitionOrder({
    orderId:            Number(req.params.id),
    toStatus:           status,
    actorId:            Number(req.header('x-user-id')) || null,
    actorRole:          'admin',
    note,
    allowedTransitions: ADMIN_TRANSITIONS,
  });
  res.status(result.code).json(result.body);
});

// Customer self-cancel. Only the order's own owner may call this, and only
// while the order is still pending or processing. Anything past that needs
// admin intervention (it's already with the carrier or delivered).
app.post('/:id/cancel', async (req, res) => {
  const callerId = req.header('x-user-id');
  if (!callerId) return res.status(401).json({ error: 'Authentication required' });

  const own = await pool.query('SELECT user_id, status FROM orders WHERE id = $1', [req.params.id]);
  if (own.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
  if (String(own.rows[0].user_id) !== String(callerId) && !isAdmin(req)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const result = await transitionOrder({
    orderId:            Number(req.params.id),
    toStatus:           'cancelled',
    actorId:            Number(callerId),
    actorRole:          isAdmin(req) ? 'admin' : 'customer',
    note:               req.body?.note || 'Cancelled by customer',
    allowedTransitions: isAdmin(req) ? ADMIN_TRANSITIONS : CUSTOMER_TRANSITIONS,
  });
  res.status(result.code).json(result.body);
});

// Timeline endpoint — both customer (own orders) and admin can view.
app.get('/:id/history', async (req, res) => {
  const callerId   = req.header('x-user-id');
  const callerRole = req.header('x-user-role');
  if (!callerId) return res.status(401).json({ error: 'Authentication required' });
  const own = await pool.query('SELECT user_id FROM orders WHERE id = $1', [req.params.id]);
  if (own.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
  if (String(own.rows[0].user_id) !== String(callerId) && callerRole !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const rows = await pool.query(
    `SELECT id, from_status, to_status, actor_role, note, created_at
       FROM order_status_history
      WHERE order_id = $1
      ORDER BY created_at ASC`,
    [req.params.id]
  );
  res.json({ orderId: Number(req.params.id), history: rows.rows });
});




app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// ── Internal endpoints ─────────────────────────────────────
// Endpoints under /internal/** are NOT exposed by the api-gateway —
// they are intended for sibling services (admin-service, etc) that
// need server-to-server access to order aggregates without owning the
// orders DB. Naming convention matches the auth-service /internal/users
// pattern introduced in Phase D1.5.

/**
 * GET /internal/stats
 *
 * Returns aggregate counters used by admin-service's dashboard.
 *   { totalOrders, totalRevenue }
 */
app.get('/internal/stats', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS total_orders,
              COALESCE(SUM(total), 0)::numeric AS total_revenue
       FROM orders`
    );
    res.json({
      totalOrders:  rows[0].total_orders,
      totalRevenue: Number(rows[0].total_revenue),
    });
  } catch (err) {
    logger.error({ err }, 'GET /internal/stats failed');
    res.status(500).json({ error: 'Failed to fetch order stats' });
  }
});

/**
 * GET /internal/analytics/revenue?days=30
 *
 * Daily revenue series for the last N days. Returns
 *   [{ date: 'YYYY-MM-DD', revenue: number, orders: number }, ...]
 */
app.get('/internal/analytics/revenue', async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
  try {
    const { rows } = await pool.query(
      `SELECT DATE(created_at)::text AS date,
              COALESCE(SUM(total), 0)::numeric AS revenue,
              COUNT(*)::int AS orders
       FROM orders
       WHERE created_at >= NOW() - ($1 || ' days')::interval
       GROUP BY DATE(created_at)
       ORDER BY DATE(created_at) DESC`,
      [String(days)]
    );
    res.json(rows.map(r => ({
      date: r.date, revenue: Number(r.revenue), orders: r.orders
    })));
  } catch (err) {
    logger.error({ err }, 'GET /internal/analytics/revenue failed');
    res.status(500).json({ error: 'Failed to fetch revenue analytics' });
  }
});

/**
 * GET /internal/analytics/top-products?limit=10
 *
 * Returns the SKUs with the highest aggregate quantity sold across
 * all order_items. admin-service composes these with product-service
 * to enrich with names/prices. No JOIN against products is performed
 * here — the DB-per-service split means products live elsewhere.
 *   [{ productId, productName, quantity, orderCount }, ...]
 */
app.get('/internal/analytics/top-products', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);
  try {
    const { rows } = await pool.query(
      `SELECT product_id          AS "productId",
              MAX(product_name)   AS "productName",
              SUM(quantity)::int  AS quantity,
              COUNT(DISTINCT order_id)::int AS "orderCount"
       FROM order_items
       GROUP BY product_id
       ORDER BY SUM(quantity) DESC
       LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    logger.error({ err }, 'GET /internal/analytics/top-products failed');
    res.status(500).json({ error: 'Failed to fetch top products' });
  }
});

// Listen for payment events so the order-service owns its own orders table.
// The payment-service (Node or Go) publishes payment.completed / payment.failed;
// we react by moving the order forward. This keeps DB writes inside one service.
async function startPaymentConsumers() {
  try {
    await consumeEvents('payment.completed', async (data) => {
      const orderId = data?.orderId;
      if (!orderId) return;
      // pending → processing, system-driven, but route through the same
      // transition path so order_status_history stays the source of truth.
      const result = await transitionOrder({
        orderId,
        toStatus:           'processing',
        actorId:            null,
        actorRole:          'system',
        note:               'Payment completed',
        allowedTransitions: ADMIN_TRANSITIONS,
      });
      if (result.code === 200) {
        logger.info({ orderId, newStatus: 'processing' }, 'Order advanced after payment.completed');
      } else if (result.code !== 422) {
        // 422 just means the order wasn't pending — usually a retry of an
        // already-processed event. Not worth logging as an error.
        logger.warn({ orderId, code: result.code, body: result.body }, 'Payment-completed transition skipped');
      }
    }, 'order-service.payment.completed');

    await consumeEvents('payment.failed', async (data) => {
      const orderId = data?.orderId;
      if (!orderId) return;
      // Phase 4: when payment fails, inventory-service will release the
      // reservation (restoring stock). The order itself moves to
      // 'cancelled' so the customer's order history shows accurate state
      // and they can start a fresh checkout if they want to retry.
      const result = await transitionOrder({
        orderId,
        toStatus:           'cancelled',
        actorId:            null,
        actorRole:          'system',
        note:               `Payment failed${data?.failureReason ? `: ${data.failureReason}` : ''}`,
        allowedTransitions: ADMIN_TRANSITIONS,
      });
      if (result.code === 200) {
        logger.warn({ orderId, reason: data?.failureReason }, 'Order cancelled after payment.failed');
      }
    }, 'order-service.payment.failed');

    logger.info('Payment event consumers started');
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to start payment consumers (will keep serving HTTP)');
  }
}

app.listen(PORT, () => {
  console.log(`Order Service running on port ${PORT}`);
  startPaymentConsumers();
});
