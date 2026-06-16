const express = require('express');
const { logger, requestLogger } = require('./shared/logger')('product-service');

const cors = require('cors');
const { Pool } = require('pg');
const redis = require('redis');
// Prometheus metrics
const promClient = require('prom-client');
const register = new promClient.Registry();

const app = express();
const PORT = process.env.PORT || 3003;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Redis client
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || 'redis://redis:6379'
});

redisClient.on('error', (err) => console.error('Redis error:', err));
redisClient.on('connect', () => console.log('✅ Product Service Redis connected'));

(async () => {
  await redisClient.connect();
})();

app.use(cors());
app.use(express.json());

app.use(requestLogger);

// app.get('/health', (req, res) => {
//   res.json({ status: 'Product Service running with Redis cache' });
// });
app.get('/health', async (req, res) => {
  try {
    await redisClient.ping();
    res.json({ status: 'Product Service is running with Redis' });
  } catch (e) {
    res.status(503).json({ status: 'unhealthy', error: 'Redis connection issue' });
  }
});


///// prometheus
register.setDefaultLabels({
  service: 'product-service'
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
      service: 'product-service',
      method: req.method,
      route,
      status: res.statusCode
    });

    httpRequestDuration.observe(
      {
        service: 'product-service',
        method: req.method,
        route
      },
      duration
    );
  });

  next();
});


// Clears every list-level cache key after a product mutation. The keys
// for `products:featured:*` use scan + del so all variants (limit=8, limit=12…)
// get invalidated together.
async function bustListCaches(category) {
  await redisClient.del('products:all');
  await redisClient.del('products:categories');
  if (category) await redisClient.del(`products:category:${category}`);
  try {
    let cursor = 0;
    do {
      const reply = await redisClient.scan(cursor, { MATCH: 'products:featured:*', COUNT: 100 });
      cursor = reply.cursor;
      if (reply.keys.length) await redisClient.del(reply.keys);
    } while (cursor !== 0);
  } catch (e) {
    console.error('[product] featured cache bust failed:', e.message);
  }
}

// Normalises the `discountPercent` request field. Accepts numbers and numeric
// strings; rejects out-of-range or non-integer values. Returns null when the
// payload is invalid so callers can short-circuit with a 400.
function clampDiscount(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  if (i < 0 || i > 90) return null;
  return i;
}

// Helper function to update product ratings
async function updateProductRatings(productId) {
  try {
    const result = await pool.query(
      `SELECT AVG(rating)::numeric(3,2) as avg_rating, COUNT(*) as total_reviews
       FROM ratings 
       WHERE product_id = $1`,
      [productId]
    );
    
    const avgRating = parseFloat(result.rows[0].avg_rating || 0);
    const totalReviews = parseInt(result.rows[0].total_reviews || 0);
    
    await pool.query(
      `UPDATE products 
       SET average_rating = $1, total_reviews = $2, updated_at = NOW()
       WHERE id = $3`,
      [avgRating, totalReviews, productId]
    );
    
    // Invalidate cache when product updated
    await redisClient.del(`product:${productId}`);
    await redisClient.del('products:all');
    
    return { avgRating, totalReviews };
  } catch (error) {
    console.error('Error updating product ratings:', error);
    throw error;
  }
}

