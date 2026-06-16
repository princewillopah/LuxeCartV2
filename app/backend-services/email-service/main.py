"""
Email Service — Port 3015

Sends transactional emails via SendGrid (or SMTP fallback):
- Welcome emails (user.registered)
- Order confirmations (order.created)
- Payment receipts (payment.completed)
- Shipping notifications (order.status_updated)

Tech: FastAPI + MongoDB + Celery + Jinja2 templates
Storage: MongoDB for email logs and templates
"""

from fastapi import FastAPI, HTTPException, BackgroundTasks
from shared_logger import setup_logging, RequestContextMiddleware

from fastapi.middleware.cors import CORSMiddleware
from typing import Optional, Dict, Any
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import MongoClient
from datetime import datetime
import os
import logging
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from jinja2 import Template
from confluent_kafka import Consumer, KafkaError, KafkaException
import json
import asyncio
import threading
import time
from prometheus_client import Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST
from starlette.responses import Response

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Email Service", version="1.0.0")


# Structured logging — every line is JSON with service + request_id
_svc_logger = setup_logging('email-service')
app.add_middleware(RequestContextMiddleware, service_name='email-service')

# Prometheus metrics
REQUEST_COUNT = Counter('http_requests_total', 'Total HTTP requests', ['service', 'method', 'endpoint', 'status'])
REQUEST_LATENCY = Histogram('http_request_duration_seconds', 'HTTP request latency', ['service', 'method', 'endpoint'])
EMAIL_SENT = Counter('emails_sent_total', 'Total emails sent', ['type'])

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
    start_time = time.time()
    response = await call_next(request)
    duration = time.time() - start_time
    
    REQUEST_COUNT.labels("email-service", request.method, request.url.path, response.status_code).inc()
    REQUEST_LATENCY.labels("email-service", request.method, request.url.path).observe(duration)
    
    return response

# MongoDB connection
mongo_client = None
db = None
# Sync client used by the RabbitMQ consumer (which runs in its own thread/loop
# and therefore can't safely share the asyncio motor client).
sync_mongo_client = None
sync_db = None

# # Email configuration
# # SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
# SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
# # SMTP_USER = os.getenv("SMTP_USER", "noreply@luxecart.com")
# # SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")  # Set in production
# FROM_EMAIL = os.getenv("FROM_EMAIL", "LuxeCart <noreply@luxecart.com>")


# RABBITMQ_URL = os.environ["RABBITMQ_URL"]
# MONGODB_URL = os.environ["MONGODB_URL"]

# SMTP_HOST = os.environ["SMTP_HOST"]
# SMTP_USER = os.environ["SMTP_USER"]
# SMTP_PASSWORD = os.environ["SMTP_PASSWORD"]

SMTP_HOST = os.environ["SMTP_HOST"]
SMTP_PORT = int(os.environ["SMTP_PORT"])
SMTP_USER = os.environ["SMTP_USER"]
SMTP_PASSWORD = os.environ["SMTP_PASSWORD"]

FROM_EMAIL = os.getenv("FROM_EMAIL", "LuxeCart <noreply@luxecart.com>")
FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:18081").rstrip("/")

MONGODB_URL = os.environ["MONGODB_URL"]
# Kafka migration — replaces the previous RABBITMQ_URL. Comma-separated
# broker list (e.g. "kafka1:9092,kafka2:9092"). SERVICE_NAME is used both
# as the Kafka clientId and as the consumer-group prefix so this service
# owns its own offsets across restarts.
KAFKA_BROKERS = os.environ["KAFKA_BROKERS"]
SERVICE_NAME = os.getenv("SERVICE_NAME", "email-service")


