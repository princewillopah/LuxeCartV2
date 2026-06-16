/**
 * Search Service — Port 3012
 *
 * Provides full-text product search powered by OpenSearch 2.x
 * (Apache-2.0, API-compatible with the Elasticsearch 7.x wire protocol).
 *
 * CONSUMES events from Kafka:
 *   order.created          → triggers index sync (new popular items)
 *   inventory.out_of_stock → marks product unavailable in index
 *   product.created/updated/deleted
 *
 * EXPOSES HTTP:
 *   GET  /search?q=&category=&minPrice=&maxPrice=&minRating=&sort=&page=&limit=
 *   GET  /search/suggest?q=    → autocomplete suggestions
 *   POST /search/index/sync    → manual re-index from product-service (admin)
 *   GET  /health
 */

const express    = require('express');
const { logger, requestLogger } = require('./shared/logger')('search-service');
const { createHttpClient } = require('./shared/httpClient');

const cors       = require('cors');
const { Client } = require('@opensearch-project/opensearch');
const { consumeEvents } = require('./shared/eventBus');
// Prometheus metrics
const promClient = require('prom-client');
const register = new promClient.Registry();

const app  = express();
const PORT = process.env.PORT || 3012;

// OpenSearch client. Variable kept as `es` to minimize diff against the
// prior Elasticsearch-based implementation; the underlying transport now
// targets OpenSearch 2.x (Apache-2.0). Accepts legacy ELASTICSEARCH_URL
// as a fallback so older deployment manifests keep working during the
// cutover.
const es = new Client({
  node: process.env.OPENSEARCH_URL
     || process.env.ELASTICSEARCH_URL
     || 'http://opensearch:9200'
});

const INDEX = 'products';

// Database-per-service: the products table lives in product-service's
// own DB now. We pull products over HTTP from product-service for
// reindexing instead of running cross-DB SELECTs.
const PRODUCT_SERVICE_URL =
  process.env.PRODUCT_SERVICE_URL || 'http://product-service:3003';

// Hardened HTTP client (timeout + retry + breaker + metrics). Reindex
// pages and single-product lookups are both safe GETs — default GET
// retry is fine.
const productHttp = createHttpClient({
  target: 'product-service',
  baseUrl: PRODUCT_SERVICE_URL,
  register,
  promClient,
  logger,
  timeoutMs: 5000, // bulk pages can be a touch larger — give it room
  retry:   { attempts: 2, baseDelayMs: 200, maxDelayMs: 1500 },
  breaker: {
    timeout: 5500, errorThresholdPercentage: 50, resetTimeout: 10_000,
    volumeThreshold: 5, rollingCountTimeout: 30_000, rollingCountBuckets: 10,
  },
});

/** Fetch a single product by id from product-service. Returns null on 404. */
async function httpGetProduct(id) {
  const p = await productHttp.getJson(`/public/${id}`);
  return p === undefined ? null : p;
}

/**
 * Page through `GET /public?page=N&limit=PAGE_SIZE` until exhausted.
 * Yields each page's `items` array. The product-service returns the
 * paginated envelope `{items, total, page, limit}` whenever page or
 * limit is supplied.
 */
async function* iterateAllProducts(pageSize = 200) {
  for (let page = 1; ; page++) {
    const body = await productHttp.getJson('/public', { query: { page, limit: pageSize } });
    const items = Array.isArray(body?.items) ? body.items : [];
    if (items.length === 0) return;
    yield items;
    if (items.length < pageSize) return;
  }
}

app.use(cors());
app.use(express.json());

app.use(requestLogger);

// ── Index mapping ──────────────────────────────────────────
async function createIndex() {
  // OpenSearch JS client wraps every response in {body, statusCode, headers, meta}.
  const existsResp = await es.indices.exists({ index: INDEX });
  if (existsResp.body) return;

  await es.indices.create({
    index: INDEX,
    body: {
      settings: {
        analysis: {
          analyzer: {
            product_analyzer: {
              type:      'custom',
              tokenizer: 'standard',
              filter:    ['lowercase', 'stop', 'snowball']
            }
          }
        }
      },
      mappings: {
        properties: {
          id:             { type: 'integer' },
          name:           { type: 'text',    analyzer: 'product_analyzer' },
          description:    { type: 'text',    analyzer: 'product_analyzer' },
          category:       { type: 'keyword' },
          brand:          { type: 'keyword' },
          price:          { type: 'float' },
          stock:          { type: 'integer' },
          average_rating: { type: 'float' },
          total_reviews:  { type: 'integer' },
          images:         { type: 'keyword', index: false },
          in_stock:       { type: 'boolean' },
          created_at:     { type: 'date' }
        }
      }
    }
  });
  console.log(`[Search] Index "${INDEX}" created`);
}

// ── Index a single product ─────────────────────────────────
/**
 * Accepts both shapes of input:
 *   - legacy snake_case from the (now-removed) cross-DB SELECT
 *   - product-service's camelCase ProductDto
 *
 * We coerce to one shape before indexing so we don't have to migrate
 * the Elasticsearch mapping (which is snake_case to match the
 * frontend's expectations on the /search response).
 */
