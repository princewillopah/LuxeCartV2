const express = require('express');
const { logger, requestLogger } = require('./shared/logger')('auth-service');

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const { publishEvent } = require('./shared/eventBus');

// Prometheus metrics
const promClient = require('prom-client');
const register = new promClient.Registry();

const app = express();
const PORT = process.env.PORT || 3001;

// JWT secret(s). Supports a rotation ring via comma-separated JWT_SECRETS,
// falling back to legacy single-value JWT_SECRET. Both are bound here so
// the rest of this file can stay simple (uses JWT_SECRET for signing,
// shared/jwtAuth handles multi-secret verification elsewhere). Refusing to
// start on a missing / too-short secret prevents a misconfigured prod
// deploy from silently issuing trivially-forgeable tokens.
const { signToken, verifyToken, loadSecrets } = require('./shared/jwtAuth');
const _secrets = loadSecrets();
if (_secrets.length === 0 || _secrets[0].length < 32) {
  console.error('FATAL: JWT_SECRET (or JWT_SECRETS) env var is required and the active key must be \u226532 chars');
  process.exit(1);
}
const JWT_SECRET = _secrets[0]; // active signing key

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Fix seeded user passwords on startup
async function fixSeedPasswords() {
  try {
    const hash = await bcrypt.hash('123456', 10);
    const result = await pool.query(
      `UPDATE users 
       SET password = $1 
       WHERE password = 'NEEDS_BCRYPT_HASH'
       RETURNING email`,
      [hash]
    );
    if (result.rowCount > 0) {
      console.log(`✅ Fixed passwords for ${result.rowCount} seeded users:`, result.rows.map(r => r.email));
    }
  } catch (error) {
    console.error('Error fixing seed passwords:', error);
  }
}

pool.query('SELECT NOW()', async (err, res) => {
  if (err) {
    console.error('Database connection error:', err);
  } else {
    console.log('Database connected successfully');
    // Fix seed user passwords
    await fixSeedPasswords();
  }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(requestLogger);

app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'Auth Service is running', database: 'connected' });
  } catch (error) {
    res.status(500).json({ status: 'Auth Service is running', database: 'disconnected' });
  }
});


///// prometheus
register.setDefaultLabels({
  service: 'auth-service'
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

// ── Rate limiters ──────────────────────────────────────────────────────────
// All auth-sensitive endpoints get rate-limited per source IP. The api-gateway
// forwards the real client IP via X-Forwarded-For, so we trust the first hop.
app.set('trust proxy', 1);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,       // 15 minutes
  max: 10,                        // 10 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again in 15 minutes.' },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,       // 1 hour
  max: 5,                         // 5 new accounts per IP per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many accounts created from this IP, try again later.' },
});

const verifyLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,        // 1 minute
  max: 60,                        // 60 verify calls per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
});

// Slow, expensive endpoints that send an email — strict cap per IP to make
// account-enumeration and email-spam attacks unprofitable.
const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,       // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many reset requests, please try again in an hour.' },
});

const resendVerifyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,       // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification emails, please try again in an hour.' },
});

// ── Token helpers ──────────────────────────────────────────────────────────
// We store only the SHA-256 hash of each token; the raw token only lives in the
// recipient's email. So a DB leak doesn't let an attacker take over accounts.
const FRONTEND_URL = (process.env.PUBLIC_FRONTEND_URL || 'http://localhost:18081').replace(/\/$/, '');

const TOKEN_TTL_MS = {
  email_verify:   24 * 60 * 60 * 1000, // 24h
  password_reset:  1 * 60 * 60 * 1000, //  1h
};

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Issue a fresh single-use token of the given purpose for a user. Any prior
 * unused token for that (user, purpose) pair is wiped first so old links die
 * as soon as a new one is issued.
 */
async function issueToken(userId, purpose) {
  const raw  = crypto.randomBytes(32).toString('hex');
  const hash = sha256(raw);
  const ttl  = TOKEN_TTL_MS[purpose];
  if (!ttl) throw new Error(`Unknown token purpose: ${purpose}`);

  await pool.query(
    'DELETE FROM auth_tokens WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL',
    [userId, purpose]
  );
  await pool.query(
    `INSERT INTO auth_tokens (user_id, token_hash, purpose, expires_at)
     VALUES ($1, $2, $3, NOW() + ($4 || ' milliseconds')::interval)`,
    [userId, hash, purpose, String(ttl)]
  );
  return raw;
}

