const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
// Prometheus metrics
const promClient = require('prom-client');
const register = new promClient.Registry();


const app = express();
const PORT = process.env.PORT || 3002;





// Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

app.use(cors());
app.use(express.json());

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

// Get all users
app.get('/', async (req, res) => {
  try {
    const result = await pool.query(`SELECT id, email, first_name, last_name, role, created_at FROM users ORDER BY created_at DESC`);
    const users = result.rows.map(user => ({
      id: user.id, email: user.email, firstName: user.first_name, lastName: user.last_name, role: user.role, createdAt: user.created_at
    }));
    res.json(users);
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get user by ID
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

// Update user
app.put('/:id(\\d+)', async (req, res) => {
  try {
    const { firstName, lastName, phone } = req.body;
    const result = await pool.query(
      `UPDATE users SET first_name = $1, last_name = $2, phone = $3, updated_at = NOW() WHERE id = $4 RETURNING id, email, first_name, last_name, role, phone`,
      [firstName, lastName, phone, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = result.rows[0];
    res.json({
      id: user.id, email: user.email, firstName: user.first_name, lastName: user.last_name, role: user.role, phone: user.phone
    });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Delete user - FIXED: complete implementation
app.delete('/:id(\\d+)', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'User deleted successfully', id: result.rows[0].id });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});



// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`User Service running on port ${PORT}`);
});