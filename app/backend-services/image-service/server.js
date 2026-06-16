/**
 * LuxeCart — Image Service (v2)
 *
 * Two upload flows:
 *   1. PRESIGNED (recommended) — browser uploads directly to S3.
 *   2. PROXY — multipart upload via this service (fallback).
 *
 * Works with LocalStack (dev) via S3_ENDPOINT or real S3 (prod).
 */
const express = require('express');
const { logger, requestLogger } = require('./shared/logger')('image-service');

const cors = require('cors');
const multer = require('multer');
const { Pool } = require('pg');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const promClient = require('prom-client');

const app = express();
const PORT = process.env.PORT || 3016;
const BUCKET = process.env.S3_BUCKET_NAME || 'luxecart-images';
const REGION = process.env.AWS_REGION || 'us-east-1';
const ENDPOINT = process.env.S3_ENDPOINT || null;
// Endpoint embedded in presigned URLs (must be reachable from the browser).
// Defaults to ENDPOINT for prod; in dev set this to http://localhost:4566.
const PRESIGN_ENDPOINT = process.env.S3_PRESIGN_ENDPOINT || ENDPOINT || null;
const PUBLIC_BASE =
  process.env.S3_PUBLIC_BASE_URL ||
  (PRESIGN_ENDPOINT
    ? `${PRESIGN_ENDPOINT}/${BUCKET}`
    : `https://${BUCKET}.s3.${REGION}.amazonaws.com`);
const PRESIGN_TTL = Number(process.env.PRESIGN_TTL_SECONDS || 300);
const MAX_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 5 * 1024 * 1024);

// ── S3 clients ──────────────────────────────────────────────────────────────
// Internal client: used by the service for Head/Put/Delete (inside docker net).
const s3 = new S3Client({
  region: REGION,
  ...(ENDPOINT ? { endpoint: ENDPOINT, forcePathStyle: true } : {}),
  ...(process.env.AWS_ACCESS_KEY_ID
    ? {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      }
    : {}),
});

// Presign client: identical config but pointed at the browser-visible endpoint
// so the resulting signed URL works when the browser executes the PUT.
const presignClient = new S3Client({
  region: REGION,
  ...(PRESIGN_ENDPOINT ? { endpoint: PRESIGN_ENDPOINT, forcePathStyle: true } : {}),
  ...(process.env.AWS_ACCESS_KEY_ID
    ? {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      }
    : {}),
});

// ── Postgres (image_db) ─────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS images (
      id           UUID PRIMARY KEY,
      key          TEXT NOT NULL UNIQUE,
      url          TEXT NOT NULL,
      owner_type   TEXT NOT NULL,
      owner_id     TEXT,
      content_type TEXT,
      size_bytes   BIGINT,
      uploaded_by  TEXT,
      status       TEXT NOT NULL DEFAULT 'pending',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_images_owner  ON images(owner_type, owner_id);
    CREATE INDEX IF NOT EXISTS idx_images_status ON images(status);
  `);
  console.log('✅ image_db schema ready');
}

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(requestLogger);

app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// ── Prometheus ──────────────────────────────────────────────────────────────
const register = new promClient.Registry();
register.setDefaultLabels({ service: 'image-service' });
promClient.collectDefaultMetrics({ register });
const reqCounter = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['service', 'method', 'route', 'status'],
});
const reqDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['service', 'method', 'route'],
  buckets: [0.1, 0.3, 0.5, 1, 2, 5],
});
register.registerMetric(reqCounter);
register.registerMetric(reqDuration);
app.use((req, res, next) => {
  if (req.path === '/metrics') return next();
  const start = Date.now();
  res.on('finish', () => {
    const seconds = (Date.now() - start) / 1000;
    const route = req.route?.path || req.path || 'unknown';
    reqCounter.inc({
      service: 'image-service',
      method: req.method,
      route,
      status: res.statusCode,
    });
    reqDuration.observe(
      { service: 'image-service', method: req.method, route },
      seconds,
    );
  });
  next();
});

// ── Helpers ─────────────────────────────────────────────────────────────────
const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
]);

function extFor(contentType) {
  switch (contentType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    case 'image/avif':
      return 'avif';
    default:
      return 'bin';
  }
}

function buildKey({ ownerType, ownerId, contentType }) {
  const hash = crypto.randomBytes(12).toString('hex');
  const path = ownerId ? `${ownerType}/${ownerId}` : ownerType;
  return `${path}/${Date.now()}-${hash}.${extFor(contentType)}`;
}

function publicUrlFor(key) {
  return `${PUBLIC_BASE.replace(/\/$/, '')}/${key}`;
}

// ── Routes ──────────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'Image Service is running',
      database: 'connected',
      bucket: BUCKET,
      endpoint: ENDPOINT || 'aws',
    });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', error: err.message });
  }
});

/**
 * POST /presign
 * Body: { contentType, ownerType, ownerId?, sizeBytes?, uploadedBy? }
 */
app.post('/presign', async (req, res) => {
  try {
    const {
      contentType,
      ownerType = 'misc',
      ownerId = null,
      sizeBytes,
      uploadedBy = null,
    } = req.body || {};

    if (!contentType || !ALLOWED_TYPES.has(contentType)) {
      return res.status(400).json({
        error: `Unsupported contentType. Allowed: ${[...ALLOWED_TYPES].join(', ')}`,
      });
    }
    if (sizeBytes && sizeBytes > MAX_BYTES) {
      return res
        .status(413)
        .json({ error: `File too large. Max ${MAX_BYTES} bytes.` });
    }

    const id = uuid();
    const key = buildKey({ ownerType, ownerId, contentType });

    const cmd = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: contentType,
    });
    const uploadUrl = await getSignedUrl(presignClient, cmd, { expiresIn: PRESIGN_TTL });

    await pool.query(
      `INSERT INTO images
        (id, key, url, owner_type, owner_id, content_type, size_bytes, uploaded_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')`,
      [id, key, publicUrlFor(key), ownerType, ownerId, contentType, sizeBytes ?? null, uploadedBy],
    );

    res.json({
      id,
      key,
      uploadUrl,
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      publicUrl: publicUrlFor(key),
      expiresIn: PRESIGN_TTL,
    });
  } catch (err) {
    console.error('Presign error:', err);
    res.status(500).json({ error: 'Failed to create presigned URL', details: err.message });
  }
});