/**
 * Consume a token, returning the matching user_id if the token is valid,
 * unexpired, and unused. The token is marked used atomically so the same link
 * can never be replayed.
 */
async function consumeToken(rawToken, purpose) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const hash = sha256(rawToken);
  const result = await pool.query(
    `UPDATE auth_tokens
        SET used_at = NOW()
      WHERE token_hash = $1
        AND purpose    = $2
        AND used_at    IS NULL
        AND expires_at > NOW()
      RETURNING user_id`,
    [hash, purpose]
  );
  return result.rows[0]?.user_id ?? null;
}

// ── Account lockout + audit log ───────────────────────────────────────────
// Lock an account after MAX_FAILED_LOGINS consecutive bad-password attempts.
// Lockout is temporary (LOCKOUT_MS) — long enough to neutralise online
// brute-force, short enough that real users don't need an admin reset.
// Every security-relevant event also gets a row in auth_audit_log so a
// future admin UI can show "what happened to this account".
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Append a row to auth_audit_log. Best-effort — a log failure must not
 * break the calling auth endpoint, so we swallow errors.
 */
async function audit(event, { userId = null, email = null, req = null, detail = null } = {}) {
  try {
    await pool.query(
      `INSERT INTO auth_audit_log (event, user_id, email, ip, user_agent, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        event,
        userId,
        email ? String(email).toLowerCase().slice(0, 255) : null,
        req?.ip ? String(req.ip).slice(0, 64) : null,
        req?.headers?.['user-agent'] ? String(req.headers['user-agent']).slice(0, 500) : null,
        detail ? JSON.stringify(detail) : null,
      ]
    );
  } catch (e) {
    console.error('Audit log write failed:', e.message);
  }
}

/**
 * Increment the failed-login counter and lock the account once the
 * threshold is hit. Atomic via a single UPDATE.
 */
async function recordFailedLogin(userId) {
  const r = await pool.query(
    `UPDATE users
        SET failed_login_attempts = failed_login_attempts + 1,
            locked_until = CASE
              WHEN failed_login_attempts + 1 >= $2
              THEN NOW() + ($3 || ' milliseconds')::interval
              ELSE locked_until
            END
      WHERE id = $1
      RETURNING failed_login_attempts, locked_until`,
    [userId, MAX_FAILED_LOGINS, String(LOCKOUT_MS)]
  );
  return r.rows[0];
}

/**
 * Reset the failure counter on a successful login.
 */
async function resetFailedLogins(userId) {
  await pool.query(
    `UPDATE users
        SET failed_login_attempts = 0,
            locked_until = NULL,
            last_login_at = NOW()
      WHERE id = $1`,
    [userId]
  );
}

// ── Refresh token helpers ──────────────────────────────────────────────────
// We pair each short-lived access JWT (15 min) with an opaque refresh token
// stored hashed in `refresh_tokens`. The refresh flow rotates: every /refresh
// hit issues a brand-new token and marks the old one used. Replaying a used
// token is treated as theft and revokes the entire family for that user.
const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function signAccessToken(user) {
  // signToken() uses the first secret in the rotation ring, so new tokens
  // always go out signed with the current active key.
  return signToken(
    { userId: user.id, email: user.email, role: user.role },
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}

/**
 * Mint a refresh token for a user. Returns the raw token; only its SHA-256
 * hash is persisted. user_agent / ip are stored for forensic visibility on
 * the future "active sessions" admin UI.
 */
async function issueRefreshToken(userId, req) {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = sha256(raw);
  await pool.query(
    `INSERT INTO refresh_tokens
       (user_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, NOW() + ($3 || ' milliseconds')::interval, $4, $5)`,
    [
      userId,
      hash,
      String(REFRESH_TOKEN_TTL_MS),
      (req?.headers?.['user-agent'] || '').slice(0, 500),
      (req?.ip || '').slice(0, 64),
    ]
  );
  return raw;
}

/**
 * Validate + rotate a refresh token. On success returns the user_id and the
 * new raw refresh token. Returns null on any failure (expired, unknown,
 * revoked, already used). If the token was already used, all of that user's
 * refresh tokens are revoked — we treat reuse as theft.
 */
async function rotateRefreshToken(rawToken, req) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const hash = sha256(rawToken);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const lookup = await client.query(
      `SELECT id, user_id, used_at, revoked_at, expires_at
         FROM refresh_tokens
        WHERE token_hash = $1
        FOR UPDATE`,
      [hash]
    );
    const row = lookup.rows[0];

    // Reuse detection: a previously-rotated token is being presented again.
    // The only way that happens is theft — revoke the whole family.
    if (row && row.used_at) {
      await client.query(
        `UPDATE refresh_tokens
            SET revoked_at = NOW()
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [row.user_id]
      );
      await client.query('COMMIT');
      console.warn('Refresh token reuse detected; revoked all tokens for user', row.user_id);
      await audit('refresh.reuse', { userId: row.user_id, req });
      return null;
    }

    if (!row || row.revoked_at || row.expires_at <= new Date()) {
      await client.query('ROLLBACK');
      return null;
    }

    // Mark the presented token as rotated, then issue its successor.
    await client.query(
      'UPDATE refresh_tokens SET used_at = NOW() WHERE id = $1',
      [row.id]
    );

    const newRaw = crypto.randomBytes(32).toString('hex');
    const newHash = sha256(newRaw);
    await client.query(
      `INSERT INTO refresh_tokens
         (user_id, token_hash, expires_at, user_agent, ip)
       VALUES ($1, $2, NOW() + ($3 || ' milliseconds')::interval, $4, $5)`,
      [
        row.user_id,
        newHash,
        String(REFRESH_TOKEN_TTL_MS),
        (req?.headers?.['user-agent'] || '').slice(0, 500),
        (req?.ip || '').slice(0, 64),
      ]
    );

    await client.query('COMMIT');
    return { userId: row.user_id, refreshToken: newRaw };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Revoke a refresh token (logout). Idempotent — revoking an already-revoked
 * or unknown token is a no-op.
 */
async function revokeRefreshToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return;
  const hash = sha256(rawToken);
  await pool.query(
    `UPDATE refresh_tokens
        SET revoked_at = NOW()
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hash]
  );
}

// ✅ middleware
app.use((req, res, next) => {
  if (req.path === '/metrics') return next(); 

  const start = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;

    const route = req.route?.path || req.path || 'unknown';

    httpRequestCounter.inc({
      service: 'auth-service',
      method: req.method,
      route,
      status: res.statusCode
    });

    httpRequestDuration.observe(
      {
        service: 'auth-service',
        method: req.method,
        route
      },
      duration
    );
  });

  next();
});




app.post('/register', registerLimiter, async (req, res) => {
  console.log('Register request received:', { email: req.body.email });
  
  try {
    const { email, password, firstName, lastName } = req.body;

    if (!email || !password || !firstName || !lastName) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (email, password, first_name, last_name, role) 
       VALUES ($1, $2, $3, $4, 'user') 
       RETURNING id, email, first_name, last_name, role, created_at`,
      [email, hashedPassword, firstName, lastName]
    );

    const user = result.rows[0];

    console.log('User registered successfully:', email);

    // Issue an email-verification token and publish event for email-service.
    // We do this best-effort — registration must not fail if RabbitMQ is down.
    try {
      const verifyToken = await issueToken(user.id, 'email_verify');
      const verifyUrl   = `${FRONTEND_URL}/auth/verify-email?token=${verifyToken}`;
      await publishEvent('user.email_verify_requested', {
        userId:    user.id,
        email:     user.email,
        firstName: user.first_name,
        token:     verifyToken,
        verifyUrl,
      });
    } catch (e) {
      console.error('Could not send verification email:', e.message);
    }

    // Publish event → Notification Service will send welcome email
    await publishEvent('user.registered', {
      userId:    user.id,
      email:     user.email,
      firstName: user.first_name,
      lastName:  user.last_name,
      role:      user.role
    });

    await audit('register', { userId: user.id, email: user.email, req });

    // NOTE: we intentionally do NOT issue a JWT here. The user must verify
    // their email first; the frontend will redirect them to /auth/login with
    // a "check your inbox" notice.
    res.status(201).json({
      message: 'User registered successfully. Please check your email to verify your account.',
      requiresVerification: true,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed', details: error.message });
  }
});

