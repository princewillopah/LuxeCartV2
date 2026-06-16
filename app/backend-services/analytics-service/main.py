"""
Analytics Service — Port 3013

Maintains a read-side projection of all data the analytics endpoints
need, populated entirely from Kafka events. Owns its own
`analytics_db` (under the database-per-service split). NO cross-service
SQL JOINs are performed — every query reads from local projection
tables only.

Projection tables (created at startup, idempotent):
  - users           (id, email, first_name, last_name, role, created_at)
  - products        (id, name, category, brand, price, stock, average_rating, total_reviews, created_at)
  - orders          (id, user_id, user_email, user_first_name, user_last_name, total, status, created_at, updated_at)
  - order_items     (id, order_id, product_id, product_name, product_category, price, quantity, created_at)

Event → projection table mapping:
  user.registered          → users INSERT
  user.profile_updated     → users UPDATE
  user.deleted             → users DELETE (cascades order_items references)
  product.created          → products INSERT
  product.updated          → products UPDATE (also keeps category fresh on order_items)
  product.deleted          → products DELETE
  order.created            → orders + order_items INSERT
  order.status_updated     → orders UPDATE status (+ updated_at)

Endpoints unchanged from the legacy implementation; all SQL now
reads from local projection tables only.

Tech: FastAPI + asyncpg + confluent-kafka
"""

import asyncio
import json
import logging
import os
import threading
import time
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import asyncpg
from confluent_kafka import Consumer, KafkaError, KafkaException
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from prometheus_client import Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST
from starlette.responses import Response

from shared_logger import setup_logging, RequestContextMiddleware


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Analytics Service", version="2.0.0")

# Structured logging — every line is JSON with service + request_id
_svc_logger = setup_logging('analytics-service')
app.add_middleware(RequestContextMiddleware, service_name='analytics-service')

# Prometheus metrics
REQUEST_COUNT = Counter('http_requests_total', 'Total HTTP requests',
                        ['service', 'method', 'endpoint', 'status'])
REQUEST_LATENCY = Histogram('http_request_duration_seconds', 'HTTP request latency',
                            ['service', 'method', 'endpoint'])
EVENTS_CONSUMED = Counter('analytics_events_consumed_total',
                          'Kafka events applied to the projection',
                          ['event_type'])

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def track_metrics(request, call_next):
    start = time.time()
    response = await call_next(request)
    duration = time.time() - start
    REQUEST_COUNT.labels("analytics-service", request.method, request.url.path,
                         response.status_code).inc()
    REQUEST_LATENCY.labels("analytics-service", request.method,
                           request.url.path).observe(duration)
    return response


# ─── Connection / config ────────────────────────────────────────────
# Database-per-service: we read/write only `analytics_db`. The compose
# file passes DATABASE_URL pointing at that DB. Legacy default keeps
# the service runnable against the shared dev DB before the physical
# split is finished.
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://ecommerce:ecommerce123@postgres:5432/analytics_db"
)
KAFKA_BROKERS = os.environ.get("KAFKA_BROKERS", "kafka:9092")
SERVICE_NAME  = os.environ.get("SERVICE_NAME", "analytics-service")

# Topics whose payloads we materialize into the local projection.
KAFKA_TOPICS = [
    "ecommerce.user.registered",
    "ecommerce.user.profile_updated",
    "ecommerce.user.deleted",
    "ecommerce.product.created",
    "ecommerce.product.updated",
    "ecommerce.product.deleted",
    "ecommerce.order.created",
    "ecommerce.order.status_updated",
]

# Asyncio loop captured at startup so the Kafka-consumer thread can
# `run_coroutine_threadsafe(...)` writes back onto FastAPI's main loop
# (asyncpg pool lives there).
main_loop: Optional[asyncio.AbstractEventLoop] = None
db_pool: Optional[asyncpg.Pool] = None


