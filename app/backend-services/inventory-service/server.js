/**
 * Inventory Service — Port 3011
 *
 * Owns ALL writes to `products.stock` and the `reservations` table.
 *
 * Phase 4 lifecycle:
 *   POST /reserve              (called by order-service at order-create time)
 *     → atomically check + decrement stock + insert active reservation rows
 *   POST /commit/:orderId      (called from RabbitMQ on payment.completed)
 *     → flip reservations 'active' → 'committed' (stock already deducted)
 *   POST /release/:orderId     (called from RabbitMQ on payment.failed,
 *                              or by the sweeper job, or by admin)
 *     → restore stock and flip reservations 'active' → 'released' / 'expired'
 *
 * CONSUMES events from RabbitMQ:
 *   payment.completed → commit the order's active reservations
 *   payment.failed    → release the order's active reservations (restore stock)
 *
 * PUBLISHES events:
 *   inventory.low_stock  → when a product drops below threshold (in /reserve)
 *   inventory.out_of_stock → when a product reaches 0 (in /reserve)
 *
 * EXPOSES HTTP:
 *   GET  /stock/:productId   → current stock level
 *   GET  /stock/low          → all low-stock products (< 10)
 *   GET  /stock              → all products with stock
 *   PUT  /stock/:productId   → manual stock adjustment (admin)
 *   POST /reserve            → reserve stock for an order
 *   POST /commit/:orderId    → mark reservations committed
 *   POST /release/:orderId   → release reservations + restore stock
 *   GET  /reservations/:orderId → inspect reservations for an order
 */

const express = require('express');
const { logger, requestLogger } = require('./shared/logger')('inventory-service');
const { createHttpClient, HttpClientError } = require('./shared/httpClient');

const cors    = require('cors');
const { Pool } = require('pg');
const { consumeEvents, publishEvent } = require('./shared/eventBus');
// Prometheus metrics
const promClient = require('prom-client');
const register = new promClient.Registry();

const app  = express();
const PORT = process.env.PORT || 3011;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const LOW_STOCK_THRESHOLD = parseInt(process.env.LOW_STOCK_THRESHOLD || '10');
// How long a reservation may sit in 'active' before the sweeper releases it.
// Long enough for a slow customer on the payment page, short enough that
// abandoned checkouts don't bleed inventory for hours.
const RESERVATION_TTL_MS = parseInt(process.env.RESERVATION_TTL_MS || String(30 * 60 * 1000));
const SWEEP_INTERVAL_MS  = parseInt(process.env.SWEEP_INTERVAL_MS  || String(2 * 60 * 1000));

// product-service URL. Under the database-per-service split, inventory_db
// no longer contains a `products` table — stock lives in product-service's
// own DB. Inventory-service is the orchestration layer (reservations
// ledger + sweeper) and routes every stock read / write through product-
// service's `/internal/products/{id}/stock*` endpoints.
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || 'http://product-service:3003';

// Hardened HTTP client (timeout + retry + circuit breaker + metrics).
// One long-lived client so the breaker state persists across requests.
// Stock writes are intentionally NOT marked idempotent (POST /stock/adjust
// is a delta — retrying could double-decrement). Stock reads use the GET
// retry default.
const productHttp = createHttpClient({
  target: 'product-service',
  baseUrl: PRODUCT_SERVICE_URL,
  register,
  promClient,
  logger,
  timeoutMs: 3000,
  retry:   { attempts: 2, baseDelayMs: 100, maxDelayMs: 800 },
  breaker: {
    timeout:                  3500,
    errorThresholdPercentage: 50,
    resetTimeout:             10_000,
    volumeThreshold:          10,
    rollingCountTimeout:      30_000,
    rollingCountBuckets:      10,
  },
});

