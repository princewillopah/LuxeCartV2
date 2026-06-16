package com.luxecart.product.web.dto;

import java.util.List;

/**
 * Generic paginated response envelope used by GET /public when the
 * caller supplies `page` / `limit` query params. Matches the
 * `{ items, total, page, limit }` shape the admin pages + the
 * frontend `Paged<T>` type expect.
 */
public record PagedResponse<T>(
        List<T> items,
        long    total,
        int     page,
        int     limit
) {}