# ─── DDL ────────────────────────────────────────────────────────────
# Until each service owns its own physical database we isolate the
# projection inside a dedicated Postgres schema so it doesn't collide
# with the canonical `public.*` tables in the shared dev DB.
PROJECTION_SCHEMA = "analytics"

PROJECTION_DDL = f"""
CREATE SCHEMA IF NOT EXISTS {PROJECTION_SCHEMA};

CREATE TABLE IF NOT EXISTS {PROJECTION_SCHEMA}.users (
    id           INTEGER PRIMARY KEY,
    email        VARCHAR(255),
    first_name   VARCHAR(100),
    last_name    VARCHAR(100),
    role         VARCHAR(20) DEFAULT 'user',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS {PROJECTION_SCHEMA}.products (
    id              INTEGER PRIMARY KEY,
    name            VARCHAR(255),
    category        VARCHAR(100),
    brand           VARCHAR(100),
    price           NUMERIC(12,2),
    stock           INTEGER DEFAULT 0,
    average_rating  NUMERIC(3,2) DEFAULT 0,
    total_reviews   INTEGER DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS {PROJECTION_SCHEMA}.orders (
    id              INTEGER PRIMARY KEY,
    user_id         INTEGER,
    user_email      VARCHAR(255),
    user_first_name VARCHAR(100),
    user_last_name  VARCHAR(100),
    total           NUMERIC(12,2),
    status          VARCHAR(30),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_a_orders_user_id    ON {PROJECTION_SCHEMA}.orders(user_id);
CREATE INDEX IF NOT EXISTS idx_a_orders_created_at ON {PROJECTION_SCHEMA}.orders(created_at);
CREATE INDEX IF NOT EXISTS idx_a_orders_status     ON {PROJECTION_SCHEMA}.orders(status);

CREATE TABLE IF NOT EXISTS {PROJECTION_SCHEMA}.order_items (
    id               SERIAL PRIMARY KEY,
    order_id         INTEGER NOT NULL,
    product_id       INTEGER,
    product_name     VARCHAR(255),
    product_category VARCHAR(100),
    price            NUMERIC(12,2),
    quantity         INTEGER,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(order_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_a_order_items_product_id ON {PROJECTION_SCHEMA}.order_items(product_id);
CREATE INDEX IF NOT EXISTS idx_a_order_items_order_id   ON {PROJECTION_SCHEMA}.order_items(order_id);
"""


@app.on_event("startup")
async def startup():
    global main_loop, db_pool
    main_loop = asyncio.get_event_loop()
    try:
        async def _init_conn(conn):
            # Every connection sees the projection schema first, then
            # falls through to public for shared extensions, etc.
            await conn.execute(
                f'SET search_path = {PROJECTION_SCHEMA}, public'
            )
        db_pool = await asyncpg.create_pool(
            DATABASE_URL, min_size=2, max_size=10, command_timeout=60,
            setup=_init_conn,
        )
        logger.info("✅ Analytics Service connected to PostgreSQL")
    except Exception as e:
        logger.error(f"❌ Database connection failed: {e}")
        raise
    # Create projection tables (idempotent).
    async with db_pool.acquire() as conn:
        await conn.execute(PROJECTION_DDL)
    logger.info("✅ Projection tables ensured")

    # Backfill from the canonical tables on the first run so the
    # projection isn't cold. Once the physical DB split is done this
    # step becomes seeding from a per-service dump instead.
    await backfill_projection()

    # Start Kafka consumer in a background thread (confluent-kafka is
    # blocking — same pattern as email-service).
    threading.Thread(target=start_kafka_consumer, daemon=True).start()


@app.on_event("shutdown")
async def shutdown():
    global db_pool
    if db_pool:
        await db_pool.close()
        logger.info("Database pool closed")


