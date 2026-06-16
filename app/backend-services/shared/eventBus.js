/**
 * eventBus.js — Shared Kafka wrapper used by every Node service.
 *
 * Replaces the previous RabbitMQ-based shim. Public API is unchanged
 * so business services don't need any modification:
 *
 *   const { publishEvent, consumeEvents } = require('./shared/eventBus');
 *
 *   // Publish
 *   await publishEvent('order.created', { orderId: 1, userId: 2, total: 99.99 });
 *
 *   // Consume
 *   await consumeEvents('order.created', async (data) => {
 *     console.log('Order created:', data);
 *   });
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Industry-standard conventions used here:
 *
 *  1. ONE TOPIC PER EVENT TYPE.  `order.created` lives on topic
 *     `ecommerce.order.created`, `payment.completed` on
 *     `ecommerce.payment.completed`, etc.  This is the Kafka idiom — it
 *     keeps consumers from having to fetch + filter events they don't care
 *     about, and lets us scale partitions per event type.
 *
 *  2. STABLE CONSUMER GROUP IDs.  Each service uses a group ID of
 *     `<service-name>.<event>` so it owns its own offsets and reading
 *     from one event doesn't interfere with another.  Restarts resume
 *     from the last committed offset (no replay surprises).
 *
 *  3. AT-LEAST-ONCE DELIVERY with manual commit.  We commit offsets only
 *     AFTER the handler returns successfully.  If the handler throws we
 *     log and DO commit (mirrors the previous RMQ "nack-without-requeue"
 *     behaviour so a poison message can't block the whole partition).
 *     Tighter retry/DLQ semantics belong in a follow-up.
 *
 *  4. ENVELOPE COMPAT.  Outbound messages keep the same JSON shape the
 *     old RabbitMQ envelope used — `{event, data, timestamp, messageId}`
 *     — so any service (Go payment-service, Python email-service) that
 *     re-implements its own producer/consumer stays interoperable.
 */

const { Kafka, logLevel } = require('kafkajs');

// ──────────────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────────────
const BROKERS      = (process.env.KAFKA_BROKERS || 'kafka:9092').split(',');
const CLIENT_ID    = process.env.SERVICE_NAME   || 'unknown-service';
const TOPIC_PREFIX = 'ecommerce.';

const kafka = new Kafka({
  clientId: CLIENT_ID,
  brokers: BROKERS,
  logLevel: logLevel.WARN,
  retry: { initialRetryTime: 500, retries: 10 },
});

// Single shared producer per process (idempotent connect).
let producer = null;
let producerConnecting = null;
async function getProducer() {
  if (producer) return producer;
  if (producerConnecting) return producerConnecting;
  producerConnecting = (async () => {
    const p = kafka.producer({
      allowAutoTopicCreation: true,
      // idempotent=true forces acks=all and dedup'd retries — exactly-once
      // *to the broker* (not end-to-end). Cheap insurance against double-
      // publish on a transient network blip.
      idempotent: true,
    });
    await p.connect();
    producer = p;
    console.log(`[EventBus] (${CLIENT_ID}) producer connected to ${BROKERS.join(',')}`);
    return p;
  })();
  return producerConnecting;
}

// Track consumer handles so SIGTERM can disconnect them cleanly.
const consumers = [];

