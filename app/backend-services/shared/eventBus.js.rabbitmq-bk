/**
 * eventBus.js — Shared RabbitMQ wrapper used by every service
 *
 * Usage:
 *   const { publishEvent, consumeEvents } = require('./eventBus');
 *
 *   // Publish
 *   await publishEvent('order.created', { orderId: 1, userId: 2, total: 99.99 });
 *
 *   // Consume
 *   await consumeEvents('order.created', async (data) => {
 *     console.log('Order created:', data);
 *   });
 */

const amqp = require('amqplib');

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://ecommerce:ecommerce123@rabbitmq:5672';
const EXCHANGE     = 'ecommerce.events';   // Topic exchange — all events go here
const RECONNECT_DELAY = 5000;

let connection = null;
let publishChannel = null;

// ─────────────────────────────────────────────
// Internal: connect with automatic retry
// ─────────────────────────────────────────────
async function connect(retries = 10) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      connection = await amqp.connect(RABBITMQ_URL);

      connection.on('error', (err) => {
        console.error('[EventBus] Connection error:', err.message);
        connection = null;
        publishChannel = null;
      });

      connection.on('close', () => {
        console.warn('[EventBus] Connection closed — reconnecting...');
        connection = null;
        publishChannel = null;
        setTimeout(() => connect(), RECONNECT_DELAY);
      });

      console.log('[EventBus] Connected to RabbitMQ');
      return connection;
    } catch (err) {
      console.warn(`[EventBus] Attempt ${attempt}/${retries} failed: ${err.message}`);
      if (attempt < retries) await sleep(RECONNECT_DELAY);
    }
  }
  throw new Error('[EventBus] Could not connect to RabbitMQ after max retries');
}

// ─────────────────────────────────────────────
// Internal: ensure exchange exists
// ─────────────────────────────────────────────
async function assertExchange(channel) {
  await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
}

// ─────────────────────────────────────────────
// Publish an event
// routingKey examples: 'order.created', 'payment.completed'
// ─────────────────────────────────────────────
async function publishEvent(routingKey, data) {
  try {
    if (!connection) await connect();

    if (!publishChannel) {
      publishChannel = await connection.createChannel();
      await assertExchange(publishChannel);
    }

    const payload = Buffer.from(JSON.stringify({
      event:     routingKey,
      data,
      timestamp: new Date().toISOString(),
      messageId: `${routingKey}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    }));

    publishChannel.publish(EXCHANGE, routingKey, payload, {
      persistent:   true,   // survive broker restart
      contentType:  'application/json',
    });

    console.log(`[EventBus] Published → ${routingKey}`, JSON.stringify(data).slice(0, 120));
  } catch (err) {
    console.error(`[EventBus] Failed to publish ${routingKey}:`, err.message);
    // Non-fatal: log and continue — the HTTP response was already sent
  }
}

// ─────────────────────────────────────────────
// Consume events matching a routing key pattern
// pattern examples: 'order.created', 'payment.*', '#' (all)
// ─────────────────────────────────────────────
async function consumeEvents(pattern, handler, queueName = null) {
  if (!connection) await connect();

  const channel = await connection.createChannel();
  await assertExchange(channel);

  channel.prefetch(1); // Process one message at a time

  // Each service gets its own durable queue named after the pattern
  const queue = queueName || `${pattern.replace(/[.*#]/g, '_')}_queue`;

  await channel.assertQueue(queue, {
    durable:    true,
    arguments: {
      'x-message-ttl':       86400000, // 24 hours
      'x-dead-letter-exchange': `${EXCHANGE}.dlx`
    }
  });

  await channel.bindQueue(queue, EXCHANGE, pattern);

  console.log(`[EventBus] Consuming ${pattern} from queue "${queue}"`);

  channel.consume(queue, async (msg) => {
    if (!msg) return;

    try {
      const envelope = JSON.parse(msg.content.toString());
      console.log(`[EventBus] Received ← ${envelope.event} (${envelope.messageId})`);

      await handler(envelope.data, envelope);

      channel.ack(msg); // Success
    } catch (err) {
      console.error('[EventBus] Handler error:', err.message);
      // Nack without requeue — goes to DLX after 1 attempt
      channel.nack(msg, false, false);
    }
  });
}

// ─────────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────────
async function closeConnection() {
  try {
    if (publishChannel) await publishChannel.close();
    if (connection)     await connection.close();
  } catch (err) {
    // Ignore on shutdown
  }
}

process.on('SIGTERM', closeConnection);
process.on('SIGINT',  closeConnection);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { publishEvent, consumeEvents, closeConnection };
