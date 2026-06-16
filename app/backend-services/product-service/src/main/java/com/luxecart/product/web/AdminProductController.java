package com.luxecart.product.web;

import com.luxecart.product.service.ProductService;
import com.luxecart.product.web.dto.ProductDto;
import com.luxecart.product.web.dto.ProductRequest;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * Admin (auth-required) endpoints — proxied by the api-gateway at
 * `/api/products/**` after JWT verification. The gateway forwards
 * `x-user-id`, `x-user-role`, `x-user-email` headers; the role check
 * is enforced one layer up at the gateway (admin pages already do
 * an in-page guard too), so we don't re-check here — matches the
 * legacy Node service's behaviour.
 *
 * Note: the path-rewrite in the gateway is
 * `^/api/products → '' (empty)`, so a POST to /api/products lands
 * on POST '' here. Spring needs an explicit `@RequestMapping("/")`
 * for that to bind, hence the root-level mappings below.
 */
@RestController
public class AdminProductController {

    private final ProductService service;

    public AdminProductController(ProductService service) {
        this.service = service;
    }

    @PostMapping("/")
    public ResponseEntity<ProductDto> create(@Valid @RequestBody ProductRequest req) {
        ProductDto created = service.create(req);
        return ResponseEntity.status(HttpStatus.CREATED).body(created);
    }

    @PutMapping("/{id}")
    public ProductDto update(@PathVariable Integer id, @Valid @RequestBody ProductRequest req) {
        return service.update(id, req);
    }

    @DeleteMapping("/{id}")
    public Map<String, Object> delete(@PathVariable Integer id) {
        Integer deleted = service.delete(id);
        return Map.of("message", "Product deleted", "id", deleted);
    }

    /**
     * Legacy endpoint kept ONLY as a tombstone. Under the database-per-
     * service split, rating-service no longer shares a DB with us and must
     * push the {avgRating,totalReviews} aggregate via
     * POST /internal/products/{id}/rating-summary instead. Returning 410
     * here makes the deprecation explicit so any forgotten caller fails
     * loudly during the migration.
     */
    @PostMapping("/{id}/update-ratings")
    public ProductService.RatingRefresh refreshRatings(@PathVariable Integer id) {
        return service.refreshRatings(id);
    }
}
