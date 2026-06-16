package com.luxecart.product.web;

import io.micrometer.prometheusmetrics.PrometheusMeterRegistry;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * Compatibility shims for the legacy URL surface:
 *
 *  - `GET /health`  — the Node service responded with
 *    `{"status":"Product Service is running with Redis"}` on success
 *    and a 503 if Redis was unreachable. We replicate that exactly so
 *    the existing api-gateway / monitoring probes don't need
 *    re-wiring. (Spring Boot's `/actuator/health` is also exposed for
 *    Kubernetes-style probes.)
 *
 *  - `GET /metrics` — the legacy path served Prometheus text format.
 *    We delegate to Micrometer's PrometheusMeterRegistry so the
 *    existing scrape config in monitoring/prometheus.yml keeps
 *    working without edits.
 */
@RestController
public class HealthAndMetricsController {

    private final StringRedisTemplate redis;
    private final PrometheusMeterRegistry promRegistry;

    @Autowired
    public HealthAndMetricsController(StringRedisTemplate redis,
                                      PrometheusMeterRegistry promRegistry) {
        this.redis = redis;
        this.promRegistry = promRegistry;
    }

    @GetMapping("/health")
    public ResponseEntity<Map<String, String>> health() {
        try {
            // PING the Redis connection. Lettuce uses a connection pool;
            // a successful PING means a live connection is reachable.
            String pong = redis.getConnectionFactory().getConnection().ping();
            if (!"PONG".equalsIgnoreCase(pong)) {
                throw new IllegalStateException("Unexpected ping reply: " + pong);
            }
            return ResponseEntity.ok(Map.of(
                    "status", "Product Service is running with Redis"
            ));
        } catch (Exception e) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(Map.of(
                    "status", "unhealthy",
                    "error",  "Redis connection issue"
            ));
        }
    }

    @GetMapping(value = "/metrics", produces = MediaType.TEXT_PLAIN_VALUE + "; version=0.0.4")
    public String metrics() {
        return promRegistry.scrape();
    }
}