// Get all products (public) - WITH CACHING
// Supports pagination (?page=&limit=) + free-text search (?search=).
// Backwards-compatible: when no `page`/`limit`/`search` query params are
// supplied the response is the legacy unwrapped array (and benefits from
// Redis cache); otherwise it returns { items, total, page, limit } and
// skips the cache because results vary by query.
app.get('/public', async (req, res) => {
  try {
    const { category } = req.query;
    const hasPagination = req.query.page != null || req.query.limit != null;
    const search = (req.query.search || '').toString().trim();
    const usesQuery = hasPagination || !!search;

    // Cache only the legacy (no-query) path.
    const cacheKey = category && category !== 'all' ? `products:category:${category}` : 'products:all';
    if (!usesQuery) {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        console.log('✅ Cache HIT for products');
        return res.json(JSON.parse(cached));
      }
      console.log('❌ Cache MISS - fetching from database');
    }

    const where = [];
    const params = [];
    if (category && category !== 'all') {
      params.push(category);
      where.push(`category = $${params.length}`);
    }
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where.push(`(LOWER(name) LIKE $${params.length} OR LOWER(brand) LIKE $${params.length} OR LOWER(category) LIKE $${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    let total = null;
    if (hasPagination) {
      const totalQ = await pool.query(`SELECT COUNT(*)::int AS total FROM products ${whereSql}`, params);
      total = totalQ.rows[0].total;
    }

    let dataSql = `
      SELECT id, name, description, price, discount_percent, category, stock, brand, images,
             average_rating, total_reviews, created_at
        FROM products
        ${whereSql}
        ORDER BY created_at DESC`;
    let dataParams = params;
    if (hasPagination) {
      const page  = Math.max(parseInt(req.query.page, 10)  || 1, 1);
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
      const offset = (page - 1) * limit;
      dataParams = [...params, limit, offset];
      dataSql += ` LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`;
    }

    const result = await pool.query(dataSql, dataParams);

    const products = result.rows.map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      price: parseFloat(p.price),
      discountPercent: parseInt(p.discount_percent || 0),
      category: p.category,
      stock: p.stock,
      brand: p.brand,
      images: p.images,
      averageRating: parseFloat(p.average_rating || 0),
      totalReviews: parseInt(p.total_reviews || 0),
      createdAt: p.created_at
    }));

    if (hasPagination) {
      const page  = Math.max(parseInt(req.query.page, 10)  || 1, 1);
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
      return res.json({ items: products, total, page, limit });
    }

    if (!usesQuery) {
      await redisClient.setEx(cacheKey, 300, JSON.stringify(products));
    }

    res.json(products);
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// Featured products (top rated → falls back to newest). Registered BEFORE
// `/public/:id` so Express doesn't try to interpret "featured" as an id.
app.get('/public/featured', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 24);
    const cacheKey = `products:featured:${limit}`;

    const cached = await redisClient.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const result = await pool.query(
      `SELECT id, name, description, price, discount_percent, category, stock, brand, images,
              average_rating, total_reviews, created_at
       FROM products
       WHERE stock > 0
       ORDER BY average_rating DESC NULLS LAST,
                total_reviews DESC NULLS LAST,
                created_at DESC
       LIMIT $1`,
      [limit]
    );

    const products = result.rows.map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      price: parseFloat(p.price),
      discountPercent: parseInt(p.discount_percent || 0),
      category: p.category,
      stock: p.stock,
      brand: p.brand,
      images: p.images,
      averageRating: parseFloat(p.average_rating || 0),
      totalReviews: parseInt(p.total_reviews || 0),
      createdAt: p.created_at
    }));

    await redisClient.setEx(cacheKey, 300, JSON.stringify(products));
    res.json(products);
  } catch (err) {
    console.error('Get featured error:', err);
    res.status(500).json({ error: 'Failed to fetch featured products' });
  }
});

// Category list with live product counts.
app.get('/public/categories', async (_req, res) => {
  try {
    const cacheKey = 'products:categories';
    const cached = await redisClient.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const result = await pool.query(
      `SELECT category AS name, COUNT(*)::int AS count
       FROM products
       WHERE category IS NOT NULL AND category <> ''
       GROUP BY category
       ORDER BY count DESC, category ASC`
    );

    await redisClient.setEx(cacheKey, 300, JSON.stringify(result.rows));
    res.json(result.rows);
  } catch (err) {
    console.error('Get categories error:', err);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// Get single product - WITH CACHING
app.get('/public/:id', async (req, res) => {
  try {
    const cacheKey = `product:${req.params.id}`;
    
    // Try cache first
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      console.log(`✅ Cache HIT for product ${req.params.id}`);
      return res.json(JSON.parse(cached));
    }
    
    console.log(`❌ Cache MISS - fetching product ${req.params.id} from database`);
    
    const result = await pool.query(
      'SELECT * FROM products WHERE id = $1',
      [req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    const p = result.rows[0];
    const product = {
      id: p.id,
      name: p.name,
      description: p.description,
      price: parseFloat(p.price),
      discountPercent: parseInt(p.discount_percent || 0),
      category: p.category,
      stock: p.stock,
      brand: p.brand,
      images: p.images,
      averageRating: parseFloat(p.average_rating || 0),
      totalReviews: parseInt(p.total_reviews || 0)
    };
    
    // Cache for 5 minutes
    await redisClient.setEx(cacheKey, 300, JSON.stringify(product));
    
    res.json(product);
  } catch (error) {
    console.error('Get product error:', error);
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

// Create product - INVALIDATE CACHE
app.post('/', async (req, res) => {
  try {
    const { name, description, price, category, stock, brand, images, discountPercent } = req.body;
    // Clamp discount to the same range the DB constraint enforces so a bad
    // payload becomes a 400 (clearer than letting Postgres throw).
    const discount = clampDiscount(discountPercent);
    if (discount === null) {
      return res.status(400).json({ error: 'discountPercent must be an integer between 0 and 90' });
    }

    const result = await pool.query(
      `INSERT INTO products (name, description, price, discount_percent, category, stock, brand, images)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [name, description, price, discount, category, stock, brand, images]
    );
    
    // Invalidate cache
    await bustListCaches(category);

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create product error:', error);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// Update product - INVALIDATE CACHE
app.put('/:id', async (req, res) => {
  try {
    const { name, description, price, category, stock, brand, images, discountPercent } = req.body;
    const discount = clampDiscount(discountPercent);
    if (discount === null) {
      return res.status(400).json({ error: 'discountPercent must be an integer between 0 and 90' });
    }

    const result = await pool.query(
      `UPDATE products 
       SET name = $1, description = $2, price = $3, discount_percent = $4, category = $5, 
           stock = $6, brand = $7, images = $8, updated_at = NOW()
       WHERE id = $9
       RETURNING *`,
      [name, description, price, discount, category, stock, brand, images, req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    // Invalidate cache
    await redisClient.del(`product:${req.params.id}`);
    await bustListCaches(category);

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update product error:', error);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// Delete product - INVALIDATE CACHE
app.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM products WHERE id = $1 RETURNING id, category',
      [req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    // Invalidate cache
    await redisClient.del(`product:${req.params.id}`);
    await bustListCaches(result.rows[0].category);

    res.json({ message: 'Product deleted', id: result.rows[0].id });
  } catch (error) {
    console.error('Delete product error:', error);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// Update product ratings (called by rating service)
app.post('/:id/update-ratings', async (req, res) => {
  try {
    const ratings = await updateProductRatings(req.params.id);
    res.json(ratings);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update ratings' });
  }
});



app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.listen(PORT, () => {
  console.log(`Product Service running on port ${PORT} with Redis cache`);
});
