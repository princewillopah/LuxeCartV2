package com.luxecart.product.web;

import com.luxecart.product.service.ProductService;
import com.luxecart.product.web.dto.ProductDto;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;

import java.math.BigDecimal;

/**
 * Internal-only endpoints used by sibling microservices.
 *
 * These exist because — under the database-per-service architecture —
 * inventory-service and rating-service no longer share a Postgres DB with
 * product-service, so they can't write to `products.stock` /
 * `products.average_rating` directly. They call us instead.
 *
 * Security model: these routes are intentionally NOT exposed by the
 * api-gateway under `/api/*`. They're only reachable from inside the Docker
 * compose / Kubernetes network on the service port. The gateway never
 * proxies anything to `/internal/*`. If you ever expose this service
 * publicly, add a shared-secret header check here.
 */
@RestController
@RequestMapping("/internal/products")
public class InternalProductController {

    private final ProductService service;

    public InternalProductController(ProductService service) {
        this.service = service;
    }

    /**
     * Absolute stock setter — overwrites current value. Called by
     * inventory-service after admin stock-adjustments or sweeper restocks.
     */
    @PutMapping("/{id}/stock")
    public ProductDto setStock(@PathVariable Integer id, @RequestBody StockSetRequest body) {
        if (body == null || body.stock == null || body.stock < 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "stock must be a non-negative integer");
        }
        return service.setStock(id, body.stock);
    }

    /**
     * Atomic delta — used by inventory-service on reserve/release/commit.
     * Negative delta deducts (e.g. on reserve); positive delta restores.
     * Caller is responsible for not letting stock go negative; we'll throw
     * 409 if the operation would.
     */
    @PostMapping("/{id}/stock/adjust")
    public ProductDto adjustStock(@PathVariable Integer id, @RequestBody StockAdjustRequest body) {
        if (body == null || body.delta == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "delta is required");
        }
        return service.adjustStock(id, body.delta);
    }

    /**
     * Rating summary push — called by rating-service after every rating
     * insert/update/delete. Replaces the legacy /{id}/update-ratings
     * endpoint that used to read from a co-located `ratings` table.
     */
    @PostMapping("/{id}/rating-summary")
    public ProductDto setRatingSummary(@PathVariable Integer id, @RequestBody RatingSummaryRequest body) {
        if (body == null || body.avgRating == null || body.totalReviews == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "avgRating and totalReviews are required");
        }
        return service.setRatingSummary(id, body.avgRating, body.totalReviews);
    }

    // ── DTOs ────────────────────────────────────────────────────────

    public static class StockSetRequest {
        @NotNull @Min(0)
        public Integer stock;
    }

    public static class StockAdjustRequest {
        @NotNull
        public Integer delta;
    }

    public static class RatingSummaryRequest {
        @NotNull
        public BigDecimal avgRating;
        @NotNull @Min(0)
        public Integer totalReviews;
    }
}
