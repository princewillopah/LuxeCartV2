/**
 * Inventory Service — Port 3011
 *
 * CONSUMES events from RabbitMQ:
 *   order.created  → deduct stock for each order item
 *   order.status_updated (cancelled/refunded) → restore stock
 *
 * PUBLISHES events:
 *   inventory.low_stock  → when a product drops below threshold
 *   inventory.out_of_stock → when a product reaches 0
 *
 * EXPOSES HTTP:
 *   GET  /stock/:productId   → current stock level
 *   GET  /stock/low          → all low-stock products (< 10)
 *   PUT  /stock/:productId   → manual stock adjustment (admin)
 */

const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');
const { consumeEvents, publishEvent } = require('./shared/eventBus');
// Prometheus metrics
const promClient = require('prom-client');
const register = new promClient.Registry();

const app  = express();
const PORT = process.env.PORT || 3011;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const LOW_STOCK_THRESHOLD = parseInt(process.env.LOW_STOCK_THRESHOLD || '10');

app.use(cors());
app.use(express.json());

// ── Helper: deduct stock for one item ─────────────────────
async function deductStock(productId, quantity, orderId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the row before updating
    const current = await client.query(
      'SELECT id, name, stock FROM products WHERE id = $1 FOR UPDATE',
      [productId]
    );

    if (!current.rows.length) {
      await client.query('ROLLBACK');
      console.warn(`[Inventory] Product ${productId} not found`);
      return;
    }

    const product = current.rows[0];
    const newStock = Math.max(0, product.stock - quantity);

    await client.query(
      'UPDATE products SET stock = $1, updated_at = NOW() WHERE id = $2',
      [newStock, productId]
    );

    await client.query('COMMIT');

    console.log(`[Inventory] Deducted ${quantity} from product ${productId} (${product.name}): ${product.stock} → ${newStock}`);

    // Publish low-stock / out-of-stock alerts
    if (newStock === 0) {
      await publishEvent('inventory.out_of_stock', {
        productId,
        productName: product.name,
        orderId
      });
      console.warn(`[Inventory] ⚠️  Product ${product.name} is OUT OF STOCK`);
    } else if (newStock < LOW_STOCK_THRESHOLD) {
      await publishEvent('inventory.low_stock', {
        productId,
        productName: product.name,
        currentStock: newStock,
        threshold: LOW_STOCK_THRESHOLD,
        orderId
      });
      console.warn(`[Inventory] ⚠️  Product ${product.name} is LOW STOCK (${newStock} left)`);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[Inventory] Deduct stock error for product ${productId}:`, err.message);
  } finally {
    client.release();
  }
}

// ── Helper: restore stock (on cancellation/refund) ────────
async function restoreStock(productId, quantity) {
  try {
    await pool.query(
      'UPDATE products SET stock = stock + $1, updated_at = NOW() WHERE id = $2',
      [quantity, productId]
    );
    console.log(`[Inventory] Restored ${quantity} units to product ${productId}`);
  } catch (err) {
    console.error(`[Inventory] Restore stock error for product ${productId}:`, err.message);
  }
}

// ── Start RabbitMQ consumers ────────────────────────────────
async function startEventConsumers() {
  // order.created → deduct stock for each item
  await consumeEvents('order.created', async (data) => {
    if (!data.items?.length) return;
    console.log(`[Inventory] Processing stock deduction for Order #${data.id}`);
    for (const item of data.items) {
      const productId = item.id || item.productId || item.product_id;
      const quantity  = item.quantity || 1;
      if (productId) await deductStock(productId, quantity, data.id);
    }
  }, 'inventory_order_created');

  // order.status_updated → restore stock on cancellation or refund
  await consumeEvents('order.status_updated', async (data) => {
    if (!['cancelled', 'refunded'].includes(data.status)) return;

    // Fetch order items to know what to restore
    const result = await pool.query(
      'SELECT product_id, quantity FROM order_items WHERE order_id = $1',
      [data.orderId]
    );

    for (const item of result.rows) {
      await restoreStock(item.product_id, item.quantity);
    }

    console.log(`[Inventory] Restored stock for ${data.status} order #${data.orderId}`);
  }, 'inventory_order_status');

  console.log('[Inventory] Event consumers registered ✅');
}

// ── HTTP endpoints ──────────────────────────────────────────
app.get('/health', (req, res) =>
  res.json({ status: 'Inventory Service running', consumers: 'active' })
);


///// prometheus
register.setDefaultLabels({
  service: 'inventory-service'
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
      service: 'inventory-service',
      method: req.method,
      route,
      status: res.statusCode
    });

    httpRequestDuration.observe(
      {
        service: 'inventory-service',
        method: req.method,
        route
      },
      duration
    );
  });

  next();
});


// Get stock for a product
app.get('/stock/:productId', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, name, stock, category FROM products WHERE id = $1',
      [req.params.productId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Product not found' });
    const p = r.rows[0];
    res.json({
      productId: p.id,
      name: p.name,
      stock: p.stock,
      status: p.stock === 0 ? 'out_of_stock' : p.stock < LOW_STOCK_THRESHOLD ? 'low_stock' : 'in_stock'
    });
  } catch { res.status(500).json({ error: 'Failed to fetch stock' }); }
});

// Get all low-stock products
app.get('/stock/low', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, name, stock, category FROM products WHERE stock < $1 ORDER BY stock ASC',
      [LOW_STOCK_THRESHOLD]
    );
    res.json(r.rows);
  } catch { res.status(500).json({ error: 'Failed to fetch low stock' }); }
});

// All products with stock levels
app.get('/stock', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, name, stock, category FROM products ORDER BY stock ASC'
    );
    res.json(r.rows);
  } catch { res.status(500).json({ error: 'Failed to fetch stock' }); }
});

// Manual stock adjustment (admin)
app.put('/stock/:productId', async (req, res) => {
  const { stock, reason } = req.body;
  if (stock === undefined || stock < 0) {
    return res.status(400).json({ error: 'Valid stock value required' });
  }
  try {
    const r = await pool.query(
      'UPDATE products SET stock = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name, stock',
      [stock, req.params.productId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Product not found' });
    console.log(`[Inventory] Manual adjustment: product ${req.params.productId} → ${stock} (${reason || 'no reason'})`);
    res.json(r.rows[0]);
  } catch { res.status(500).json({ error: 'Failed to update stock' }); }
});

// ── Start ─────────────────────────────────────────────────


app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.listen(PORT, () => {
  console.log(`Inventory Service running on port ${PORT}`);
  setTimeout(startEventConsumers, 5000);
});