@app.on_event("startup")
async def startup():
    global mongo_client, db, sync_mongo_client, sync_db

    # MongoDB (async, for HTTP routes)
    try:
        mongo_client = AsyncIOMotorClient(MONGODB_URL)
        db = mongo_client.ecommerce
        await db.command("ping")
        logger.info("✅ Email Service connected to MongoDB")

        # Create indexes
        await db.email_logs.create_index("user_id")
        await db.email_logs.create_index("created_at")
        await db.email_logs.create_index([("user_id", 1), ("type", 1)])
    except Exception as e:
        logger.error(f"❌ MongoDB connection failed: {e}")
        # Continue anyway — emails can still work without MongoDB

    # Sync client used by send_email (consumer thread + HTTP both call it)
    try:
        sync_mongo_client = MongoClient(MONGODB_URL, serverSelectionTimeoutMS=3000)
        sync_db = sync_mongo_client.ecommerce
        sync_db.command("ping")
    except Exception as e:
        logger.error(f"❌ MongoDB sync connection failed: {e}")

    # Start Kafka consumer in background thread (mirrors the previous
    # pika setup — sync client running in its own loop, dispatching each
    # event to process_event() via asyncio.run()).
    threading.Thread(target=start_kafka_consumer, daemon=True).start()


@app.on_event("shutdown")
async def shutdown():
    if mongo_client:
        mongo_client.close()


@app.get("/health")
async def health():
    try:
        if mongo_client:
            await db.command("ping")
            return {"status": "healthy", "service": "Email", "mongodb": "connected"}
        return {"status": "healthy", "service": "Email", "mongodb": "not configured"}
    except:
        return {"status": "degraded", "service": "Email", "mongodb": "disconnected"}


@app.get("/metrics")
async def metrics():
    """Prometheus metrics endpoint"""
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# EMAIL TEMPLATES (Jinja2)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

