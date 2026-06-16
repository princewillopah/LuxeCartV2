const express = require('express');
const { logger, requestLogger } = require('./shared/logger')('user-service');
const { createHttpClient, HttpClientError } = require('./shared/httpClient');

const cors = require('cors');
const { Pool } = require('pg');
const { consumeEvents } = require('./shared/eventBus');
// Prometheus metrics
const promClient = require('prom-client');
const register = new promClient.Registry();


const app = express();
const PORT = process.env.PORT || 3002;





// Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// auth-service is the sole writer of the users table (auth_db). We hold a
// local read-side projection (`users` table in users_db) that's populated
// by Kafka events (user.registered / user.profile_updated / user.deleted)
// — that gives us low-latency reads for /me, /:id, GET / without ever
// cross-querying auth_db.
//
// PUT /:id and DELETE /:id are proxied to auth-service over HTTP. auth-
// service writes its own DB and publishes the corresponding event, which
// our consumer then applies to the projection. Read-your-own-write is
// best-effort: the API response uses the auth-service reply so callers
// see fresh data without waiting for the event round-trip.
const AUTH_SERVICE_URL    = process.env.AUTH_SERVICE_URL    || 'http://auth-service:3001';
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || 'http://product-service:3003';

// Hardened HTTP clients — one per downstream target so circuit breakers
// are scoped per service. PUT/DELETE to /internal/users/{id} are
// idempotent (full-replace + by-id delete) so we opt-in to retry on those
// calls.
const httpOpts = {
  register, promClient, logger,
  timeoutMs: 3000,
  retry:   { attempts: 2, baseDelayMs: 100, maxDelayMs: 800 },
  breaker: {
    timeout: 3500, errorThresholdPercentage: 50, resetTimeout: 10_000,
    volumeThreshold: 10, rollingCountTimeout: 30_000, rollingCountBuckets: 10,
  },
};
const authHttp    = createHttpClient({ ...httpOpts, target: 'auth-service',    baseUrl: AUTH_SERVICE_URL });
const productHttp = createHttpClient({ ...httpOpts, target: 'product-service', baseUrl: PRODUCT_SERVICE_URL });

app.use(cors());
app.use(express.json());

app.use(requestLogger);

app.get('/health', (req, res) => {
  res.json({ status: 'User Service is running' });
});


///// prometheus
register.setDefaultLabels({
  service: 'user-service'
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



app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});



// ✅ middleware
app.use((req, res, next) => {
  if (req.path === '/metrics') return next(); 

  const start = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;

    const route = req.route?.path || req.path || 'unknown';

    httpRequestCounter.inc({
      service: 'user-service',
      method: req.method,
      route,
      status: res.statusCode
    });

    httpRequestDuration.observe(
      {
        service: 'user-service',
        method: req.method,
        route
      },
      duration
    );
  });

  next();
});

