const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const jwt = require('jsonwebtoken');
// Prometheus metrics
const promClient = require('prom-client');
const register = new promClient.Registry();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Enhanced CORS configuration
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true,
  optionsSuccessStatus: 200
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json());

// Log all requests for debugging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Service URLs
const services = {
  auth:            process.env.AUTH_SERVICE_URL            || 'http://auth-service:3001',
  user:            process.env.USER_SERVICE_URL            || 'http://user-service:3002',
  product:         process.env.PRODUCT_SERVICE_URL         || 'http://product-service:3003',
  cart:            process.env.CART_SERVICE_URL            || 'http://cart-service:3004',
  order:           process.env.ORDER_SERVICE_URL           || 'http://order-service:3005',
  review:          process.env.REVIEW_SERVICE_URL          || 'http://review-service:3006',
  rating:          process.env.RATING_SERVICE_URL          || 'http://rating-service:3007',
  payment:         process.env.PAYMENT_SERVICE_URL         || 'http://payment-service:3008',
  notification:    process.env.NOTIFICATION_SERVICE_URL    || 'http://notification-service:3009',
  admin:           process.env.ADMIN_SERVICE_URL           || 'http://admin-service:3010',
  inventory:       process.env.INVENTORY_SERVICE_URL       || 'http://inventory-service:3011',
  search:          process.env.SEARCH_SERVICE_URL          || 'http://search-service:3012',
  analytics:       process.env.ANALYTICS_SERVICE_URL       || 'http://analytics-service:3013',
  recommendation:  process.env.RECOMMENDATION_SERVICE_URL  || 'http://recommendation-service:3014',
  email:           process.env.EMAIL_SERVICE_URL           || 'http://email-service:3015',
  image:           process.env.IMAGE_SERVICE_URL           || 'http://image-service:3016'
};

// Auth middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// Admin middleware
const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'API Gateway is running', timestamp: new Date().toISOString() });
});


///// prometheus
register.setDefaultLabels({
  service: 'api-gateway-service'
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
      service: 'api-gateway-service',
      method: req.method,
      route,
      status: res.statusCode
    });

    httpRequestDuration.observe(
      {
        service: 'api-gateway-service',
        method: req.method,
        route
      },
      duration
    );
  });

  next();
});


// Proxy configuration with increased timeout
const proxyOptions = {
  changeOrigin: true,
  timeout: 60000, // 60 seconds
  proxyTimeout: 60000,
  followRedirects: true,
  onError: (err, req, res) => {
    console.error('Proxy error:', err.message, err.code);
    res.status(504).json({ error: 'Gateway timeout', details: err.message });
  },
  onProxyReq: (proxyReq, req, res) => {
    console.log(`Proxying ${req.method} ${req.path} -> ${proxyReq.path}`);
    
    // Manually set content-length if body exists
    if (req.body && Object.keys(req.body).length > 0) {
      const bodyData = JSON.stringify(req.body);
      proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
      proxyReq.write(bodyData);
    }
  },
  onProxyRes: (proxyRes, req, res) => {
    console.log(`Proxy response: ${proxyRes.statusCode} from ${req.path}`);
  }
};

// Public routes (no auth required)
app.use('/api/auth', createProxyMiddleware({
  ...proxyOptions,
  target: services.auth,
  pathRewrite: { '^/api/auth': '' },
  logLevel: 'debug'
}));

// Public product routes
app.use('/api/products/public', createProxyMiddleware({
  ...proxyOptions,
  target: services.product,
  pathRewrite: { '^/api/products/public': '/public' }
}));

// Public review routes
app.use('/api/reviews/public', createProxyMiddleware({
  ...proxyOptions,
  target: services.review,
  pathRewrite: { '^/api/reviews/public': '/public' }
}));

// Protected user routes
app.use('/api/users', authenticateToken, createProxyMiddleware({
  ...proxyOptions,
  target: services.user,
  pathRewrite: { '^/api/users': '' }
}));

// Protected product routes
app.use('/api/products', authenticateToken, createProxyMiddleware({
  ...proxyOptions,
  target: services.product,
  pathRewrite: { '^/api/products': '' }
}));

// Cart routes
app.use('/api/cart', authenticateToken, createProxyMiddleware({
  ...proxyOptions,
  target: services.cart,
  pathRewrite: { '^/api/cart': '' }
}));

// Order routes
app.use('/api/orders', authenticateToken, createProxyMiddleware({
  ...proxyOptions,
  target: services.order,
  pathRewrite: { '^/api/orders': '' }
}));

// Review routes
app.use('/api/reviews', authenticateToken, createProxyMiddleware({
  ...proxyOptions,
  target: services.review,
  pathRewrite: { '^/api/reviews': '' }
}));

// Rating routes
app.use('/api/ratings', authenticateToken, createProxyMiddleware({
  ...proxyOptions,
  target: services.rating,
  pathRewrite: { '^/api/ratings': '' }
}));

// Payment routes
app.use('/api/payments', authenticateToken, createProxyMiddleware({
  ...proxyOptions,
  target: services.payment,
  pathRewrite: { '^/api/payments': '' }
}));

// Notification routes
app.use('/api/notifications', authenticateToken, createProxyMiddleware({
  ...proxyOptions,
  target: services.notification,
  pathRewrite: { '^/api/notifications': '' }
}));

// Admin routes
app.use('/api/admin', authenticateToken, requireAdmin, createProxyMiddleware({
  ...proxyOptions,
  target: services.admin,
  pathRewrite: { '^/api/admin': '' }
}));

// Search routes (public — no auth needed for search)
app.use('/api/search', createProxyMiddleware({
  ...proxyOptions,
  target: services.search,
  pathRewrite: { '^/api/search': '/search' }
}));

// Inventory routes (admin for writes, auth for reads)
app.use('/api/inventory', authenticateToken, createProxyMiddleware({
  ...proxyOptions,
  target: services.inventory,
  pathRewrite: { '^/api/inventory': '' }
}));

// Analytics routes (admin only)
app.use('/api/analytics', authenticateToken, requireAdmin, createProxyMiddleware({
  ...proxyOptions,
  target: services.analytics,
  pathRewrite: { '^/api/analytics': '/analytics' }
}));

// Recommendation routes (public for product recs, auth for user recs)
app.use('/api/recommendations', createProxyMiddleware({
  ...proxyOptions,
  target: services.recommendation,
  pathRewrite: { '^/api/recommendations': '/recommendations' }
}));

// Email routes (admin only)
app.use('/api/email', authenticateToken, requireAdmin, createProxyMiddleware({
  ...proxyOptions,
  target: services.email,
  pathRewrite: { '^/api/email': '/email' }
}));

// ─── Image routes ─────────────────────────────────────────────────────────
// Public reads of image metadata (so the storefront can list product images)
app.use('/api/images/public', createProxyMiddleware({
  ...proxyOptions,
  target: services.image,
  pathRewrite: { '^/api/images/public': '/images' }
}));

// Authenticated writes: presign, confirm, proxy-upload, delete
app.use('/api/images', authenticateToken, createProxyMiddleware({
  ...proxyOptions,
  target: services.image,
  pathRewrite: { '^/api/images': '' }
}));

// Error handling
app.use((err, req, res, next) => {
  console.error('Gateway error:', err);
  res.status(500).json({ error: 'Internal server error' });
});



app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.listen(PORT, () => {
  console.log(`API Gateway running on port ${PORT}`);
});