async def backfill_projection():
    """One-time seed of the projection from canonical tables. Skips any
    table that already has rows (so re-runs are no-ops).

    During the transitional period both the canonical and projection
    tables live in the same Postgres instance, so we copy directly via
    SELECT/INSERT. After the physical DB split this helper can be
    deleted and seeding can come from a pg_dump of the originating
    service.
    """
    async with db_pool.acquire() as conn:
        # users
        n = await conn.fetchval(f"SELECT COUNT(*) FROM {PROJECTION_SCHEMA}.users")
        if n == 0:
            await conn.execute(
                f"""
                INSERT INTO {PROJECTION_SCHEMA}.users
                  (id, email, first_name, last_name, role, created_at)
                SELECT id, email, first_name, last_name, role,
                       COALESCE(created_at, NOW())
                FROM public.users
                ON CONFLICT (id) DO NOTHING
                """
            )
            logger.info(f"Backfilled {PROJECTION_SCHEMA}.users")

        # products
        n = await conn.fetchval(f"SELECT COUNT(*) FROM {PROJECTION_SCHEMA}.products")
        if n == 0:
            await conn.execute(
                f"""
                INSERT INTO {PROJECTION_SCHEMA}.products
                  (id, name, category, brand, price, stock,
                   average_rating, total_reviews, created_at)
                SELECT id, name, category, brand, price,
                       COALESCE(stock, 0),
                       COALESCE(average_rating, 0),
                       COALESCE(total_reviews, 0),
                       COALESCE(created_at, NOW())
                FROM public.products
                ON CONFLICT (id) DO NOTHING
                """
            )
            logger.info(f"Backfilled {PROJECTION_SCHEMA}.products")

        # orders + items (do them together to keep things consistent)
        n = await conn.fetchval(f"SELECT COUNT(*) FROM {PROJECTION_SCHEMA}.orders")
        if n == 0:
            await conn.execute(
                f"""
                INSERT INTO {PROJECTION_SCHEMA}.orders
                  (id, user_id, user_email, user_first_name, user_last_name,
                   total, status, created_at, updated_at)
                SELECT o.id, o.user_id,
                       u.email, u.first_name, u.last_name,
                       o.total, o.status,
                       COALESCE(o.created_at, NOW()),
                       COALESCE(o.updated_at, o.created_at, NOW())
                FROM public.orders o
                LEFT JOIN public.users u ON u.id = o.user_id
                ON CONFLICT (id) DO NOTHING
                """
            )
            await conn.execute(
                f"""
                INSERT INTO {PROJECTION_SCHEMA}.order_items
                  (order_id, product_id, product_name, product_category,
                   price, quantity)
                SELECT oi.order_id, oi.product_id,
                       p.name, p.category,
                       oi.price, oi.quantity
                FROM public.order_items oi
                LEFT JOIN public.products p ON p.id = oi.product_id
                ON CONFLICT (order_id, product_id) DO NOTHING
                """
            )
            logger.info(
                f"Backfilled {PROJECTION_SCHEMA}.orders + order_items"
            )


@app.get("/health")
async def health():
    try:
        async with db_pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        return {"status": "healthy", "service": "Analytics", "database": "connected"}
    except Exception:
        return {"status": "unhealthy", "service": "Analytics", "database": "disconnected"}


@app.get("/metrics")
async def metrics():
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# PROJECTION HANDLERS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def _parse_ts(raw) -> Optional[datetime]:
    """Tolerate ISO-8601 strings (`Z` suffix or `+00:00`) and bare
    epoch ints. Returns None if we can't parse — caller defaults to NOW().
    """
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        try:
            return datetime.fromtimestamp(raw)
        except Exception:
            return None
    if isinstance(raw, str):
        s = raw.replace("Z", "+00:00")
        try:
            return datetime.fromisoformat(s)
        except Exception:
            return None
    return None


