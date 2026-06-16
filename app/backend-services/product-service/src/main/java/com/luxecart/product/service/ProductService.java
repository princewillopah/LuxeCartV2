package com.luxecart.product.service;

import com.luxecart.product.domain.Product;
import com.luxecart.product.domain.ProductRepository;
import com.luxecart.product.web.dto.ProductDto;
import com.luxecart.product.web.dto.ProductRequest;
import org.springframework.cache.annotation.CacheEvict;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.cache.annotation.Caching;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;

import java.math.BigDecimal;
import java.util.List;

/**
 * Business logic for the product catalog. Caching is declarative
 * (`@Cacheable` / `@CacheEvict`) so the controller stays a thin
 * HTTP adapter.
 *
 * Cache invalidation strategy on mutations:
 *  - All entries under `productsList` are evicted (covers `all`,
 *    `category:Electronics`, etc.)
 *  - `productsFeatured` is fully evicted (it depends on stock/rating
 *    which a mutation may have changed)
 *  - `productsCategories` is evicted (counts may have changed)
 *  - The single-product entry is evicted by id
 *
 * This is broader than the Node version (which scanned for specific
 * keys), but it's correct and simpler, and the catalog isn't large
 * enough for the extra cache misses to matter.
 */
@Service
public class ProductService {

    /** Same upper bound as the Node service so the DB constraint never fires. */
    private static final int MAX_DISCOUNT = 90;

    private final ProductRepository repo;
    private final ProductEventPublisher events;

    public ProductService(ProductRepository repo, ProductEventPublisher events) {
        this.repo = repo;
        this.events = events;
    }

    // ─── Reads ──────────────────────────────────────────────────────

    /**
     * Legacy unwrapped list — cached. Key is the category (or "all" when
     * no filter), so the same Redis entry serves every visitor of that
     * category until something mutates it.
     *
     * Returns a wrapper record (not a bare `List`) so the Redis JSON
     * serializer can tag it with a class identifier on the way in and
     * find it again on the way out. Controllers call `.items()`.
     */
    @Cacheable(value = "productsList", key = "(#category == null || #category == 'all') ? 'all' : 'category:' + #category")
    public ProductList listLegacy(String category) {
        List<Product> rows = (category == null || "all".equalsIgnoreCase(category))
                ? repo.findAllByOrderByCreatedAtDesc()
                : repo.findAllByCategoryOrderByCreatedAtDesc(category);
        return new ProductList(rows.stream().map(ProductDto::from).toList());
    }

    /**
     * Paginated / search variant — NOT cached because results vary by
     * `page`, `limit`, `search`, and `category` combined (the cache
     * key explosion isn't worth the hit rate).
     */
    public Page<ProductDto> search(String category, String search, int page, int limit) {
        // Match the Node clamps so the contract is byte-for-byte identical.
        int safePage  = Math.max(page, 1);
        int safeLimit = Math.min(Math.max(limit, 1), 200);

        String catFilter = (category == null || "all".equalsIgnoreCase(category) || category.isBlank())
                ? null : category;
        String like = (search == null || search.isBlank())
                ? null : "%" + search.toLowerCase() + "%";

        Pageable pageable = PageRequest.of(safePage - 1, safeLimit, Sort.by(Sort.Direction.DESC, "createdAt"));
        return repo.search(catFilter, like, pageable).map(ProductDto::from);
    }

    @Cacheable(value = "productsFeatured", key = "'limit:' + #limit")
    public ProductList featured(int limit) {
        int safe = Math.min(Math.max(limit, 1), 24);
        return new ProductList(
                repo.findFeatured(PageRequest.of(0, safe)).stream()
                        .map(ProductDto::from).toList());
    }

    @Cacheable(value = "productsCategories", key = "'all'")
    public Categories categories() {
        return new Categories(
                repo.categoryCounts().stream()
                        .map(c -> new CategoryCount(c.getName(), c.getCount()))
                        .toList());
    }

    /** Wrapper used as the cached value for product-list responses. */
    public record ProductList(List<ProductDto> items) {}

    /** Wrapper used as the cached value for the category-count response. */
    public record Categories(List<CategoryCount> items) {}

    /** Public-facing category count DTO (mirrors the Node `{name, count}`). */
    public record CategoryCount(String name, long count) {}

    @Cacheable(value = "productSingle", key = "#id")
    public ProductDto get(Integer id) {
        return repo.findById(id)
                .map(ProductDto::from)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Product not found"));
    }

    // ─── Writes ─────────────────────────────────────────────────────
    // All three mutators evict every list-shaped cache. Single-product
    // entries are evicted by id on update / delete.

    @Transactional
    @Caching(evict = {
            @CacheEvict(value = "productsList",       allEntries = true),
            @CacheEvict(value = "productsFeatured",   allEntries = true),
            @CacheEvict(value = "productsCategories", allEntries = true)
    })
    public ProductDto create(ProductRequest req) {
        Product p = new Product();
        applyRequest(p, req);
        ProductDto dto = ProductDto.from(repo.save(p));
        events.publishCreated(dto);
        return dto;
    }

