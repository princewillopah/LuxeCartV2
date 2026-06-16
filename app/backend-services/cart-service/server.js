/**
 * Cart Service — Phase 6 (persistent + abandoned-cart sweeper)
 *
 * - Source of truth for cart contents is now Postgres (`carts`,
 *   `cart_items`). Carts survive restarts, multi-device, and arbitrary
 *   downtime. They live for as long as the user account does.
 * - Redis is a cache-aside layer: GET / reads from Redis first, falls
 *   back to Postgres on miss, and writes back. Every mutation evicts
 *   the cache key.
 * - Caller identity comes from the gateway via the `x-user-id` header
 *   (gateway requires auth on /api/cart). userId is no longer in the
 *   path so the legacy /:userId routes are gone.
 * - Sweeper runs in-process on a setInterval. Every interval it looks
 *   for non-empty carts whose last_activity_at is older than the
 *   threshold and whose abandoned_email_sent_at is NULL, joins users to
 *   pick up email + first_name, publishes `cart.abandoned`, and stamps
 *   the cart row so we don't re-email until the user comes back.
 *
 * Routes (all mounted at root; gateway maps /api/cart → /):
 *   GET    /              → current cart  { items: [{productId, quantity, price, name, image}] }
 *   POST   /items         → add or increment      body { productId, quantity, price, name, image }
 *   PUT    /items/:productId → set quantity (≤ 0 deletes)  body { quantity }
 *   DELETE /items/:productId → remove one item
 *   DELETE /              → clear cart
 *   POST   /merge         → merge guest cart, body { items: [...] }, returns merged
 *   GET    /health        → status + redis ping
 *   GET    /metrics       → prometheus
 */

const express   = require('express');
const cors      = require('cors');
const redis     = require('redis');
const { Pool }  = require('pg');
const promClient = require('prom-client');
const { logger, requestLogger } = require('./shared/logger')('cart-service');
const { publishEvent } = require('./shared/eventBus');

const PORT = process.env.PORT || 3004;

// ── Tunables (env overridable so tests can crank them down) ──────────
// Wait this long after the cart's last activity before considering it
// abandoned. 1 hour matches industry norms; lower for demo testing.
const ABANDONED_AFTER_MS = parseInt(
  process.env.ABANDONED_CART_AFTER_MS || (60 * 60 * 1000),
  10,
);
// How often the sweeper scans. 10 min keeps DB load minimal while still
// being responsive enough that an abandoned cart gets emailed within
// ~70 min in the worst case.
const SWEEP_INTERVAL_MS = parseInt(
  process.env.ABANDONED_CART_SWEEP_INTERVAL_MS || (10 * 60 * 1000),
  10,
);
// Redis cache TTL for the cache-aside read path. A short window is fine
// because every mutation invalidates the key anyway.
const CACHE_TTL_SEC = 300;

// ── App + middleware ─────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(requestLogger);

// ── Postgres ─────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
pool.on('error', (err) => logger.error({ err }, 'pg pool error'));

// ── Redis ────────────────────────────────────────────────────────────
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || 'redis://redis:6379',
});
redisClient.on('error', (err) => logger.error({ err }, 'redis error'));
redisClient.on('connect', () => logger.info('Redis connected'));

(async () => {
  await redisClient.connect();
})();

const cacheKey = (userId) => `cart:${userId}`;

// ── Prometheus ───────────────────────────────────────────────────────
const register = new promClient.Registry();
register.setDefaultLabels({ service: 'cart-service' });
promClient.collectDefaultMetrics({ register });

const httpRequestCounter = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['service', 'method', 'route', 'status'],
});
const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['service', 'method', 'route'],
  buckets: [0.1, 0.3, 0.5, 1, 2, 5],
});
const abandonedSweepCounter = new promClient.Counter({
  name: 'cart_abandoned_emails_total',
  help: 'Number of abandoned-cart emails published',
});
register.registerMetric(httpRequestCounter);
register.registerMetric(httpRequestDuration);
register.registerMetric(abandonedSweepCounter);

