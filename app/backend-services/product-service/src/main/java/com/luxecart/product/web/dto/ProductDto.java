package com.luxecart.product.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.luxecart.product.domain.Product;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * Public-facing product representation. Field names mirror the camelCase
 * shape the legacy Node service returned (the React Product type expects
 * exactly these keys).
 *
 * `createdAt` is serialised as an ISO-8601 String (not Instant) for two
 * reasons:
 *   1. The default Spring-Data-Redis Jackson serializer rejects
 *      java.time.* unless an extra module is wired in.
 *   2. The frontend only ever calls `new Date(createdAt)` on it, which
 *      accepts the same ISO string the Node service used to send.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ProductDto(
        Integer    id,
        String     name,
        String     description,
        BigDecimal price,
        Integer    discountPercent,
        String     category,
        Integer    stock,
        String     brand,
        String[]   images,
        BigDecimal averageRating,
        Integer    totalReviews,
        String     createdAt
) {
    /** Convenience builder so controllers / cache layer share one mapping. */
    public static ProductDto from(Product p) {
        Instant created = p.getCreatedAt();
        return new ProductDto(
                p.getId(),
                p.getName(),
                p.getDescription(),
                p.getPrice(),
                p.getDiscountPercent() != null ? p.getDiscountPercent() : 0,
                p.getCategory(),
                p.getStock(),
                p.getBrand(),
                p.getImages(),
                p.getAverageRating() != null ? p.getAverageRating() : BigDecimal.ZERO,
                p.getTotalReviews() != null ? p.getTotalReviews() : 0,
                created != null ? created.toString() : null
        );
    }
}