// ── Thin HTTP shim for product-service stock operations ───────────────────
//
// fetchProduct: GET /public/{id} — used for name + current stock when
//   checking availability and emitting alerts.
// adjustStock:  POST /internal/products/{id}/stock/adjust {delta} — atomic
//   ±delta. Returns 409 when the result would go negative; we surface that
//   as 'insufficient_stock'. NOT retried — see comment on productHttp.
// setStock:     PUT  /internal/products/{id}/stock {stock} — absolute set,
//   used by the admin manual-adjust endpoint here. Idempotent by nature.
async function httpGetProduct(productId) {
  const p = await productHttp.getJson(`/public/${encodeURIComponent(productId)}`);
  if (!p) return null; // 404 surfaces as undefined
  return {
    id:       p.id,
    name:     p.name,
    stock:    Number(p.stock ?? 0),
    category: p.category,
  };
}

async function httpAdjustStock(productId, delta) {
  try {
    const p = await productHttp.postJson(
      `/internal/products/${encodeURIComponent(productId)}/stock/adjust`,
      { delta: Number(delta) },
      { idempotent: false }
    );
    return Number(p?.stock ?? 0);
  } catch (err) {
    if (err instanceof HttpClientError) {
      if (err.status === 409) {
        const e = new Error('insufficient_stock');
        e.code = 'insufficient_stock';
        throw e;
      }
      if (err.status === 404) {
        const e = new Error('product_not_found');
        e.code = 'product_not_found';
        throw e;
      }
    }
    throw err;
  }
}

async function httpSetStock(productId, stock) {
  // PUT is idempotent (replaces value); safe to retry on transient failure.
  return productHttp.putJson(
    `/internal/products/${encodeURIComponent(productId)}/stock`,
    { stock: Number(stock) },
    { idempotent: true }
  );
}

app.use(cors());
app.use(express.json());

app.use(requestLogger);

// ── Helper: emit low/out-of-stock alerts (called from /reserve) ───────────
async function emitStockAlerts(productId, productName, newStock, orderId) {
  if (newStock === 0) {
    await publishEvent('inventory.out_of_stock', { productId, productName, orderId });
    console.warn(`[Inventory] ⚠️  Product ${productName} is OUT OF STOCK`);
  } else if (newStock < LOW_STOCK_THRESHOLD) {
    await publishEvent('inventory.low_stock', {
      productId, productName, currentStock: newStock,
      threshold: LOW_STOCK_THRESHOLD, orderId,
    });
    console.warn(`[Inventory] ⚠️  Product ${productName} is LOW STOCK (${newStock} left)`);
  }
}