TEMPLATES = {
    "welcome": Template("""
<!DOCTYPE html>
<html>
<head><style>
body { font-family: Arial, sans-serif; background: #f7fafc; padding: 20px; }
.container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; }
h1 { color: #7c3aed; margin-bottom: 20px; }
p { color: #4a5568; line-height: 1.6; }
.button { display: inline-block; background: #7c3aed; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 20px; }
.footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; color: #a0aec0; font-size: 14px; }
</style></head>
<body>
<div class="container">
  <h1>Welcome to LuxeCart! 🎉</h1>
  <p>Hi {{ firstName }},</p>
  <p>Thank you for joining LuxeCart. We're excited to have you as part of our community!</p>
  <p>Start exploring our curated collection of premium products designed for refined tastes.</p>
  <a href="{{ frontend_url }}/products" class="button">Start Shopping</a>
  <div class="footer">
    <p>If you have any questions, reply to this email or contact support@luxecart.com</p>
    <p>&copy; 2026 LuxeCart. All rights reserved.</p>
  </div>
</div>
</body>
</html>
    """),
    
    "order_confirmation": Template("""
<!DOCTYPE html>
<html>
<head><style>
body { font-family: Arial, sans-serif; background: #f7fafc; padding: 20px; }
.container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; }
h1 { color: #10b981; margin-bottom: 10px; }
.order-id { color: #7c3aed; font-size: 18px; font-weight: 600; margin-bottom: 20px; }
table { width: 100%; border-collapse: collapse; margin: 20px 0; }
th, td { padding: 12px; text-align: left; border-bottom: 1px solid #e2e8f0; }
th { background: #f7fafc; font-weight: 600; }
.total { font-size: 20px; font-weight: 600; color: #2d3748; }
.footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; color: #a0aec0; font-size: 14px; }
</style></head>
<body>
<div class="container">
  <h1>Order Confirmed! ✅</h1>
  <p class="order-id">Order #{{ orderId }}</p>
  <p>Hi {{ firstName }},</p>
  <p>Thank you for your order! We're processing it and will send you a shipping notification soon.</p>
  
  <h3>Order Summary</h3>
  <table>
    <thead><tr><th>Product</th><th>Qty</th><th>Price</th></tr></thead>
    <tbody>
    {% for item in items %}
    <tr>
      <td>{{ item.name }}</td>
      <td>{{ item.quantity }}</td>
      <td>${{ "%.2f"|format(item.price) }}</td>
    </tr>
    {% endfor %}
    </tbody>
  </table>
  
  <p class="total">Total: ${{ "%.2f"|format(total) }}</p>
  
  <div class="footer">
    <p>Track your order at <a href="{{ frontend_url }}/account/orders">{{ frontend_url }}/account/orders</a></p>
    <p>&copy; 2026 LuxeCart</p>
  </div>
</div>
</body>
</html>
    """),
    
    "payment_success": Template("""
<!DOCTYPE html>
<html>
<head><style>
body { font-family: Arial, sans-serif; background: #f7fafc; padding: 20px; }
.container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; }
h1 { color: #10b981; margin-bottom: 20px; }
.receipt { background: #f7fafc; padding: 20px; border-radius: 6px; margin: 20px 0; }
.receipt p { margin: 8px 0; color: #4a5568; }
.footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; color: #a0aec0; font-size: 14px; }
</style></head>
<body>
<div class="container">
  <h1>Payment Successful! 💳</h1>
  <p>Your payment of <strong>${{ "%.2f"|format(amount) }}</strong> for Order #{{ orderId }} has been processed successfully.</p>
  
  <div class="receipt">
    <p><strong>Transaction ID:</strong> {{ transactionId }}</p>
    <p><strong>Amount:</strong> ${{ "%.2f"|format(amount) }}</p>
    <p><strong>Payment Method:</strong> {{ method }}</p>
    <p><strong>Date:</strong> {{ date }}</p>
  </div>
  
  <p>Your order is being prepared for shipment.</p>
  
  <div class="footer">
    <p>&copy; 2026 LuxeCart</p>
  </div>
</div>
</body>
</html>
    """),
    
    "payment_failed": Template("""
<!DOCTYPE html>
<html>
<head><style>
body { font-family: Arial, sans-serif; background: #f7fafc; padding: 20px; }
.container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; }
h1 { color: #ef4444; margin-bottom: 20px; }
.alert { background: #fef2f2; border-left: 4px solid #ef4444; padding: 16px; margin: 20px 0; }
.button { display: inline-block; background: #7c3aed; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 20px; }
.footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; color: #a0aec0; font-size: 14px; }
</style></head>
<body>
<div class="container">
  <h1>Payment Failed ❌</h1>
  <div class="alert">
    <p>We were unable to process your payment of ${{ "%.2f"|format(amount) }} for Order #{{ orderId }}.</p>
    <p><strong>Reason:</strong> {{ reason }}</p>
  </div>
  <p>Please check your payment details and try again, or use a different payment method.</p>
  <a href="{{ frontend_url }}/account/orders" class="button">Retry Payment</a>
  <div class="footer">
    <p>If you need assistance, contact support@luxecart.com</p>
    <p>&copy; 2026 LuxeCart</p>
  </div>
</div>
</body>
</html>
    """),
    
    "order_shipped": Template("""
<!DOCTYPE html>
<html>
<head><style>
body { font-family: Arial, sans-serif; background: #f7fafc; padding: 20px; }
.container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; }
h1 { color: #7c3aed; margin-bottom: 20px; }
.tracking { background: #ede9fe; padding: 20px; border-radius: 6px; margin: 20px 0; text-align: center; }
.tracking-number { font-size: 24px; font-weight: 600; color: #7c3aed; }
.footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; color: #a0aec0; font-size: 14px; }
</style></head>
<body>
<div class="container">
  <h1>Your Order Has Shipped! 🚚</h1>
  <p>Good news! Order #{{ orderId }} is on its way to you.</p>
  <div class="tracking">
    <p>Tracking Number</p>
    <p class="tracking-number">{{ trackingNumber }}</p>
  </div>
  <p>You can expect delivery within 3-5 business days.</p>
  <div class="footer">
    <p>&copy; 2026 LuxeCart</p>
  </div>
</div>
</body>
</html>
    """),

    "order_delivered": Template("""
<!DOCTYPE html>
<html>
<head><style>
body { font-family: Arial, sans-serif; background: #f7fafc; padding: 20px; }
.container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; }
h1 { color: #10b981; margin-bottom: 20px; }
.button { display: inline-block; background: #7c3aed; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 20px; }
.footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; color: #a0aec0; font-size: 14px; }
</style></head>
<body>
<div class="container">
  <h1>Delivered ✅</h1>
  <p>Hi {{ firstName }},</p>
  <p>Order <strong>#{{ orderId }}</strong> has been delivered. We hope you love it!</p>
  <p>If anything's wrong, you have <strong>30 days</strong> to start a free return.</p>
  <a href="{{ frontend_url }}/account/orders" class="button">View order</a>
  <div class="footer">
    <p>Loved your purchase? <a href="{{ frontend_url }}/products">Leave a review</a>.</p>
    <p>&copy; 2026 LuxeCart</p>
  </div>
</div>
</body>
</html>
    """),

    "order_cancelled": Template("""
<!DOCTYPE html>
<html>
<head><style>
body { font-family: Arial, sans-serif; background: #f7fafc; padding: 20px; }
.container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; }
h1 { color: #ef4444; margin-bottom: 20px; }
.alert { background: #fef2f2; border-left: 4px solid #ef4444; padding: 16px; margin: 20px 0; }
.button { display: inline-block; background: #7c3aed; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 20px; }
.footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; color: #a0aec0; font-size: 14px; }
</style></head>
<body>
<div class="container">
  <h1>Order Cancelled</h1>
  <p>Hi {{ firstName }},</p>
  <div class="alert">
    <p>Your order <strong>#{{ orderId }}</strong> has been cancelled.</p>
    <p>Any authorized payment will be refunded within 5-10 business days.</p>
  </div>
  <a href="{{ frontend_url }}/products" class="button">Keep shopping</a>
  <div class="footer">
    <p>Questions? Reply to this email or contact support@luxecart.com.</p>
    <p>&copy; 2026 LuxeCart</p>
  </div>
</div>
</body>
</html>
    """),

    "order_refunded": Template("""
<!DOCTYPE html>
<html>
<head><style>
body { font-family: Arial, sans-serif; background: #f7fafc; padding: 20px; }
.container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; }
h1 { color: #0ea5e9; margin-bottom: 20px; }
.receipt { background: #f0f9ff; padding: 20px; border-radius: 6px; margin: 20px 0; }
.button { display: inline-block; background: #7c3aed; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 20px; }
.footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; color: #a0aec0; font-size: 14px; }
</style></head>
<body>
<div class="container">
  <h1>Refund issued 💸</h1>
  <p>Hi {{ firstName }},</p>
  <div class="receipt">
    <p>We've issued a refund for order <strong>#{{ orderId }}</strong>.</p>
    <p>The refund should appear on your original payment method within <strong>5-10 business days</strong>, depending on your bank.</p>
  </div>
  {% if note %}<p style="color:#4a5568;"><strong>Note from our team:</strong> {{ note }}</p>{% endif %}
  <a href="{{ frontend_url }}/account/orders" class="button">View order</a>
  <div class="footer">
    <p>If the refund doesn't arrive by then, reply to this email.</p>
    <p>&copy; 2026 LuxeCart</p>
  </div>
</div>
</body>
</html>
    """),

    "order_processing": Template("""
<!DOCTYPE html>
<html>
<head><style>
body { font-family: Arial, sans-serif; background: #f7fafc; padding: 20px; }
.container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; }
h1 { color: #7c3aed; margin-bottom: 20px; }
.button { display: inline-block; background: #7c3aed; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 20px; }
.footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; color: #a0aec0; font-size: 14px; }
</style></head>
<body>
<div class="container">
  <h1>Your order is being prepared 📦</h1>
  <p>Hi {{ firstName }},</p>
  <p>Good news — order <strong>#{{ orderId }}</strong> is now being processed in our warehouse.</p>
  <p>You'll get another email with tracking details as soon as it ships.</p>
  <a href="{{ frontend_url }}/account/orders" class="button">View order</a>
  <div class="footer">
    <p>&copy; 2026 LuxeCart</p>
  </div>
</div>
</body>
</html>
    """),

    "email_verify": Template("""
<!DOCTYPE html>
<html>
<head><style>
body { font-family: Arial, sans-serif; background: #f7fafc; padding: 20px; }
.container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; }
h1 { color: #7c3aed; margin-bottom: 20px; }
p { color: #4a5568; line-height: 1.6; }
.button { display: inline-block; background: #7c3aed; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 20px; }
.token-box { background: #f7fafc; padding: 16px; border-radius: 6px; font-family: monospace; font-size: 13px; word-break: break-all; margin: 16px 0; }
.footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; color: #a0aec0; font-size: 14px; }
</style></head>
<body>
<div class="container">
  <h1>Confirm your email</h1>
  <p>Hi {{ firstName }},</p>
  <p>Welcome to LuxeCart! Please confirm your email address so we can keep your account secure.</p>
  <a href="{{ verify_url }}" class="button">Verify email</a>
  <p style="margin-top: 24px; font-size: 13px; color: #718096;">
    Or paste this link in your browser:
  </p>
  <div class="token-box">{{ verify_url }}</div>
  <p style="font-size: 13px; color: #718096;">
    This link expires in 24 hours. If you didn't sign up for LuxeCart, you can safely ignore this email.
  </p>
  <div class="footer">
    <p>&copy; 2026 LuxeCart</p>
  </div>
</div>
</body>
</html>
    """),

    "password_reset": Template("""
<!DOCTYPE html>
<html>
<head><style>
body { font-family: Arial, sans-serif; background: #f7fafc; padding: 20px; }
.container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; }
h1 { color: #dc2626; margin-bottom: 20px; }
p { color: #4a5568; line-height: 1.6; }
.button { display: inline-block; background: #dc2626; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 20px; }
.token-box { background: #f7fafc; padding: 16px; border-radius: 6px; font-family: monospace; font-size: 13px; word-break: break-all; margin: 16px 0; }
.footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; color: #a0aec0; font-size: 14px; }
</style></head>
<body>
<div class="container">
  <h1>Reset your password</h1>
  <p>Hi {{ firstName }},</p>
  <p>We received a request to reset the password for your LuxeCart account. Click below to choose a new one.</p>
  <a href="{{ reset_url }}" class="button">Reset password</a>
  <p style="margin-top: 24px; font-size: 13px; color: #718096;">
    Or paste this link in your browser:
  </p>
  <div class="token-box">{{ reset_url }}</div>
  <p style="font-size: 13px; color: #718096;">
    This link expires in 1 hour. If you didn't request a password reset, you can ignore this email — your password will not change.
  </p>
  <div class="footer">
    <p>&copy; 2026 LuxeCart</p>
  </div>
</div>
</body>
</html>
    """),

    # ── Phase 6: abandoned-cart nudge ────────────────────────────────
    # Triggered by the cart-service sweeper publishing `cart.abandoned`.
    # Warm amber theme so it visually distinguishes from order emails.
    # Includes the line items with image thumbnails (when available)
    # so the user is reminded what they were shopping for.
    "abandoned_cart": Template("""
<!DOCTYPE html>
<html>
<head><style>
body { font-family: Arial, sans-serif; background: #fffbeb; padding: 20px; }
.container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; }
h1 { color: #d97706; margin-bottom: 20px; }
p { color: #4a5568; line-height: 1.6; }
.button { display: inline-block; background: #d97706; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; margin-top: 20px; font-weight: 600; }
.item { display: flex; gap: 16px; padding: 12px; border: 1px solid #fde68a; border-radius: 6px; margin-bottom: 12px; align-items: center; }
.item img { width: 64px; height: 64px; object-fit: cover; border-radius: 4px; background: #fef3c7; }
.item .meta { flex: 1; }
.item .name { font-weight: 600; color: #92400e; }
.item .qty { font-size: 13px; color: #92400e; }
.item .price { font-weight: 600; color: #d97706; white-space: nowrap; }
.total { text-align: right; margin-top: 16px; padding-top: 16px; border-top: 1px solid #fde68a; font-size: 16px; font-weight: 700; color: #92400e; }
.footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; color: #a0aec0; font-size: 14px; }
</style></head>
<body>
<div class="container">
  <h1>You left something behind 🛍️</h1>
  <p>Hi {{ firstName }},</p>
  <p>We noticed you didn't finish checking out. Your cart is still saved — come back any time and your items will be waiting for you.</p>

  {% for item in items %}
  <div class="item">
    {% if item.image %}<img src="{{ item.image }}" alt="{{ item.name }}" />{% endif %}
    <div class="meta">
      <div class="name">{{ item.name }}</div>
      <div class="qty">Quantity: {{ item.quantity }}</div>
    </div>
    <div class="price">₦{{ "{:,.2f}".format(item.price * item.quantity) }}</div>
  </div>
  {% endfor %}

  <div class="total">Total: ₦{{ "{:,.2f}".format(total) }}</div>

  <p style="text-align:center;">
    <a href="{{ cart_url }}" class="button">Resume checkout →</a>
  </p>

  <div class="footer">
    <p>Items in your cart may sell out — grab them while stock lasts.</p>
    <p>&copy; 2026 LuxeCart</p>
  </div>
</div>
</body>
</html>
    """)
}


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# EMAIL SENDING
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def send_email(to_email: str, subject: str, html_content: str, email_type: str, user_id: int = None):
    """Send a transactional email via SMTP (sync send wrapped in a thread).

    Falls back to log-only mode when no recipient is supplied so that bad
    events never crash the consumer. Logs every send to MongoDB.
    """
    if not to_email:
        logger.warning(f"[Email] {email_type}: no recipient — skipping send")
        return False

    delivered = False
    err_msg = None
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = FROM_EMAIL
        msg["To"] = to_email
        msg.attach(MIMEText(html_content, "html"))

        def _send():
            # Gmail uses SMTPS on 465 (implicit TLS) or STARTTLS on 587.
            if SMTP_PORT == 465:
                with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=15) as srv:
                    srv.login(SMTP_USER, SMTP_PASSWORD)
                    srv.send_message(msg)
            else:
                with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as srv:
                    srv.starttls()
                    srv.login(SMTP_USER, SMTP_PASSWORD)
                    srv.send_message(msg)

        # SMTP is blocking — push it off the event loop
        await asyncio.to_thread(_send)
        delivered = True
        logger.info(f"📧 Email sent: {subject} → {to_email}")
    except Exception as e:
        err_msg = str(e)
        logger.error(f"[Email] SMTP send failed for {to_email}: {err_msg}")

    EMAIL_SENT.labels(email_type).inc()

    # Always log to Mongo so we can audit even failed sends. We use the sync
    # pymongo client here because this function may be called from either the
    # asyncio event loop (HTTP routes) or the RabbitMQ consumer's own loop —
    # motor would crash with "attached to a different loop".
    if sync_db is not None:
        try:
            await asyncio.to_thread(
                sync_db.email_logs.insert_one,
                {
                    "to": to_email,
                    "subject": subject,
                    "type": email_type,
                    "user_id": user_id,
                    "sent_at": datetime.utcnow(),
                    "status": "sent" if delivered else "failed",
                    "error": err_msg,
                    "html_preview": html_content[:500],
                },
            )
        except Exception as e:
            logger.error(f"[Email] MongoDB log failed: {e}")

    return delivered


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# KAFKA EVENT CONSUMER
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# One topic per event type — industry-standard Kafka idiom. Matches what
# the shared Node eventBus.js shim publishes (topic = "ecommerce." + event).
KAFKA_TOPICS = [
    "ecommerce.user.registered",
    "ecommerce.user.email_verify_requested",
    "ecommerce.user.password_reset_requested",
    "ecommerce.order.created",
    "ecommerce.order.status_updated",
    "ecommerce.payment.completed",
    "ecommerce.payment.failed",
    "ecommerce.cart.abandoned",
]


