// Shared JWT verifier for Node services that want to re-validate the access
// token instead of trusting the api-gateway's `x-user-*` headers blindly.
//
// Why this exists: the gateway runs the only `jwt.verify()` today, and every
// downstream service trusts whatever `x-user-id` it receives. If the gateway
// is bypassed (someone hits the service directly on the internal network,
// for example) the auth check is gone. This module lets any service add a
// "belt and braces" verification with one line.
//
// Key rotation: `JWT_SECRETS` (comma-separated, optional) is the rotation
// ring. Tokens are signed with the FIRST secret; verification accepts ANY
// secret in the ring. To rotate:
//   1. Prepend a new secret in front: JWT_SECRETS=new,current
//   2. Restart auth-service (new tokens signed with `new`)
//   3. Wait for all old tokens to expire (15m access TTL → fast)
//   4. Drop the old secret: JWT_SECRETS=new
//
// If `JWT_SECRETS` is unset we fall back to `JWT_SECRET` so existing
// deployments keep working without config changes.

const jwt = require('jsonwebtoken');

function loadSecrets() {
  const ring = (process.env.JWT_SECRETS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ring.length > 0) return ring;
  if (process.env.JWT_SECRET) return [process.env.JWT_SECRET];
  return [];
}

/**
 * Verify a raw JWT string against the configured secret ring. Tries each
 * secret in order until one succeeds (oldest tokens may have been signed
 * with a now-rotated-out secret, but during the rotation window we still
 * accept them). Returns the decoded payload, or throws.
 */
function verifyToken(token) {
  const secrets = loadSecrets();
  if (secrets.length === 0) {
    throw new Error('No JWT secrets configured (JWT_SECRET / JWT_SECRETS)');
  }
  let lastErr;
  for (const secret of secrets) {
    try {
      return jwt.verify(token, secret);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/**
 * Sign a payload using the FIRST secret in the ring (= current "active"
 * key). Use this from the auth-service so new tokens always go out with the
 * freshest key during rotation.
 */
function signToken(payload, options = {}) {
  const secrets = loadSecrets();
  if (secrets.length === 0) {
    throw new Error('No JWT secrets configured (JWT_SECRET / JWT_SECRETS)');
  }
  return jwt.sign(payload, secrets[0], options);
}

/**
 * Express middleware that re-validates the bearer token. Use this in
 * downstream services that handle sensitive operations and shouldn't rely
 * solely on the gateway. Sets req.user to the decoded JWT payload.
 *
 * If the request arrived through the gateway (and so has `x-user-id` set),
 * we cross-check that the JWT's userId matches — protects against a
 * compromised gateway forging headers for a different user than the token
 * actually authorises.
 */
function authMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }
  try {
    const decoded = verifyToken(token);
    req.user = decoded;

    const headerUserId = req.headers['x-user-id'];
    if (headerUserId && String(decoded.userId) !== String(headerUserId)) {
      return res.status(403).json({ error: 'Token / header identity mismatch' });
    }
    next();
  } catch (e) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { verifyToken, signToken, authMiddleware, loadSecrets };