app.post('/login', loginLimiter, async (req, res) => {
  console.log('Login request received:', { email: req.body.email });

  try {
    const { email, password } = req.body;

    if (!email || !password) {
      console.log('Login failed: Missing credentials');
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await pool.query(
      `SELECT id, email, password, first_name, last_name, role, email_verified,
              failed_login_attempts, locked_until
         FROM users WHERE email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      // Audit the probe but reply with a generic message so attackers can't
      // tell which emails exist. Failed-login counter only ticks for real
      // accounts (otherwise an attacker could DoS a victim by repeatedly
      // submitting their email).
      await audit('login.failed', { email, req, detail: { reason: 'unknown_user' } });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // Account-lockout gate. If `locked_until` is in the future, refuse the
    // attempt regardless of password correctness. This short-circuits both
    // online brute-force and credential-stuffing.
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const retryAfterSec = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 1000);
      await audit('login.locked', { userId: user.id, email: user.email, req, detail: { retryAfterSec } });
      res.set('Retry-After', String(retryAfterSec));
      return res.status(423).json({
        error: 'Account temporarily locked due to too many failed attempts. Try again later.',
        code: 'ACCOUNT_LOCKED',
        retryAfterSec,
      });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      const after = await recordFailedLogin(user.id);
      const justLocked = after?.locked_until && new Date(after.locked_until) > new Date();
      await audit(justLocked ? 'login.locked' : 'login.failed', {
        userId: user.id, email: user.email, req,
        detail: { attempts: after?.failed_login_attempts },
      });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Admins can always sign in (the seed admin has no verified email and we
    // don't want to lock the back-office out). Regular users must verify.
    if (user.role !== 'admin' && !user.email_verified) {
      await audit('login.failed', { userId: user.id, email: user.email, req, detail: { reason: 'unverified_email' } });
      return res.status(403).json({
        error: 'Please verify your email before signing in.',
        code: 'EMAIL_NOT_VERIFIED',
        email: user.email,
      });
    }

    await resetFailedLogins(user.id);
    const token = signAccessToken(user);
    const refreshToken = await issueRefreshToken(user.id, req);
    await audit('login.success', { userId: user.id, email: user.email, req });

    res.json({
      message: 'Login successful',
      token,
      refreshToken,
      expiresIn: ACCESS_TOKEN_TTL,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ error: 'Login failed', details: error.message });
  }
});

// Exchange a valid refresh token for a fresh access JWT (and a rotated
// refresh token). Stateless from the client's POV — no auth header needed,
// just the refresh token in the body. Reuse detection lives in
// rotateRefreshToken().
app.post('/refresh', verifyLimiter, async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) {
      return res.status(400).json({ error: 'refreshToken is required' });
    }
    const rotated = await rotateRefreshToken(refreshToken, req);
    if (!rotated) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }
    const userResult = await pool.query(
      'SELECT id, email, first_name, last_name, role FROM users WHERE id = $1',
      [rotated.userId]
    );
    const user = userResult.rows[0];
    if (!user) {
      return res.status(401).json({ error: 'User no longer exists' });
    }
    const token = signAccessToken(user);
    res.json({
      token,
      refreshToken: rotated.refreshToken,
      expiresIn: ACCESS_TOKEN_TTL,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
      },
    });
  } catch (error) {
    console.error('Refresh error:', error);
    res.status(500).json({ error: 'Could not refresh token' });
  }
});

// Server-side logout: revoke the supplied refresh token so it can't be used
// again. The frontend also clears its local copy. Always returns 200 so a
// stale or already-revoked token doesn't generate user-visible errors.
app.post('/logout', async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    await revokeRefreshToken(refreshToken);
    await audit('logout', { req });
    res.json({ message: 'Logged out' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

app.post('/verify', verifyLimiter, (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }
    // verifyToken() walks the rotation ring, so tokens minted with a
    // recently-retired secret still validate during the rollover window.
    const decoded = verifyToken(token);
    res.json({ valid: true, user: decoded });
  } catch (error) {
    res.status(401).json({ valid: false, error: 'Invalid token' });
  }
});

// ─── Email verification ────────────────────────────────────────────────────
// Click-through from the email lands here. We accept the raw token, consume it,
// then flip the user's email_verified flag. Always returns generic responses so
// nothing about token existence/validity leaks.
app.post('/verify-email', verifyLimiter, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token is required' });

    const userId = await consumeToken(token, 'email_verify');
    if (!userId) {
      return res.status(400).json({ error: 'Invalid or expired verification link' });
    }
    await pool.query(
      'UPDATE users SET email_verified = TRUE, email_verified_at = NOW() WHERE id = $1',
      [userId]
    );
    await audit('email.verified', { userId, req });
    res.json({ message: 'Email verified', userId });
  } catch (error) {
    console.error('Verify-email error:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Allow a logged-in user (or anyone supplying their email) to request a fresh
// verification email. We never reveal whether the email exists.
app.post('/resend-verification', resendVerifyLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const result = await pool.query(
      'SELECT id, email, first_name, email_verified FROM users WHERE LOWER(email) = $1',
      [email]
    );
    const user = result.rows[0];

    // Only issue a fresh token for unverified accounts, but always respond
    // identically to prevent account enumeration.
    if (user && !user.email_verified) {
      const token = await issueToken(user.id, 'email_verify');
      const verifyUrl = `${FRONTEND_URL}/auth/verify-email?token=${token}`;
      await publishEvent('user.email_verify_requested', {
        userId:    user.id,
        email:     user.email,
        firstName: user.first_name,
        token,
        verifyUrl,
      });
    }
    res.json({ message: 'If your email is registered and unverified, a new link has been sent.' });
  } catch (error) {
    console.error('Resend-verification error:', error);
    res.status(500).json({ error: 'Could not send verification email' });
  }
});

// ─── Password reset ────────────────────────────────────────────────────────
// Step 1 of 2: user submits their email. We always answer the same way to keep
// attackers from probing the user table.
app.post('/forgot-password', passwordResetLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const result = await pool.query(
      'SELECT id, email, first_name FROM users WHERE LOWER(email) = $1',
      [email]
    );
    const user = result.rows[0];

    if (user) {
      const token = await issueToken(user.id, 'password_reset');
      const resetUrl = `${FRONTEND_URL}/auth/reset-password?token=${token}`;
      await publishEvent('user.password_reset_requested', {
        userId:    user.id,
        email:     user.email,
        firstName: user.first_name,
        token,
        resetUrl,
      });
    }
    res.json({ message: 'If an account exists for that email, a reset link has been sent.' });
  } catch (error) {
    console.error('Forgot-password error:', error);
    res.status(500).json({ error: 'Could not process request' });
  }
});

// Step 2 of 2: user submits their new password along with the token from email.
app.post('/reset-password', passwordResetLimiter, async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) {
      return res.status(400).json({ error: 'Token and new password are required' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const userId = await consumeToken(token, 'password_reset');
    if (!userId) {
      return res.status(400).json({ error: 'Invalid or expired reset link' });
    }

    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hash, userId]);

    // A password change should kick all existing refresh tokens for the
    // user — the new owner of the credential shouldn't inherit prior
    // sessions. Audit the reset for forensic visibility.
    await pool.query(
      `UPDATE refresh_tokens SET revoked_at = NOW()
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    );
    await audit('password.reset', { userId, req });

    // Invalidate any other outstanding reset tokens for this user.
    await pool.query(
      'DELETE FROM auth_tokens WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL',
      [userId, 'password_reset']
    );
    res.json({ message: 'Password updated. You can now sign in.' });
  } catch (error) {
    console.error('Reset-password error:', error);
    res.status(500).json({ error: 'Could not reset password' });
  }
});



app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// ───────────────────────────────────────────────────────────────────────
// Internal endpoints — called by sibling services (user-service) under
// the database-per-service split. They are NOT exposed by api-gateway at
// `/api/*`; only reachable on the internal Docker / K8s network.
// ───────────────────────────────────────────────────────────────────────

/**
 * Admin: list/search users with pagination. Used by user-service to serve
 * its `GET /` admin endpoint and by admin-service to count users.
 */
app.get('/internal/users', async (req, res) => {
  try {
    const hasPagination = req.query.page != null || req.query.limit != null;
    const page  = Math.max(parseInt(req.query.page, 10)  || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').toString().trim();

    const where = [];
    const params = [];
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where.push(`(LOWER(email) LIKE $${params.length} OR LOWER(first_name) LIKE $${params.length} OR LOWER(last_name) LIKE $${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const totalQ = await pool.query(
      `SELECT COUNT(*)::int AS total FROM users ${whereSql}`,
      params
    );
    const total = totalQ.rows[0].total;

    const dataParams = [...params, limit, offset];
    const result = await pool.query(
      `SELECT id, email, first_name, last_name, role, phone, email_verified, created_at
         FROM users ${whereSql}
         ORDER BY created_at DESC
         LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );
    const users = result.rows.map(u => ({
      id: u.id, email: u.email,
      firstName: u.first_name, lastName: u.last_name,
      role: u.role, phone: u.phone,
      emailVerified: u.email_verified,
      createdAt: u.created_at,
    }));
    res.json(hasPagination ? { items: users, total, page, limit } : { items: users, total });
  } catch (error) {
    console.error('Internal list users error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

/** Single-user lookup. */
app.get('/internal/users/:id(\\d+)', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, email, first_name, last_name, role, phone, email_verified, created_at FROM users WHERE id = $1',
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    const u = r.rows[0];
    res.json({
      id: u.id, email: u.email,
      firstName: u.first_name, lastName: u.last_name,
      role: u.role, phone: u.phone,
      emailVerified: u.email_verified,
      createdAt: u.created_at,
    });
  } catch (error) {
    console.error('Internal get user error:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

/**
 * Profile update — invoked by user-service when the customer PUTs their
 * profile. We update auth_db (sole SoT for users) and publish
 * `user.profile_updated`; user-service consumes that event to refresh
 * its own read-side projection. Eventually-consistent CQRS.
 */
app.put('/internal/users/:id(\\d+)', async (req, res) => {
  try {
    const { firstName, lastName, phone } = req.body || {};
    const r = await pool.query(
      `UPDATE users
          SET first_name = $1, last_name = $2, phone = $3, updated_at = NOW()
        WHERE id = $4
      RETURNING id, email, first_name, last_name, role, phone, email_verified, created_at`,
      [firstName, lastName, phone, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    const u = r.rows[0];

    // Publish event so every read-side projection (user-service, anyone
    // else who keeps a denormalized user snapshot) stays in sync.
    await publishEvent('user.profile_updated', {
      userId:        u.id,
      email:         u.email,
      firstName:     u.first_name,
      lastName:      u.last_name,
      role:          u.role,
      phone:         u.phone,
      emailVerified: u.email_verified,
    });

    res.json({
      id: u.id, email: u.email,
      firstName: u.first_name, lastName: u.last_name,
      role: u.role, phone: u.phone,
      emailVerified: u.email_verified,
      createdAt: u.created_at,
    });
  } catch (error) {
    console.error('Internal update user error:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

/**
 * Delete user. auth-service owns the cleanup of its own auth_db
 * dependents (auth_tokens, refresh_tokens, auth_audit_log via
 * `ON DELETE SET NULL`). It then publishes `user.deleted`, and each
 * other service is responsible for cleaning up its own data
 * (notification-service deletes notifications, user-service deletes
 * wishlists+addresses, rating-service deletes ratings, etc.).
 *
 * This is the textbook choreographed-saga pattern: no central
 * coordinator, every bounded context handles its own cleanup.
 */
app.delete('/internal/users/:id(\\d+)', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Same-DB cascades. auth_tokens / refresh_tokens FK ON DELETE CASCADE,
    // auth_audit_log FK ON DELETE SET NULL — so just deleting the user
    // row is enough inside auth_db.
    const r = await client.query(
      'DELETE FROM users WHERE id = $1 RETURNING id, email',
      [req.params.id]
    );
    if (!r.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }
    await client.query('COMMIT');

    // Fan out to every other bounded context via Kafka.
    await publishEvent('user.deleted', {
      userId: r.rows[0].id,
      email:  r.rows[0].email,
    });

    res.json({ message: 'User deleted successfully', id: r.rows[0].id });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Internal delete user error:', error);
    res.status(500).json({ error: 'Failed to delete user', details: error.message });
  } finally {
    client.release();
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Auth Service running on port ${PORT}`);
});