async function indexProduct(product) {
  const avg   = product.averageRating ?? product.average_rating;
  const total = product.totalReviews  ?? product.total_reviews;
  const created = product.createdAt   ?? product.created_at;
  await es.index({
    index: INDEX,
    id:    String(product.id),
    body: {
      id:             product.id,
      name:           product.name,
      description:    product.description || '',
      category:       product.category,
      brand:          product.brand || '',
      price:          parseFloat(product.price),
      stock:          product.stock || 0,
      average_rating: parseFloat(avg) || 0,
      total_reviews:  total || 0,
      images:         product.images || [],
      in_stock:       (product.stock || 0) > 0,
      created_at:     created || new Date()
    }
  });
}

// ── Sync all products from product-service to OpenSearch ─────
async function syncAllProducts() {
  console.log('[Search] Starting full product sync to OpenSearch (via product-service HTTP)...');
  let count = 0;
  for await (const page of iterateAllProducts(200)) {
    for (const product of page) {
      await indexProduct(product);
      count++;
    }
  }
  await es.indices.refresh({ index: INDEX });
  console.log(`[Search] Synced ${count} products to OpenSearch ✅`);
  return count;
}

// ── Init: create index + initial sync ─────────────────────
async function init() {
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      await es.ping();
      console.log('[Search] OpenSearch connected ✅');
      await createIndex();
      await syncAllProducts();
      console.log('[Search] Initialization complete ✅');
      return true;
    } catch (err) {
      console.warn(`[Search] OpenSearch not ready (attempt ${attempt}/20): ${err.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  console.error('[Search] ⚠️  Could not connect to OpenSearch after 20 attempts');
  console.error('[Search] ⚠️  Search will not work until OpenSearch is available');
  console.error('[Search] ⚠️  Call POST /search/index/sync to retry manually');
  return false;
}

// ── Kafka event consumers ───────────────────────────────
async function startEventConsumers() {
  // Re-sync a product whenever inventory may have changed.
  await consumeEvents('inventory.out_of_stock', async (data) => {
    const product = await httpGetProduct(data.productId);
    if (product) await indexProduct(product);
    console.log(`[Search] Re-indexed out-of-stock product ${data.productId}`);
  }, 'search_inventory_oos');

  // Product lifecycle events from product-service (Phase D1.10).
  await consumeEvents('product.created', async (data) => {
    const product = await httpGetProduct(data.productId ?? data.id);
    if (product) await indexProduct(product);
  }, 'search_product_created');

  await consumeEvents('product.updated', async (data) => {
    const id = data.productId ?? data.id;
    const product = await httpGetProduct(id);
    if (product) await indexProduct(product);
    else await es.delete({ index: INDEX, id: String(id) }).catch(() => {});
  }, 'search_product_updated');

  await consumeEvents('product.deleted', async (data) => {
    const id = data.productId ?? data.id;
    try { await es.delete({ index: INDEX, id: String(id) }); }
    catch (_) { /* already gone */ }
  }, 'search_product_deleted');

  // Periodically catch rating changes
  await consumeEvents('order.created', async () => {
    // Lightweight: just refresh index — ratings were updated by rating service
    await es.indices.refresh({ index: INDEX });
  }, 'search_order_created');

  console.log('[Search] Event consumers registered ✅');
}

// ─────────────────────────────────────────────
// HTTP ENDPOINTS
// ─────────────────────────────────────────────

app.get('/health', async (req, res) => {
  try {
    await es.ping();
    res.json({ status: 'Search Service running', opensearch: 'connected' });
  } catch {
    res.status(503).json({ status: 'Search Service running', opensearch: 'disconnected' });
  }
});


///// prometheus
register.setDefaultLabels({
  service: 'search-service'
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
      service: 'search-service',
      method: req.method,
      route,
      status: res.statusCode
    });

    httpRequestDuration.observe(
      {
        service: 'search-service',
        method: req.method,
        route
      },
      duration
    );
  });

  next();
});

/**
 * GET /search?q=headphones&category=Electronics&minPrice=50&maxPrice=500
 *              &minRating=3&sort=price_asc|price_desc|rating|newest&page=1&limit=12
 */
app.get('/search', async (req, res) => {
  try {
    // Check if index exists before searching (OpenSearch wraps in {body}).
    const existsResp = await es.indices.exists({ index: INDEX });
    if (!existsResp.body) {
      return res.status(503).json({
        error: 'Search not ready',
        message: 'Search index is still being created. Please try again in a moment or call POST /search/index/sync to force initialization.'
      });
    }

    const {
      q          = '',
      category,
      brand,
      minPrice,
      maxPrice,
      minRating,
      inStock,
      sort       = 'relevance',
      page       = 1,
      limit      = 12
    } = req.query;

    const from = (parseInt(page) - 1) * parseInt(limit);

    // ── Build query ──────────────────────────────────────
    const must    = [];
    const filters = [];

    if (q.trim()) {
      must.push({
        multi_match: {
          query:     q,
          fields:    ['name^3', 'description', 'category^2', 'brand'],
          type:      'best_fields',
          fuzziness: 'AUTO'
        }
      });
    } else {
      must.push({ match_all: {} });
    }

    if (category)  filters.push({ term: { category } });
    if (brand)     filters.push({ term: { brand } });
    if (inStock === 'true') filters.push({ term: { in_stock: true } });

    if (minPrice || maxPrice) {
      filters.push({
        range: {
          price: {
            ...(minPrice ? { gte: parseFloat(minPrice) } : {}),
            ...(maxPrice ? { lte: parseFloat(maxPrice) } : {})
          }
        }
      });
    }

    if (minRating) {
      filters.push({ range: { average_rating: { gte: parseFloat(minRating) } } });
    }

    // ── Sort options ─────────────────────────────────────
    const sortMap = {
      price_asc:  [{ price: 'asc' }],
      price_desc: [{ price: 'desc' }],
      rating:     [{ average_rating: 'desc' }, { total_reviews: 'desc' }],
      newest:     [{ created_at: 'desc' }],
      relevance:  ['_score']
    };

    const esSort = sortMap[sort] || ['_score'];

    const response = await es.search({
      index: INDEX,
      body: {
        from,
        size: parseInt(limit),
        query: {
          bool: { must, filter: filters }
        },
        sort: esSort,
        aggs: {
          categories: { terms: { field: 'category', size: 20 } },
          brands:     { terms: { field: 'brand',    size: 20 } },
          price_range: {
            stats: { field: 'price' }
          }
        },
        highlight: {
          fields: {
            name:        { number_of_fragments: 0 },
            description: { fragment_size: 150, number_of_fragments: 1 }
          },
          pre_tags:  ['<mark>'],
          post_tags: ['</mark>']
        }
      }
    });

    // OpenSearch JS client returns {body, statusCode, headers, meta}.
    const body  = response.body;
    const hits  = body.hits;
    const total = hits.total.value;

    const products = hits.hits.map(hit => ({
      ...hit._source,
      score:     hit._score,
      highlight: hit.highlight || {}
    }));

    res.json({
      total,
      page:          parseInt(page),
      limit:         parseInt(limit),
      totalPages:    Math.ceil(total / parseInt(limit)),
      products,
      aggregations: {
        categories: body.aggregations?.categories?.buckets || [],
        brands:     body.aggregations?.brands?.buckets     || [],
        priceRange: body.aggregations?.price_range         || {}
      }
    });
  } catch (err) {
    console.error('[Search] Search error:', err.message);
    res.status(500).json({ error: 'Search failed', details: err.message });
  }
});

/**
 * GET /search/suggest?q=wire  → autocomplete suggestions
 */
app.get('/search/suggest', async (req, res) => {
  try {
    const { q = '' } = req.query;
    if (!q.trim()) return res.json({ suggestions: [] });

    const response = await es.search({
      index: INDEX,
      body: {
        size: 0,
        query: {
          bool: {
            should: [
              { prefix: { name: { value: q.toLowerCase(), boost: 2 } } },
              { match:  { name: { query: q, fuzziness: 'AUTO' } } }
            ]
          }
        },
        aggs: {
          suggestions: {
            terms: { field: 'name.keyword', size: 8 }
          }
        }
      }
    });

    // Also search for matching categories
    const catResponse = await es.search({
      index: INDEX,
      body: {
        size: 5,
        query: { prefix: { name: q.toLowerCase() } },
        _source: ['name', 'category', 'price', 'images', 'average_rating']
      }
    });

    const suggestions = catResponse.body.hits.hits.map(h => ({
      text:   h._source.name,
      category: h._source.category,
      price:  h._source.price,
      image:  h._source.images?.[0] || null,
      rating: h._source.average_rating
    }));

    res.json({ suggestions });
  } catch (err) {
    console.error('[Search] Suggest error:', err.message);
    res.status(500).json({ error: 'Suggest failed' });
  }
});

/**
 * POST /search/index/sync  → full re-index (admin)
 */
app.post('/search/index/sync', async (req, res) => {
  try {
    console.log('[Search] Manual sync requested');
    
    // Ensure index exists
    await createIndex();
    
    const count = await syncAllProducts();
    res.json({ message: `Synced ${count} products successfully`, count });
  } catch (err) {
    console.error('[Search] Sync error:', err);
    res.status(500).json({ error: 'Sync failed', details: err.message });
  }
});

/**
 * POST /search/index/:productId  → index a single product
 */
app.post('/search/index/:productId', async (req, res) => {
  try {
    const product = await httpGetProduct(req.params.productId);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    await indexProduct(product);
    res.json({ message: 'Product indexed successfully', productId: req.params.productId });
  } catch (err) {
    res.status(500).json({ error: 'Index failed' });
  }
});

// ── Start ─────────────────────────────────────────────────
let initialized = false;



app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.listen(PORT, async () => {
  console.log(`Search Service running on port ${PORT}`);
  console.log('[Search] Waiting for OpenSearch to be ready...');
  
  // Run init in background
  setTimeout(async () => {
    initialized = await init();
    if (initialized) {
      await startEventConsumers();
    }
  }, 10000); // Wait 10s for OpenSearch to fully start
});
