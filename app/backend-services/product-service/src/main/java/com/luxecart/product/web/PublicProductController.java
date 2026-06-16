package com.luxecart.product.web;

import com.luxecart.product.service.ProductService;
import com.luxecart.product.web.dto.PagedResponse;
import com.luxecart.product.web.dto.ProductDto;
import org.springframework.data.domain.Page;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * Public, unauthenticated endpoints — proxied by the api-gateway at
 * `/api/products/public/**`. Paths and JSON shapes match the legacy
 * Node implementation exactly.
 */
@RestController
@RequestMapping("/public")
public class PublicProductController {

    private final ProductService service;

    public PublicProductController(ProductService service) {
        this.service = service;
    }

    /**
     * GET /public
     *
     * Backward-compatible: when neither `page` nor `limit` (nor
     * `search`) is provided, returns the legacy unwrapped JSON array
     * (and hits the 5-min Redis cache). When any of those are present,
     * returns `{items, total, page, limit}` and skips the cache.
     */
    @GetMapping
    public ResponseEntity<?> list(
            @RequestParam(required = false) String  category,
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer limit,
            @RequestParam(required = false) String  search
    ) {
        boolean hasPagination = page != null || limit != null;
        boolean usesQuery     = hasPagination || (search != null && !search.isBlank());

        if (!usesQuery) {
            // Legacy path → cached array (unwrap the cache wrapper).
            return ResponseEntity.ok(service.listLegacy(category).items());
        }

        Page<ProductDto> pg = service.search(
                category,
                search,
                page  != null ? page  : 1,
                limit != null ? limit : 20
        );
        // When the caller only sent `search` (no pagination), still
        // wrap so the new clients can parse it; the Node version did
        // the same.
        return ResponseEntity.ok(new PagedResponse<>(
                pg.getContent(),
                pg.getTotalElements(),
                pg.getNumber() + 1,
                pg.getSize()
        ));
    }

    /** GET /public/featured?limit=N — top-rated, in-stock items. */
    @GetMapping("/featured")
    public List<ProductDto> featured(@RequestParam(defaultValue = "8") int limit) {
        return service.featured(limit).items();
    }

    /** GET /public/categories — `[{name, count}]`. */
    @GetMapping("/categories")
    public List<ProductService.CategoryCount> categories() {
        return service.categories().items();
    }

    /**
     * GET /public/{id}
     *
     * Registered AFTER /featured + /categories so Spring's routing
     * never tries to interpret those literal segments as an id.
     */
    @GetMapping("/{id}")
    public ProductDto byId(@PathVariable Integer id) {
        return service.get(id);
    }
}
