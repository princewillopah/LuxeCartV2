/**
 * Search Service — Port 3012
 *
 * Provides full-text product search powered by Elasticsearch.
 *
 * CONSUMES events from RabbitMQ:
 *   order.created          → triggers index sync (new popular items)
 *   inventory.out_of_stock → marks product unavailable in index
 *
 * EXPOSES HTTP:
 *   GET  /search?q=&category=&minPrice=&maxPrice=&minRating=&sort=&page=&limit=
 *   GET  /search/suggest?q=    → autocomplete suggestions
 *   POST /search/index/sync    → manual re-index from PostgreSQL (admin)
 *   GET  /health
 */

const express    = require('express');
const cors       = require('cors');
const { Pool }   = require('pg');
const { Client } = require('@elastic/elasticsearch');
const { consumeEvents } = require('./shared/eventBus');
// Prometheus metrics
const promClient = require('prom-client');
const register = new promClient.Registry();

const app  = express();
const PORT = process.env.PORT || 3012;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const es = new Client({
  node: process.env.ELASTICSEARCH_URL || 'http://elasticsearch:9200'
});

const INDEX = 'products';

app.use(cors());
app.use(express.json());

// ── Index mapping ──────────────────────────────────────────
async function createIndex() {
  const exists = await es.indices.exists({ index: INDEX });
  if (exists) return;

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
async function indexProduct(product) {
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
      average_rating: parseFloat(product.average_rating) || 0,
      total_reviews:  product.total_reviews || 0,
      images:         product.images || [],
      in_stock:       (product.stock || 0) > 0,
      created_at:     product.created_at || new Date()
    }
  });
}

// ── Sync all products from PostgreSQL to Elasticsearch ─────
async function syncAllProducts() {
  console.log('[Search] Starting full product sync to Elasticsearch...');
  const result = await pool.query('SELECT * FROM products');
  
  let count = 0;
  for (const product of result.rows) {
    await indexProduct(product);
    count++;
  }

  await es.indices.refresh({ index: INDEX });
  console.log(`[Search] Synced ${count} products to Elasticsearch ✅`);
  return count;
}

// ── Init: create index + initial sync ─────────────────────
async function init() {
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      await es.ping();
      console.log('[Search] Elasticsearch connected ✅');
      await createIndex();
      await syncAllProducts();
      console.log('[Search] Initialization complete ✅');
      return true;
    } catch (err) {
      console.warn(`[Search] ES not ready (attempt ${attempt}/20): ${err.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  console.error('[Search] ⚠️  Could not connect to Elasticsearch after 20 attempts');
  console.error('[Search] ⚠️  Search will not work until Elasticsearch is available');
  console.error('[Search] ⚠️  Call POST /search/index/sync to retry manually');
  return false;
}

// ── RabbitMQ event consumers ───────────────────────────────
async function startEventConsumers() {
  // Re-sync a product whenever it may have changed
  await consumeEvents('inventory.out_of_stock', async (data) => {
    const result = await pool.query('SELECT * FROM products WHERE id = $1', [data.productId]);
    if (result.rows[0]) await indexProduct(result.rows[0]);
    console.log(`[Search] Re-indexed out-of-stock product ${data.productId}`);
  }, 'search_inventory_oos');

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
    res.json({ status: 'Search Service running', elasticsearch: 'connected' });
  } catch {
    res.status(503).json({ status: 'Search Service running', elasticsearch: 'disconnected' });
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
    // Check if index exists before searching
    const indexExists = await es.indices.exists({ index: INDEX });
    if (!indexExists) {
      return res.status(503).json({
        error: 'Search not ready',
        message: 'Elasticsearch index is still being created. Please try again in a moment or call POST /search/index/sync to force initialization.'
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

    const hits  = response.hits;
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
        categories: response.aggregations?.categories?.buckets || [],
        brands:     response.aggregations?.brands?.buckets     || [],
        priceRange: response.aggregations?.price_range         || {}
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

    const suggestions = catResponse.hits.hits.map(h => ({
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
    const result = await pool.query(
      'SELECT * FROM products WHERE id = $1', [req.params.productId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Product not found' });
    await indexProduct(result.rows[0]);
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
  console.log('[Search] Waiting for Elasticsearch to be ready...');
  
  // Run init in background
  setTimeout(async () => {
    initialized = await init();
    if (initialized) {
      await startEventConsumers();
    }
  }, 10000); // Wait 10s for ES to fully start
});
