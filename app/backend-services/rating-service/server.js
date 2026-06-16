const express = require('express');
const { logger, requestLogger } = require('./shared/logger')('rating-service');
const { createHttpClient, HttpClientError } = require('./shared/httpClient');

const cors = require('cors');
const { Pool } = require('pg');
const redis = require('redis');
// Prometheus metrics
const promClient = require('prom-client');
const register = new promClient.Registry();

const app = express();
const PORT = process.env.PORT || 3007;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// product-service base URL. Under the database-per-service split this is
// the ONLY way we can keep `products.average_rating` / `products.total_reviews`
// in sync — we can't UPDATE that table directly anymore (it lives in
// products_db, not ratings_db).
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || 'http://product-service:3003';

// Hardened HTTP client. The push is idempotent (POST that replaces an
// aggregate — same input always sets the same value), so we opt-in to
// retries to ride out transient blips.
const productHttp = createHttpClient({
  target: 'product-service',
  baseUrl: PRODUCT_SERVICE_URL,
  register,
  promClient,
  logger,
  timeoutMs: 2500,
  retry:   { attempts: 2, baseDelayMs: 100, maxDelayMs: 800 },
  breaker: {
    timeout: 3000, errorThresholdPercentage: 50, resetTimeout: 10_000,
    volumeThreshold: 5, rollingCountTimeout: 30_000, rollingCountBuckets: 10,
  },
});

/**
 * Best-effort POST to product-service to push the recomputed rating
 * aggregate. Swallows failures: if product-service is down momentarily,
 * the rating itself is still saved in ratings_db and the next rating
 * submission will resync. (For full durability we'd add an outbox
 * pattern — future improvement.)
 */
async function pushRatingSummaryToProduct(productId, avgRating, totalReviews) {
  try {
    await productHttp.postJson(
      `/internal/products/${encodeURIComponent(productId)}/rating-summary`,
      { avgRating: Number(avgRating), totalReviews: Number(totalReviews) },
      { idempotent: true }
    );
  } catch (e) {
    const ctx = e instanceof HttpClientError
      ? { status: e.status, code: e.code, target: e.target }
      : { message: e?.message };
    logger.warn({ productId, err: ctx }, 'rating-summary push degraded');
  }
}

// Redis client — used ONLY to invalidate product-service's cache
// when a rating changes the product's average_rating / total_reviews.
let redisClient = null;
if (process.env.REDIS_URL) {
  redisClient = redis.createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', (err) => console.error('Rating-service Redis error:', err.message));
  redisClient.on('connect', () => console.log('✅ Rating Service Redis connected'));
  (async () => {
    try { await redisClient.connect(); } catch (e) { console.error('Redis connect failed:', e.message); }
  })();
}

async function invalidateProductCache(productId) {
  if (!redisClient || !redisClient.isOpen) return;
  try {
    await redisClient.del(`product:${productId}`);
    // wipe all listing caches (default + per-category)
    const keys = await redisClient.keys('products:*');
    if (keys.length) await redisClient.del(keys);
  } catch (e) {
    console.error('Cache invalidation failed:', e.message);
  }
}

app.use(cors());
app.use(express.json());

app.use(requestLogger);

app.get('/health', (req, res) => {
  res.json({ status: 'Rating Service is running' });
});


///// prometheus
register.setDefaultLabels({
  service: 'rating-service'
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
      service: 'rating-service',
      method: req.method,
      route,
      status: res.statusCode
    });

    httpRequestDuration.observe(
      {
        service: 'rating-service',
        method: req.method,
        route
      },
      duration
    );
  });

  next();
});

// Helper to recompute the local rating aggregate AND push it to
// product-service so the catalog display stays consistent. Under the
// database-per-service split we can no longer UPDATE products.* directly.
async function updateProductRating(productId) {
  const result = await pool.query(
    `SELECT AVG(rating)::numeric(3,2) as avg_rating, COUNT(*) as total_reviews
     FROM ratings 
     WHERE product_id = $1`,
    [productId]
  );

  const exactAvg = parseFloat(result.rows[0].avg_rating || 0);
  const totalReviews = parseInt(result.rows[0].total_reviews || 0);

  // Push the new summary to product-service (best-effort — see
  // pushRatingSummaryToProduct comments).
  await pushRatingSummaryToProduct(productId, exactAvg, totalReviews);

  console.log(`Updated product ${productId}: ${exactAvg.toFixed(2)} average from ${totalReviews} ratings`);

  return { avgRating: exactAvg, exactAvg, totalRatings: totalReviews };
}

// Submit or update rating
app.post('/product/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    const { userId, rating, userFirstName, userLastName } = req.body;

    if (!userId || !rating) {
      return res.status(400).json({ error: 'userId and rating are required' });
    }

    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }

    // Denormalized snapshot — frontend forwards firstName+lastName from
    // the post-login user object so we don't need a cross-DB JOIN to
    // users_db at read time. Falls back to a sentinel if missing.
    const userName = [userFirstName, userLastName].filter(Boolean).join(' ').trim() || `User ${userId}`;

    // Upsert rating. user_name is refreshed on every upsert so a profile
    // rename eventually propagates the next time the user re-rates.
    await pool.query(
      `INSERT INTO ratings (product_id, user_id, rating, user_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (product_id, user_id)
       DO UPDATE SET rating = EXCLUDED.rating,
                     user_name = EXCLUDED.user_name,
                     created_at = NOW()`,
      [productId, userId, rating, userName]
    );
    
    // Update product average rating
    const updated = await updateProductRating(productId);

    // Invalidate the product-service Redis cache so the new rating shows up
    await invalidateProductCache(productId);

    res.json({
      message: 'Rating submitted',
      productId,
      userId,
      rating,
      avgRating: updated.avgRating,
      totalRatings: updated.totalRatings
    });
  } catch (error) {
    console.error('Submit rating error:', error);
    res.status(500).json({ error: 'Failed to submit rating' });
  }
});

// Get user's rating for a product
app.get('/product/:productId/user/:userId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT rating, created_at FROM ratings WHERE product_id = $1 AND user_id = $2',
      [req.params.productId, req.params.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Rating not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get rating error:', error);
    res.status(500).json({ error: 'Failed to get rating' });
  }
});

// Get all ratings for a product. Now reads from ratings_db only — user
// name is denormalized into ratings.user_name at insert time, so no
// cross-DB JOIN against users is needed.
app.get('/product/:productId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, product_id, user_id, user_name, rating, created_at
         FROM ratings
        WHERE product_id = $1
        ORDER BY created_at DESC`,
      [req.params.productId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Get ratings error:', error);
    res.status(500).json({ error: 'Failed to get ratings' });
  }
});

// Get rating distribution for a product
app.get('/product/:productId/distribution', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        rating,
        COUNT(*) as count
       FROM ratings
       WHERE product_id = $1
       GROUP BY rating
       ORDER BY rating DESC`,
      [req.params.productId]
    );
    
    // Create distribution object
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    result.rows.forEach(row => {
      distribution[row.rating] = parseInt(row.count);
    });
    
    res.json(distribution);
  } catch (error) {
    console.error('Get distribution error:', error);
    res.status(500).json({ error: 'Failed to get distribution' });
  }
});



app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.listen(PORT, () => {
  console.log(`Rating Service running on port ${PORT}`);
});
