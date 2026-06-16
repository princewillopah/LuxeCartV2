package com.luxecart.product.domain;

import jakarta.persistence.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * Maps directly to the existing `products` table defined in
 * database/schema.sql. We deliberately don't let Hibernate manage DDL
 * (`ddl-auto=none`) so the canonical schema stays in SQL.
 *
 * Notes:
 *  - `images` is a Postgres TEXT[]; Hibernate 6 handles native arrays
 *    via `@JdbcTypeCode(SqlTypes.ARRAY)` + matching `columnDefinition`.
 *  - `updatedAt` is bumped manually in the service layer (mirrors the
 *    Node implementation, which set `updated_at = NOW()` in SQL).
 */
@Entity
@Table(name = "products")
public class Product {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Integer id;

    @Column(nullable = false)
    private String name;

    @Column(columnDefinition = "text")
    private String description;

    @Column(nullable = false, precision = 10, scale = 2)
    private BigDecimal price;

    /**
     * Percentage discount applied at sale time. The DB CHECK constraint
     * caps this at 90 — the service layer rejects out-of-range values
     * with a 400 before the INSERT so the error is clearer.
     */
    @Column(name = "discount_percent", nullable = false)
    private Integer discountPercent = 0;

    @Column(nullable = false, length = 100)
    private String category;

    private Integer stock = 0;

    @Column(length = 100)
    private String brand;

    @Column(columnDefinition = "text[]")
    @JdbcTypeCode(SqlTypes.ARRAY)
    private String[] images;

    @Column(name = "average_rating", precision = 3, scale = 2)
    private BigDecimal averageRating = BigDecimal.ZERO;

    @Column(name = "total_reviews")
    private Integer totalReviews = 0;

    @Column(name = "created_at", insertable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at")
    private Instant updatedAt;

    // ─── Lifecycle hooks ────────────────────────────────────────────
    // Keep the legacy behaviour: every write touches updated_at, but
    // the DB DEFAULTs handle created_at on first INSERT.

    @PrePersist
    void onCreate() {
        if (updatedAt == null) updatedAt = Instant.now();
    }

    @PreUpdate
    void onUpdate() {
        updatedAt = Instant.now();
    }

    // ─── Getters / setters ──────────────────────────────────────────

    public Integer getId() { return id; }
    public void setId(Integer id) { this.id = id; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getDescription() { return description; }
    public void setDescription(String description) { this.description = description; }

    public BigDecimal getPrice() { return price; }
    public void setPrice(BigDecimal price) { this.price = price; }

    public Integer getDiscountPercent() { return discountPercent; }
    public void setDiscountPercent(Integer discountPercent) { this.discountPercent = discountPercent; }

    public String getCategory() { return category; }
    public void setCategory(String category) { this.category = category; }

    public Integer getStock() { return stock; }
    public void setStock(Integer stock) { this.stock = stock; }

    public String getBrand() { return brand; }
    public void setBrand(String brand) { this.brand = brand; }

    public String[] getImages() { return images; }
    public void setImages(String[] images) { this.images = images; }

    public BigDecimal getAverageRating() { return averageRating; }
    public void setAverageRating(BigDecimal averageRating) { this.averageRating = averageRating; }

    public Integer getTotalReviews() { return totalReviews; }
    public void setTotalReviews(Integer totalReviews) { this.totalReviews = totalReviews; }

    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
