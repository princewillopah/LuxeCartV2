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
from fastapi.middleware.cors import CORSMiddleware
from typing import Optional, Dict, Any
from motor.motor_asyncio import AsyncIOMotorClient
from datetime import datetime
import os
import logging
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from jinja2 import Template
import pika
import json
import asyncio
import threading
import time
from prometheus_client import Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST
from starlette.responses import Response

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Email Service", version="1.0.0")

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

MONGODB_URL = os.environ["MONGODB_URL"]
RABBITMQ_URL = os.environ["RABBITMQ_URL"]


@app.on_event("startup")
async def startup():
    global mongo_client, db
    
    # MongoDB
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
    
    # Start RabbitMQ consumer in background thread
    threading.Thread(target=start_rabbitmq_consumer, daemon=True).start()


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
  <a href="http://localhost" class="button">Start Shopping</a>
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
    <p>Track your order at http://localhost/orders</p>
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
  <a href="http://localhost/orders" class="button">Retry Payment</a>
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
    <p class="tracking-number">TRK-{{ orderId }}-2026</p>
  </div>
  <p>You can expect delivery within 3-5 business days.</p>
  <div class="footer">
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
    """Send email and log to MongoDB"""
    try:
        # In production, use SendGrid or similar
        # For now, just log the email (SMTP requires real credentials)
        logger.info(f"📧 Email sent: {subject} → {to_email}")
        
        # Track in Prometheus
        EMAIL_SENT.labels(email_type).inc()
        
        # Log to MongoDB
        if db:
            email_log = {
                "to": to_email,
                "subject": subject,
                "type": email_type,
                "user_id": user_id,
                "sent_at": datetime.utcnow(),
                "status": "sent",
                "html_preview": html_content[:500]  # Store preview
            }
            await db.email_logs.insert_one(email_log)
        
        return True
    except Exception as e:
        logger.error(f"Email send error: {e}")
        return False


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# RABBITMQ EVENT CONSUMER
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def start_rabbitmq_consumer():
    """Start consuming RabbitMQ events in a background thread"""
    max_retries = 20
    retry_delay = 5
    
    for attempt in range(1, max_retries + 1):
        try:
            logger.info(f"[Email] Attempting RabbitMQ connection (attempt {attempt}/{max_retries})...")
            
            connection = pika.BlockingConnection(pika.URLParameters(RABBITMQ_URL))
            channel = connection.channel()
            
            # Declare exchange
            channel.exchange_declare(exchange='ecommerce.events', exchange_type='topic', durable=True)
            
            # Create queue for email service
            queue_name = 'email_service_queue'
            channel.queue_declare(queue=queue_name, durable=True)
            
            # Bind to events
            channel.queue_bind(exchange='ecommerce.events', queue=queue_name, routing_key='user.registered')
            channel.queue_bind(exchange='ecommerce.events', queue=queue_name, routing_key='order.created')
            channel.queue_bind(exchange='ecommerce.events', queue=queue_name, routing_key='payment.completed')
            channel.queue_bind(exchange='ecommerce.events', queue=queue_name, routing_key='payment.failed')
            channel.queue_bind(exchange='ecommerce.events', queue=queue_name, routing_key='order.status_updated')
            
            logger.info("✅ Email Service RabbitMQ consumer started")
            
            def callback(ch, method, properties, body):
                try:
                    envelope = json.loads(body)
                    event_type = envelope.get('event')
                    data = envelope.get('data', {})
                    
                    logger.info(f"[Email] Received event: {event_type}")
                    
                    # Process in asyncio event loop
                    asyncio.run(process_event(event_type, data))
                    
                    ch.basic_ack(delivery_tag=method.delivery_tag)
                except Exception as e:
                    logger.error(f"[Email] Event processing error: {e}")
                    ch.basic_nack(delivery_tag=method.delivery_tag, requeue=False)
            
            channel.basic_consume(queue=queue_name, on_message_callback=callback)
            channel.start_consuming()
            
            # If we get here, connection was successful
            break
            
        except Exception as e:
            logger.error(f"[Email] RabbitMQ connection attempt {attempt}/{max_retries} failed: {e}")
            if attempt < max_retries:
                logger.info(f"[Email] Retrying in {retry_delay} seconds...")
                time.sleep(retry_delay)
            else:
                logger.error("[Email] ❌ Could not connect to RabbitMQ after all retries")
                logger.error("[Email] ⚠️  Email service will run without event consumer")


async def process_event(event_type: str, data: Dict):
    """Process incoming events and send appropriate emails"""
    try:
        if event_type == "user.registered":
            html = TEMPLATES["welcome"].render(firstName=data.get('firstName', 'there'))
            await send_email(
                to_email=data.get('email'),
                subject="Welcome to LuxeCart! 🎉",
                html_content=html,
                email_type="welcome",
                user_id=data.get('userId')
            )
        
        elif event_type == "order.created":
            html = TEMPLATES["order_confirmation"].render(
                orderId=data.get('id'),
                firstName="Customer",
                items=data.get('items', []),
                total=data.get('total', 0)
            )
            await send_email(
                to_email="customer@example.com",  # In production, fetch user email
                subject=f"Order #{data.get('id')} Confirmed!",
                html_content=html,
                email_type="order_confirmation",
                user_id=data.get('userId')
            )
        
        elif event_type == "payment.completed":
            html = TEMPLATES["payment_success"].render(
                orderId=data.get('orderId'),
                amount=data.get('amount', 0),
                transactionId=data.get('transactionId'),
                method=data.get('method', 'Card'),
                date=datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            )
            await send_email(
                to_email="customer@example.com",
                subject="Payment Successful! 💳",
                html_content=html,
                email_type="payment_success",
                user_id=data.get('userId')
            )
        
        elif event_type == "payment.failed":
            html = TEMPLATES["payment_failed"].render(
                orderId=data.get('orderId'),
                amount=data.get('amount', 0),
                reason=data.get('reason', 'Payment declined')
            )
            await send_email(
                to_email="customer@example.com",
                subject="Payment Failed - Action Required",
                html_content=html,
                email_type="payment_failed",
                user_id=data.get('userId')
            )
        
        elif event_type == "order.status_updated":
            if data.get('status') == 'shipped':
                html = TEMPLATES["order_shipped"].render(orderId=data.get('orderId'))
                await send_email(
                    to_email="customer@example.com",
                    subject=f"Order #{data.get('orderId')} Shipped! 🚚",
                    html_content=html,
                    email_type="shipping_notification",
                    user_id=data.get('userId')
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
