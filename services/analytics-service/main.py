"""
Analytics Service — Port 3013

Provides real-time analytics and reporting:
- Revenue analytics (daily, weekly, monthly)
- Customer analytics (top customers, lifetime value)
- Product analytics (best sellers, category performance)
- Order analytics (average order value, conversion rates)

Tech: FastAPI + PostgreSQL + pandas
"""

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from typing import Optional, List, Dict, Any
from datetime import datetime, timedelta
from decimal import Decimal
import asyncpg
import os
import logging
from prometheus_client import Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST
from starlette.responses import Response

# Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Analytics Service", version="1.0.0")

# Prometheus metrics
REQUEST_COUNT = Counter('http_requests_total', 'Total HTTP requests', ['service', 'method', 'endpoint', 'status'])
REQUEST_LATENCY = Histogram('http_request_duration_seconds', 'HTTP request latency', ['service', 'method', 'endpoint'])

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Prometheus middleware
@app.middleware("http")
async def track_metrics(request, call_next):
    import time
    start_time = time.time()
    response = await call_next(request)
    duration = time.time() - start_time
    
    REQUEST_COUNT.labels("analytics-service", request.method, request.url.path, response.status_code).inc()
    REQUEST_LATENCY.labels("analytics-service", request.method, request.url.path).observe(duration)
    
    return response

# Database connection pool
db_pool = None

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://ecommerce:ecommerce123@postgres:5432/ecommerce"
)


@app.on_event("startup")
async def startup():
    global db_pool
    try:
        db_pool = await asyncpg.create_pool(
            DATABASE_URL,
            min_size=2,
            max_size=10,
            command_timeout=60
        )
        logger.info("✅ Analytics Service connected to PostgreSQL")
    except Exception as e:
        logger.error(f"❌ Database connection failed: {e}")
        raise


@app.on_event("shutdown")
async def shutdown():
    global db_pool
    if db_pool:
        await db_pool.close()
        logger.info("Database pool closed")


@app.get("/health")
async def health():
    """Health check endpoint"""
    try:
        async with db_pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        return {"status": "healthy", "service": "Analytics", "database": "connected"}
    except:
        return {"status": "unhealthy", "service": "Analytics", "database": "disconnected"}


@app.get("/metrics")
async def metrics():
    """Prometheus metrics endpoint"""
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# REVENUE ANALYTICS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@app.get("/analytics/revenue/summary")
async def revenue_summary(
    days: int = Query(30, ge=1, le=365, description="Number of days to analyze")
):
    """
    Get revenue summary for the past N days
    
    Returns:
    - Total revenue
    - Number of orders
    - Average order value
    - Revenue by day
    """
    try:
        async with db_pool.acquire() as conn:
            # Total revenue and orders
            since_date = datetime.now() - timedelta(days=days)
            
            summary = await conn.fetchrow("""
                SELECT 
                    COUNT(*) as total_orders,
                    COALESCE(SUM(total), 0) as total_revenue,
                    COALESCE(AVG(total), 0) as avg_order_value,
                    COUNT(DISTINCT user_id) as unique_customers
                FROM orders
                WHERE created_at >= $1
                  AND status IN ('completed', 'shipped', 'delivered')
            """, since_date)
            
            # Revenue by day
            daily_revenue = await conn.fetch("""
                SELECT 
                    DATE(created_at) as date,
                    COUNT(*) as orders,
                    SUM(total) as revenue
                FROM orders
                WHERE created_at >= $1
                  AND status IN ('completed', 'shipped', 'delivered')
                GROUP BY DATE(created_at)
                ORDER BY date DESC
            """, since_date)
            
            return {
                "period_days": days,
                "since_date": since_date.isoformat(),
                "summary": {
                    "total_revenue": float(summary['total_revenue']),
                    "total_orders": summary['total_orders'],
                    "avg_order_value": float(summary['avg_order_value']),
                    "unique_customers": summary['unique_customers']
                },
                "daily_breakdown": [
                    {
                        "date": str(row['date']),
                        "orders": row['orders'],
                        "revenue": float(row['revenue'])
                    }
                    for row in daily_revenue
                ]
            }
    except Exception as e:
        logger.error(f"Revenue summary error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/analytics/revenue/by-category")
