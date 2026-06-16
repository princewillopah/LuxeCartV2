const express = require('express');
const { logger, requestLogger } = require('./shared/logger')('admin-service');
const { createHttpClient, HttpClientError } = require('./shared/httpClient');

const cors = require('cors');

// Prometheus metrics
const promClient = require('prom-client');
const register = new promClient.Registry();

const app = express();
const PORT = process.env.PORT || 3010;

// Database-per-service: admin-service owns NO domain tables. It is a
// production-grade Backend-for-Frontend (BFF) that aggregates read-side
// views from auth-service, order-service and product-service.
//
// Every downstream call goes through `shared/httpClient.js` which gives
// us, for free:
//   - per-call AbortController timeout
//   - bounded retry with exponential backoff + jitter (idempotent GETs)
//   - per-target opossum circuit breaker (fail fast on a sick downstream)
//   - Prometheus metrics: http_client_requests_total, _duration_seconds,
//     _circuit_state — all labelled by `target`
//   - structured HttpClientError preserving downstream context
//
// All sibling URLs are env-configurable so the same image runs in
// docker-compose, k8s and local dev.
const AUTH_SERVICE_URL    = process.env.AUTH_SERVICE_URL    || 'http://auth-service:3001';
const ORDER_SERVICE_URL   = process.env.ORDER_SERVICE_URL   || 'http://order-service:3005';
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || 'http://product-service:3003';

///// prometheus
register.setDefaultLabels({ service: 'admin-service' });
promClient.collectDefaultMetrics({ register });

const httpRequestCounter = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['service', 'method', 'route', 'status'],
  registers: [register],
});
const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['service', 'method', 'route'],
  buckets: [0.1, 0.3, 0.5, 1, 2, 5],
  registers: [register],
});

// One client per downstream target. Long-lived so the breaker state
// persists across requests (the whole point of a breaker).
const httpClientOpts = {
  register,
  promClient,
  logger,
  timeoutMs: 2000,
  retry:   { attempts: 2, baseDelayMs: 100, maxDelayMs: 800 },
  breaker: {
    timeout:                  3000,
    errorThresholdPercentage: 50,
    resetTimeout:             10_000,
    volumeThreshold:          5,
    rollingCountTimeout:      30_000,
    rollingCountBuckets:      10,
  },
};
const authHttp    = createHttpClient({ ...httpClientOpts, target: 'auth-service',    baseUrl: AUTH_SERVICE_URL });
const orderHttp   = createHttpClient({ ...httpClientOpts, target: 'order-service',   baseUrl: ORDER_SERVICE_URL });
const productHttp = createHttpClient({ ...httpClientOpts, target: 'product-service', baseUrl: PRODUCT_SERVICE_URL });

// Tiny in-process TTL cache for the dashboard hot path. 10-second TTL is
// short enough that stats feel live, long enough to flatten the QPS that
// an admin clicking around generates. (In-process is fine for a single
// admin pod; if we scale admin-service horizontally we promote this to
// Redis — cart-service already shows the pattern.)
function ttlCache(defaultTtlMs) {
  const store = new Map();
  return {
    get(key) {
      const e = store.get(key);
      if (!e) return undefined;
      if (e.exp < Date.now()) { store.delete(key); return undefined; }
      return e.val;
    },
    set(key, val, ttlMs = defaultTtlMs) {
      store.set(key, { val, exp: Date.now() + ttlMs });
    },
    async getOrSet(key, fn, ttlMs = defaultTtlMs) {
      const hit = this.get(key);
      if (hit !== undefined) return hit;
      const v = await fn();
      this.set(key, v, ttlMs);
      return v;
    },
  };
}
const cache = ttlCache(10_000);

app.use(cors());
app.use(express.json());
app.use(requestLogger);

app.get('/health', (_req, res) => res.json({ status: 'Admin Service is running' }));

// In-request metrics middleware (separate from http_client_* which
// tracks OUTBOUND calls; this one tracks INBOUND).
app.use((req, res, next) => {
  if (req.path === '/metrics') return next();
  const start = Date.now();
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const route = req.route?.path || req.path || 'unknown';
    httpRequestCounter.inc({ service: 'admin-service', method: req.method, route, status: res.statusCode });
    httpRequestDuration.observe({ service: 'admin-service', method: req.method, route }, duration);
  });
  next();
});

// Helper: turn an HttpClientError into a clean log-friendly payload
function errCtx(err) {
  if (!(err instanceof HttpClientError)) return { message: err?.message };
  return {
    target:  err.target,
    url:     err.url,
    method:  err.method,
    status:  err.status,
    code:    err.code,
    attempt: err.attempt,
  };
}