/**
 * POST /confirm/:id
 * Browser calls after PUT completes; verifies object & flips status -> 'ready'.
 */
app.post('/confirm/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      'SELECT key, content_type FROM images WHERE id = $1',
      [id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Image not found' });

    const head = await s3.send(
      new HeadObjectCommand({ Bucket: BUCKET, Key: rows[0].key }),
    );

    await pool.query(
      `UPDATE images
         SET status = 'ready',
             size_bytes = $1,
             confirmed_at = NOW()
       WHERE id = $2`,
      [head.ContentLength ?? null, id],
    );

    res.json({
      id,
      key: rows[0].key,
      url: publicUrlFor(rows[0].key),
      sizeBytes: head.ContentLength,
      status: 'ready',
    });
  } catch (err) {
    console.error('Confirm error:', err);
    res.status(500).json({ error: 'Failed to confirm upload', details: err.message });
  }
});

app.get('/images/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM images WHERE id = $1', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

app.get('/images', async (req, res) => {
  const { ownerType, ownerId } = req.query;
  const params = [];
  const where = ["status = 'ready'"];
  if (ownerType) {
    params.push(ownerType);
    where.push(`owner_type = $${params.length}`);
  }
  if (ownerId) {
    params.push(ownerId);
    where.push(`owner_id = $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT id, key, url, content_type, size_bytes, created_at
       FROM images WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 200`,
    params,
  );
  res.json(rows);
});

app.delete('/images/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key FROM images WHERE id = $1', [
      req.params.id,
    ]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: rows[0].key }));
    await pool.query('DELETE FROM images WHERE id = $1', [req.params.id]);
    res.json({ deleted: true });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: 'Failed to delete', details: err.message });
  }
});

// ── Streaming serve (public read) ──────────────────────────────────────────
// GET /s/<key...>  → streams the object from S3.
// Lets the browser load images without needing direct network access to S3
// (so we never have to expose LocalStack's port 4566 to the public).
app.get(/^\/s\/(.+)$/, async (req, res) => {
  try {
    const key = req.params[0];
    if (!key) return res.status(400).end();
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    if (obj.ContentType) res.setHeader('Content-Type', obj.ContentType);
    if (obj.ContentLength) res.setHeader('Content-Length', String(obj.ContentLength));
    res.setHeader('Cache-Control', 'public, max-age=86400');
    obj.Body.pipe(res);
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.Code === 'NoSuchKey') {
      return res.status(404).end();
    }
    console.error('Serve error:', err);
    res.status(500).end();
  }
});

// ── Proxy upload (fallback) ────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
  fileFilter: (_req, file, cb) =>
    ALLOWED_TYPES.has(file.mimetype)
      ? cb(null, true)
      : cb(new Error('Only image files allowed')),
});

app.post('/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });

    const id = uuid();
    const key = buildKey({
      ownerType: req.body.ownerType || 'misc',
      ownerId: req.body.ownerId || null,
      contentType: req.file.mimetype,
    });

    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      }),
    );

    await pool.query(
      `INSERT INTO images
        (id, key, url, owner_type, owner_id, content_type, size_bytes, status, confirmed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'ready',NOW())`,
      [
        id,
        key,
        publicUrlFor(key),
        req.body.ownerType || 'misc',
        req.body.ownerId || null,
        req.file.mimetype,
        req.file.size,
      ],
    );

    res.json({ id, key, url: publicUrlFor(key), status: 'ready' });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed', details: err.message });
  }
});

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

initSchema()
  .then(() =>
    app.listen(PORT, () => {
      console.log(`✅ Image Service listening on :${PORT}`);
      console.log(`   bucket=${BUCKET}  endpoint=${ENDPOINT || 'AWS'}  region=${REGION}`);
      console.log(`   publicBase=${PUBLIC_BASE}`);
    }),
  )
  .catch((err) => {
    console.error('Failed to start image-service:', err);
    process.exit(1);
  });