async def apply_user_registered(data: Dict[str, Any]):
    uid = data.get("userId") or data.get("id")
    if not uid:
        return
    async with db_pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO users (id, email, first_name, last_name, role, created_at)
            VALUES ($1, $2, $3, $4, $5, COALESCE($6, NOW()))
            ON CONFLICT (id) DO UPDATE SET
                email      = EXCLUDED.email,
                first_name = EXCLUDED.first_name,
                last_name  = EXCLUDED.last_name,
                role       = COALESCE(EXCLUDED.role, users.role)
            """,
            int(uid),
            data.get("email"),
            data.get("firstName") or data.get("first_name"),
            data.get("lastName")  or data.get("last_name"),
            data.get("role") or "user",
            _parse_ts(data.get("createdAt") or data.get("created_at")),
        )


async def apply_user_profile_updated(data: Dict[str, Any]):
    uid = data.get("userId") or data.get("id")
    if not uid:
        return
    async with db_pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO users (id, email, first_name, last_name, role)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (id) DO UPDATE SET
                email      = COALESCE(EXCLUDED.email,      users.email),
                first_name = COALESCE(EXCLUDED.first_name, users.first_name),
                last_name  = COALESCE(EXCLUDED.last_name,  users.last_name),
                role       = COALESCE(EXCLUDED.role,       users.role)
            """,
            int(uid),
            data.get("email"),
            data.get("firstName") or data.get("first_name"),
            data.get("lastName")  or data.get("last_name"),
            data.get("role"),
        )


async def apply_user_deleted(data: Dict[str, Any]):
    uid = data.get("userId") or data.get("id")
    if not uid:
        return
    async with db_pool.acquire() as conn:
        await conn.execute("DELETE FROM users WHERE id = $1", int(uid))


async def apply_product_upsert(data: Dict[str, Any]):
    pid = data.get("productId") or data.get("id")
    if not pid:
        return
    async with db_pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO products
              (id, name, category, brand, price, stock, average_rating,
               total_reviews, created_at)
            VALUES
              ($1, $2, $3, $4, $5, COALESCE($6, 0), COALESCE($7, 0),
               COALESCE($8, 0), COALESCE($9, NOW()))
            ON CONFLICT (id) DO UPDATE SET
                name           = EXCLUDED.name,
                category       = EXCLUDED.category,
                brand          = EXCLUDED.brand,
                price          = EXCLUDED.price,
                stock          = EXCLUDED.stock,
                average_rating = EXCLUDED.average_rating,
                total_reviews  = EXCLUDED.total_reviews
            """,
            int(pid),
            data.get("name"),
            data.get("category"),
            data.get("brand"),
            data.get("price"),
            data.get("stock"),
            data.get("averageRating") or data.get("average_rating"),
            data.get("totalReviews")  or data.get("total_reviews"),
            _parse_ts(data.get("createdAt") or data.get("created_at")),
        )
        # Keep the order_items denormalised name/category in sync so
        # reports don't drift after a product rename / re-categorisation.
        if data.get("name") is not None or data.get("category") is not None:
            await conn.execute(
                """
                UPDATE order_items
                SET product_name     = COALESCE($2, product_name),
                    product_category = COALESCE($3, product_category)
                WHERE product_id = $1
                """,
                int(pid),
                data.get("name"),
                data.get("category"),
            )


async def apply_product_deleted(data: Dict[str, Any]):
    pid = data.get("productId") or data.get("id")
    if not pid:
        return
    async with db_pool.acquire() as conn:
        await conn.execute("DELETE FROM products WHERE id = $1", int(pid))


async def apply_order_created(data: Dict[str, Any]):
    oid = data.get("orderId") or data.get("id")
    if not oid:
        return
    items = data.get("items") or []
    async with db_pool.acquire() as conn, conn.transaction():
        await conn.execute(
            """
            INSERT INTO orders
              (id, user_id, user_email, user_first_name, user_last_name,
               total, status, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7,'pending'),
                    COALESCE($8, NOW()), COALESCE($8, NOW()))
            ON CONFLICT (id) DO UPDATE SET
                user_id         = EXCLUDED.user_id,
                user_email      = COALESCE(EXCLUDED.user_email,      orders.user_email),
                user_first_name = COALESCE(EXCLUDED.user_first_name, orders.user_first_name),
                user_last_name  = COALESCE(EXCLUDED.user_last_name,  orders.user_last_name),
                total           = EXCLUDED.total,
                status          = EXCLUDED.status
            """,
            int(oid),
            data.get("userId") or data.get("user_id"),
            data.get("userEmail")     or data.get("email"),
            data.get("userFirstName") or data.get("firstName"),
            data.get("userLastName")  or data.get("lastName"),
            data.get("total"),
            data.get("status"),
            _parse_ts(data.get("createdAt") or data.get("created_at")),
        )
        for it in items:
            pid = it.get("productId") or it.get("product_id")
            if not pid:
                continue
            # Enrich category from the local products projection so
            # downstream queries can JOIN-locally on the snapshot.
            category = None
            row = await conn.fetchrow(
                "SELECT category FROM products WHERE id = $1", int(pid)
            )
            if row:
                category = row["category"]
            await conn.execute(
                """
                INSERT INTO order_items
                  (order_id, product_id, product_name, product_category, price, quantity)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (order_id, product_id) DO UPDATE SET
                    product_name     = EXCLUDED.product_name,
                    product_category = COALESCE(EXCLUDED.product_category,
                                                order_items.product_category),
                    price            = EXCLUDED.price,
                    quantity         = EXCLUDED.quantity
                """,
                int(oid),
                int(pid),
                it.get("productName") or it.get("name") or it.get("product_name"),
                category,
                it.get("price"),
                it.get("quantity"),
            )


async def apply_order_status_updated(data: Dict[str, Any]):
    oid = data.get("orderId") or data.get("id")
    new_status = data.get("status")
    if not oid or not new_status:
        return
    async with db_pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE orders
            SET status = $2, updated_at = NOW()
            WHERE id = $1
            """,
            int(oid), new_status,
        )


