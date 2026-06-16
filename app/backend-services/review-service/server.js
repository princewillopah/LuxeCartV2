const express = require('express');
const { logger, requestLogger } = require('./shared/logger')('review-service');

const cors = require('cors');
const { Pool } = require('pg');
// Prometheus metrics
const promClient = require('prom-client');
const register = new promClient.Registry();

const app = express();
const PORT = process.env.PORT || 3006;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

app.use(cors());
app.use(express.json());

app.use(requestLogger);

app.get('/health', (req, res) => {
  res.json({ status: 'Review Service is running' });
});


///// prometheus
register.setDefaultLabels({
  service: 'review-service'
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
      service: 'review-service',
      method: req.method,
      route,
      status: res.statusCode
    });

    httpRequestDuration.observe(
      {
        service: 'review-service',
        method: req.method,
        route
      },
      duration
    );
  });

  next();
});

// Create review (comments only, NO rating here)
app.post('/', async (req, res) => {
  try {
    const { productId, userId, userName, comment } = req.body;
    
    if (!productId || !userId || !comment) {
      return res.status(400).json({ error: 'productId, userId, and comment are required' });
    }
    
    // Get user info if userName not provided
    let finalUserName = userName;
    if (!finalUserName) {
      const userResult = await pool.query(
        'SELECT first_name, last_name FROM users WHERE id = $1',
        [userId]
      );
      if (userResult.rows.length > 0) {
        const user = userResult.rows[0];
        finalUserName = `${user.first_name} ${user.last_name}`;
      } else {
        finalUserName = 'Anonymous';
      }
    }
    
    const result = await pool.query(
      `INSERT INTO reviews (product_id, user_id, user_name, comment)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [productId, userId, finalUserName, comment]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create review error:', error);
    res.status(500).json({ error: 'Failed to create review' });
  }
});

// Get reviews for a product (public)
app.get('/public/product/:productId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, 
              (SELECT rating FROM ratings WHERE product_id = r.product_id AND user_id = r.user_id) as rating
       FROM reviews r
       WHERE r.product_id = $1
       ORDER BY r.created_at DESC`,
      [req.params.productId]
    );
    
    const reviews = result.rows.map(r => ({
      id: r.id,
      productId: r.product_id,
      userId: r.user_id,
      userName: r.user_name,
      rating: r.rating,
      comment: r.comment,
      helpful: r.helpful || 0,
      verified: r.verified || false,
      createdAt: r.created_at
    }));
    
    res.json(reviews);
  } catch (error) {
    console.error('Get reviews error:', error);
    res.status(500).json({ error: 'Failed to get reviews' });
  }
});

// Mark review as helpful
app.post('/:id/helpful', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE reviews 
       SET helpful = helpful + 1
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Review not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Mark helpful error:', error);
    res.status(500).json({ error: 'Failed to mark helpful' });
  }
});

// Delete review
app.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM reviews WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Review not found' });
    }
    
    res.json({ message: 'Review deleted', id: result.rows[0].id });
  } catch (error) {
    console.error('Delete review error:', error);
    res.status(500).json({ error: 'Failed to delete review' });
  }
});



app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.listen(PORT, () => {
  console.log(`Review Service running on port ${PORT}`);
});
