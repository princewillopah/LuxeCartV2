/**
 * httpClient.js — production-grade inter-service HTTP client.
 *
 * Wraps Node 18+ fetch with the resilience patterns every microservice
 * needs in production (k8s, EKS, GKE — platform-agnostic):
 *
 *   1. Per-call timeout via AbortController (default 3s)
 *   2. Bounded retry with full-jitter exponential backoff on:
 *        - network errors (ECONNRESET, fetch failed, ETIMEDOUT, ENOTFOUND, …)
 *        - 5xx and 429 responses (honours Retry-After when present)
 *      Idempotent verbs only (GET/HEAD/OPTIONS) by default; opt-in for
 *      POST/PUT/PATCH/DELETE via { idempotent:true } when caller knows
 *      the endpoint is safe to retry.
 *   3. Per-target circuit breaker (opossum) — opens after a streak of
 *      failures, half-open probes after a cool-down. Stops cascading
 *      failures + sheds load on a sick downstream.
 *   4. Prometheus metrics auto-registered against the caller's registry:
 *        http_client_requests_total{target,method,outcome,status}
 *        http_client_request_duration_seconds{target,method}
 *        http_client_circuit_state{target}                  (0=closed,1=open,2=halfOpen)
 *   5. Request-id propagation: forwards x-request-id when present.
 *   6. Structured Error subclass (HttpClientError) preserving downstream
 *      context: { url, method, status, attempt, target, cause }.
 *
 * Usage:
 *
 *   const { createHttpClient } = require('./shared/httpClient');
 *
 *   const productHttp = createHttpClient({
 *     target: 'product-service',
 *     baseUrl: PRODUCT_SERVICE_URL,
 *     timeoutMs: 2000,
 *     register: promClient.register,           // your prom-client Registry
 *     logger,                                  // pino instance (optional)
 *     // circuit breaker tuning (opossum):
 *     breaker: {
 *       timeout: 3000,
 *       errorThresholdPercentage: 50,
 *       resetTimeout: 10000,
 *       volumeThreshold: 10,
 *     },
 *     retry: { attempts: 2, baseDelayMs: 100, maxDelayMs: 1000 },
 *   });
 *
 *   const product = await productHttp.getJson(`/public/${id}`);
 *   const result  = await productHttp.requestJson('/internal/stock/adjust', {
 *     method: 'POST',
 *     body: { delta: -1 },
 *     idempotent: false,             // never retry a non-idempotent write
 *     requestId: req.id,
 *   });
 *
 * Design notes:
 *   - One breaker instance per target. Keep callers long-lived (module-scope).
 *   - 4xx responses are NOT retried and DO NOT trip the breaker — those are
 *     client-side bugs, not downstream failures.
 *   - Timeout fires AbortController; the breaker also has its own timeout
 *     as a belt-and-braces safety net.
 *   - We intentionally do NOT bundle a cache here — caching belongs to
 *     the caller (each endpoint has different TTL semantics).
 */

const CircuitBreaker = require('opossum');

// ── Metric singletons keyed by registry ────────────────────────────────────
// Multiple clients in one process share the same Counter/Histogram so the
// label cardinality stays low ({target} only).
const _metricsByRegistry = new WeakMap();

function getMetrics(register, promClient) {
  if (_metricsByRegistry.has(register)) return _metricsByRegistry.get(register);

  const requests = new promClient.Counter({
    name: 'http_client_requests_total',
    help: 'Outbound HTTP requests from this service, by target.',
    labelNames: ['target', 'method', 'outcome', 'status'],
    registers: [register],
  });
  const duration = new promClient.Histogram({
    name: 'http_client_request_duration_seconds',
    help: 'Outbound HTTP request latency, by target.',
    labelNames: ['target', 'method'],
    buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [register],
  });
  const breakerState = new promClient.Gauge({
    name: 'http_client_circuit_state',
    help: 'Circuit breaker state per target (0=closed, 1=open, 2=halfOpen).',
    labelNames: ['target'],
    registers: [register],
  });

  const m = { requests, duration, breakerState };
  _metricsByRegistry.set(register, m);
  return m;
}