/**
 * GET /dashboard/stats — composed from sibling services.
 *
 * Uses Promise.allSettled so a single downstream failure DOES NOT take
 * the whole dashboard down. Each stat degrades to `null` with a `_warnings`
 * array describing what failed. Frontend shows "—" for null cells.
 *
 * 10s in-process cache absorbs button-mash refresh.
 */
app.get('/dashboard/stats', async (req, res) => {
  try {
    const data = await cache.getOrSet('dashboard:stats', async () => {
      const requestId = req.id;
      const [usersR, ordersR, productsR] = await Promise.allSettled([
        authHttp.getJson('/internal/users', { query: { page: 1, limit: 1 }, requestId }),
        orderHttp.getJson('/internal/stats',                                { requestId }),
        productHttp.getJson('/public',       { query: { page: 1, limit: 1 }, requestId }),
      ]);
      const warnings = [];
      const pick = (label, settled, fn) => {
        if (settled.status === 'fulfilled') return fn(settled.value);
        warnings.push({ stat: label, ...errCtx(settled.reason) });
        logger.warn({ stat: label, err: errCtx(settled.reason) }, 'dashboard stat degraded');
        return null;
      };
      return {
        totalUsers:    pick('totalUsers',    usersR,    v => Number(v?.total) || 0),
        totalOrders:   pick('totalOrders',   ordersR,   v => Number(v?.totalOrders)  || 0),
        totalRevenue:  pick('totalRevenue',  ordersR,   v => Number(v?.totalRevenue) || 0),
        totalProducts: pick('totalProducts', productsR, v => Number(v?.total) || 0),
        _warnings:     warnings.length ? warnings : undefined,
        _generatedAt:  new Date().toISOString(),
      };
    });
    res.json(data);
  } catch (error) {
    logger.error({ err: errCtx(error) }, 'Dashboard stats hard failure');
    res.status(500).json({ error: 'Failed to fetch stats', code: error.code || 'INTERNAL' });
  }
});

/**
 * GET /analytics/revenue — proxied to order-service.
 * If order-service is down, return [] with a degraded header so the
 * admin chart shows "no data" instead of breaking the page.
 */
app.get('/analytics/revenue', async (req, res) => {
  try {
    const rows = await orderHttp.getJson('/internal/analytics/revenue', {
      query: { days: 30 }, requestId: req.id,
    });
    res.json(rows || []);
  } catch (error) {
    logger.error({ err: errCtx(error) }, 'Revenue analytics error');
    if (error.code === 'CIRCUIT_OPEN') {
      res.set('x-degraded', 'order-service-circuit-open');
      return res.json([]);
    }
    res.status(502).json({ error: 'Failed to fetch analytics', code: error.code || 'UPSTREAM' });
  }
});

/**
 * GET /analytics/top-products — composed.
 * Pulls top SKU ids/quantities from order-service, enriches each with
 * name/price from product-service. Per-id enrichment failures fall back
 * to the order_items snapshot (product_name) returned by order-service.
 */
app.get('/analytics/top-products', async (req, res) => {
  try {
    const top = await orderHttp.getJson('/internal/analytics/top-products', {
      query: { limit: 10 }, requestId: req.id,
    });
    if (!Array.isArray(top) || top.length === 0) return res.json([]);

    const settled = await Promise.allSettled(top.map(row =>
      productHttp.getJson(`/public/${row.productId}`, { requestId: req.id })
    ));

    const enriched = top.map((row, i) => {
      const r = settled[i];
      const p = r.status === 'fulfilled' ? r.value : null;
      return {
        id:          row.productId,
        name:        p?.name  || row.productName,
        price:       p?.price != null ? Number(p.price) : null,
        order_count: row.orderCount,
        total_sold:  row.quantity,
        _enriched:   r.status === 'fulfilled',
      };
    });
    res.json(enriched);
  } catch (error) {
    logger.error({ err: errCtx(error) }, 'Top products error');
    res.status(502).json({ error: 'Failed to fetch top products', code: error.code || 'UPSTREAM' });
  }
});

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// Single error tail-stop so an unhandled throw never leaks a stack trace
// to the client. Per-route handlers above already do typed responses.
app.use((err, req, res, _next) => {
  req.log?.error({ err: errCtx(err) }, 'unhandled error');
  if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
});

const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, 'Admin Service running');
});

// Graceful shutdown — drains in-flight, closes the breakers cleanly so
// k8s rolling deploys don't 502 mid-flight.
function shutdown(signal) {
  logger.info({ signal }, 'shutdown requested');
  server.close(() => {
    [authHttp, orderHttp, productHttp].forEach(c => c.breaker.shutdown());
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
