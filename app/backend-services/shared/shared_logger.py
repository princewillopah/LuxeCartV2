"""
shared_logger.py — Structured JSON logging + request-id propagation for the
FastAPI services (analytics-service, email-service, recommendation-service).

Usage inside a service:

    from shared_logger import setup_logging, RequestContextMiddleware

    logger = setup_logging("email-service")
    app.add_middleware(RequestContextMiddleware, service_name="email-service")

Each request gets `X-Request-Id` (incoming header is honored; otherwise a
random 16-char hex id is generated). The id is:

  - returned to the client via the response header,
  - injected into every log record via a context filter,
  - available inside route handlers as `request.state.request_id`.

That makes Loki queries like
    {service="email-service"} | json | request_id="abc"
work end-to-end alongside the Node services.
"""

from __future__ import annotations

import contextvars
import logging
import os
import secrets
import sys
import time
from typing import Optional

from fastapi import Request
from pythonjsonlogger import jsonlogger
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

REQUEST_ID_HEADER = "x-request-id"

# Context variable so log records emitted anywhere inside the request task
# (including background work spawned via asyncio.create_task) inherit the id.
_request_id_ctx: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "request_id", default=None
)


def get_request_id() -> Optional[str]:
    return _request_id_ctx.get()


class _ContextFilter(logging.Filter):
    """Pulls the current request_id off the contextvar into the log record."""

    def __init__(self, service_name: str) -> None:
        super().__init__()
        self.service_name = service_name

    def filter(self, record: logging.LogRecord) -> bool:
        record.service = self.service_name
        record.request_id = _request_id_ctx.get() or "-"
        return True


def setup_logging(service_name: str, level: Optional[str] = None) -> logging.Logger:
    """Replace the root handler with a JSON one and return a service logger."""
    log_level = (level or os.getenv("LOG_LEVEL") or "INFO").upper()

    handler = logging.StreamHandler(sys.stdout)
    formatter = jsonlogger.JsonFormatter(
        # rename_fields lets the JSON keys match the Node services' shape.
        fmt="%(asctime)s %(levelname)s %(name)s %(message)s "
            "%(service)s %(request_id)s",
        rename_fields={"asctime": "time", "levelname": "level"},
    )
    handler.setFormatter(formatter)
    handler.addFilter(_ContextFilter(service_name))

    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(log_level)

    # Tame the noisy access logger — we emit our own per-request line below.
    logging.getLogger("uvicorn.access").handlers = [handler]
    logging.getLogger("uvicorn.access").propagate = False

    return logging.getLogger(service_name)


def _new_id() -> str:
    return secrets.token_hex(8)


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Assigns a request_id, threads it into context, emits an access log."""

    def __init__(self, app, service_name: str) -> None:
        super().__init__(app)
        self.service_name = service_name
        self._logger = logging.getLogger(service_name)

    async def dispatch(self, request: Request, call_next) -> Response:
        incoming = request.headers.get(REQUEST_ID_HEADER)
        request_id = incoming or _new_id()
        token = _request_id_ctx.set(request_id)
        request.state.request_id = request_id

        start = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception as exc:
            duration_ms = round((time.perf_counter() - start) * 1000)
            self._logger.exception(
                "request failed",
                extra={
                    "method": request.method,
                    "url": str(request.url.path),
                    "status": 500,
                    "duration_ms": duration_ms,
                },
            )
            raise
        finally:
            _request_id_ctx.reset(token)

        duration_ms = round((time.perf_counter() - start) * 1000)
        response.headers[REQUEST_ID_HEADER] = request_id

        # Emit the access log with the same id back in context so the line is
        # tagged correctly even though we already reset the contextvar.
        token2 = _request_id_ctx.set(request_id)
        try:
            level = (
                logging.ERROR if response.status_code >= 500
                else logging.WARNING if response.status_code >= 400
                else logging.INFO
            )
            self._logger.log(
                level,
                "request completed",
                extra={
                    "method": request.method,
                    "url": str(request.url.path),
                    "status": response.status_code,
                    "duration_ms": duration_ms,
                },
            )
        finally:
            _request_id_ctx.reset(token2)

        return response