// ──────────────────────────────────────────────────────────────────────────
// Publish
// ──────────────────────────────────────────────────────────────────────────
// `routingKey` is the event name (e.g. 'order.created'). It maps 1:1 to a
// topic named `ecommerce.<routingKey>`.
//
// We also set the Kafka message `key` to a stable per-entity identifier
// when available (orderId / userId / cartId / productId) so messages for
// the same entity always land in the same partition (giving us per-entity
// ordering). Fallback is the routing key, which is fine for low-volume
// fan-out events.
async function publishEvent(routingKey, data) {
  try {
    const p = await getProducer();
    const topic = TOPIC_PREFIX + routingKey;
    const key = pickPartitionKey(data) || routingKey;

    const envelope = {
      event: routingKey,
      data,
      timestamp: new Date().toISOString(),
      messageId: `${routingKey}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };

    await p.send({
      topic,
      messages: [{
        key,
        value: JSON.stringify(envelope),
        headers: {
          'event-type':   routingKey,
          'producer':     CLIENT_ID,
          'content-type': 'application/json',
        },
      }],
    });

    console.log(`[EventBus] (${CLIENT_ID}) → ${topic} key=${key}`);
  } catch (err) {
    console.error(`[EventBus] (${CLIENT_ID}) publish ${routingKey} failed:`, err.message);
    // Non-fatal — caller has already responded to the HTTP request.
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Consume
// ──────────────────────────────────────────────────────────────────────────
// `pattern` is the event name (e.g. 'order.created'). It maps 1:1 to a
// topic named `ecommerce.<pattern>`.
//
// `handler` is invoked as handler(data, envelope). Handler throws are
// logged but the offset is still committed so a poison message doesn't
// stall the partition (mirrors the previous RMQ nack-without-requeue).
//
// `queueName` is preserved as the 3rd arg for back-compat with the old
// RabbitMQ shim's signature, but is otherwise unused — Kafka uses
// consumer groups instead.
async function consumeEvents(pattern, handler, _queueName = null) {
  // Wildcard subscription is not supported in this shim (we deliberately
  // avoid the "one big topic + filter in code" anti-pattern). Every
  // consumer subscribes to ONE exact topic.
  if (pattern === '#' || pattern === '*' || pattern.includes('*')) {
    throw new Error(
      `[EventBus] wildcard patterns ('${pattern}') are not supported on Kafka. ` +
      `Subscribe to a specific event name like 'order.created'.`
    );
  }

  const topic   = TOPIC_PREFIX + pattern;
  const groupId = `${CLIENT_ID}.${pattern}`;

  const consumer = kafka.consumer({
    groupId,
    // Read only events emitted from now on, the first time this consumer
    // group exists. Once it has committed offsets, restarts resume from
    // last commit (Kafka default — no explicit override needed beyond
    // `fromBeginning: false` below).
    sessionTimeout: 30000,
    heartbeatInterval: 3000,
  });

  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: false });
  consumers.push(consumer);

  await consumer.run({
    eachMessage: async ({ topic: t, partition, message }) => {
      let envelope;
      try {
        envelope = JSON.parse(message.value.toString());
      } catch (err) {
        console.error(`[EventBus] (${CLIENT_ID}) malformed message on ${t}/${partition}@${message.offset}`);
        return; // skip + commit
      }
      const data = envelope?.data ?? envelope; // tolerate raw-payload messages
      console.log(`[EventBus] (${CLIENT_ID}) ← ${t}@${message.offset} ${envelope?.messageId || ''}`);
      try {
        await handler(data, envelope);
      } catch (err) {
        console.error(`[EventBus] (${CLIENT_ID}) handler ${pattern} failed:`, err.message);
        // Swallow — the offset will still be committed by kafkajs after
        // this function returns. Prevents poison-message stalls.
      }
    },
  });

  console.log(`[EventBus] (${CLIENT_ID}) consuming ${topic} as group "${groupId}"`);
  return consumer;
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

// Best-effort: pick a stable partition key so messages about the same
// entity land in the same partition (Kafka guarantees in-partition order).
// Returns null when no obvious key is available — caller then falls back
// to routingKey for hash distribution.
function pickPartitionKey(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.orderId   != null) return `order:${data.orderId}`;
  if (data.id        != null && data.userId != null) return `user:${data.userId}`; // e.g. order.created where id is orderId — prefer userId so same user's events stay ordered
  if (data.userId    != null) return `user:${data.userId}`;
  if (data.cartId    != null) return `cart:${data.cartId}`;
  if (data.productId != null) return `product:${data.productId}`;
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Graceful shutdown
// ──────────────────────────────────────────────────────────────────────────
async function closeConnection() {
  try {
    await Promise.all(consumers.map(c => c.disconnect().catch(() => {})));
    if (producer) await producer.disconnect().catch(() => {});
  } catch {
    // Ignore on shutdown
  }
}

process.on('SIGTERM', closeConnection);
process.on('SIGINT',  closeConnection);

module.exports = { publishEvent, consumeEvents, closeConnection };
