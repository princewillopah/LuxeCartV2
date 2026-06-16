/**
 * Canonical product categories shown in admin dropdowns.
 *
 * Why a constant (not a database table)?
 *   For a small storefront, a hardcoded list is the right size — no extra
 *   service, no extra schema, no extra cache invalidation.
 *
 * Want a "Categories" admin page later? Promote this to:
 *   - a `categories` table in postgres (id, name, slug)
 *   - `/api/products/categories` endpoint (already trivial via product-service)
 *   - an admin page at /admin/categories
 * For now this is enough.
 */
export const PRODUCT_CATEGORIES = [
  "Electronics",
  "Accessories",
  "Sports",
  "Home & Kitchen",
  "Beauty",
  "Books",
  "Clothing",
  "Toys",
  "Other",
] as const;

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];
