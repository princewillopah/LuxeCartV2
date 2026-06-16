Read [](file:///home/princewillopah/DevOps/LuxeCartV2/services)

Searched for regex `app.use\('/api` (`**/LuxeCartV2/services/api-gateway-service/server.js`), 20 results

Searched for regex `/api/` (`**/LuxeCartV2/frontend-v2/src/**`), 20 results

Searched for regex `/api/` (`**/LuxeCartV2/frontend-v2/src/lib/api.ts`), 20 results

Read [](file:///home/princewillopah/DevOps/LuxeCartV2/frontend-v2/src/lib/api.ts#196-196), lines 196 to 360

Searched for regex `/api/(payments|notifications|inventory|analytics|recommendations|email)` (`**/LuxeCartV2/**`), 18 results

Searched for regex `consume|subscribe|assertQueue|bindQueue|consumeEvent` (`**/LuxeCartV2/services/**`), 56 results

Searched for regex `consume|app\.|router\.|@app|/recommendations` (`**/LuxeCartV2/services/recommendation-service/main.py`), 19 results

Searched for regex `consume|@app|/analytics` (`**/LuxeCartV2/services/analytics-service/main.py`), 19 results

Searched for regex `analytics|app\.get|app\.post` (`**/LuxeCartV2/services/admin-service/server.js`), 10 results

Searched for regex `app\.get|app\.post|publishEvent|consumeEvents` (`**/LuxeCartV2/services/payment-service/server.js`), 10 results

Searched for regex `payment|payment-service|publishEvent` (`**/LuxeCartV2/services/order-service/server.js`), 11 results

Searched for regex `app\.get|app\.post|publishEvent|sendEmail|axios|fetch` (`**/LuxeCartV2/services/notification-service/server.js`), 7 results

Read [](file:///home/princewillopah/DevOps/LuxeCartV2/services/notification-service/server.js#40-40), lines 40 to 110

Searched for regex `inventory|axios|fetch` (`**/LuxeCartV2/services/cart-service/server.js`), 1 result

Searched for regex `app\.get|app\.post|inventory_` (`**/LuxeCartV2/services/inventory-service/server.js`), 7 results

Searched for regex `@app\.|routing_key|user\.|order\.|payment\.` (`**/LuxeCartV2/services/email-service/main.py`), 20 results

Searched for regex `payments|checkout|payment\.` (`**/LuxeCartV2/frontend-v2/**`), 19 results

Read [](file:///home/princewillopah/DevOps/LuxeCartV2/frontend-v2/src/app/checkout/page.tsx#30-30), lines 30 to 110

Searched for regex `app\.get|app\.post|app\.delete` (`**/LuxeCartV2/services/rating-service/server.js`), 6 results

Searched for regex `rating|app\.get|app\.post` (`**/LuxeCartV2/services/review-service/server.js`), 11 results

Done. Here's the breakdown after tracing every service against the frontend (api.ts), the gateway proxy table, and the RabbitMQ consumers.

## Dead weight — frontend never calls, no working event path produces useful side-effects

### 1. `payment-service` — completely unused
- The `/checkout` page collects card data, calls `api.createOrder(...)`, then redirects to `/account?tab=orders`. **It never calls `/api/payments/process`.**
- order-service publishes `order.created` (consumed by notification, inventory, email, search — none of which charge a card).
- Nothing publishes `payment.completed` or `payment.failed`, so the consumers in notification-service and email-service for those events sit idle forever.
- Net effect: payment-service is a stub that nobody talks to. Card data entered on checkout is **silently dropped** (you can confirm — buy something, no row is inserted into `payments`).

### 2. `analytics-service` — duplicated by admin-service
- Frontend uses `adminDashboardStats`, `adminRevenueAnalytics`, `adminTopProducts` → all hit **admin-service** (admin-service/server.js at `/dashboard/stats`, `/analytics/revenue`, `/analytics/top-products`).
- analytics-service (Python/FastAPI) exposes 7 richer endpoints (`/analytics/revenue/summary`, `/by-category`, `/customers/top`, `/lifetime-value`, `/products/best-sellers`, `/low-performers`, `/dashboard`) — **none are called by anyone**.
- It's proxied at `/api/analytics` in the gateway but no frontend or backend invokes it.

### 3. `recommendation-service` — never invoked
- Exposes `/recommendations/collaborative/{id}`, `/similar/{id}`, `/trending`, `/for-user/{id}`, `/track-view`, `/recently-viewed/{id}`.
- `grep "/api/recommendations"` in the frontend returns **zero** matches outside the gateway config and docs.
- The product page doesn't render "you may also like…" — nothing pulls trending or similar items.

## Working but reaches a dead end (alive, but data has no consumer)

### 4. `notification-service` — half-functional
- Consumes events correctly and writes rows into `notifications` table (welcome, order confirmation, status updates, payment success/fail).
- Frontend has **no `/notifications` page or notification bell** — `grep "/api/notifications"` in the frontend = 0 hits.
- So users accumulate in-app notifications they can never see. (Email versions of the same events *are* sent — that's email-service's job.)

### 5. `inventory-service` — partially used
- Decrements stock on `order.created` (useful background work).
- BUT the `products.stock` column already exists and `product-service` is the source of truth the rest of the system reads from. Inventory-service has its own `stock/*` endpoints nothing queries.
- Borderline keep — only if you plan to add an admin "low stock" page (the endpoint `/stock/low` is already there waiting).

## Borderline redundancy (could be merged, not "useless")

### `rating-service` + `review-service`
- They're two separate services for one product-review feature — and review-service already does `SELECT … FROM ratings` directly. The split is academic for this scale; merging into one `reviews-service` would cut a container without losing features.

## Verdict — the truly useless three

| Service | Why it's dead | Action |
|---|---|---|
| `payment-service` | Frontend doesn't POST to it; no event consumer triggers it. Card data on checkout is dropped. | **Delete or wire it up** to actually charge cards before order is finalized. |
| `analytics-service` | Duplicated by admin-service which the frontend actually uses. | **Delete**, or migrate admin's analytics calls to use it and delete admin's analytics endpoints. |
| `recommendation-service` | Zero callers anywhere. | **Delete**, or surface "trending" / "similar products" in the UI to make it earn its container. |

If you want a meaningful demo, I'd argue the better fix isn't deletion — it's *wiring* them up. Three small frontend tasks make this whole thing legit:

1. **Checkout**: between `api.createOrder` and `clear()`, call `api.processPayment(orderId, …)`. payment-service then publishes the `payment.completed` event that notification + email are already waiting for.
2. **Header bell**: add a notification dropdown that calls `GET /api/notifications/user/:userId/unread-count` + list — gives the notification-service a reason to exist.
3. **Product page**: load `GET /api/recommendations/similar/:id` and `/api/recommendations/trending` for a "You may also like" section.

