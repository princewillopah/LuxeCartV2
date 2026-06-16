# Phase D — Database-Per-Service Migration Plan

## Goal
Move from one shared `ecommerce` Postgres DB to one dedicated DB per service —
the textbook bounded-context isolation that every real microservices stack
requires. This is the second half of the "industry standard, nothing short"
mandate (the first half — Kafka swap — is complete and verified).

## Why this matters
- **Today:** every service connects to the same `ecommerce` DB. Multiple
  services do cross-domain SQL JOINs across tables that conceptually belong to
  other services (rating→users, cart→users, user→products, admin→orders,
  analytics→4 tables, recommendation→3 tables). This makes the DB a hidden
  coupling layer — any schema change ripples across services, and the DB is a
  single point of failure for the whole platform.
- **After:** each service owns its data. Cross-service queries go through
  REST/events. Schema migrations are local. Each DB can be scaled, backed up,
  encrypted, and replicated independently. This is what we'd put in front of
  EKS.

## Final topology

| Service                | Database                | Tables                                                                                   |
|------------------------|-------------------------|------------------------------------------------------------------------------------------|
| auth-service           | `auth_db`               | `users` (auth fields + profile), `auth_tokens`, `auth_audit_log`, `refresh_tokens`       |
| user-service           | `users_db`              | `user_addresses`, `wishlists` (NO `users` table — reads via HTTP from auth-service)      |
| product-service        | `products_db`           | `products` (no `stock` column)                                                           |
| cart-service           | `carts_db`              | `carts` (+ denormalized `user_email`/`user_first_name`), `cart_items`                    |
| order-service          | `orders_db`             | `orders`, `order_items`, `order_status_history`                                          |
| review-service         | `reviews_db`            | `reviews`                                                                                |
| rating-service         | `ratings_db`            | `ratings` (+ denormalized `user_name`)                                                   |
| notification-service   | `notifications_db`      | `notifications`                                                                          |
| inventory-service      | `inventory_db`          | `product_stock` (NEW — SoT for stock), `reservations`                                    |
| payment-service-go     | `payments_db`           | `payments`, `payment_attempts`, `payment_idempotency` ✅ already                         |
| image-service          | `image_db`              | image metadata ✅ already                                                                |
| email-service          | MongoDB                 | email logs ✅ already                                                                    |
| search-service         | Elasticsearch           | product index ✅ already                                                                 |
| analytics-service      | `analytics_db`          | event-driven projections: `daily_revenue`, `top_products`, `user_signups_by_day`         |
| recommendation-service | `recommendation_db`     | event-driven projections: `user_purchases`, `product_co_purchases`                       |
| admin-service          | (no DB)                 | composes responses via HTTP calls to other services                                      |

## Strategic decisions

### 1. `users` table stays in auth-service
**Pragmatic choice.** auth-service is the writer for users (register, login,
password reset, email verify, lockout counter). Splitting users into a tiny
"credentials" table in auth_db + a "profile" table in users_db would force a
2-phase create on every signup with Saga compensation logic — too much surface
for too little gain when there's exactly one writer. user-service keeps only
data IT owns (`user_addresses`, `wishlists`) and fetches user identity via
HTTP from auth-service or directly from the JWT.

### 2. Stock moves from product-service to inventory-service
**Strict pattern.** `products.stock` column is removed from products_db.
inventory_db gets a new `product_stock` table (product_id PK, stock_quantity,
updated_at). Inventory-service becomes the source of truth for stock levels.

**Sync flow:**
- product-service emits `product.created` / `product.updated` /
  `product.deleted` events to Kafka.
- inventory-service consumes those events to create/update/delete its
  `product_stock` rows.
- When stock changes (reservation, restock), inventory-service updates
  `product_stock` directly and publishes `inventory.stock_changed`.
- For display: frontend reads stock from inventory-service's existing
  `GET /inventory/stock/:productId` endpoint, or via API gateway composition.

### 3. Analytics & recommendation become event-driven projections
These two services are already shelf-ware (not called by the frontend yet).
We use the migration as an opportunity to rebuild them as **CQRS read-side
projections** — exactly what Kafka was added for. They consume domain events
and maintain their own denormalized read tables in their own DBs.

This is the canonical use case for Kafka's 7-day retention: a new service
can be added and replay history to backfill its read model.

## Cross-domain JOINs to eliminate

| File                                              | Current JOIN                              | Fix                                                                       |
|---------------------------------------------------|-------------------------------------------|---------------------------------------------------------------------------|
| `services/rating-service/server.js` ~L199         | `ratings JOIN users`                      | Snapshot `user_name` into `ratings` on INSERT                             |
| `services/cart-service/server.js` ~L438 (sweeper) | `carts JOIN users`                        | Snapshot `user_email`, `user_first_name` into `carts` on first activity   |
| `services/user-service/server.js` ~L292           | `wishlists JOIN products`                 | HTTP call to product-service GET `/products/by-ids?ids=...`               |
| `services/admin-service/server.js` ~L146          | `products LEFT JOIN order_items`          | HTTP composition: call order-service for top SKU ids, then product-service|
| `services/recommendation-service/server.js`       | 3-table JOIN                              | REWRITE as Kafka projection: consume `order.created`, build own tables    |
| `services/analytics-service/server.js`            | 4-table JOIN                              | REWRITE as Kafka projection: consume domain events, build own read model  |