// ── Core: reserve stock for an order ──────────────────────────────────────
// Atomic across all items via TWO-PHASE COMMIT pattern over HTTP:
//   1. SELECT and lock our own reservations rows (idempotency check).
//   2. For each item: HTTP atomic adjust(-quantity) against product-service.
//      Product-service is the SoT for stock and rejects with 409 if there
//      isn't enough. We collect successes and any insufficiency.
//   3. If ANY item came back insufficient: HTTP-rollback all successful
//      adjusts (+quantity each), return 409 with the shortage list. No
//      reservation rows are written.
//   4. If all items succeeded: INSERT reservation rows in inventory_db.
//      If that INSERT itself fails (shouldn't, but…), rollback the HTTP
//      adjusts as a final compensating action.
//
// Idempotent on (order_id, product_id) — replaying the same POST returns
// the existing reservation rather than double-deducting.
async function reserveForOrder(orderId, items) {
  // Idempotency check first (cheap, local).
  const existing = await pool.query(
    `SELECT product_id, quantity, status
       FROM reservations
      WHERE order_id = $1 AND status IN ('active','committed')`,
    [orderId]
  );
  if (existing.rows.length > 0) {
    return {
      idempotent: true,
      reservations: existing.rows.map(r => ({
        productId: r.product_id,
        quantity:  r.quantity,
        status:    r.status,
      })),
    };
  }

  // Normalize and order items so concurrent reserves take HTTP adjusts in
  // the same product_id order (helps avoid livelock under heavy contention).
  const sorted = [...items]
    .map(it => ({ productId: Number(it.productId), quantity: Number(it.quantity) }))
    .sort((a, b) => a.productId - b.productId);

  for (const it of sorted) {
    if (!it.productId || !it.quantity || it.quantity < 1) {
      return { error: 'Each item must have a positive productId and quantity' };
    }
  }

  const succeeded = []; // [{ productId, quantity, newStock, name }]
  const insufficient = [];

  for (const it of sorted) {
    let product;
    try {
      product = await httpGetProduct(it.productId);
    } catch (e) {
      // If GET fails treat as not-found rather than blowing up the batch.
      product = null;
    }
    const productName = product?.name || `Product ${it.productId}`;

    try {
      const newStock = await httpAdjustStock(it.productId, -it.quantity);
      succeeded.push({
        productId:     it.productId,
        quantity:      it.quantity,
        previousStock: product ? product.stock : null,
        newStock,
        name:          productName,
      });
    } catch (e) {
      if (e.code === 'insufficient_stock') {
        insufficient.push({
          productId: it.productId,
          name:      productName,
          requested: it.quantity,
          available: product ? product.stock : 0,
          reason:    'insufficient_stock',
        });
      } else if (e.code === 'product_not_found') {
        insufficient.push({
          productId: it.productId,
          requested: it.quantity,
          available: 0,
          reason:    'not_found',
        });
      } else {
        // Unexpected — roll back what we did and bubble up.
        await rollbackAdjustments(succeeded);
        throw e;
      }
    }
  }

  if (insufficient.length > 0) {
    // Compensate any successful adjusts so we don't strand stock.
    await rollbackAdjustments(succeeded);
    return { error: 'insufficient_stock', insufficient };
  }

  // All adjusts succeeded — record the reservation rows.
  const expiresAt = new Date(Date.now() + RESERVATION_TTL_MS).toISOString();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const s of succeeded) {
      await client.query(
        `INSERT INTO reservations (order_id, product_id, quantity, expires_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (order_id, product_id) DO NOTHING`,
        [orderId, s.productId, s.quantity, expiresAt]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Compensate the HTTP adjusts since we couldn't record them locally.
    await rollbackAdjustments(succeeded);
    client.release();
    throw err;
  } finally {
    client.release();
  }

  // Fire alerts AFTER commit so a downstream subscriber that crashes can't
  // block the customer's order. publishEvent is itself best-effort.
  for (const s of succeeded) {
    await emitStockAlerts(s.productId, s.name, s.newStock, orderId);
  }

  console.log(`[Inventory] Reserved order #${orderId}: ${succeeded.length} item(s)`);
  return {
    idempotent: false,
    reservations: succeeded.map(s => ({
      productId:     s.productId,
      quantity:      s.quantity,
      previousStock: s.previousStock,
      newStock:      s.newStock,
    })),
    expiresAt,
  };
}

// Compensating action — restore stock for adjusts that we have to undo.
// Best-effort: logged on failure but never throws (we're already in an
// error path).
async function rollbackAdjustments(succeeded) {
  for (const s of succeeded) {
    try {
      await httpAdjustStock(s.productId, +s.quantity);
    } catch (e) {
      console.error(
        `[Inventory] Rollback failed for product ${s.productId} (+${s.quantity}):`,
        e.message
      );
    }
  }
}

// ── Core: commit active reservations for an order ─────────────────────────
// Called when payment.completed arrives. Stock was already deducted at
// reserve time — this is purely a status flip so the sweeper can't release
// reservations belonging to a paid order.
async function commitForOrder(orderId, source = 'payment.completed') {
  const r = await pool.query(
    `UPDATE reservations
        SET status = 'committed',
            resolved_at = NOW(),
            resolved_by = $2
      WHERE order_id = $1 AND status = 'active'
      RETURNING product_id, quantity`,
    [orderId, source]
  );
  if (r.rowCount > 0) {
    console.log(`[Inventory] Committed order #${orderId} (${r.rowCount} lines)`);
  }
  return r.rows;
}