async def revenue_by_category(days: int = Query(30, ge=1, le=365)):
    """Revenue breakdown by product category"""
    try:
        async with db_pool.acquire() as conn:
            since_date = datetime.now() - timedelta(days=days)
            
            results = await conn.fetch("""
                SELECT 
                    p.category,
                    COUNT(DISTINCT o.id) as orders,
                    SUM(oi.quantity) as units_sold,
                    SUM(oi.price * oi.quantity) as revenue
                FROM orders o
                JOIN order_items oi ON o.id = oi.order_id
                JOIN products p ON oi.product_id = p.id
                WHERE o.created_at >= $1
                  AND o.status IN ('completed', 'shipped', 'delivered')
                GROUP BY p.category
                ORDER BY revenue DESC
            """, since_date)
            
            return {
                "period_days": days,
                "categories": [
                    {
                        "category": row['category'],
                        "orders": row['orders'],
                        "units_sold": row['units_sold'],
                        "revenue": float(row['revenue'])
                    }
                    for row in results
                ]
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
    days: int = Query(30, ge=1, le=365)
):
    """Top customers by revenue"""
    try:
        async with db_pool.acquire() as conn:
            since_date = datetime.now() - timedelta(days=days)
            
            results = await conn.fetch("""
                SELECT 
                    u.id,
                    u.email,
                    u.first_name,
                    u.last_name,
                    COUNT(o.id) as total_orders,
                    SUM(o.total) as total_spent,
                    AVG(o.total) as avg_order_value,
                    MAX(o.created_at) as last_order_date
                FROM users u
                JOIN orders o ON u.id = o.user_id
                WHERE o.created_at >= $1
                  AND o.status IN ('completed', 'shipped', 'delivered')
                GROUP BY u.id
                ORDER BY total_spent DESC
                LIMIT $2
            """, since_date, limit)
            
            return {
                "period_days": days,
                "top_customers": [
                    {
                        "user_id": row['id'],
                        "email": row['email'],
                        "name": f"{row['first_name']} {row['last_name']}",
                        "total_orders": row['total_orders'],
                        "total_spent": float(row['total_spent']),
                        "avg_order_value": float(row['avg_order_value']),
                        "last_order_date": row['last_order_date'].isoformat()
                    }
                    for row in results
                ]
            }
    except Exception as e:
        logger.error(f"Top customers error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/analytics/customers/lifetime-value")
async def customer_lifetime_value(user_id: int):
    """Calculate lifetime value for a specific customer"""
    try:
        async with db_pool.acquire() as conn:
            stats = await conn.fetchrow("""
                SELECT 
                    COUNT(*) as total_orders,
                    SUM(total) as lifetime_value,
                    AVG(total) as avg_order_value,
                    MIN(created_at) as first_order_date,
                    MAX(created_at) as last_order_date
                FROM orders
                WHERE user_id = $1
                  AND status IN ('completed', 'shipped', 'delivered')
            """, user_id)
            
            if not stats or stats['total_orders'] == 0:
                return {
                    "user_id": user_id,
                    "lifetime_value": 0,
                    "total_orders": 0,
                    "message": "No completed orders found"
                }
            
            # Calculate days since first order
            days_active = (datetime.now() - stats['first_order_date']).days or 1
            
            return {
                "user_id": user_id,
                "lifetime_value": float(stats['lifetime_value']),
                "total_orders": stats['total_orders'],
                "avg_order_value": float(stats['avg_order_value']),
                "first_order_date": stats['first_order_date'].isoformat(),
                "last_order_date": stats['last_order_date'].isoformat(),
                "days_active": days_active,
                "orders_per_month": round((stats['total_orders'] / days_active) * 30, 2)
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
    days: int = Query(30, ge=1, le=365)
):
    """Top selling products by units and revenue"""
    try:
        async with db_pool.acquire() as conn:
            since_date = datetime.now() - timedelta(days=days)
            
            results = await conn.fetch("""
                SELECT 
                    p.id,
                    p.name,
                    p.category,
                    p.price as current_price,
                    COUNT(DISTINCT o.id) as orders,
                    SUM(oi.quantity) as units_sold,
                    SUM(oi.price * oi.quantity) as revenue,
                    AVG(p.average_rating) as avg_rating
                FROM products p
                JOIN order_items oi ON p.id = oi.product_id
                JOIN orders o ON oi.order_id = o.id
                WHERE o.created_at >= $1
                  AND o.status IN ('completed', 'shipped', 'delivered')
                GROUP BY p.id
                ORDER BY units_sold DESC
                LIMIT $2
            """, since_date, limit)
            
            return {
                "period_days": days,
                "best_sellers": [
                    {
                        "product_id": row['id'],
                        "name": row['name'],
                        "category": row['category'],
                        "current_price": float(row['current_price']),
                        "orders": row['orders'],
                        "units_sold": row['units_sold'],
                        "revenue": float(row['revenue']),
                        "avg_rating": float(row['avg_rating']) if row['avg_rating'] else 0
                    }
                    for row in results
                ]
            }
    except Exception as e:
        logger.error(f"Best sellers error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/analytics/products/low-performers")