EVENT_DISPATCH = {
    "user.registered":      apply_user_registered,
    "user.profile_updated": apply_user_profile_updated,
    "user.deleted":         apply_user_deleted,
    "product.created":      apply_product_upsert,
    "product.updated":      apply_product_upsert,
    "product.deleted":      apply_product_deleted,
    "order.created":        apply_order_created,
    "order.status_updated": apply_order_status_updated,
}


async def process_event(event_type: str, data: Dict[str, Any]):
    handler = EVENT_DISPATCH.get(event_type)
    if handler is None:
        return
    try:
        await handler(data)
        EVENTS_CONSUMED.labels(event_type=event_type).inc()
    except Exception as e:
        logger.error(f"[Analytics] failed to apply {event_type}: {e}")


# ─── Kafka consumer (background thread) ─────────────────────────────
def start_kafka_consumer():
    """Subscribes to the projection topics and dispatches each event
    onto the asyncio main loop so asyncpg writes use the pool. Manual
    commit after the handler completes for at-least-once delivery.
    """
    max_retries = 20
    retry_delay = 5

    for attempt in range(1, max_retries + 1):
        try:
            logger.info(
                f"[Analytics] Attempting Kafka connection "
                f"(attempt {attempt}/{max_retries})..."
            )

            consumer = Consumer({
                "bootstrap.servers":     KAFKA_BROKERS,
                "group.id":              f"{SERVICE_NAME}.projection",
                "client.id":             SERVICE_NAME,
                "enable.auto.commit":    False,
                "auto.offset.reset":     "earliest",
                "session.timeout.ms":    30000,
                "heartbeat.interval.ms": 3000,
                "max.poll.interval.ms":  300000,
            })
            consumer.subscribe(KAFKA_TOPICS)
            logger.info(
                f"✅ Analytics consumer subscribed to {len(KAFKA_TOPICS)} topics"
            )

            while True:
                msg = consumer.poll(timeout=1.0)
                if msg is None:
                    continue
                if msg.error():
                    if msg.error().code() == KafkaError._PARTITION_EOF:
                        continue
                    logger.error(f"[Analytics] poll error: {msg.error()}")
                    continue
                try:
                    envelope   = json.loads(msg.value().decode("utf-8"))
                    topic      = msg.topic() or ""
                    event_type = envelope.get("event") or (
                        topic[len("ecommerce."):] if topic.startswith("ecommerce.") else topic
                    )
                    data       = envelope.get("data", {})
                    future = asyncio.run_coroutine_threadsafe(
                        process_event(event_type, data), main_loop
                    )
                    # 30s ceiling — beyond that the handler is stuck.
                    future.result(timeout=30)
                    consumer.commit(msg, asynchronous=False)
                except Exception as e:
                    logger.error(f"[Analytics] handler error: {e}")
                    try:
                        consumer.commit(msg, asynchronous=False)
                    except Exception as ce:
                        logger.error(f"[Analytics] commit after error: {ce}")

            consumer.close()
            break

        except KafkaException as e:
            logger.error(
                f"[Analytics] Kafka connection {attempt}/{max_retries} "
                f"failed: {e}"
            )
            if attempt < max_retries:
                time.sleep(retry_delay)
            else:
                logger.error("[Analytics] ❌ Giving up on Kafka")
        except Exception as e:
            logger.error(f"[Analytics] unexpected consumer error: {e}")
            if attempt < max_retries:
                time.sleep(retry_delay)
            else:
                break


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# REVENUE ANALYTICS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

