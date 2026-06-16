"""
Recommendation Service — Port 3014

Maintains a read-side projection of products + order history populated
entirely from Kafka events. Owns its own `recommendation_db` under
the database-per-service split. NO cross-service SQL is performed —
every query reads from local projection tables only.

Endpoints (unchanged contract):
  GET  /recommendations/collaborative/{product_id}    (users-also-bought)
  GET  /recommendations/similar/{product_id}          (content-based)
  GET  /recommendations/trending                      (popularity-based)
  GET  /recommendations/for-user/{user_id}            (personalized)
  POST /recommendations/track-view                    (Redis sorted-set)
  GET  /recommendations/recently-viewed/{user_id}     (Redis + projection)

Projection tables (created at startup, idempotent):
  - products        (id, name, description, category, brand, price,
                     stock, images, average_rating, total_reviews, created_at)
  - orders          (id, user_id, status, created_at)
  - order_items     (id, order_id, product_id, quantity, price, created_at)

Event → projection table mapping:
  product.created   → products INSERT
  product.updated   → products UPDATE
  product.deleted   → products DELETE
  order.created     → orders + order_items INSERT
  order.status_updated → orders UPDATE status

Tech: FastAPI + asyncpg + Redis + confluent-kafka
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
from prometheus_client import Counter as PromCounter, Histogram, generate_latest, CONTENT_TYPE_LATEST
from redis import asyncio as aioredis
from starlette.responses import Response

from shared_logger import setup_logging, RequestContextMiddleware


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Recommendation Service", version="2.0.0")

# Structured logging — every line is JSON with service + request_id
_svc_logger = setup_logging('recommendation-service')
app.add_middleware(RequestContextMiddleware, service_name='recommendation-service')

# Prometheus metrics
REQUEST_COUNT = PromCounter('http_requests_total', 'Total HTTP requests',
                            ['service', 'method', 'endpoint', 'status'])
REQUEST_LATENCY = Histogram('http_request_duration_seconds',
                            'HTTP request latency',
                            ['service', 'method', 'endpoint'])
EVENTS_CONSUMED = PromCounter('recommendation_events_consumed_total',
                              'Kafka events applied to the projection',
                              ['event_type'])

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def track_metrics(request, call_next):
    start_time = time.time()
    response = await call_next(request)
    duration = time.time() - start_time
    REQUEST_COUNT.labels("recommendation-service", request.method,
                         request.url.path, response.status_code).inc()
    REQUEST_LATENCY.labels("recommendation-service", request.method,
                           request.url.path).observe(duration)
    return response


# ─── Connection / config ────────────────────────────────────────────
db_pool: Optional[asyncpg.Pool] = None
redis_client = None
main_loop: Optional[asyncio.AbstractEventLoop] = None

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://ecommerce:ecommerce123@postgres:5432/recommendation_db"
)
REDIS_URL = os.getenv(
    "REDIS_URL",
    "redis://:some-default-password-here@redis:6379"
)
KAFKA_BROKERS = os.environ.get("KAFKA_BROKERS", "kafka:9092")
SERVICE_NAME  = os.environ.get("SERVICE_NAME", "recommendation-service")

KAFKA_TOPICS = [
    "ecommerce.product.created",
    "ecommerce.product.updated",
    "ecommerce.product.deleted",
    "ecommerce.order.created",
    "ecommerce.order.status_updated",
]


PROJECTION_SCHEMA = "recommendation"

PROJECTION_DDL = f"""
CREATE SCHEMA IF NOT EXISTS {PROJECTION_SCHEMA};

