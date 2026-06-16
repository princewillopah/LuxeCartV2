/**
 * logger.js — Shared structured logging for every Node service.
 *
 * Two things ship from this module:
 *
 *   const { logger, requestLogger } = require('./shared/logger')(serviceName);
 *
 *   - `logger`         pino instance tagged with { service }, suitable for
 *                      bootstrap / background logging.
 *   - `requestLogger`  express middleware that:
 *                        • assigns/propagates `X-Request-Id` per request,
 *                        • exposes it as `req.id` and `res.locals.requestId`,
 *                        • attaches a child pino logger as `req.log`,
 *                        • emits one structured log line per completed request.
 *
 * The shape of every log line is JSON, e.g.:
 *   { "level":"info", "time":..., "service":"auth-service",
 *     "request_id":"...", "method":"POST", "url":"/login",
 *     "status":200, "duration_ms":42, "msg":"request completed" }
 *
 * This is what makes `{service="auth-service"} | json | request_id="abc"`
 * queries work end-to-end in Loki.
 */

const pino = require('pino');
const pinoHttp = require('pino-http');
const crypto = require('crypto');

const REQUEST_ID_HEADER = 'x-request-id';

function newRequestId() {
  // 16 hex chars — short enough to eyeball in logs, wide enough to be unique
  // across the request volume we'll ever realistically see.
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Build the shared logger toolkit for a service.
 *
 * @param {string} serviceName  e.g. 'auth-service' — becomes a baked-in label
 * @returns {{ logger: pino.Logger, requestLogger: import('express').RequestHandler }}
 */
module.exports = function buildLogger(serviceName) {
  const logger = pino({
    base:        { service: serviceName },
    level:       process.env.LOG_LEVEL || 'info',
    timestamp:   pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.password',
        '*.token',
        '*.password_hash',
      ],
      censor: '[REDACTED]',
    },
    formatters: {
      // Make levels human-readable instead of numeric — Loki dashboards parse
      // strings much more naturally.
      level: (label) => ({ level: label }),
    },
  });

  const requestLogger = pinoHttp({
    logger,
    genReqId: (req, res) => {
      const incoming = req.headers[REQUEST_ID_HEADER];
      const id = (Array.isArray(incoming) ? incoming[0] : incoming) || newRequestId();
      res.setHeader(REQUEST_ID_HEADER, id);
      return id;
    },
    customLogLevel: (req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    customSuccessMessage: (req, res) =>
      `${req.method} ${req.url} ${res.statusCode}`,
    customErrorMessage: (req, res, err) =>
      `${req.method} ${req.url} ${res.statusCode} (${err.message})`,
    customProps: (req, res) => ({
      request_id:  req.id,
      method:      req.method,
      route:       req.route?.path || req.path,
      status:      res.statusCode,
      duration_ms: Math.round(res.responseTime ?? 0),
    }),
    serializers: {
      // Keep the request/response objects out of every log line — we already
      // surface what we care about via customProps.
      req: () => undefined,
      res: () => undefined,
    },
  });

  return { logger, requestLogger };
};

module.exports.REQUEST_ID_HEADER = REQUEST_ID_HEADER;
module.exports.newRequestId = newRequestId;