def start_kafka_consumer():
    """Background-thread Kafka consumer. Subscribes to every business event
    topic this service cares about, dispatches each into the asyncio loop
    so process_event() can `await` SMTP + Mongo writes.

    Uses confluent-kafka-python (librdkafka under the hood) — the
    industry-standard production Python Kafka client. Manual commit so we
    only advance the offset after the handler succeeds (at-least-once).
    Poison messages are logged and committed to prevent partition stalls,
    mirroring the old RabbitMQ nack-without-requeue behaviour.
    """
    max_retries = 20
    retry_delay = 5

    for attempt in range(1, max_retries + 1):
        try:
            logger.info(f"[Email] Attempting Kafka connection (attempt {attempt}/{max_retries})...")

            consumer = Consumer({
                "bootstrap.servers":       KAFKA_BROKERS,
                "group.id":                f"{SERVICE_NAME}.consumer",
                "client.id":               SERVICE_NAME,
                "enable.auto.commit":      False,   # manual commit after handler
                "auto.offset.reset":       "earliest",
                "session.timeout.ms":      30000,
                "heartbeat.interval.ms":   3000,
                "max.poll.interval.ms":    300000,  # 5 min — SMTP can be slow
            })

            consumer.subscribe(KAFKA_TOPICS)
            logger.info(f"✅ Email Service Kafka consumer subscribed to {len(KAFKA_TOPICS)} topics")

            while True:
                msg = consumer.poll(timeout=1.0)
                if msg is None:
                    continue
                if msg.error():
                    # _PARTITION_EOF is informational on broker rebalance — ignore.
                    if msg.error().code() == KafkaError._PARTITION_EOF:
                        continue
                    logger.error(f"[Email] Kafka poll error: {msg.error()}")
                    continue

                try:
                    envelope = json.loads(msg.value().decode("utf-8"))
                    event_type = envelope.get("event") or msg.topic().removeprefix("ecommerce.")
                    data = envelope.get("data", {})

                    logger.info(f"[Email] Received event: {event_type} (topic={msg.topic()} offset={msg.offset()})")

                    # Run async handler in this thread's own event loop.
                    asyncio.run(process_event(event_type, data))

                    # Commit only after success.
                    consumer.commit(msg, asynchronous=False)
                except Exception as e:
                    logger.error(f"[Email] Event processing error: {e}")
                    # Still commit — poison message stays in the topic for
                    # forensic inspection via kafka-ui, but we move on so
                    # the partition keeps flowing. (Future: route to a
                    # `<topic>.dlq` retry topic.)
                    try:
                        consumer.commit(msg, asynchronous=False)
                    except Exception as commit_err:
                        logger.error(f"[Email] Commit failed after handler error: {commit_err}")

            # Unreachable — `while True` above runs forever until exception.
            consumer.close()
            break

        except KafkaException as e:
            logger.error(f"[Email] Kafka connection attempt {attempt}/{max_retries} failed: {e}")
            if attempt < max_retries:
                logger.info(f"[Email] Retrying in {retry_delay} seconds...")
                time.sleep(retry_delay)
            else:
                logger.error("[Email] ❌ Could not connect to Kafka after all retries")
                logger.error("[Email] ⚠️  Email service will run without event consumer")
        except Exception as e:
            logger.error(f"[Email] Unexpected consumer error: {e}")
            if attempt < max_retries:
                time.sleep(retry_delay)
            else:
                break


