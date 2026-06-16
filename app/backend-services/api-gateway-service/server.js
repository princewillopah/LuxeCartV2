const express = require('express');
const { logger, requestLogger } = require('./shared/logger')('api-gateway-service');

const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createProxyMiddleware } = require('http-proxy-middleware');
const jwt = require('jsonwebtoken');
// Prometheus metrics
const promClient = require('prom-client');
const register = new promClient.Registry();

const app = express();
const PORT = process.env.PORT || 3000;

// Same fail-fast rule as auth-service: refuse to start without a real
// JWT_SECRET (or rotation ring JWT_SECRETS). A weak fallback here would
// silently accept forged tokens. Verification uses the shared helper so the
// gateway accepts any secret in the rotation ring while auth-service signs
// with the first one.
const { verifyToken, loadSecrets } = require('./shared/jwtAuth');
const _secrets = loadSecrets();
if (_secrets.length === 0 || _secrets[0].length < 32) {
  console.error('FATAL: JWT_SECRET (or JWT_SECRETS) env var is required and the active key must be \u226532 chars');
  process.exit(1);
}

// We sit behind nginx/ingress in prod, so trust the first proxy hop for
// rate-limiting and X-Forwarded-For. Anything stricter would lump every
// request under the proxy IP and break per-IP limiting.
app.set('trust proxy', 1);

// CORS: in dev allow common localhost ports; in prod read CORS_ORIGINS as a
// comma-separated allowlist (e.g. "https://luxecart.com,https://www.luxecart.com").
// Wildcard '*' is disallowed because we send credentials (cookies/auth header).
const DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:18081',
  'http://127.0.0.1:18081',
];
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
if (allowedOrigins.length === 0) allowedOrigins.push(...DEV_ORIGINS);

const corsOptions = {
  origin: (origin, callback) => {
    // Same-origin requests (curl, server-to-server) have no Origin header.
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Request-Id'],
  exposedHeaders: ['X-Request-Id'],
  credentials: true,
  optionsSuccessStatus: 200,
};

// Middleware
app.use(cors(corsOptions));

// Security headers — applied to every response. We disable the default CSP
// because the storefront pulls in third-party hosted images (Unsplash) and
// the Paystack/Flutterwave hosted-payment iframes; a tight CSP here would
// have to be tuned per environment, which we'd rather do at the ingress
// layer once we have a real domain. Everything else (HSTS off in dev,
// X-Frame-Options, X-Content-Type-Options, referrer-policy, etc.) ships on.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

// Defense-in-depth global rate limit. The auth-service already has its own
// strict per-endpoint limits; this one is a wider net that catches abuse on
// any other route (e.g. someone scraping /api/products, hammering /api/cart,
// etc.). Health/metrics are exempt so monitors never get throttled.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,           // 1 minute window
  max: 300,                      // 300 req / IP / minute → ~5 rps sustained
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health' || req.path === '/metrics',
  message: { error: 'Too many requests, please slow down.' },
});
app.use(globalLimiter);

// Tighter limiter on auth endpoints (extra layer on top of auth-service's own
// loginLimiter). Anything that creates accounts, issues tokens, or sends
// emails goes through here.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,      // 15 minutes
  max: 30,                       // 30 attempts / IP / 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts, please try again later.' },
});
app.use('/api/auth', authLimiter);

// ── Paystack webhook proxy ──────────────────────────────────────────────────
// MUST be registered BEFORE express.json(). Paystack signs the raw request
// body with HMAC-SHA512; if we let Express parse + re-serialise the JSON the
// bytes change and the signature check downstream would always fail. The
// proxy middleware streams the raw body straight through, so the
// payment-service receives the exact bytes Paystack sent.
//
// No auth on this route — Paystack itself is the caller, identity is
// verified by the HMAC signature inside payment-service.
const { createProxyMiddleware: createProxyMiddlewareEarly } = require('http-proxy-middleware');
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || 'http://payment-service:3008';
app.use('/api/payments/webhook', createProxyMiddlewareEarly({
  target: PAYMENT_SERVICE_URL,
  changeOrigin: true,
  pathRewrite: { '^/api/payments/webhook': '/webhook' },
  onError: (err, req, res) => {
    console.error('[gateway] webhook proxy error:', err.message);
    res.status(502).end();
  }
}));

app.use(express.json());

app.use(requestLogger);

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

  try {
    // verifyToken() walks the JWT_SECRETS rotation ring, so during a key
    // rollover tokens signed with either the old or new key are accepted.
    req.user = verifyToken(token);
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
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

    // Forward the per-request correlation ID so every downstream service can
    // tag its own logs with the same id. The gateway's pino-http middleware
    // already assigned `req.id` (and set the response header for the client).
    if (req.id) {
      proxyReq.setHeader('x-request-id', String(req.id));
    }

    // Forward the authenticated identity so downstream services can scope
    // queries to the caller (e.g. "GET /api/orders" must only return the
    // caller's own orders unless they are an admin).
    if (req.user) {
      proxyReq.setHeader('x-user-id', String(req.user.userId));
      proxyReq.setHeader('x-user-role', req.user.role || 'user');
      if (req.user.email) proxyReq.setHeader('x-user-email', req.user.email);
    }

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
// Public streaming of stored objects so the browser can render images
// without ever talking to S3/LocalStack directly. MUST come before the
// auth-protected /api/images route below.
app.use('/api/images/s', createProxyMiddleware({
  ...proxyOptions,
  target: services.image,
  pathRewrite: { '^/api/images/s': '/s' }
}));

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