app.use((req, res, next) => {
  if (req.path === '/metrics') return next();
  const start = Date.now();
  res.on('finish', () => {
    const route = req.route?.path || req.path || 'unknown';
    httpRequestCounter.inc({
      service: 'cart-service',
      method: req.method,
      route,
      status: res.statusCode,
    });
    httpRequestDuration.observe(
      { service: 'cart-service', method: req.method, route },
      (Date.now() - start) / 1000,
    );
  });
  next();
});

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// ── Auth helper ──────────────────────────────────────────────────────
// The gateway terminates JWT and forwards x-user-id on every authed
// request. In dev you can hit the service directly by setting the
// header by hand.
function requireUser(req, res, next) {
  const raw = req.header('x-user-id');
  const userId = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.userId = userId;
  // Capture the buyer snapshot from the gateway-forwarded headers (or
  // explicit body fields when the frontend POSTs them). Used by
  // getOrCreateCart() to keep carts.user_email / user_first_name fresh
  // so the abandoned-cart sweeper doesn't have to JOIN against users
  // (which lives in auth_db under the database-per-service split).
  req.buyer = {
    email:     req.header('x-user-email') || req.body?.userEmail     || null,
    firstName: req.body?.userFirstName    || null,
  };
  next();
}

// ── Health (no auth) ─────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    await redisClient.ping();
    await pool.query('SELECT 1');
    res.json({ status: 'Cart Service is running with Postgres + Redis' });
  } catch (e) {
    res.status(503).json({ status: 'unhealthy', error: e.message });
  }
});

// ── Repository helpers (Postgres) ────────────────────────────────────

/**
 * Ensure a cart row exists for this user, returning its id. We
 * always update last_activity_at on the way out so the abandoned-cart
 * sweeper has a fresh timestamp to scan.
 *
 * INSERT … ON CONFLICT … DO UPDATE bumps the timestamp atomically; the
 * RETURNING gives us back the cart id whether the row existed or not.
 *
 * Database-per-service: we also snapshot the buyer's email + first name
 * onto the cart so the abandoned-cart sweeper doesn't need to JOIN
 * users (which lives in auth_db now). buyer is { email, firstName }
 * — passed from the gateway-forwarded x-user-email / x-user-first-name
 * headers. NULLs are tolerated: the gateway only sets x-user-email,
 * not the name, so first-time carts have no firstName until the next
 * mutation that includes it (or until the user.profile_updated event
 * consumer below backfills it).
 */
async function getOrCreateCart(userId, buyer = {}, client = pool) {
  const { rows } = await client.query(
    `
    INSERT INTO carts (user_id, user_email, user_first_name)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id) DO UPDATE
      SET last_activity_at = NOW(),
          updated_at       = NOW(),
          -- Refresh the buyer snapshot whenever we have new values; keep
          -- existing values when the caller didn't pass any.
          user_email       = COALESCE(EXCLUDED.user_email,      carts.user_email),
          user_first_name  = COALESCE(EXCLUDED.user_first_name, carts.user_first_name),
          -- A new mutation resets the abandoned-email gate so a fresh
          -- abandonment can fire next time the sweeper sees this cart.
          abandoned_email_sent_at = NULL
    RETURNING id
    `,
    [userId, buyer.email || null, buyer.firstName || null],
  );
  return rows[0].id;
}

/** Fetch the items rows in the canonical wire shape. */
async function loadCartItems(cartId, client = pool) {
  const { rows } = await client.query(
    `
    SELECT product_id      AS "productId",
           quantity        AS quantity,
           price_snapshot  AS price,
           name_snapshot   AS name,
           image_snapshot  AS image
    FROM cart_items
    WHERE cart_id = $1
    ORDER BY added_at ASC
    `,
    [cartId],
  );
  return rows.map((r) => ({
    productId: r.productId,
    quantity:  r.quantity,
    price:     Number(r.price),
    name:      r.name,
    image:     r.image,
  }));
}

/**
 * Read-through cache. Cache key uses the userId (not the cart id) so
 * we don't have to round-trip Postgres just to learn the cart id on a
 * cache hit.
 */
async function getCartCached(userId) {
  const key = cacheKey(userId);
  const cached = await redisClient.get(key);
  if (cached) return JSON.parse(cached);

  const cartId = await getOrCreateCart(userId);
  const items = await loadCartItems(cartId);
  const payload = { userId, items };
  await redisClient.setEx(key, CACHE_TTL_SEC, JSON.stringify(payload));
  return payload;
}

/** Evict the user's cart cache. Called on every mutation. */
async function evictCart(userId) {
  await redisClient.del(cacheKey(userId));
}

// ── Routes (require auth) ────────────────────────────────────────────

