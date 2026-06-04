const express = require('express');
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
app.get('/public', async (req, res) => {
  try {
    const { category } = req.query;
    const cacheKey = category && category !== 'all' ? `products:category:${category}` : 'products:all';
    
    // Try cache first
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      console.log('✅ Cache HIT for products');
      return res.json(JSON.parse(cached));
    }
    
    console.log('❌ Cache MISS - fetching from database');
    
    let query = `
      SELECT id, name, description, price, category, stock, brand, images, 
             average_rating, total_reviews, created_at
      FROM products
    `;
    
    const params = [];
    if (category && category !== 'all') {
      query += ' WHERE category = $1';
      params.push(category);
    }
    
    query += ' ORDER BY created_at DESC';
    
    const result = await pool.query(query, params);
    
    const products = result.rows.map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      price: parseFloat(p.price),
      category: p.category,
      stock: p.stock,
      brand: p.brand,
      images: p.images,
      averageRating: parseFloat(p.average_rating || 0),
      totalReviews: parseInt(p.total_reviews || 0),
      createdAt: p.created_at
    }));
    
    // Cache for 5 minutes
    await redisClient.setEx(cacheKey, 300, JSON.stringify(products));
    
    res.json(products);
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({ error: 'Failed to fetch products' });
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
    const { name, description, price, category, stock, brand, images } = req.body;
    
    const result = await pool.query(
      `INSERT INTO products (name, description, price, category, stock, brand, images)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [name, description, price, category, stock, brand, images]
    );
    
    // Invalidate cache
    await redisClient.del('products:all');
    await redisClient.del(`products:category:${category}`);
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create product error:', error);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// Update product - INVALIDATE CACHE
app.put('/:id', async (req, res) => {
  try {
    const { name, description, price, category, stock, brand, images } = req.body;
    
    const result = await pool.query(
      `UPDATE products 
       SET name = $1, description = $2, price = $3, category = $4, 
           stock = $5, brand = $6, images = $7, updated_at = NOW()
       WHERE id = $8
       RETURNING *`,
      [name, description, price, category, stock, brand, images, req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    // Invalidate cache
    await redisClient.del(`product:${req.params.id}`);
    await redisClient.del('products:all');
    await redisClient.del(`products:category:${category}`);
    
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
    await redisClient.del('products:all');
    if (result.rows[0].category) {
      await redisClient.del(`products:category:${result.rows[0].category}`);
    }
    
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