async def low_performers(days: int = Query(30, ge=1, le=365)):
    """Products with low sales or no sales"""
    try:
        async with db_pool.acquire() as conn:
            since_date = datetime.now() - timedelta(days=days)
            
            results = await conn.fetch("""
                SELECT 
                    p.id,
                    p.name,
                    p.category,
                    p.price,
                    p.stock,
                    COALESCE(SUM(oi.quantity), 0) as units_sold,
                    COALESCE(COUNT(DISTINCT o.id), 0) as orders
                FROM products p
                LEFT JOIN order_items oi ON p.id = oi.product_id
                LEFT JOIN orders o ON oi.order_id = o.id 
                    AND o.created_at >= $1
                    AND o.status IN ('completed', 'shipped', 'delivered')
                GROUP BY p.id
                HAVING COALESCE(SUM(oi.quantity), 0) < 5
                ORDER BY units_sold ASC, p.stock DESC
            """, since_date)
            
            return {
                "period_days": days,
                "low_performers": [
                    {
                        "product_id": row['id'],
                        "name": row['name'],
                        "category": row['category'],
                        "price": float(row['price']),
                        "stock": row['stock'],
                        "units_sold": row['units_sold'],
                        "orders": row['orders']
                    }
                    for row in results
                ]
            }
    except Exception as e:
        logger.error(f"Low performers error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# DASHBOARD STATS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@app.get("/analytics/dashboard")
async def dashboard_stats():
    """Overview dashboard statistics"""
    try:
        async with db_pool.acquire() as conn:
            # Last 30 days stats
            since_30 = datetime.now() - timedelta(days=30)
            
            # Revenue
            revenue = await conn.fetchrow("""
                SELECT 
                    COALESCE(SUM(total), 0) as revenue_30d,
                    COUNT(*) as orders_30d,
                    COALESCE(AVG(total), 0) as avg_order_value
                FROM orders
                WHERE created_at >= $1
                  AND status IN ('completed', 'shipped', 'delivered')
            """, since_30)
            
            # Total customers
            customers = await conn.fetchval("""
                SELECT COUNT(*) FROM users WHERE role = 'user'
            """)
            
            # Total products
            products = await conn.fetchval("SELECT COUNT(*) FROM products")
            
            # Low stock items
            low_stock = await conn.fetchval("""
                SELECT COUNT(*) FROM products WHERE stock < 10
            """)
            
            return {
                "revenue_30d": float(revenue['revenue_30d']),
                "orders_30d": revenue['orders_30d'],
                "avg_order_value": float(revenue['avg_order_value']),
                "total_customers": customers,
                "total_products": products,
                "low_stock_items": low_stock
            }
    except Exception as e:
        logger.error(f"Dashboard error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=3013)