## Cross-database FKs to drop
All FK constraints that reference tables in other DBs must be dropped (Postgres
cannot enforce FKs across databases). App-level integrity replaces them.

- `orders.user_id` → users
- `order_items.product_id` → products
- `reviews.user_id`, `reviews.product_id`
- `ratings.user_id`, `ratings.product_id`
- `wishlists.product_id` (wishlists.user_id stays — same DB as nothing... actually it goes to users_db where users table doesn't exist, so this also drops)
- `notifications.user_id`
- `carts.user_id`
- `reservations.product_id`

FKs that stay (same-DB):
- `auth_tokens.user_id`, `refresh_tokens.user_id`, `auth_audit_log.user_id` (all in auth_db)
- `user_addresses.user_id` ← actually NO, users not in users_db. DROP this too.
- `cart_items.cart_id` (carts_db)
- `order_items.order_id`, `order_status_history.order_id` (orders_db)

## Execution slices

### D1 — Code refactors on the shared DB
Touch one service at a time. After each, restart and smoke-test. Keep the
shared `ecommerce` DB intact during this phase so any regression is reversible.

1. rating-service: add `user_name` column, snapshot on insert, drop JOIN
2. cart-service: add `user_email`/`user_first_name` columns, write on cart
   touch from `x-user-email` header, drop sweeper JOIN
3. user-service: replace wishlist JOIN with HTTP call to product-service
4. admin-service: HTTP composition for bestseller report
5. product-service: emit `product.created`/`product.updated`/`product.deleted`
6. inventory-service: add `product_stock` table; consume product events to
   populate it; switch all stock reads/writes from `products.stock` to
   `product_stock`
7. product-service: drop `stock` column (read it via HTTP from inventory when
   product details are requested, OR maintain a denormalized cache via the
   `inventory.stock_changed` event — pick simpler: HTTP call on demand)
8. analytics-service: rewrite as Kafka consumer with own read tables
9. recommendation-service: rewrite as Kafka consumer with own read tables

### D2 — Database split
1. Write `database/init-databases.sql` that runs at Postgres bootstrap to
   create all 9 new DBs (idempotent — `CREATE DATABASE IF NOT EXISTS` via
   DO block).
2. Write per-DB schema files in `database/schemas/`:
   `auth_db.sql`, `users_db.sql`, `products_db.sql`, `carts_db.sql`,
   `orders_db.sql`, `reviews_db.sql`, `ratings_db.sql`,
   `notifications_db.sql`, `inventory_db.sql`, `analytics_db.sql`,
   `recommendation_db.sql`.
   Each contains only the tables that DB owns, with all cross-DB FKs removed.
3. Bootstrap the new DBs in the running Postgres (idempotent).
4. Migrate data: `INSERT INTO <new_db>.<table> SELECT ... FROM ecommerce.<table>`
   via `dblink` extension OR pg_dump+pg_restore per table.
5. Update each service's `DATABASE_URL` env var in `docker-compose.yml`.
6. Restart all services.

### D3 — Live test
Re-run the full Kafka test matrix from Phase K plus a few new things:
- Register, login, profile fetch (proves auth_db + users_db split)
- Create product, list products (product_db works)
- Add to cart, view cart (carts_db works)
- Place order (orders_db works, no FK to users)
- Reserve / commit stock (inventory_db with product_stock works)
- Rate a product (ratings_db with denormalized user_name works)
- View wishlist (user-service ⇆ product-service HTTP works)
- Admin bestsellers (admin-service composition works)
- Trigger analytics projection consumer (consume order.created → row in analytics_db)

### D4 — Cleanup
- Drop the old `ecommerce` DB tables that have been migrated (keep DB itself
  for now as backup). Or keep all data, just stop using it.
- Update `services/serice-descriptions.md` with new topology.
- Update `/memories/repo/luxecart-status.md` with completion entry.

## Risk register
- **Data drift during migration**: do migration with services stopped (5 min
  window) to avoid in-flight writes splitting between old and new.
- **HTTP call latency in wishlist/admin paths**: small N (wishlist usually
  ≤10 items, bestsellers ≤20). Acceptable. If it becomes an issue we add a
  denormalized cache or move to event projection.
- **product→inventory split breaks display**: every place that currently reads
  `products.stock` (admin product list, storefront product cards) needs
  updating to read from inventory-service. Audit all such reads BEFORE
  dropping the column.