async def process_event(event_type: str, data: Dict):
    """Process incoming events and send appropriate emails.

    All events must carry the recipient's `email` (the producing services
    — order-service, payment-service, auth-service — enrich payloads by
    joining against the users table before publishing).
    """
    try:
        recipient = data.get('email')
        first_name = data.get('firstName') or 'there'

        if event_type == "user.registered":
            html = TEMPLATES["welcome"].render(
                firstName=first_name,
                frontend_url=FRONTEND_URL,
            )
            await send_email(
                to_email=recipient,
                subject="Welcome to LuxeCart! 🎉",
                html_content=html,
                email_type="welcome",
                user_id=data.get('userId'),
            )

        elif event_type == "order.created":
            html = TEMPLATES["order_confirmation"].render(
                orderId=data.get('id'),
                firstName=first_name,
                items=data.get('items', []),
                total=data.get('total', 0),
                frontend_url=FRONTEND_URL,
            )
            await send_email(
                to_email=recipient,
                subject=f"Order #{data.get('id')} Confirmed!",
                html_content=html,
                email_type="order_confirmation",
                user_id=data.get('userId'),
            )

        elif event_type == "payment.completed":
            html = TEMPLATES["payment_success"].render(
                orderId=data.get('orderId'),
                amount=data.get('amount', 0),
                transactionId=data.get('transactionId'),
                method=data.get('method', 'Card'),
                date=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                frontend_url=FRONTEND_URL,
            )
            await send_email(
                to_email=recipient,
                subject="Payment Successful! 💳",
                html_content=html,
                email_type="payment_success",
                user_id=data.get('userId'),
            )

        elif event_type == "payment.failed":
            html = TEMPLATES["payment_failed"].render(
                orderId=data.get('orderId'),
                amount=data.get('amount', 0),
                reason=data.get('reason', 'Payment declined'),
                frontend_url=FRONTEND_URL,
            )
            await send_email(
                to_email=recipient,
                subject="Payment Failed - Action Required",
                html_content=html,
                email_type="payment_failed",
                user_id=data.get('userId'),
            )

        elif event_type == "order.status_updated":
            status = (data.get('status') or '').lower()
            order_id = data.get('orderId')
            common = dict(
                orderId=order_id,
                firstName=first_name,
                frontend_url=FRONTEND_URL,
                trackingNumber=data.get('trackingNumber') or f"TRK-{order_id}-2026",
                note=data.get('note'),
            )
            template_map = {
                'processing': ("order_processing", f"Order #{order_id} is being prepared"),
                'shipped':    ("order_shipped",    f"Order #{order_id} Shipped! 🚚"),
                'delivered':  ("order_delivered",  f"Order #{order_id} Delivered ✅"),
                'cancelled':  ("order_cancelled",  f"Order #{order_id} Cancelled"),
                'refunded':   ("order_refunded",   f"Refund issued for Order #{order_id}"),
            }
            entry = template_map.get(status)
            if not entry:
                logger.info(f"[Email] Ignoring status '{status}' for order #{order_id}")
                return
            template_key, subject = entry
            html = TEMPLATES[template_key].render(**common)
            await send_email(
                to_email=recipient,
                subject=subject,
                html_content=html,
                email_type=template_key,
                user_id=data.get('userId'),
            )

        elif event_type == "user.email_verify_requested":
            html = TEMPLATES["email_verify"].render(
                firstName=first_name,
                verify_url=data.get('verifyUrl') or f"{FRONTEND_URL}/auth/verify-email?token={data.get('token','')}",
            )
            await send_email(
                to_email=recipient,
                subject="Confirm your LuxeCart email",
                html_content=html,
                email_type="email_verify",
                user_id=data.get('userId'),
            )

        elif event_type == "user.password_reset_requested":
            html = TEMPLATES["password_reset"].render(
                firstName=first_name,
                reset_url=data.get('resetUrl') or f"{FRONTEND_URL}/auth/reset-password?token={data.get('token','')}",
            )
            await send_email(
                to_email=recipient,
                subject="Reset your LuxeCart password",
                html_content=html,
                email_type="password_reset",
                user_id=data.get('userId'),
            )

        elif event_type == "cart.abandoned":
            # Phase 6: sweeper-published cart reminder. Payload shape:
            #   { userId, email, firstName, items: [{productId, quantity,
            #     price, name, image?}], total, cartUrl }
            items = data.get('items') or []
            if not items:
                logger.info(f"[Email] cart.abandoned with no items for user {data.get('userId')}, skipping")
                return
            html = TEMPLATES["abandoned_cart"].render(
                firstName=first_name,
                items=items,
                total=data.get('total', 0),
                cart_url=data.get('cartUrl') or f"{FRONTEND_URL}/cart",
            )
            await send_email(
                to_email=recipient,
                subject="You left items in your cart 🛍️",
                html_content=html,
                email_type="abandoned_cart",
                user_id=data.get('userId'),
            )

    except Exception as e:
        logger.error(f"Event processing error: {e}")


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# HTTP ENDPOINTS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@app.post("/email/send")
async def send_manual_email(
    to: str,
    subject: str,
    template: str,
    data: Dict[str, Any],
    background_tasks: BackgroundTasks
):
    """Manually send an email (for testing or admin use)"""
    if template not in TEMPLATES:
        raise HTTPException(status_code=400, detail=f"Template '{template}' not found")
    
    html = TEMPLATES[template].render(**data)
    background_tasks.add_task(send_email, to, subject, html, template)
    
    return {"status": "queued", "to": to, "template": template}


@app.get("/email/logs")
async def get_email_logs(user_id: Optional[int] = None, limit: int = 50):
    """Get email logs from MongoDB"""
    if not db:
        raise HTTPException(status_code=503, detail="MongoDB not configured")
    
    try:
        query = {"user_id": user_id} if user_id else {}
        cursor = db.email_logs.find(query).sort("sent_at", -1).limit(limit)
        logs = await cursor.to_list(length=limit)
        
        # Convert ObjectId to string
        for log in logs:
            log['_id'] = str(log['_id'])
        
        return {"logs": logs}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=3015)
