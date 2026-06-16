package com.luxecart.product.domain;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;

/**
 * JPA repository for {@link Product}. We rely on Spring Data's query
 * derivation for the simple cases and write a couple of @Query methods
 * for the public endpoints that need ILIKE search + ordering quirks.
 */
public interface ProductRepository extends JpaRepository<Product, Integer> {

    // ─── Plain listing (legacy unwrapped GET /public) ───────────────

    List<Product> findAllByOrderByCreatedAtDesc();

    List<Product> findAllByCategoryOrderByCreatedAtDesc(String category);

    // ─── Paginated + search (GET /public?page=&limit=&search=) ──────

    /**
     * Case-insensitive search across name/brand/category. Returns a
     * {@link Page} so the controller can build the
     * `{ items, total, page, limit }` response in one shot.
     *
     * Note: `:search` should already be wrapped in `%` by the caller
     * (e.g. "%phone%"); we lowercase the columns here so the LIKE is
     * case-insensitive without needing a functional index.
     */
    @Query("""
           SELECT p FROM Product p
             WHERE (:category IS NULL OR p.category = :category)
               AND (
                    :search IS NULL
                 OR LOWER(p.name)     LIKE :search
                 OR LOWER(p.brand)    LIKE :search
                 OR LOWER(p.category) LIKE :search
               )
           """)
    Page<Product> search(@Param("category") String category,
                         @Param("search")   String search,
                         Pageable           pageable);

    // ─── Featured (top rated → falls back to newest) ────────────────

    @Query("""
           SELECT p FROM Product p
             WHERE p.stock > 0
             ORDER BY p.averageRating DESC NULLS LAST,
                      p.totalReviews DESC NULLS LAST,
                      p.createdAt DESC
           """)
    List<Product> findFeatured(Pageable pageable);

    // ─── Category counts (GET /public/categories) ───────────────────

    @Query("""
           SELECT p.category AS name, COUNT(p) AS count
             FROM Product p
             WHERE p.category IS NOT NULL AND p.category <> ''
             GROUP BY p.category
             ORDER BY COUNT(p) DESC, p.category ASC
           """)
    List<CategoryCount> categoryCounts();

    interface CategoryCount {
        String getName();
        long   getCount();
    }

    // ─── Rating aggregate refresh ───────────────────────────────────
    //
    // The legacy cross-DB query `SELECT ... FROM ratings WHERE product_id`
    // has been removed. Under the database-per-service split, `ratings`
    // lives in `ratings_db` (owned by rating-service) and product-service
    // can no longer reach it. rating-service computes the aggregate
    // locally and pushes it via POST /internal/products/{id}/rating-summary,
    // which calls ProductService.setRatingSummary() and updates the
    // denormalized columns directly via the Product entity.
}
