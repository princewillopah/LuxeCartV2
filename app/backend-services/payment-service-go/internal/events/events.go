// Package events publishes payment-lifecycle events onto Kafka.
//
// Industry-standard: one topic per event type ("ecommerce.payment.completed",
// "ecommerce.payment.failed", ...). Matches the topology produced by the
// shared Node eventBus.js shim and consumed by the Python email-service.
//
// The publisher is intentionally fire-and-forget at the caller level: callers
// log the error but don't fail the HTTP response if Kafka is down — the DB
// is the source of truth and the order/payment state is already correct.
// kafka-go's `Writer` itself does internal batching + retry, so transient
// blips are absorbed without our code doing anything.
package events

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/segmentio/kafka-go"
)

// All event topics are prefixed with "ecommerce." — matches the convention
// used by the Node shim in services/shared/eventBus.js.
const topicPrefix = "ecommerce."

// Publisher owns a per-topic kafka-go Writer. Writers are goroutine-safe and
// pool their own connections, so we just need to hand each unique event type
// its own lazily-created writer.
type Publisher struct {
	brokers    []string
	clientID   string
	log        *slog.Logger

	mu      sync.Mutex
	writers map[string]*kafka.Writer
	closed  bool
}

// New constructs a Publisher. `brokerList` is a comma-separated bootstrap
// list (e.g. "kafka:9092" or "kafka1:9092,kafka2:9092").
func New(brokerList, clientID string, log *slog.Logger) *Publisher {
	brokers := []string{}
	for _, b := range strings.Split(brokerList, ",") {
		if b = strings.TrimSpace(b); b != "" {
			brokers = append(brokers, b)
		}
	}
	return &Publisher{
		brokers:  brokers,
		clientID: clientID,
		log:      log,
		writers:  make(map[string]*kafka.Writer),
	}
}

// Connect is a no-op kept for API parity with the previous RabbitMQ
// implementation — kafka-go's writers connect lazily on first Write.
// Returns nil so callers' existing "warn-on-fail" branch stays harmless.
func (p *Publisher) Connect() error {
	return nil
}

// Close tears down every cached writer on shutdown.
func (p *Publisher) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closed = true
	for _, w := range p.writers {
		_ = w.Close()
	}
	p.writers = nil
}

// writerFor returns the cached writer for a topic, creating it on demand.
func (p *Publisher) writerFor(topic string) *kafka.Writer {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil
	}
	if w, ok := p.writers[topic]; ok {
		return w
	}
	w := &kafka.Writer{
		Addr:                   kafka.TCP(p.brokers...),
		Topic:                  topic,
		Balancer:               &kafka.Hash{}, // partition by key for ordering
		RequiredAcks:           kafka.RequireAll,
		AllowAutoTopicCreation: true,
		WriteTimeout:           10 * time.Second,
		ReadTimeout:            10 * time.Second,
		BatchTimeout:           10 * time.Millisecond,
	}
	p.writers[topic] = w
	return w
}

// envelope matches the format used by the Node services so existing consumers
// don't need to change. See services/shared/eventBus.js publishEvent().
type envelope struct {
	Event     string `json:"event"`
	Data      any    `json:"data"`
	Timestamp string `json:"timestamp"`
	MessageID string `json:"messageId"`
}

// Publish marshals data as JSON and sends it to the topic named
// "ecommerce.<eventType>". The Kafka message key is derived from the
// payload (orderId / userId / transactionId when present) so events for the
// same entity land on the same partition (giving us per-entity ordering).
func (p *Publisher) Publish(ctx context.Context, eventType string, data any) error {
	body, err := json.Marshal(envelope{
		Event:     eventType,
		Data:      data,
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
		MessageID: fmt.Sprintf("%s-%d-%s", eventType, time.Now().UnixMilli(), randSuffix()),
	})
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}

	topic := topicPrefix + eventType
	w := p.writerFor(topic)
	if w == nil {
		return fmt.Errorf("publisher closed")
	}

	key := pickPartitionKey(data, eventType)

	if err := w.WriteMessages(ctx, kafka.Message{
		Key:   []byte(key),
		Value: body,
		Time:  time.Now(),
		Headers: []kafka.Header{
			{Key: "event-type", Value: []byte(eventType)},
			{Key: "producer", Value: []byte(p.clientID)},
			{Key: "content-type", Value: []byte("application/json")},
		},
	}); err != nil {
		return fmt.Errorf("kafka write %s: %w", topic, err)
	}

	p.log.Info("event published", "event", eventType, "topic", topic, "key", key)
	return nil
}

// pickPartitionKey returns a stable per-entity key so messages about the same
// order/user stay in-order on a single partition. Falls back to event type
// (hash-distributed) when no obvious key exists.
func pickPartitionKey(data any, eventType string) string {
	// Try to extract common ID fields via JSON round-trip. Cheap and
	// type-agnostic — the payment-service emits a small handful of payloads.
	raw, err := json.Marshal(data)
	if err != nil {
		return eventType
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return eventType
	}
	for _, k := range []string{"orderId", "userId", "transactionId", "reference"} {
		if v, ok := m[k]; ok && v != nil {
			return fmt.Sprintf("%s:%v", k, v)
		}
	}
	return eventType
}

// randSuffix returns a short random hex tag for messageId uniqueness.
func randSuffix() string {
	var b [3]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