// ── Core: release active reservations for an order ────────────────────────
// Restores stock atomically via HTTP to product-service (now the SoT for
// stock) and marks reservations released (or expired, when invoked by the
// sweeper). Idempotent — already released/committed rows are skipped by
// the WHERE clause.
//
// Note we still take a local DB transaction so two concurrent releases for
// the same order can't both flip the rows; the inner loop does the HTTP
// adjust for each line.
async function releaseForOrder(orderId, source = 'payment.failed', terminalStatus = 'released') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // SELECT FOR UPDATE on reservation rows pins them so a concurrent
    // commit can't snake in between the status flip and the stock restore.
    const rows = await client.query(
      `SELECT product_id, quantity FROM reservations
        WHERE order_id = $1 AND status = 'active'
        FOR UPDATE`,
      [orderId]
    );

    await client.query(
      `UPDATE reservations
          SET status = $3,
              resolved_at = NOW(),
              resolved_by = $2
        WHERE order_id = $1 AND status = 'active'`,
      [orderId, source, terminalStatus]
    );

    await client.query('COMMIT');

    // HTTP-restore stock AFTER the local commit. If product-service is
    // momentarily down, the reservation is already marked released — the
    // catalog will be temporarily under-counted but eventually consistent
    // once admin re-syncs (or we add an outbox).
    for (const r of rows.rows) {
      try {
        await httpAdjustStock(r.product_id, +r.quantity);
      } catch (e) {
        console.error(
          `[Inventory] Stock restore failed for product ${r.product_id} (+${r.quantity}):`,
          e.message
        );
      }
    }

    if (rows.rowCount > 0) {
      console.log(`[Inventory] Released order #${orderId} (${rows.rowCount} lines, source=${source})`);
    }
    return rows.rows;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`[Inventory] Release error for order ${orderId}:`, err.message);
    throw err;
  } finally {
    client.release();
  }
}

// ── Abandoned-reservation sweeper ─────────────────────────────────────────
// Releases reservations that have been sitting 'active' past their TTL.
// Runs in-process every SWEEP_INTERVAL_MS — fine for our load, and avoids
// pulling in a cron container just for this. setInterval, not cron, so we
// don't need to coordinate with the host's timezone.
async function sweepExpiredReservations() {
  try {
    const due = await pool.query(
      `SELECT DISTINCT order_id FROM reservations
        WHERE status = 'active' AND expires_at < NOW()`
    );
    for (const row of due.rows) {
      await releaseForOrder(row.order_id, 'sweeper', 'expired');
    }
  } catch (err) {
    console.error('[Inventory] Sweep error:', err.message);
  }
}