_COMPLETED_STATUSES = ('completed', 'shipped', 'delivered')


@app.get("/analytics/revenue/summary")
async def revenue_summary(
    days: int = Query(30, ge=1, le=365, description="Number of days to analyze")
):
    try:
        async with db_pool.acquire() as conn:
            since = datetime.now() - timedelta(days=days)
            summary = await conn.fetchrow(
                """
                SELECT
                    COUNT(*)                            AS total_orders,
                    COALESCE(SUM(total), 0)             AS total_revenue,
                    COALESCE(AVG(total), 0)             AS avg_order_value,
                    COUNT(DISTINCT user_id)             AS unique_customers
                FROM orders
                WHERE created_at >= $1
                  AND status = ANY($2::text[])
                """,
                since, list(_COMPLETED_STATUSES),
            )
            daily = await conn.fetch(
                """
                SELECT
                    DATE(created_at)        AS date,
                    COUNT(*)                AS orders,
                    SUM(total)              AS revenue
                FROM orders
                WHERE created_at >= $1
                  AND status = ANY($2::text[])
                GROUP BY DATE(created_at)
                ORDER BY date DESC
                """,
                since, list(_COMPLETED_STATUSES),
            )
            return {
                "period_days": days,
                "since_date":  since.isoformat(),
                "summary": {
                    "total_revenue":    float(summary['total_revenue']),
                    "total_orders":     summary['total_orders'],
                    "avg_order_value":  float(summary['avg_order_value']),
                    "unique_customers": summary['unique_customers']
                },
                "daily_breakdown": [
                    {
                        "date":    str(row['date']),
                        "orders":  row['orders'],
                        "revenue": float(row['revenue']),
                    }
                    for row in daily
                ],
            }
    except Exception as e:
        logger.error(f"Revenue summary error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/analytics/revenue/by-category")