class HttpClientError extends Error {
  constructor(message, ctx) {
    super(message);
    this.name = 'HttpClientError';
    Object.assign(this, ctx);
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function jitter(baseMs, attempt, maxMs) {
  // Full jitter: random in [0, min(max, base * 2^attempt))
  const exp = Math.min(maxMs, baseMs * Math.pow(2, attempt));
  return Math.floor(Math.random() * exp);
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Create a hardened HTTP client bound to a single downstream target.
 *
 * @param {object} opts
 * @param {string} opts.target           Logical name (label on metrics, e.g. "product-service")
 * @param {string} opts.baseUrl          Base URL prepended to every call
 * @param {number} [opts.timeoutMs=3000] Per-attempt timeout
 * @param {object} opts.register         prom-client Registry to register metrics on
 * @param {object} [opts.promClient]     prom-client module reference (defaults to require('prom-client'))
 * @param {object} [opts.logger]         pino logger; if omitted, console.error is used for breaker events
 * @param {object} [opts.breaker]        opossum options override
 * @param {object} [opts.retry]          { attempts, baseDelayMs, maxDelayMs }
 * @param {object} [opts.defaultHeaders] headers attached to every call
 */
function createHttpClient(opts) {
  const {
    target,
    baseUrl,
    timeoutMs = 3000,
    register,
    promClient = require('prom-client'),
    logger,
    defaultHeaders = {},
  } = opts;

  if (!target) throw new Error('createHttpClient: target is required');
  if (!baseUrl) throw new Error('createHttpClient: baseUrl is required');
  if (!register) throw new Error('createHttpClient: register (prom Registry) is required');

  const metrics = getMetrics(register, promClient);
  const retryCfg = {
    attempts:    2,
    baseDelayMs: 100,
    maxDelayMs:  1000,
    ...(opts.retry || {}),
  };
  const breakerOpts = {
    timeout:                  timeoutMs + 500, // safety net > per-attempt timeout
    errorThresholdPercentage: 50,
    resetTimeout:             10_000,
    volumeThreshold:          10,              // need ≥10 calls before opening
    rollingCountTimeout:      30_000,
    rollingCountBuckets:      10,
    name:                     `http:${target}`,
    ...(opts.breaker || {}),
  };

  // Inner executor — one HTTP attempt, no retry. The breaker wraps this.
  async function executeOnce({ url, method, headers, body }) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);
    const start = process.hrtime.bigint();
    try {
      const resp = await fetch(url, {
        method,
        headers,
        body,
        signal: ctrl.signal,
      });
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      return { resp, ms };
    } finally {
      clearTimeout(t);
    }
  }

  const breaker = new CircuitBreaker(executeOnce, breakerOpts);

  breaker.on('open',     () => { metrics.breakerState.set({ target }, 1); (logger || console).warn?.({ target }, 'circuit OPEN'); });
  breaker.on('halfOpen', () => { metrics.breakerState.set({ target }, 2); (logger || console).info?.({ target }, 'circuit HALF-OPEN'); });
  breaker.on('close',    () => { metrics.breakerState.set({ target }, 0); (logger || console).info?.({ target }, 'circuit CLOSED'); });
  metrics.breakerState.set({ target }, 0);

  // Optional fallback: when the breaker is open the call fails fast with
  // EOPENBREAKER. We surface that as a structured error rather than the
  // raw "Breaker is open" string.
  breaker.fallback((args, err) => {
    throw new HttpClientError('circuit_open', {
      url:     args?.url,
      method:  args?.method,
      target,
      attempt: 0,
      status:  503,
      code:    'CIRCUIT_OPEN',
      cause:   err,
    });
  });

  function buildUrl(path, query) {
    const base = baseUrl.replace(/\/+$/, '');
    const p = path.startsWith('/') ? path : `/${path}`;
    if (!query) return `${base}${p}`;
    const qs = new URLSearchParams(query).toString();
    return qs ? `${base}${p}?${qs}` : `${base}${p}`;
  }

  function recordOutcome(method, outcome, status) {
    metrics.requests.inc({ target, method, outcome, status: String(status || 0) });
  }

  /**
   * Low-level request with built-in retry + breaker. Returns the parsed
   * JSON body, or throws HttpClientError. For 404 we DO NOT throw — we
   * return undefined so callers can distinguish "not found" from
   * "downstream broken".
   */
  async function requestJson(path, {
    method = 'GET',
    headers = {},
    body,
    query,
    idempotent,
    requestId,
    expect404AsNull = true,
  } = {}) {
    const url = buildUrl(path, query);
    const m = method.toUpperCase();
    const safe = SAFE_METHODS.has(m);
    const allowRetry = idempotent ?? safe;

    const finalHeaders = {
      'accept': 'application/json',
      ...defaultHeaders,
      ...headers,
    };
    if (requestId) finalHeaders['x-request-id'] = requestId;
    let finalBody = body;
    if (body !== undefined && body !== null && typeof body !== 'string') {
      finalBody = JSON.stringify(body);
      if (!finalHeaders['content-type']) finalHeaders['content-type'] = 'application/json';
    }

    const maxAttempts = allowRetry ? retryCfg.attempts + 1 : 1;
    let lastErr;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const t0 = process.hrtime.bigint();
      try {
        // The breaker only sees the executor call; we don't wrap the
        // retry loop itself, so a single SLOW call doesn't cause the
        // breaker to mark every retry as a separate failure.
        const { resp, ms } = await breaker.fire({
          url, method: m, headers: finalHeaders, body: finalBody,
        });
        metrics.duration.observe({ target, method: m }, ms / 1000);

        // 2xx happy path
        if (resp.status >= 200 && resp.status < 300) {
          recordOutcome(m, 'success', resp.status);
          if (resp.status === 204) return undefined;
          // tolerate empty body
          const text = await resp.text();
          if (!text) return undefined;
          try { return JSON.parse(text); }
          catch (e) {
            throw new HttpClientError('invalid_json', {
              url, method: m, target, attempt, status: resp.status, cause: e,
            });
          }
        }

        // 404 — not a downstream failure, just "not there"
        if (resp.status === 404 && expect404AsNull) {
          recordOutcome(m, 'not_found', 404);
          return undefined;
        }

        // 4xx — client error, surface immediately, do NOT retry, do NOT count as breaker failure
        if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
          recordOutcome(m, 'client_error', resp.status);
          const text = await resp.text().catch(() => '');
          throw new HttpClientError(`http_${resp.status}`, {
            url, method: m, target, attempt, status: resp.status, body: text,
          });
        }

        // 5xx / 429 — retryable
        recordOutcome(m, 'server_error', resp.status);
        const text = await resp.text().catch(() => '');
        lastErr = new HttpClientError(`http_${resp.status}`, {
          url, method: m, target, attempt, status: resp.status, body: text,
        });

        if (attempt + 1 < maxAttempts) {
          let delay = jitter(retryCfg.baseDelayMs, attempt, retryCfg.maxDelayMs);
          const ra = resp.headers.get('retry-after');
          if (ra) {
            const raMs = /^\d+$/.test(ra) ? Number(ra) * 1000 : Math.max(0, new Date(ra).getTime() - Date.now());
            if (Number.isFinite(raMs) && raMs > 0) delay = Math.min(raMs, retryCfg.maxDelayMs);
          }
          (logger || console).warn?.({ target, url, method: m, attempt, status: resp.status, delay_ms: delay }, 'http retry');
          await sleep(delay);
          continue;
        }
        throw lastErr;
      } catch (err) {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        metrics.duration.observe({ target, method: m }, ms / 1000);

        // Don't retry HttpClientErrors we already handled above
        if (err instanceof HttpClientError && err.status && err.status < 500 && err.status !== 429) {
          throw err;
        }

        // Network / timeout / breaker-open — retryable
        const code = err?.code || err?.cause?.code || (err?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK');
        recordOutcome(m, code === 'CIRCUIT_OPEN' ? 'circuit_open' : 'network_error', 0);
        lastErr = err instanceof HttpClientError ? err : new HttpClientError(err.message || 'network_error', {
          url, method: m, target, attempt, code, cause: err,
        });

        if (allowRetry && attempt + 1 < maxAttempts && code !== 'CIRCUIT_OPEN') {
          const delay = jitter(retryCfg.baseDelayMs, attempt, retryCfg.maxDelayMs);
          (logger || console).warn?.({ target, url, method: m, attempt, code, delay_ms: delay }, 'http retry (network)');
          await sleep(delay);
          continue;
        }
        throw lastErr;
      }
    }
    throw lastErr;
  }

  return {
    target,
    breaker,
    getJson:  (path, opts)        => requestJson(path, { ...(opts || {}), method: 'GET' }),
    headJson: (path, opts)        => requestJson(path, { ...(opts || {}), method: 'HEAD' }),
    postJson: (path, body, opts)  => requestJson(path, { ...(opts || {}), method: 'POST',   body }),
    putJson:  (path, body, opts)  => requestJson(path, { ...(opts || {}), method: 'PUT',    body }),
    patchJson:(path, body, opts)  => requestJson(path, { ...(opts || {}), method: 'PATCH',  body }),
    deleteJson:(path, opts)       => requestJson(path, { ...(opts || {}), method: 'DELETE' }),
    requestJson,
  };
}

module.exports = { createHttpClient, HttpClientError };
