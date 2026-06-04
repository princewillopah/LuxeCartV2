const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

// Prometheus metrics
const promClient = require('prom-client');
const register = new promClient.Registry();



const app = express();
const PORT = process.env.PORT || 3010;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'Admin Service is running' });
});

///// prometheus
register.setDefaultLabels({
  service: 'admin-service'
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
      service: 'admin-service',
      method: req.method,
      route,
      status: res.statusCode
    });

    httpRequestDuration.observe(
      {
        service: 'admin-service',
        method: req.method,
        route
      },
      duration
    );
  });

  next();
});

// Get dashboard statistics - REAL DATA FROM DATABASE
app.get('/dashboard/stats', async (req, res) => {
  try {
    // Get total users
    const usersResult = await pool.query('SELECT COUNT(*) as count FROM users');
    const totalUsers = parseInt(usersResult.rows[0].count);

    // Get total orders
    const ordersResult = await pool.query('SELECT COUNT(*) as count FROM orders');
    const totalOrders = parseInt(ordersResult.rows[0].count);

    // Get total revenue
    const revenueResult = await pool.query('SELECT SUM(total) as revenue FROM orders');
    const totalRevenue = parseFloat(revenueResult.rows[0].revenue || 0);

    // Get total products
    const productsResult = await pool.query('SELECT COUNT(*) as count FROM products');
    const totalProducts = parseInt(productsResult.rows[0].count);

    res.json({
      totalUsers,
      totalOrders,
      totalRevenue,
      totalProducts
    });
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Get revenue analytics
app.get('/analytics/revenue', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        DATE(created_at) as date,
        SUM(total) as revenue,
        COUNT(*) as orders
      FROM orders
      GROUP BY DATE(created_at)
      ORDER BY DATE(created_at) DESC
      LIMIT 30
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Revenue analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// Get top products
app.get('/analytics/top-products', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        p.id,
        p.name,
        p.price,
        COUNT(oi.id) as order_count,
        SUM(oi.quantity) as total_sold
      FROM products p
      LEFT JOIN order_items oi ON p.id = oi.product_id
      GROUP BY p.id, p.name, p.price
      ORDER BY total_sold DESC
      LIMIT 10
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Top products error:', error);
    res.status(500).json({ error: 'Failed to fetch top products' });
  }
});



app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.listen(PORT, () => {
  console.log(`Admin Service running on port ${PORT}`);
});