async def revenue_by_category(days: int = Query(30, ge=1, le=365)):
    try:
        async with db_pool.acquire() as conn:
            since = datetime.now() - timedelta(days=days)
            results = await conn.fetch(
                """
                SELECT
                    COALESCE(oi.product_category, 'uncategorized') AS category,
                    COUNT(DISTINCT o.id) AS orders,
                    SUM(oi.quantity)     AS units_sold,
                    SUM(oi.price * oi.quantity) AS revenue
                FROM orders o
                JOIN order_items oi ON o.id = oi.order_id
                WHERE o.created_at >= $1
                  AND o.status = ANY($2::text[])
                GROUP BY oi.product_category
                ORDER BY revenue DESC
                """,
                since, list(_COMPLETED_STATUSES),
            )
            return {
                "period_days": days,
                "categories": [
                    {
                        "category":   row['category'],
                        "orders":     row['orders'],
                        "units_sold": row['units_sold'],
                        "revenue":    float(row['revenue']),
                    }
                    for row in results
                ],
            }
    except Exception as e:
        logger.error(f"Category revenue error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# CUSTOMER ANALYTICS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@app.get("/analytics/customers/top")
async def top_customers(
    limit: int = Query(10, ge=1, le=100),
    days:  int = Query(30, ge=1, le=365),
):
    try:
        async with db_pool.acquire() as conn:
            since = datetime.now() - timedelta(days=days)
            results = await conn.fetch(
                """
                SELECT
                    u.id,
                    COALESCE(u.email,      o.user_email)      AS email,
                    COALESCE(u.first_name, o.user_first_name) AS first_name,
                    COALESCE(u.last_name,  o.user_last_name)  AS last_name,
                    COUNT(o.id)              AS total_orders,
                    SUM(o.total)             AS total_spent,
                    AVG(o.total)             AS avg_order_value,
                    MAX(o.created_at)        AS last_order_date
                FROM orders o
                LEFT JOIN users u ON u.id = o.user_id
                WHERE o.created_at >= $1
                  AND o.status = ANY($2::text[])
                GROUP BY u.id, o.user_id, email, first_name, last_name
                ORDER BY total_spent DESC NULLS LAST
                LIMIT $3
                """,
                since, list(_COMPLETED_STATUSES), limit,
            )
            return {
                "period_days": days,
                "top_customers": [
                    {
                        "user_id":         row['id'],
                        "email":           row['email'],
                        "name":            f"{row['first_name'] or ''} {row['last_name'] or ''}".strip(),
                        "total_orders":    row['total_orders'],
                        "total_spent":     float(row['total_spent']),
                        "avg_order_value": float(row['avg_order_value']),
                        "last_order_date": row['last_order_date'].isoformat()
                                            if row['last_order_date'] else None,
                    }
                    for row in results
                ],
            }
    except Exception as e:
        logger.error(f"Top customers error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/analytics/customers/lifetime-value")
async def customer_lifetime_value(user_id: int):
    try:
        async with db_pool.acquire() as conn:
            stats = await conn.fetchrow(
                """
                SELECT
                    COUNT(*)        AS total_orders,
                    SUM(total)      AS lifetime_value,
                    AVG(total)      AS avg_order_value,
                    MIN(created_at) AS first_order_date,
                    MAX(created_at) AS last_order_date
                FROM orders
                WHERE user_id = $1
                  AND status = ANY($2::text[])
                """,
                user_id, list(_COMPLETED_STATUSES),
            )
            if not stats or stats['total_orders'] == 0:
                return {
                    "user_id":        user_id,
                    "lifetime_value": 0,
                    "total_orders":   0,
                    "message":        "No completed orders found",
                }
            days_active = (datetime.now() - stats['first_order_date'].replace(tzinfo=None)).days or 1
            return {
                "user_id":          user_id,
                "lifetime_value":   float(stats['lifetime_value']),
                "total_orders":     stats['total_orders'],
                "avg_order_value":  float(stats['avg_order_value']),
                "first_order_date": stats['first_order_date'].isoformat(),
                "last_order_date":  stats['last_order_date'].isoformat(),
                "days_active":      days_active,
                "orders_per_month": round(
                    (stats['total_orders'] / days_active) * 30, 2
                ),
            }
    except Exception as e:
        logger.error(f"CLV error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# PRODUCT ANALYTICS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@app.get("/analytics/products/best-sellers")
async def best_sellers(
    limit: int = Query(10, ge=1, le=100),
    days:  int = Query(30, ge=1, le=365),
):
    try:
        async with db_pool.acquire() as conn:
            since = datetime.now() - timedelta(days=days)
            results = await conn.fetch(
                """
                SELECT
                    p.id,
                    COALESCE(p.name,     MAX(oi.product_name))     AS name,
                    COALESCE(p.category, MAX(oi.product_category)) AS category,
                    COALESCE(p.price, 0) AS current_price,
                    COUNT(DISTINCT o.id) AS orders,
                    SUM(oi.quantity)     AS units_sold,
                    SUM(oi.price * oi.quantity) AS revenue,
                    AVG(p.average_rating)       AS avg_rating
                FROM order_items oi
                JOIN orders o   ON oi.order_id = o.id
                LEFT JOIN products p ON p.id    = oi.product_id
                WHERE o.created_at >= $1
                  AND o.status = ANY($2::text[])
                GROUP BY p.id
                ORDER BY units_sold DESC
                LIMIT $3
                """,
                since, list(_COMPLETED_STATUSES), limit,
            )
            return {
                "period_days": days,
                "best_sellers": [
                    {
                        "product_id":    row['id'],
                        "name":          row['name'],
                        "category":      row['category'],
                        "current_price": float(row['current_price']),
                        "orders":        row['orders'],
                        "units_sold":    row['units_sold'],
                        "revenue":       float(row['revenue']),
                        "avg_rating":    float(row['avg_rating'])
                                         if row['avg_rating'] else 0,
                    }
                    for row in results
                ],
            }
    except Exception as e:
        logger.error(f"Best sellers error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/analytics/products/low-performers")
async def low_performers(days: int = Query(30, ge=1, le=365)):
    try:
        async with db_pool.acquire() as conn:
            since = datetime.now() - timedelta(days=days)
            results = await conn.fetch(
                """
                SELECT
                    p.id,
                    p.name,
                    p.category,
                    p.price,
                    p.stock,
                    COALESCE(SUM(oi.quantity), 0)        AS units_sold,
                    COALESCE(COUNT(DISTINCT o.id), 0)    AS orders
                FROM products p
                LEFT JOIN order_items oi ON p.id = oi.product_id
                LEFT JOIN orders o ON oi.order_id = o.id
                    AND o.created_at >= $1
                    AND o.status = ANY($2::text[])
                GROUP BY p.id
                HAVING COALESCE(SUM(oi.quantity), 0) < 5
                ORDER BY units_sold ASC, p.stock DESC
                """,
                since, list(_COMPLETED_STATUSES),
            )
            return {
                "period_days": days,
                "low_performers": [
                    {
                        "product_id": row['id'],
                        "name":       row['name'],
                        "category":   row['category'],
                        "price":      float(row['price']) if row['price'] else 0,
                        "stock":      row['stock'],
                        "units_sold": row['units_sold'],
                        "orders":     row['orders'],
                    }
                    for row in results
                ],
            }
    except Exception as e:
        logger.error(f"Low performers error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# DASHBOARD STATS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@app.get("/analytics/dashboard")
async def dashboard_stats():
    try:
        async with db_pool.acquire() as conn:
            since_30 = datetime.now() - timedelta(days=30)
            revenue = await conn.fetchrow(
                """
                SELECT
                    COALESCE(SUM(total), 0) AS revenue_30d,
                    COUNT(*)                AS orders_30d,
                    COALESCE(AVG(total), 0) AS avg_order_value
                FROM orders
                WHERE created_at >= $1
                  AND status = ANY($2::text[])
                """,
                since_30, list(_COMPLETED_STATUSES),
            )
            customers = await conn.fetchval(
                "SELECT COUNT(*) FROM users WHERE role = 'user'"
            )
            products = await conn.fetchval("SELECT COUNT(*) FROM products")
            low_stock = await conn.fetchval(
                "SELECT COUNT(*) FROM products WHERE stock < 10"
            )
            return {
                "revenue_30d":     float(revenue['revenue_30d']),
                "orders_30d":      revenue['orders_30d'],
                "avg_order_value": float(revenue['avg_order_value']),
                "total_customers": customers,
                "total_products":  products,
                "low_stock_items": low_stock,
            }
    except Exception as e:
        logger.error(f"Dashboard error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=3013)