app.get('/', requireUser, async (req, res) => {
  try {
    const cart = await getCartCached(req.userId);
    res.json(cart);
  } catch (e) {
    logger.error({ err: e }, 'GET cart failed');
    res.status(500).json({ error: 'Failed to fetch cart' });
  }
});

app.post('/items', requireUser, async (req, res) => {
  const { productId, quantity, price, name, image } = req.body || {};
  if (!productId || !quantity || quantity <= 0) {
    return res.status(400).json({ error: 'productId and positive quantity required' });
  }
  if (price == null || !name) {
    return res.status(400).json({ error: 'price and name required (snapshot)' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cartId = await getOrCreateCart(req.userId, req.buyer, client);
    // Upsert: if the same product is added twice, accumulate quantity
    // (matches legacy Node behaviour). Snapshot fields are refreshed
    // from the most recent add — safest assumption when product price
    // has changed since the original add.
    await client.query(
      `
      INSERT INTO cart_items
        (cart_id, product_id, quantity, price_snapshot, name_snapshot, image_snapshot)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (cart_id, product_id) DO UPDATE
        SET quantity        = cart_items.quantity + EXCLUDED.quantity,
            price_snapshot  = EXCLUDED.price_snapshot,
            name_snapshot   = EXCLUDED.name_snapshot,
            image_snapshot  = EXCLUDED.image_snapshot
      `,
      [cartId, productId, quantity, price, name, image || null],
    );
    await client.query('COMMIT');
    await evictCart(req.userId);
    const items = await loadCartItems(cartId);
    res.json({ userId: req.userId, items });
  } catch (e) {
    await client.query('ROLLBACK');
    logger.error({ err: e }, 'POST /items failed');
    res.status(500).json({ error: 'Failed to add item' });
  } finally {
    client.release();
  }
});

app.put('/items/:productId', requireUser, async (req, res) => {
  const productId = parseInt(req.params.productId, 10);
  const { quantity } = req.body || {};
  if (!productId || quantity == null) {
    return res.status(400).json({ error: 'productId and quantity required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cartId = await getOrCreateCart(req.userId, req.buyer, client);
    if (quantity <= 0) {
      await client.query(
        `DELETE FROM cart_items WHERE cart_id = $1 AND product_id = $2`,
        [cartId, productId],
      );
    } else {
      const upd = await client.query(
        `
        UPDATE cart_items
        SET quantity = $3
        WHERE cart_id = $1 AND product_id = $2
        `,
        [cartId, productId, quantity],
      );
      if (upd.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Item not found in cart' });
      }
    }
    await client.query('COMMIT');
    await evictCart(req.userId);
    const items = await loadCartItems(cartId);
    res.json({ userId: req.userId, items });
  } catch (e) {
    await client.query('ROLLBACK');
    logger.error({ err: e }, 'PUT /items failed');
    res.status(500).json({ error: 'Failed to update item' });
  } finally {
    client.release();
  }
});

app.delete('/items/:productId', requireUser, async (req, res) => {
  const productId = parseInt(req.params.productId, 10);
  if (!productId) return res.status(400).json({ error: 'productId required' });

  try {
    const cartId = await getOrCreateCart(req.userId, req.buyer);
    await pool.query(
      `DELETE FROM cart_items WHERE cart_id = $1 AND product_id = $2`,
      [cartId, productId],
    );
    await evictCart(req.userId);
    const items = await loadCartItems(cartId);
    res.json({ userId: req.userId, items });
  } catch (e) {
    logger.error({ err: e }, 'DELETE /items failed');
    res.status(500).json({ error: 'Failed to remove item' });
  }
});

app.delete('/', requireUser, async (req, res) => {
  try {
    // We delete only the items, NOT the cart row, so future activity
    // updates the same row (and its abandoned-email gate stays usable).
    const cartId = await getOrCreateCart(req.userId, req.buyer);
    await pool.query(`DELETE FROM cart_items WHERE cart_id = $1`, [cartId]);
    await evictCart(req.userId);
    res.json({ userId: req.userId, items: [], message: 'Cart cleared' });
  } catch (e) {
    logger.error({ err: e }, 'DELETE / failed');
    res.status(500).json({ error: 'Failed to clear cart' });
  }
});

/**
 * Merge a guest cart (held in browser localStorage until login) into
 * the authenticated user's server cart. Each incoming item is added
 * additively (same semantics as POST /items). Returns the resulting
 * merged cart.
 */
app.post('/merge', requireUser, async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (items.length === 0) {
    // Nothing to merge — just return the current server cart.
    try {
      const cart = await getCartCached(req.userId);
      return res.json(cart);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to fetch cart' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cartId = await getOrCreateCart(req.userId, req.buyer, client);
    for (const it of items) {
      const productId = parseInt(it.productId, 10);
      const quantity  = parseInt(it.quantity, 10);
      const price     = it.price != null ? Number(it.price) : null;
      const name      = it.name;
      const image     = it.image || null;
      if (!productId || !quantity || quantity <= 0 || price == null || !name) continue;
      await client.query(
        `
        INSERT INTO cart_items
          (cart_id, product_id, quantity, price_snapshot, name_snapshot, image_snapshot)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (cart_id, product_id) DO UPDATE
          SET quantity = cart_items.quantity + EXCLUDED.quantity
        `,
        [cartId, productId, quantity, price, name, image],
      );
    }
    await client.query('COMMIT');
    await evictCart(req.userId);
    const merged = await loadCartItems(cartId);
    res.json({ userId: req.userId, items: merged });
  } catch (e) {
    await client.query('ROLLBACK');
    logger.error({ err: e }, 'POST /merge failed');
    res.status(500).json({ error: 'Failed to merge cart' });
  } finally {
    client.release();
  }
});

// ── Abandoned-cart sweeper ───────────────────────────────────────────
/**
 * Find non-empty carts whose last_activity_at is older than the
 * threshold and whose abandoned_email_sent_at is NULL. Email + first
 * name are read from the local denormalized snapshot columns
 * (user_email / user_first_name) — no JOIN against users is needed
 * (the users table now lives in auth_db under the database-per-service
 * split). The snapshot is populated at every cart mutation from the
 * gateway-forwarded x-user-email header. Stamp
 * abandoned_email_sent_at = NOW() so we don't email the same user
 * repeatedly while they remain inactive.
 *
 * Each abandoned cart fans out a single `cart.abandoned` event;
 * email-service subscribes to that and renders the abandoned_cart
 * template.
 */
async function sweepAbandonedCarts() {
  try {
    const cutoffMs = Date.now() - ABANDONED_AFTER_MS;
    const cutoff   = new Date(cutoffMs).toISOString();
    // Find candidates (one query, no item join — items fetched per cart).
    const { rows: candidates } = await pool.query(
      `
      SELECT c.id              AS "cartId",
             c.user_id         AS "userId",
             c.user_email      AS email,
             c.user_first_name AS "firstName"
      FROM carts c
      WHERE c.abandoned_email_sent_at IS NULL
        AND c.last_activity_at < $1
        AND c.user_email IS NOT NULL
        AND EXISTS (SELECT 1 FROM cart_items ci WHERE ci.cart_id = c.id)
      `,
      [cutoff],
    );

    if (candidates.length === 0) return;
    logger.info({ count: candidates.length }, 'sweeper: abandoned carts found');

    for (const c of candidates) {
      const items = await loadCartItems(c.cartId);
      if (items.length === 0) continue;

      const total = items.reduce((sum, it) => sum + Number(it.price) * it.quantity, 0);

      await publishEvent('cart.abandoned', {
        userId:    c.userId,
        email:     c.email,
        firstName: c.firstName || 'there',
        items,
        total,
        cartUrl:   `${(process.env.FRONTEND_URL || '').replace(/\/$/, '')}/cart`,
      });

      // Stamp the row so we don't re-publish until the user is active again.
      await pool.query(
        `
        UPDATE carts
        SET abandoned_email_sent_at = NOW(),
            abandoned_email_count   = abandoned_email_count + 1
        WHERE id = $1
        `,
        [c.cartId],
      );
      abandonedSweepCounter.inc();
    }
  } catch (e) {
    logger.error({ err: e }, 'sweepAbandonedCarts failed');
  }
}

// Kick off after a short delay so the service is fully initialised
// (especially the rabbit publish channel) before the first sweep.
setTimeout(() => {
  sweepAbandonedCarts();
  setInterval(sweepAbandonedCarts, SWEEP_INTERVAL_MS);
}, 15_000);

// ── Start ────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  logger.info(
    { port: PORT, abandonedAfterMs: ABANDONED_AFTER_MS, sweepIntervalMs: SWEEP_INTERVAL_MS },
    'Cart Service running',
  );
});
