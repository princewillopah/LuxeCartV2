Got it — holding EKS until the app is production-ready. Here's the roadmap from where we are to "ready to ship":

## Where we stand

- **Auth, orders, payments (Go), email, inventory, etc.** all working end-to-end
- **DB-per-service** started (payments_db) — pattern proven
- **Event-driven** integration between payment ↔ order via RabbitMQ
- **Paystack live integration** validated

## Phases to reach full app readiness

### Phase 3 — Order lifecycle completion (HIGH)
The order flow ends at `processing`. Real apps need the rest of the states.
- Add `shipped`, `delivered`, `cancelled`, `refunded` transitions
- Admin "Mark as shipped / delivered" endpoints with audit trail
- Email triggers on each state change (template per event)
- Customer-facing "cancel order" while `pending` or `processing`
- Refund flow → Paystack refund API → publish `payment.refunded` → order moves to `refunded`

### Phase 4 — Inventory hardening (HIGH)
Today inventory probably decrements naively. Production needs:
- Reservation pattern: stock reserved at order creation, committed on `payment.completed`, released on `payment.failed` or `order.cancelled`
- Prevent oversell under concurrency (row locks or atomic decrement with check)
- Low-stock event → notification to admin
- Restock endpoint

### Phase 5 — Search & catalog quality (MEDIUM)
- Elasticsearch/OpenSearch (or Meilisearch for simplicity) instead of LIKE queries
- Faceted filters (price, category, rating, in-stock)
- Autocomplete
- Re-index on product create/update events

### Phase 6 — Cart durability & checkout polish (MEDIUM)
- Persistent cart (Redis with TTL, or DB)
- Guest cart → merge on login
- Stock-availability check before checkout
- Address book (saved addresses for users)

### Phase 7 — Auth & security hardening (HIGH — blocks production)
- Password reset flow (email token)
- Email verification on signup
- Rate limiting on auth endpoints (Redis token bucket via gateway)
- Refresh tokens + JWT rotation
- Proper RBAC (admin/staff/customer) consistently enforced
- Input validation everywhere (zod/joi at gateway or per service)
- CORS lockdown, helmet, security headers
- Secrets out of `.env` into something checked (sealed-secrets later for k8s)

### Phase 8 — Observability (MEDIUM — needed before prod)
- Loki/Promtail already there — make sure all services log structured JSON
- Trace IDs propagated end-to-end (you have RequestID middleware; ensure gateway forwards it)
- Grafana dashboards: orders/min, payment success rate, p95 latency per service, DB pool saturation
- Alerts: payment failure spike, RabbitMQ queue backlog, DB connection errors

### Phase 9 — Frontend gaps (MEDIUM)
- Order history page + order detail
- Refund/cancel buttons
- Admin dashboard polish (real metrics, not just CRUD)
- Loading & error states everywhere
- Mobile responsiveness pass

### Phase 10 — Testing & CI (HIGH — blocks prod)
- Unit tests on critical paths (payment settlement, inventory reservation, auth)
- Integration tests using docker-compose
- GitHub Actions: lint → test → build images → push to registry
- Pre-commit hooks

### Phase 11 — Data & ops readiness (BEFORE EKS)
- DB migrations tool (no more raw SQL files) — `migrate` for Go, `node-pg-migrate` or Prisma for Node
- Backup strategy (pg_dump cron locally, RDS snapshots later)
- Seed data separation (dev/demo/prod)
- One-command bootstrap for new devs

---

## Suggested order (my recommendation)

| Order | Phase | Why first |
|---|---|---|
| 1 | **Phase 7 — Security hardening** | Anything unsafe blocks prod; cheap to fix now |
| 2 | **Phase 4 — Inventory reservation** | Single biggest correctness risk; oversell = money loss |
| 3 | **Phase 3 — Order lifecycle** | Closes the visible UX gap |
| 4 | **Phase 10 — Testing & CI** | From now on every change is protected |
| 5 | **Phase 11 — Migrations & ops** | Required for any clean deploy |
| 6 | **Phase 8 — Observability** | Needed to operate, but works without |
| 7 | **Phase 6 — Cart polish** | Nice-to-have |
| 8 | **Phase 9 — Frontend polish** | Iterate continuously |
| 9 | **Phase 5 — Search** | Defer; works without |
| 10 | **Phase 2 — EKS** | Final step |

**Which one do you want to start?** My pick would be **Phase 7 (security)** — it's the biggest gap between "demo app" and "production app," and fixing it now is easier than retrofitting later.