// ── Start RabbitMQ consumers ────────────────────────────────
async function startEventConsumers() {
  // payment.completed → commit reservations
  await consumeEvents('payment.completed', async (data) => {
    const orderId = data?.orderId;
    if (!orderId) return;
    await commitForOrder(orderId, 'payment.completed');
  }, 'inventory_payment_completed');

  // payment.failed → release reservations and restore stock
  await consumeEvents('payment.failed', async (data) => {
    const orderId = data?.orderId;
    if (!orderId) return;
    await releaseForOrder(orderId, 'payment.failed', 'released');
  }, 'inventory_payment_failed');

  // Legacy: order.status_updated still triggers a release on cancel/refund
  // for orders that were cancelled by an admin or refunded after the fact.
  // (Routine pending → processing transitions never reach this branch.)
  //
  // Note: for the 'refunded' path, the reservation is already 'committed'
  // (sale was completed), so the release function returns 0 rows here.
  // To restore stock on refund we re-deduct it from order_items.
  await consumeEvents('order.status_updated', async (data) => {
    const status = (data?.status || '').toLowerCase();
    if (!['cancelled', 'refunded'].includes(status)) return;
    if (!data.orderId) return;

    if (status === 'cancelled') {
      // Active reservations get released (only relevant if cancel happened
      // before payment, i.e. inventory still holds the active hold).
      await releaseForOrder(data.orderId, `order.${status}`, 'released');
      return;
    }

    // Refund path: stock was already committed, so we restore from the
    // order_items snapshot via HTTP to product-service. We mark the
    // reservation rows as 'released' too for clean audit, but use a
    // separate query because the lifecycle transition is 'committed' →
    // 'released' here, not 'active' → anything.
    const items = await pool.query(
      'SELECT product_id, quantity FROM order_items WHERE order_id = $1',
      [data.orderId]
    );
    for (const it of items.rows) {
      try {
        await httpAdjustStock(it.product_id, +it.quantity);
      } catch (e) {
        console.error(
          `[Inventory] Refund stock restore failed for product ${it.product_id}:`,
          e.message
        );
      }
    }
    await pool.query(
      `UPDATE reservations
          SET status = 'released',
              resolved_at = NOW(),
              resolved_by = 'order.refunded'
        WHERE order_id = $1 AND status = 'committed'`,
      [data.orderId]
    );
    console.log(`[Inventory] Restored stock for refunded order #${data.orderId} (${items.rowCount} lines)`);
  }, 'inventory_order_status');

  console.log('[Inventory] Event consumers registered ✅');
}

// ── HTTP endpoints ──────────────────────────────────────────
app.get('/health', (req, res) =>
  res.json({ status: 'Inventory Service running', consumers: 'active' })
);


///// prometheus
register.setDefaultLabels({
  service: 'inventory-service'
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
      service: 'inventory-service',
      method: req.method,
      route,
      status: res.statusCode
    });

    httpRequestDuration.observe(
      {
        service: 'inventory-service',
        method: req.method,
        route
      },
      duration
    );
  });

  next();
});


// Get all low-stock products — pulled over HTTP from product-service.
// MUST be registered BEFORE the `/stock/:productId` route so Express
// doesn't capture "low" as a productId.
app.get('/stock/low', async (req, res) => {
  try {
    const body = await productHttp.getJson('/public', { query: { page: 1, limit: 500 }, requestId: req.id });
    const items = Array.isArray(body) ? body : (body?.items || []);
    res.json(items
      .filter(p => Number(p.stock ?? 0) < LOW_STOCK_THRESHOLD)
      .map(p => ({ id: p.id, name: p.name, stock: Number(p.stock ?? 0), category: p.category }))
      .sort((a, b) => a.stock - b.stock)
    );
  } catch (e) {
    req.log?.error({ err: { message: e?.message, code: e?.code, status: e?.status } }, '/stock/low error');
    res.status(e?.code === 'CIRCUIT_OPEN' ? 503 : 502).json({ error: 'Failed to fetch low stock', code: e?.code });
  }
});

// All products with stock levels — pulled over HTTP from product-service.
app.get('/stock', async (req, res) => {
  try {
    const body = await productHttp.getJson('/public', { query: { page: 1, limit: 500 }, requestId: req.id });
    const items = Array.isArray(body) ? body : (body?.items || []);
    res.json(items
      .map(p => ({ id: p.id, name: p.name, stock: Number(p.stock ?? 0), category: p.category }))
      .sort((a, b) => a.stock - b.stock)
    );
  } catch (e) {
    req.log?.error({ err: { message: e?.message, code: e?.code, status: e?.status } }, '/stock error');
    res.status(e?.code === 'CIRCUIT_OPEN' ? 503 : 502).json({ error: 'Failed to fetch stock', code: e?.code });
  }
});