// Get all users (admin) — supports pagination + search.
// Backwards-compatible: when no `page` or `limit` query param is supplied,
// returns the legacy unwrapped array shape; otherwise wraps the response
// as { items, total, page, limit } so the admin UI can render a pager.
//
// Served from the local read-side projection (`users` table in users_db),
// which is kept in sync via Kafka events emitted by auth-service.
app.get('/', async (req, res) => {
  if (req.header('x-user-role') !== 'admin') {
    return res.status(403).json({ error: 'Admin role required' });
  }
  try {
    const hasPagination = req.query.page != null || req.query.limit != null;
    const page  = Math.max(parseInt(req.query.page, 10)  || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').toString().trim();

    const where = [];
    const params = [];
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where.push(`(LOWER(email) LIKE $${params.length} OR LOWER(first_name) LIKE $${params.length} OR LOWER(last_name) LIKE $${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const totalQ = await pool.query(
      `SELECT COUNT(*)::int AS total FROM users ${whereSql}`,
      params
    );
    const total = totalQ.rows[0].total;

    const dataParams = [...params, limit, offset];
    const result = await pool.query(
      `SELECT id, email, first_name, last_name, role, created_at
         FROM users ${whereSql}
         ORDER BY created_at DESC
         LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );
    const users = result.rows.map(user => ({
      id: user.id, email: user.email, firstName: user.first_name, lastName: user.last_name, role: user.role, createdAt: user.created_at
    }));

    if (hasPagination) {
      res.json({ items: users, total, page, limit });
    } else {
      res.json(users);
    }
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get the currently authenticated user. The api-gateway forwards the
// caller's id in `x-user-id` after verifying the JWT, so this endpoint is
// effectively just "look up by header id". Served from the local read-side
// projection.
app.get('/me', async (req, res) => {
  const id = req.header('x-user-id');
  if (!id) return res.status(401).json({ error: 'Authentication required' });
  try {
    const result = await pool.query(
      'SELECT id, email, first_name, last_name, role, phone, email_verified, created_at FROM users WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const u = result.rows[0];
    res.json({
      id: u.id,
      email: u.email,
      firstName: u.first_name,
      lastName: u.last_name,
      role: u.role,
      phone: u.phone,
      emailVerified: u.email_verified,
      createdAt: u.created_at,
    });
  } catch (error) {
    console.error('Get /me error:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// Get user by ID — served from the local read-side projection.
app.get('/:id(\\d+)', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email, first_name, last_name, role, phone, created_at FROM users WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = result.rows[0];
    res.json({
      id: user.id, email: user.email, firstName: user.first_name, lastName: user.last_name, role: user.role, phone: user.phone, createdAt: user.created_at
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// Update user — proxied to auth-service, which is the sole writer of
// the users table. auth-service publishes user.profile_updated; our
// consumer below refreshes the local projection from that event.
// Read-your-own-write: we return auth-service's reply directly so the
// caller sees fresh data without waiting on the event round-trip.
app.put('/:id(\\d+)', async (req, res) => {
  try {
    const { firstName, lastName, phone } = req.body || {};
    const updated = await authHttp.putJson(
      `/internal/users/${encodeURIComponent(req.params.id)}`,
      { firstName, lastName, phone },
      { idempotent: true, requestId: req.id }
    );
    if (updated === undefined) return res.status(404).json({ error: 'User not found' });
    res.json(updated);
  } catch (error) {
    if (error instanceof HttpClientError && error.status >= 400 && error.status < 500) {
      return res.status(error.status).json({ error: 'Profile update failed', code: error.code });
    }
    req.log?.error({ err: { message: error?.message, code: error?.code } }, 'Update user error');
    res.status(502).json({ error: 'Profile update failed', code: error?.code || 'UPSTREAM' });
  }
});

// Delete user — proxied to auth-service. auth-service deletes from auth_db
// (which cascades auth_tokens/refresh_tokens via FK) and publishes
// user.deleted. Each other bounded context (this service for wishlists +
// addresses, notification-service, rating-service, review-service, etc.)
// consumes that event and cleans up its own data — choreographed saga.
app.delete('/:id(\\d+)', async (req, res) => {
  const callerRole = req.header('x-user-role');
  const callerId = req.header('x-user-id');
  const targetId = req.params.id;

  if (callerRole !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  if (callerId && String(callerId) === String(targetId)) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }

  try {
    const deleted = await authHttp.deleteJson(
      `/internal/users/${encodeURIComponent(targetId)}`,
      { idempotent: true, requestId: req.id }
    );
    if (deleted === undefined) return res.status(404).json({ error: 'User not found' });
    res.json(deleted);
  } catch (error) {
    if (error instanceof HttpClientError && error.status >= 400 && error.status < 500) {
      return res.status(error.status).json({ error: 'User delete failed', code: error.code });
    }
    req.log?.error({ err: { message: error?.message, code: error?.code } }, 'Delete user error');
    res.status(502).json({ error: 'User delete failed', code: error?.code || 'UPSTREAM' });
  }
});

// ─── Wishlist ──────────────────────────────────────────────────────────────
// All wishlist routes require the caller's identity, which the api-gateway
// forwards as `x-user-id` after verifying the JWT.
function requireCaller(req, res) {
  const id = req.header('x-user-id');
  if (!id) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  return Number(id);
}

// List the caller's wishlist. Wishlists live in users_db (just product
// ids); product detail comes from product-service over HTTP (cross-DB
// JOIN is no longer possible under the database-per-service split). We
// fan the GETs out in parallel so a 20-item wishlist isn't an N-stage
// waterfall.
app.get('/wishlist', async (req, res) => {
  const userId = requireCaller(req, res);
  if (userId == null) return;
  try {
    const ids = await pool.query(
      `SELECT product_id, added_at
         FROM wishlists
        WHERE user_id = $1
        ORDER BY added_at DESC`,
      [userId]
    );

    if (ids.rows.length === 0) return res.json([]);

    // Parallel HTTP fan-out. Failures (e.g. product was deleted) are
    // tolerated — that wishlist entry is just skipped from the response.
    const items = await Promise.all(
      ids.rows.map(async (row) => {
        try {
          const p = await productHttp.getJson(`/public/${encodeURIComponent(row.product_id)}`, { requestId: req.id });
          if (!p) return null; // 404
          return {
            addedAt: row.added_at,
            product: {
              id:            p.id,
              name:          p.name,
              description:   p.description,
              price:         Number(p.price),
              category:      p.category,
              stock:         p.stock,
              brand:         p.brand,
              images:        p.images,
              averageRating: Number(p.averageRating || 0),
              totalReviews:  Number(p.totalReviews  || 0),
            },
          };
        } catch (e) {
          console.error(`Wishlist enrich failed for product ${row.product_id}:`, e.message);
          return null;
        }
      })
    );

    res.json(items.filter(Boolean));
  } catch (error) {
    console.error('List wishlist error:', error);
    res.status(500).json({ error: 'Failed to fetch wishlist' });
  }
});

// Compact form: just product IDs. Used by the frontend to render heart state
// on product cards without round-tripping the entire wishlist.
app.get('/wishlist/ids', async (req, res) => {
  const userId = requireCaller(req, res);
  if (userId == null) return;
  try {
    const result = await pool.query(
      'SELECT product_id FROM wishlists WHERE user_id = $1',
      [userId]
    );
    res.json(result.rows.map(r => r.product_id));
  } catch (error) {
    console.error('List wishlist ids error:', error);
    res.status(500).json({ error: 'Failed to fetch wishlist' });
  }
});

// Add a product to the caller's wishlist. Idempotent.
// We do a HEAD/GET against product-service first so we can return a clean
// 404 if the product doesn't exist (no cross-DB FK to do that for us
// anymore under the database-per-service split).
app.post('/wishlist', async (req, res) => {
  const userId = requireCaller(req, res);
  if (userId == null) return;
  const productId = Number(req.body?.productId);
  if (!productId) {
    return res.status(400).json({ error: 'productId is required' });
  }
  try {
    let exists;
    try {
      exists = await productHttp.getJson(`/public/${encodeURIComponent(productId)}`, { requestId: req.id });
    } catch (e) {
      // Don't block the add for transient product-service hiccups; only
      // a clean 404 (exists === undefined) should fail with 404.
      req.log?.warn({ err: { message: e?.message, code: e?.code } }, 'wishlist product check degraded');
      exists = true; // treat as unknown → allow
    }
    if (exists === undefined) {
      return res.status(404).json({ error: 'Product not found' });
    }

    await pool.query(
      `INSERT INTO wishlists (user_id, product_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, product_id) DO NOTHING`,
      [userId, productId]
    );
    res.status(201).json({ userId, productId });
  } catch (error) {
    console.error('Add to wishlist error:', error);
    res.status(500).json({ error: 'Failed to add to wishlist' });
  }
});

// Remove a product from the caller's wishlist. Idempotent.
app.delete('/wishlist/:productId(\\d+)', async (req, res) => {
  const userId = requireCaller(req, res);
  if (userId == null) return;
  try {
    await pool.query(
      'DELETE FROM wishlists WHERE user_id = $1 AND product_id = $2',
      [userId, req.params.productId]
    );
    res.status(204).end();
  } catch (error) {
    console.error('Remove from wishlist error:', error);
    res.status(500).json({ error: 'Failed to remove from wishlist' });
  }
});

// ─── Saved addresses ──────────────────────────────────────────────────────────────
// Customer-managed list of shipping addresses. The checkout page reads
// these on load and uses the default (or one the user picks) to skip
// retyping the address form every order.
//
// Authorisation: all routes use the gateway-forwarded `x-user-id` and
// scope every query to that id — a user can only see/modify their own
// addresses. No admin override is needed for these.

function mapAddress(r) {
  return {
    id: r.id,
    fullName: r.full_name,
    line1: r.line1,
    line2: r.line2,
    city: r.city,
    state: r.state,
    postal: r.postal,
    country: r.country,
    phone: r.phone,
    isDefault: r.is_default,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function validateAddressBody(body) {
  const errors = [];
  const required = ['fullName', 'line1', 'city', 'state', 'country'];
  for (const k of required) {
    if (!body?.[k] || String(body[k]).trim() === '') errors.push(`${k} is required`);
  }
  return errors;
}

app.get('/addresses', async (req, res) => {
  const userId = requireCaller(req, res);
  if (userId == null) return;
  try {
    const result = await pool.query(
      `SELECT * FROM user_addresses WHERE user_id = $1
         ORDER BY is_default DESC, updated_at DESC`,
      [userId]
    );
    res.json(result.rows.map(mapAddress));
  } catch (error) {
    console.error('List addresses error:', error);
    res.status(500).json({ error: 'Failed to fetch addresses' });
  }
});

app.post('/addresses', async (req, res) => {
  const userId = requireCaller(req, res);
  if (userId == null) return;
  const errs = validateAddressBody(req.body);
  if (errs.length) return res.status(400).json({ error: 'Invalid address', details: errs });
  const { fullName, line1, line2, city, state, postal, country, phone, isDefault } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // First address is always default; otherwise honour the flag.
    const countQ = await client.query('SELECT COUNT(*)::int AS n FROM user_addresses WHERE user_id = $1', [userId]);
    const makeDefault = isDefault === true || countQ.rows[0].n === 0;
    if (makeDefault) {
      await client.query('UPDATE user_addresses SET is_default = FALSE WHERE user_id = $1 AND is_default = TRUE', [userId]);
    }
    const result = await client.query(
      `INSERT INTO user_addresses
         (user_id, full_name, line1, line2, city, state, postal, country, phone, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [userId, fullName, line1, line2 || null, city, state, postal || null, country || 'Nigeria', phone || null, makeDefault]
    );
    await client.query('COMMIT');
    res.status(201).json(mapAddress(result.rows[0]));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Create address error:', error);
    res.status(500).json({ error: 'Failed to save address' });
  } finally {
    client.release();
  }
});

app.put('/addresses/:id(\\d+)', async (req, res) => {
  const userId = requireCaller(req, res);
  if (userId == null) return;
  const errs = validateAddressBody(req.body);
  if (errs.length) return res.status(400).json({ error: 'Invalid address', details: errs });
  const { fullName, line1, line2, city, state, postal, country, phone, isDefault } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (isDefault === true) {
      await client.query('UPDATE user_addresses SET is_default = FALSE WHERE user_id = $1 AND is_default = TRUE AND id <> $2', [userId, req.params.id]);
    }
    const result = await client.query(
      `UPDATE user_addresses
         SET full_name = $1, line1 = $2, line2 = $3, city = $4, state = $5,
             postal = $6, country = $7, phone = $8,
             is_default = COALESCE($9, is_default),
             updated_at = NOW()
       WHERE id = $10 AND user_id = $11
       RETURNING *`,
      [fullName, line1, line2 || null, city, state, postal || null, country || 'Nigeria', phone || null,
       typeof isDefault === 'boolean' ? isDefault : null, req.params.id, userId]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Address not found' });
    }
    await client.query('COMMIT');
    res.json(mapAddress(result.rows[0]));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Update address error:', error);
    res.status(500).json({ error: 'Failed to update address' });
  } finally {
    client.release();
  }
});

app.post('/addresses/:id(\\d+)/default', async (req, res) => {
  const userId = requireCaller(req, res);
  if (userId == null) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owns = await client.query('SELECT id FROM user_addresses WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (owns.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Address not found' });
    }
    await client.query('UPDATE user_addresses SET is_default = FALSE WHERE user_id = $1 AND is_default = TRUE', [userId]);
    await client.query('UPDATE user_addresses SET is_default = TRUE, updated_at = NOW() WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ id: Number(req.params.id), isDefault: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Set default address error:', error);
    res.status(500).json({ error: 'Failed to set default address' });
  } finally {
    client.release();
  }
});

app.delete('/addresses/:id(\\d+)', async (req, res) => {
  const userId = requireCaller(req, res);
  if (userId == null) return;
  try {
    const result = await pool.query(
      'DELETE FROM user_addresses WHERE id = $1 AND user_id = $2 RETURNING id, is_default',
      [req.params.id, userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Address not found' });
    // If we just removed the default and others exist, promote the most recently
    // updated one to default so the user always has a default for checkout.
    if (result.rows[0].is_default) {
      await pool.query(
        `UPDATE user_addresses SET is_default = TRUE
           WHERE id = (
             SELECT id FROM user_addresses WHERE user_id = $1
             ORDER BY updated_at DESC LIMIT 1
           )`,
        [userId]
      );
    }
    res.status(204).end();
  } catch (error) {
    console.error('Delete address error:', error);
    res.status(500).json({ error: 'Failed to delete address' });
  }
});

// ───────────────────────────────────────────────────────────────────────
// CQRS read-side projection — keeps the local `users` table in sync with
// auth-service via Kafka events. auth-service is the only writer of the
// source-of-truth `users` table (in auth_db); we maintain a denormalized
// copy here for low-latency reads.
// ───────────────────────────────────────────────────────────────────────

async function upsertUserProjection(u) {
  if (!u || !u.userId) return;
  await pool.query(
    `INSERT INTO users (id, email, password, first_name, last_name, role, phone, email_verified, created_at, updated_at)
     VALUES ($1, $2, '<projection>', $3, $4, $5, $6, $7, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE
       SET email          = EXCLUDED.email,
           first_name     = EXCLUDED.first_name,
           last_name      = EXCLUDED.last_name,
           role           = EXCLUDED.role,
           phone          = EXCLUDED.phone,
           email_verified = COALESCE(EXCLUDED.email_verified, users.email_verified),
           updated_at     = NOW()`,
    [
      u.userId,
      u.email || null,
      u.firstName || null,
      u.lastName  || null,
      u.role      || 'user',
      u.phone     || null,
      u.emailVerified === true,
    ]
  );
}

async function deleteUserProjection(userId) {
  if (!userId) return;
  // Same-DB cascades take care of wishlists + user_addresses (FK ON DELETE
  // CASCADE), so we just drop the projection row.
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
}

/**
 * Best-effort initial backfill — on startup, pull the current user list
 * from auth-service so the local projection is hot before serving traffic.
 * Kafka events keep it fresh from then on. Failures are logged but never
 * block startup.
 */
async function backfillProjection() {
  try {
    const body = await authHttp.getJson('/internal/users', { query: { page: 1, limit: 200 } });
    if (!body) {
      console.warn('[user-service] backfill: empty response');
      return;
    }
    const items = body.items || [];
    for (const u of items) {
      await upsertUserProjection({
        userId:        u.id,
        email:         u.email,
        firstName:     u.firstName,
        lastName:      u.lastName,
        role:          u.role,
        phone:         u.phone,
        emailVerified: u.emailVerified,
      });
    }
    console.log(`[user-service] backfilled ${items.length} user(s) into projection`);
  } catch (e) {
    console.error('[user-service] backfill error:', e.message);
  }
}

async function startProjectionConsumers() {
  try {
    await consumeEvents('user.registered', async (data) => {
      await upsertUserProjection(data);
    }, 'user_projection_registered');

    await consumeEvents('user.profile_updated', async (data) => {
      await upsertUserProjection(data);
    }, 'user_projection_updated');

    await consumeEvents('user.deleted', async (data) => {
      await deleteUserProjection(data?.userId);
    }, 'user_projection_deleted');

    console.log('[user-service] projection consumers registered ✅');
  } catch (e) {
    console.error('[user-service] failed to start projection consumers:', e.message);
  }
}

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`User Service running on port ${PORT}`);
  // Kick off Kafka consumers a touch after listen so HTTP /health is up
  // before we start handling events; backfill runs in parallel.
  setTimeout(() => {
    startProjectionConsumers();
    backfillProjection();
  }, 3000);
});