    @Transactional
    @Caching(evict = {
            @CacheEvict(value = "productsList",       allEntries = true),
            @CacheEvict(value = "productsFeatured",   allEntries = true),
            @CacheEvict(value = "productsCategories", allEntries = true),
            @CacheEvict(value = "productSingle",      key = "#id")
    })
    public ProductDto update(Integer id, ProductRequest req) {
        Product p = repo.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Product not found"));
        applyRequest(p, req);
        ProductDto dto = ProductDto.from(repo.save(p));
        events.publishUpdated(dto);
        return dto;
    }

    @Transactional
    @Caching(evict = {
            @CacheEvict(value = "productsList",       allEntries = true),
            @CacheEvict(value = "productsFeatured",   allEntries = true),
            @CacheEvict(value = "productsCategories", allEntries = true),
            @CacheEvict(value = "productSingle",      key = "#id")
    })
    public Integer delete(Integer id) {
        Product p = repo.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Product not found"));
        repo.delete(p);
        events.publishDeleted(p.getId());
        return p.getId();
    }

    /**
     * Legacy refresh — kept ONLY for backwards compatibility with the old
     * route. Under the database-per-service split, product-service no longer
     * shares a DB with `ratings`, so this path can't actually query the
     * aggregate. It throws GONE so any stale caller fails loudly. New
     * callers must use POST /internal/products/{id}/rating-summary with
     * the aggregate already computed in their own DB.
     */
    @Deprecated
    public RatingRefresh refreshRatings(Integer id) {
        throw new ResponseStatusException(HttpStatus.GONE,
                "GET /update-ratings no longer cross-queries the ratings table. " +
                "Use POST /internal/products/{id}/rating-summary with {avgRating,totalReviews}.");
    }

    public record RatingRefresh(BigDecimal avgRating, int totalReviews) {}

    /**
     * Push the pre-computed rating summary from rating-service into the
     * denormalized columns on `products`. Replaces the legacy refresh that
     * relied on a same-DB JOIN against the `ratings` table.
     */
    @Transactional
    @Caching(evict = {
            @CacheEvict(value = "productsList",     allEntries = true),
            @CacheEvict(value = "productsFeatured", allEntries = true),
            @CacheEvict(value = "productSingle",    key = "#id")
    })
    public ProductDto setRatingSummary(Integer id, BigDecimal avgRating, Integer totalReviews) {
        Product p = repo.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Product not found"));
        p.setAverageRating(avgRating == null ? BigDecimal.ZERO : avgRating);
        p.setTotalReviews(totalReviews == null ? 0 : totalReviews);
        ProductDto dto = ProductDto.from(repo.save(p));
        events.publishUpdated(dto);
        return dto;
    }

    /**
     * Hard-set the stock for a product. Called by inventory-service after
     * admin stock-adjust / sweeper restock operations.
     */
    @Transactional
    @Caching(evict = {
            @CacheEvict(value = "productsList",     allEntries = true),
            @CacheEvict(value = "productsFeatured", allEntries = true),
            @CacheEvict(value = "productSingle",    key = "#id")
    })
    public ProductDto setStock(Integer id, Integer stock) {
        Product p = repo.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Product not found"));
        p.setStock(stock);
        ProductDto dto = ProductDto.from(repo.save(p));
        events.publishUpdated(dto);
        return dto;
    }

    /**
     * Atomic stock delta. Called by inventory-service on reserve (delta<0),
     * release (delta>0), and commit (delta=0 → no-op). Throws 409 if the
     * resulting stock would be negative — caller is expected to have
     * already checked availability against their own SoT before calling.
     */
    @Transactional
    @Caching(evict = {
            @CacheEvict(value = "productsList",     allEntries = true),
            @CacheEvict(value = "productsFeatured", allEntries = true),
            @CacheEvict(value = "productSingle",    key = "#id")
    })
    public ProductDto adjustStock(Integer id, Integer delta) {
        if (delta == null || delta == 0) {
            return get(id);
        }
        Product p = repo.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Product not found"));
        int next = (p.getStock() == null ? 0 : p.getStock()) + delta;
        if (next < 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "stock would go negative (current=" + p.getStock() + ", delta=" + delta + ")");
        }
        p.setStock(next);
        ProductDto dto = ProductDto.from(repo.save(p));
        events.publishUpdated(dto);
        return dto;
    }

    // ─── Helpers ────────────────────────────────────────────────────

    private static void applyRequest(Product p, ProductRequest req) {
        p.setName(req.name());
        p.setDescription(req.description());
        p.setPrice(req.price());
        p.setDiscountPercent(clampDiscount(req.discountPercent()));
        p.setCategory(req.category());
        p.setStock(req.stock() == null ? 0 : req.stock());
        p.setBrand(req.brand());
        p.setImages(req.images());
    }

    /**
     * Normalises the discountPercent payload. Mirrors `clampDiscount()`
     * in the legacy Node service: accepts null/missing as 0, rejects
     * out-of-range (0..90) with a 400.
     */
    private static int clampDiscount(Integer raw) {
        if (raw == null) return 0;
        if (raw < 0 || raw > MAX_DISCOUNT) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "discountPercent must be an integer between 0 and " + MAX_DISCOUNT);
        }
        return raw;
    }
}