// Get stock for a single product — registered AFTER `/stock/low` and
// `/stock` so those literal paths win.
app.get('/stock/:productId', async (req, res) => {
  try {
    const p = await httpGetProduct(req.params.productId);
    if (!p) return res.status(404).json({ error: 'Product not found' });
    res.json({
      productId: p.id,
      name:      p.name,
      stock:     p.stock,
      status:    p.stock === 0 ? 'out_of_stock' :
                 p.stock < LOW_STOCK_THRESHOLD ? 'low_stock' : 'in_stock'
    });
  } catch (e) {
    console.error('[inventory] /stock/:productId error:', e?.message);
    res.status(500).json({ error: 'Failed to fetch stock' });
  }
});

// Manual stock adjustment (admin) — proxied to product-service.
app.put('/stock/:productId', async (req, res) => {
  const { stock, reason } = req.body;
  if (stock === undefined || stock < 0) {
    return res.status(400).json({ error: 'Valid stock value required' });
  }
  try {
    const updated = await httpSetStock(req.params.productId, Number(stock));
    if (!updated) return res.status(404).json({ error: 'Product not found' });
    console.log(`[Inventory] Manual adjustment: product ${req.params.productId} → ${stock} (${reason || 'no reason'})`);
    res.json({
      id:    updated.id,
      name:  updated.name,
      stock: Number(updated.stock ?? 0),
    });
  } catch (e) {
    console.error('[inventory] PUT /stock/:productId error:', e?.message);
    res.status(500).json({ error: 'Failed to update stock' });
  }
});

// ── Reservation endpoints ─────────────────────────────────────────────────
// POST /reserve — called synchronously by order-service during checkout.
// Body: { orderId, items: [{ productId, quantity }] }
// Returns 201 on success, 409 with { error:'insufficient_stock', insufficient:[...] }
// when one or more items don't have enough stock.
app.post('/reserve', async (req, res) => {
  const { orderId, items } = req.body || {};
  if (!orderId || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'orderId and non-empty items[] are required' });
  }
  try {
    const result = await reserveForOrder(Number(orderId), items);
    if (result.error === 'insufficient_stock') {
      return res.status(409).json({ error: 'insufficient_stock', insufficient: result.insufficient });
    }
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    return res.status(result.idempotent ? 200 : 201).json(result);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reserve stock' });
  }
});

// Manual commit / release endpoints — primarily for admin tooling and
// integration tests. The happy path commits via the payment.completed
// event consumer (no HTTP hop needed).
app.post('/commit/:orderId', async (req, res) => {
  try {
    const rows = await commitForOrder(Number(req.params.orderId), 'admin');
    res.json({ orderId: Number(req.params.orderId), committed: rows });
  } catch {
    res.status(500).json({ error: 'Failed to commit reservations' });
  }
});

app.post('/release/:orderId', async (req, res) => {
  try {
    const rows = await releaseForOrder(Number(req.params.orderId), 'admin', 'released');
    res.json({ orderId: Number(req.params.orderId), released: rows });
  } catch {
    res.status(500).json({ error: 'Failed to release reservations' });
  }
});

// Read endpoint so order-service / admin UI can show reservation state.
app.get('/reservations/:orderId', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT product_id, quantity, status, created_at, expires_at, resolved_at, resolved_by
         FROM reservations WHERE order_id = $1 ORDER BY product_id`,
      [req.params.orderId]
    );
    res.json({ orderId: Number(req.params.orderId), reservations: r.rows });
  } catch {
    res.status(500).json({ error: 'Failed to fetch reservations' });
  }
});

// ── Start ─────────────────────────────────────────────────


app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.listen(PORT, () => {
  console.log(`Inventory Service running on port ${PORT}`);
  setTimeout(startEventConsumers, 5000);
  // Stagger the first sweep so it doesn't fight the consumer registration
  // for the DB pool, then run on a fixed interval.
  setTimeout(() => {
    sweepExpiredReservations();
    setInterval(sweepExpiredReservations, SWEEP_INTERVAL_MS);
  }, 15_000);
});