CREATE TABLE IF NOT EXISTS {PROJECTION_SCHEMA}.products (
    id              INTEGER PRIMARY KEY,
    name            VARCHAR(255),
    description     TEXT,
    category        VARCHAR(100),
    brand           VARCHAR(100),
    price           NUMERIC(12,2),
    stock           INTEGER DEFAULT 0,
    images          JSONB,
    average_rating  NUMERIC(3,2) DEFAULT 0,
    total_reviews   INTEGER DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_r_products_category ON {PROJECTION_SCHEMA}.products(category);
CREATE INDEX IF NOT EXISTS idx_r_products_stock    ON {PROJECTION_SCHEMA}.products(stock);

CREATE TABLE IF NOT EXISTS {PROJECTION_SCHEMA}.orders (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER,
    status      VARCHAR(30),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_r_orders_user_id     ON {PROJECTION_SCHEMA}.orders(user_id);
CREATE INDEX IF NOT EXISTS idx_r_orders_status      ON {PROJECTION_SCHEMA}.orders(status);
CREATE INDEX IF NOT EXISTS idx_r_orders_created_at  ON {PROJECTION_SCHEMA}.orders(created_at);

CREATE TABLE IF NOT EXISTS {PROJECTION_SCHEMA}.order_items (
    id           SERIAL PRIMARY KEY,
    order_id     INTEGER NOT NULL,
    product_id   INTEGER,
    quantity     INTEGER,
    price        NUMERIC(12,2),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(order_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_r_order_items_order_id   ON {PROJECTION_SCHEMA}.order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_r_order_items_product_id ON {PROJECTION_SCHEMA}.order_items(product_id);
"""


_COMPLETED_STATUSES = ('completed', 'shipped', 'delivered')


@app.on_event("startup")
async def startup():
    global db_pool, redis_client, main_loop
    main_loop = asyncio.get_event_loop()

    try:
        async def _init_conn(conn):
            await conn.execute(
                f'SET search_path = {PROJECTION_SCHEMA}, public'
            )
        db_pool = await asyncpg.create_pool(
            DATABASE_URL, min_size=2, max_size=10, command_timeout=60,
            setup=_init_conn,
        )
        logger.info("✅ Recommendation Service connected to PostgreSQL")
    except Exception as e:
        logger.error(f"❌ PostgreSQL connection failed: {e}")
        raise

    try:
        redis_client = aioredis.from_url(REDIS_URL, decode_responses=True)
        await redis_client.ping()
        logger.info("✅ Recommendation Service connected to Redis")
    except Exception as e:
        logger.error(f"❌ Redis connection failed: {e}")
        raise

    async with db_pool.acquire() as conn:
        await conn.execute(PROJECTION_DDL)
    logger.info("✅ Projection tables ensured")

    # Backfill from canonical tables on first run (transitional).
    await backfill_projection()

    threading.Thread(target=start_kafka_consumer, daemon=True).start()


@app.on_event("shutdown")
async def shutdown():
    if db_pool:
        await db_pool.close()
    if redis_client:
        await redis_client.close()


async def backfill_projection():
    """Seed projection from canonical tables on first run. Idempotent.
    Skips any table that already has rows. Removed once the physical
    DB split is complete.
    """
    async with db_pool.acquire() as conn:
        # products: public.images is text[] — cast to jsonb via array_to_json
        n = await conn.fetchval(f"SELECT COUNT(*) FROM {PROJECTION_SCHEMA}.products")
        if n == 0:
            await conn.execute(
                f"""
                INSERT INTO {PROJECTION_SCHEMA}.products
                  (id, name, description, category, brand, price, stock,
                   images, average_rating, total_reviews, created_at)
                SELECT id, name, description, category, brand, price,
                       COALESCE(stock, 0),
                       to_jsonb(images),
                       COALESCE(average_rating, 0),
                       COALESCE(total_reviews, 0),
                       COALESCE(created_at, NOW())
                FROM public.products
                ON CONFLICT (id) DO NOTHING
                """
            )
            logger.info(f"Backfilled {PROJECTION_SCHEMA}.products")

        n = await conn.fetchval(f"SELECT COUNT(*) FROM {PROJECTION_SCHEMA}.orders")
        if n == 0:
            await conn.execute(
                f"""
                INSERT INTO {PROJECTION_SCHEMA}.orders (id, user_id, status, created_at)
                SELECT id, user_id, status, COALESCE(created_at, NOW())
                FROM public.orders
                ON CONFLICT (id) DO NOTHING
                """
            )
            await conn.execute(
                f"""
                INSERT INTO {PROJECTION_SCHEMA}.order_items
                  (order_id, product_id, quantity, price)
                SELECT order_id, product_id, quantity, price
                FROM public.order_items
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
        await redis_client.ping()
        return {
            "status":   "healthy",
            "service":  "Recommendations",
            "database": "connected",
            "redis":    "connected",
        }
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        return {"status": "unhealthy", "service": "Recommendations", "error": str(e)}


@app.get("/metrics")
async def metrics():
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# PROJECTION HANDLERS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def _parse_ts(raw) -> Optional[datetime]:
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


def _images_json(value) -> Optional[str]:
    """asyncpg's JSONB column accepts a JSON-encoded string. Tolerate
    either a Python list/dict (encode it) or an already-encoded string.
    """
    if value is None:
        return None
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value)
    except Exception:
        return None


async def apply_product_upsert(data: Dict[str, Any]):
    pid = data.get("productId") or data.get("id")
    if not pid:
        return
    async with db_pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO products
              (id, name, description, category, brand, price, stock, images,
               average_rating, total_reviews, created_at)
            VALUES
              ($1, $2, $3, $4, $5, $6, COALESCE($7, 0), $8::jsonb,
               COALESCE($9, 0), COALESCE($10, 0), COALESCE($11, NOW()))
            ON CONFLICT (id) DO UPDATE SET
                name           = EXCLUDED.name,
                description    = EXCLUDED.description,
                category       = EXCLUDED.category,
                brand          = EXCLUDED.brand,
                price          = EXCLUDED.price,
                stock          = EXCLUDED.stock,
                images         = COALESCE(EXCLUDED.images, products.images),
                average_rating = EXCLUDED.average_rating,
                total_reviews  = EXCLUDED.total_reviews
            """,
            int(pid),
            data.get("name"),
            data.get("description"),
            data.get("category"),
            data.get("brand"),
            data.get("price"),
            data.get("stock"),
            _images_json(data.get("images")),
            data.get("averageRating") or data.get("average_rating"),
            data.get("totalReviews")  or data.get("total_reviews"),
            _parse_ts(data.get("createdAt") or data.get("created_at")),
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
            INSERT INTO orders (id, user_id, status, created_at)
            VALUES ($1, $2, COALESCE($3,'pending'), COALESCE($4, NOW()))
            ON CONFLICT (id) DO UPDATE SET
                user_id    = EXCLUDED.user_id,
                status     = EXCLUDED.status,
                created_at = EXCLUDED.created_at
            """,
            int(oid),
            data.get("userId") or data.get("user_id"),
            data.get("status"),
            _parse_ts(data.get("createdAt") or data.get("created_at")),
        )
        for it in items:
            pid = it.get("productId") or it.get("product_id")
            if not pid:
                continue
            await conn.execute(
                """
                INSERT INTO order_items (order_id, product_id, quantity, price)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (order_id, product_id) DO UPDATE SET
                    quantity = EXCLUDED.quantity,
                    price    = EXCLUDED.price
                """,
                int(oid),
                int(pid),
                it.get("quantity"),
                it.get("price"),
            )


async def apply_order_status_updated(data: Dict[str, Any]):
    oid = data.get("orderId") or data.get("id")
    new_status = data.get("status")
    if not oid or not new_status:
        return
    async with db_pool.acquire() as conn:
        await conn.execute(
            "UPDATE orders SET status = $2 WHERE id = $1", int(oid), new_status
        )


EVENT_DISPATCH = {
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
        logger.error(f"[Recommendation] failed to apply {event_type}: {e}")


# ─── Kafka consumer (background thread) ─────────────────────────────
def start_kafka_consumer():
    max_retries = 20
    retry_delay = 5

    for attempt in range(1, max_retries + 1):
        try:
            logger.info(
                f"[Recommendation] Attempting Kafka connection "
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
                f"✅ Recommendation consumer subscribed to "
                f"{len(KAFKA_TOPICS)} topics"
            )

            while True:
                msg = consumer.poll(timeout=1.0)
                if msg is None:
                    continue
                if msg.error():
                    if msg.error().code() == KafkaError._PARTITION_EOF:
                        continue
                    logger.error(f"[Recommendation] poll error: {msg.error()}")
                    continue
                try:
                    envelope   = json.loads(msg.value().decode("utf-8"))
                    topic      = msg.topic() or ""
                    event_type = envelope.get("event") or (
                        topic[len("ecommerce."):]
                        if topic.startswith("ecommerce.") else topic
                    )
                    data       = envelope.get("data", {})
                    future = asyncio.run_coroutine_threadsafe(
                        process_event(event_type, data), main_loop
                    )
                    future.result(timeout=30)
                    consumer.commit(msg, asynchronous=False)
                except Exception as e:
                    logger.error(f"[Recommendation] handler error: {e}")
                    try:
                        consumer.commit(msg, asynchronous=False)
                    except Exception as ce:
                        logger.error(f"[Recommendation] commit after error: {ce}")

            consumer.close()
            break

        except KafkaException as e:
            logger.error(
                f"[Recommendation] Kafka connection {attempt}/{max_retries} "
                f"failed: {e}"
            )
            if attempt < max_retries:
                time.sleep(retry_delay)
            else:
                logger.error("[Recommendation] ❌ Giving up on Kafka")
        except Exception as e:
            logger.error(f"[Recommendation] unexpected consumer error: {e}")
            if attempt < max_retries:
                time.sleep(retry_delay)
            else:
                break


# Helper used by recommendations endpoints to materialise a product row
# into the JSON shape clients already consume.
def _product_payload(row, extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    out = {
        "id":             row['id'],
        "name":           row['name'],
        "description":    row['description'],
        "price":          float(row['price']) if row['price'] is not None else 0,
        "category":       row['category'],
        "images":         row['images'],
        "average_rating": float(row['average_rating']) if row['average_rating'] else 0,
        "stock":          row['stock'],
    }
    if extra:
        out.update(extra)
    return out


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# COLLABORATIVE FILTERING
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@app.get("/recommendations/collaborative/{product_id}")
async def collaborative_recommendations(
    product_id: int,
    limit: int = Query(6, ge=1, le=20)
):
    """Users who bought this product also bought…"""
    try:
        async with db_pool.acquire() as conn:
            user_orders = await conn.fetch(
                """
                SELECT DISTINCT o.user_id
                FROM orders o
                JOIN order_items oi ON o.id = oi.order_id
                WHERE oi.product_id = $1
                  AND o.status = ANY($2::text[])
                """,
                product_id, list(_COMPLETED_STATUSES),
            )
            if not user_orders:
                return {"product_id": product_id, "recommendations": []}

            user_ids = [row['user_id'] for row in user_orders if row['user_id'] is not None]
            if not user_ids:
                return {"product_id": product_id, "recommendations": []}

            related = await conn.fetch(
                """
                SELECT
                    p.id, p.name, p.description, p.price, p.category,
                    p.images, p.average_rating, p.stock,
                    COUNT(DISTINCT o.user_id) AS co_purchase_count
                FROM products p
                JOIN order_items oi ON p.id = oi.product_id
                JOIN orders o       ON oi.order_id = o.id
                WHERE o.user_id = ANY($1::int[])
                  AND o.status  = ANY($2::text[])
                  AND p.id != $3
                  AND p.stock > 0
                GROUP BY p.id
                ORDER BY co_purchase_count DESC, p.average_rating DESC
                LIMIT $4
                """,
                user_ids, list(_COMPLETED_STATUSES), product_id, limit,
            )
            return {
                "product_id": product_id,
                "algorithm":  "collaborative_filtering",
                "recommendations": [
                    _product_payload(r, {"relevance_score": r['co_purchase_count']})
                    for r in related
                ],
            }
    except Exception as e:
        logger.error(f"Collaborative recommendations error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# CONTENT-BASED FILTERING
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@app.get("/recommendations/similar/{product_id}")
async def similar_products(
    product_id: int,
    limit: int = Query(6, ge=1, le=20)
):
    """Find similar products based on category, price range, rating."""
    try:
        async with db_pool.acquire() as conn:
            source = await conn.fetchrow(
                "SELECT category, price, average_rating FROM products WHERE id = $1",
                product_id,
            )
            if not source:
                raise HTTPException(status_code=404, detail="Product not found")

            similar = await conn.fetch(
                """
                SELECT
                    id, name, description, price, category, images,
                    average_rating, stock,
                    ABS(price - $2) AS price_diff
                FROM products
                WHERE category = $1
                  AND id != $3
                  AND stock > 0
                ORDER BY price_diff ASC, average_rating DESC
                LIMIT $4
                """,
                source['category'],
                float(source['price']) if source['price'] is not None else 0,
                product_id, limit,
            )
            return {
                "product_id": product_id,
                "algorithm":  "content_based_filtering",
                "recommendations": [_product_payload(r) for r in similar],
            }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Similar products error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# TRENDING PRODUCTS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@app.get("/recommendations/trending")
async def trending_products(
    days:  int = Query(7,  ge=1, le=30),
    limit: int = Query(10, ge=1, le=50),
):
    """Trending products based on recent orders."""
    try:
        async with db_pool.acquire() as conn:
            since = datetime.now() - timedelta(days=days)
            results = await conn.fetch(
                """
                SELECT
                    p.id, p.name, p.description, p.price, p.category,
                    p.images, p.average_rating, p.stock,
                    COUNT(DISTINCT o.id) AS order_count,
                    SUM(oi.quantity)     AS units_sold
                FROM products p
                JOIN order_items oi ON p.id = oi.product_id
                JOIN orders o       ON oi.order_id = o.id
                WHERE o.created_at >= $1
                  AND o.status = ANY($2::text[])
                  AND p.stock > 0
                GROUP BY p.id
                ORDER BY units_sold DESC, order_count DESC
                LIMIT $3
                """,
                since, list(_COMPLETED_STATUSES), limit,
            )
            return {
                "period_days": days,
                "trending": [
                    _product_payload(r, {
                        "order_count": r['order_count'],
                        "units_sold":  r['units_sold'],
                    })
                    for r in results
                ],
            }
    except Exception as e:
        logger.error(f"Trending products error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# PERSONALIZED RECOMMENDATIONS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@app.get("/recommendations/for-user/{user_id}")
async def recommendations_for_user(
    user_id: int,
    limit: int = Query(10, ge=1, le=50),
):
    """Personalized recommendations for a user from their order history."""
    try:
        async with db_pool.acquire() as conn:
            history = await conn.fetch(
                """
                SELECT DISTINCT p.category, oi.product_id
                FROM orders o
                JOIN order_items oi ON o.id = oi.order_id
                JOIN products p     ON oi.product_id = p.id
                WHERE o.user_id = $1
                  AND o.status  = ANY($2::text[])
                """,
                user_id, list(_COMPLETED_STATUSES),
            )

            if not history:
                # Cold-start fallback — fall through to trending.
                trending = await trending_products(days=7, limit=limit)
                return {
                    "user_id":         user_id,
                    "algorithm":       "trending_fallback",
                    "recommendations": trending['trending'],
                }

            purchased_ids = [row['product_id'] for row in history if row['product_id']]
            categories    = list({row['category'] for row in history if row['category']})

            if not categories:
                trending = await trending_products(days=7, limit=limit)
                return {
                    "user_id":         user_id,
                    "algorithm":       "trending_fallback",
                    "recommendations": trending['trending'],
                }

            results = await conn.fetch(
                """
                SELECT id, name, description, price, category, images,
                       average_rating, stock
                FROM products
                WHERE category = ANY($1::text[])
                  AND id != ALL($2::int[])
                  AND stock > 0
                ORDER BY average_rating DESC, total_reviews DESC
                LIMIT $3
                """,
                categories, purchased_ids or [-1], limit,
            )
            return {
                "user_id":             user_id,
                "algorithm":           "personalized_category_based",
                "favorite_categories": categories,
                "recommendations":     [_product_payload(r) for r in results],
            }
    except Exception as e:
        logger.error(f"User recommendations error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# RECENTLY VIEWED (Redis-backed)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@app.post("/recommendations/track-view")
async def track_product_view(user_id: int, product_id: int):
    """Track a user view in Redis (sorted set, 30-day TTL, cap 50)."""
    try:
        key = f"viewed:{user_id}"
        await redis_client.zadd(key, {str(product_id): datetime.now().timestamp()})
        await redis_client.zremrangebyrank(key, 0, -51)
        await redis_client.expire(key, 30 * 24 * 60 * 60)
        return {"status": "tracked", "user_id": user_id, "product_id": product_id}
    except Exception as e:
        logger.error(f"Track view error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/recommendations/recently-viewed/{user_id}")
async def recently_viewed(user_id: int, limit: int = Query(10, ge=1, le=50)):
    """Recently viewed product list (Redis order, hydrated from projection)."""
    try:
        key = f"viewed:{user_id}"
        product_ids_raw = await redis_client.zrevrange(key, 0, limit - 1)
        if not product_ids_raw:
            return {"user_id": user_id, "recently_viewed": []}

        product_ids = [int(pid) for pid in product_ids_raw]
        async with db_pool.acquire() as conn:
            results = await conn.fetch(
                """
                SELECT id, name, description, price, category, images,
                       average_rating, stock
                FROM products
                WHERE id = ANY($1::int[])
                """,
                product_ids,
            )
            row_by_id = {row['id']: row for row in results}
            ordered = [row_by_id[pid] for pid in product_ids if pid in row_by_id]
            return {
                "user_id": user_id,
                "recently_viewed": [_product_payload(r) for r in ordered],
            }
    except Exception as e:
        logger.error(f"Recently viewed error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=3014)
