package com.luxecart.product.service;

import com.luxecart.product.web.dto.ProductDto;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Publishes product.* lifecycle events on the
 *   ecommerce.product.created
 *   ecommerce.product.updated
 *   ecommerce.product.deleted
 * topics. Sibling services (search-service, recommendation-service,
 * analytics-service) subscribe to keep their projections in sync under
 * the database-per-service split.
 *
 * Envelope shape mirrors what the Node {@code publishEvent()} helper
 * produces so all consumers can use the same payload contract:
 *   {
 *     id: "<uuid>",
 *     event: "product.created",
 *     timestamp: "<iso>",
 *     data: { ...payload... }
 *   }
 *
 * Failures are logged and swallowed — a Kafka outage must not block
 * the user-facing HTTP write path (admin-facing writes already
 * persisted to Postgres before this publish fires).
 */
@Component
public class ProductEventPublisher {

    private static final Logger log = LoggerFactory.getLogger(ProductEventPublisher.class);
    private static final String TOPIC_PREFIX = "ecommerce.";

    private final KafkaTemplate<String, Object> kafkaTemplate;

    public ProductEventPublisher(KafkaTemplate<String, Object> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }

    /** Fired after ProductService.create() commits. */
    public void publishCreated(ProductDto p) {
        publish("product.created", buildPayload(p));
    }

    /** Fired after ProductService.update() commits. */
    public void publishUpdated(ProductDto p) {
        publish("product.updated", buildPayload(p));
    }

    /**
     * Fired after ProductService.delete() commits. We only have the id
     * by the time the row is gone, so the payload is minimal.
     */
    public void publishDeleted(Integer id) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("productId", id);
        data.put("id",        id);
        publish("product.deleted", data);
    }

    private void publish(String event, Map<String, Object> data) {
        String topic = TOPIC_PREFIX + event;
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("id",        java.util.UUID.randomUUID().toString());
        envelope.put("event",     event);
        envelope.put("timestamp", Instant.now().toString());
        envelope.put("data",      data);
        // Key on the entity id so all events for the same product land
        // on the same partition (consumers see them in order).
        Object key = data.get("productId");
        if (key == null) key = data.get("id");
        try {
            kafkaTemplate.send(topic, key == null ? null : String.valueOf(key), envelope);
            log.debug("Published {} key={}", topic, key);
        } catch (Exception e) {
            log.warn("Failed to publish {} key={}: {}", topic, key, e.getMessage());
        }
    }

    private static Map<String, Object> buildPayload(ProductDto p) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("productId",       p.id());
        data.put("id",              p.id());
        data.put("name",            p.name());
        data.put("description",     p.description());
        data.put("price",           p.price());
        data.put("discountPercent", p.discountPercent());
        data.put("category",        p.category());
        data.put("stock",           p.stock());
        data.put("brand",           p.brand());
        data.put("images",          p.images());
        data.put("averageRating",   p.averageRating());
        data.put("totalReviews",    p.totalReviews());
        data.put("createdAt",       p.createdAt());
        return data;
    }
}
