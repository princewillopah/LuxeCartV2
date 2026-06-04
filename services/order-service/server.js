const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { publishEvent } = require('./shared/eventBus');
// Prometheus metrics
const promClient = require('prom-client');
const register = new promClient.Registry();

const app = express();
const PORT = process.env.PORT || 3005;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'Order Service is running' });
});


///// prometheus
register.setDefaultLabels({
  service: 'order-service'
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
      service: 'order-service',
      method: req.method,
      route,
      status: res.statusCode
    });

    httpRequestDuration.observe(
      {
        service: 'order-service',
        method: req.method,
        route
      },
      duration
    );
  });

  next();
});

// Create order
app.post('/', async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { userId, items, total, shippingAddress, paymentMethod } = req.body;
    
    if (!userId || !items || !total) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Create order
    const orderResult = await client.query(
      `INSERT INTO orders (user_id, total, shipping_address, payment_method, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING *`,
      [userId, total, JSON.stringify(shippingAddress), paymentMethod]
    );
    
    const order = orderResult.rows[0];
    
    // Create order items
    for (const item of items) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, price, quantity)
         VALUES ($1, $2, $3, $4, $5)`,
        [order.id, item.id, item.name, item.price, item.quantity]
      );
    }
    
    await client.query('COMMIT');

    const orderPayload = {
      id: order.id,
      userId: order.user_id,
      total: parseFloat(order.total),
      status: order.status,
      items,
      shippingAddress,
      paymentMethod,
      createdAt: order.created_at
    };

    // ── Publish event to RabbitMQ ──────────────────────────
    // Notification Service will send confirmation email
    // Inventory Service will reduce stock
    await publishEvent('order.created', orderPayload);

    res.status(201).json(orderPayload);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create order error:', error);
    res.status(500).json({ error: 'Failed to create order' });
  } finally {
    client.release();
  }
});

// Get all orders (admin)
app.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*, 
              json_agg(json_build_object(
                'id', oi.id,
                'productId', oi.product_id,
                'productName', oi.product_name,
                'price', oi.price,
                'quantity', oi.quantity
              )) as items
       FROM orders o
       LEFT JOIN order_items oi ON o.id = oi.order_id
       GROUP BY o.id
       ORDER BY o.created_at DESC`
    );
    
    const orders = result.rows.map(o => ({
      id: o.id,
      userId: o.user_id,
      total: parseFloat(o.total),
      status: o.status,
      shippingAddress: o.shipping_address,
      paymentMethod: o.payment_method,
      items: o.items,
      createdAt: o.created_at
    }));
    
    res.json(orders);
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Get user's orders
app.get('/user/:userId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*, 
              json_agg(json_build_object(
                'id', oi.id,
                'productId', oi.product_id,
                'productName', oi.product_name,
                'price', oi.price,
                'quantity', oi.quantity
              )) as items
       FROM orders o
       LEFT JOIN order_items oi ON o.id = oi.order_id
       WHERE o.user_id = $1
       GROUP BY o.id
       ORDER BY o.created_at DESC`,
      [req.params.userId]
    );
    
    const orders = result.rows.map(o => ({
      id: o.id,
      userId: o.user_id,
      total: parseFloat(o.total),
      status: o.status,
      items: o.items,
      createdAt: o.created_at
    }));
    
    res.json(orders);
  } catch (error) {
    console.error('Get user orders error:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Update order status
app.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    
    const result = await pool.query(
      `UPDATE orders 
       SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [status, req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const updatedOrder = result.rows[0];

    // Publish status change event
    await publishEvent('order.status_updated', {
      orderId:  updatedOrder.id,
      userId:   updatedOrder.user_id,
      status:   updatedOrder.status,
      updatedAt: updatedOrder.updated_at
    });

    res.json(updatedOrder);
  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({ error: 'Failed to update status' });
  }
});




app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.listen(PORT, () => {
  console.log(`Order Service running on port ${PORT}`);
});
