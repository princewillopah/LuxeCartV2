Honest take: **defer CI/CD. You're right.** Testing+CI is a 1-2 day distraction that adds zero user-visible value while the app still has gaps. Ship more features → polish → THEN lock it down with CI.

## What I'd actually do next (in priority order)

**1. Phase 6 — Cart polish + abandoned-cart email** (biggest UX win)
- Right now the cart is in-memory/localStorage. Persist it to `carts` table per user so it survives logout/device-switch.
- Wire abandoned-cart email (you already have email-service + RabbitMQ). 1-hour timer → send.
- This is the single feature that makes the demo feel like a real shop.

**2. Phase 9 — Frontend polish** (interview-ready)
- Loading skeletons (you have spinners; skeletons feel modern)
- Error boundaries (one global + one per route)
- a11y: keyboard nav on the admin tables, alt text on product images, focus-visible styles
- SEO: `metadata` exports per page, OG images, sitemap.xml, robots.txt
- This is what recruiters click on first.

**3. Rating-service → product-service cache evict** (the one thing I called out)
- 5 lines in rating-service: after the UPDATE, `fetch('http://product-service:3003/<id>/update-ratings', POST)`. Now ratings invalidate the cache instantly instead of after 5 min.

**4. Phase 8 — Observability dashboards** (portfolio gold)
- You already have Prometheus + Loki + Promtail + Grafana running. Just nobody's looked at them.
- Build 3 dashboards: Orders funnel (created→paid→shipped→delivered with drop-offs), Service health (p95 latency + error rate per service), Payment providers (Paystack vs Flutterwave success rate, avg response).
- This is the single most impressive thing to show in an interview because it proves you understand production, not just code.

**5. Phase 11 — Migrations** (cleanup)
- `golang-migrate` or `node-pg-migrate`. Replace the giant `database/schema.sql` with `001_init.sql, 002_add_addresses.sql, ...`. Important for EKS later but not urgent.

**6. THEN Phase 10 — Testing & CI**
**7. THEN Phase EKS — deploy**

## When you DO get to CI, here's the answer

**Recommended setup** (when you're ready):

```
GitHub Actions workflow:
  on: push to main, pull_request
  jobs:
    1. lint          → eslint (node), golangci-lint (go), spotless/checkstyle (java), ruff (python)
    2. unit-test     → npm test, go test, mvn test, pytest  (parallel per service)
    3. build-images  → docker buildx, push to GHCR (NOT Docker Hub)
    4. integration   → docker compose up, curl smoke tests
```

**Where to push images: GHCR (`ghcr.io/<your-username>/luxecart-product-service`), not Docker Hub.**

Why GHCR over Docker Hub:
- Free unlimited public + private repos (Docker Hub free tier limits private to 1 + adds rate limits)
- Auth uses your existing `GITHUB_TOKEN` automatically — no secrets to manage
- Lives next to your code, single audit trail
- Same pull syntax: `docker pull ghcr.io/you/luxecart-product-service:latest`

**To get the images** locally after the workflow runs:
```bash
echo $GITHUB_TOKEN | docker login ghcr.io -u USERNAME --password-stdin
docker pull ghcr.io/USERNAME/luxecart-product-service:main
```

For deploys, EKS pulls them with an `imagePullSecrets` referencing a GHCR PAT.

**For testing, pragmatic minimum** (don't aim for 80% coverage, aim for the 5 critical paths):
1. Auth: login → access token → /me works → refresh → logout (auth-service)
2. Order: create with valid cart → paid webhook → committed inventory → email sent (order + payment + inventory + email)
3. Payment provider switch: paystack vs flutterwave init both return a redirect URL (payment-service-go)
4. Reservation deadlock fix: 100 concurrent /reserve calls don't deadlock (inventory)
5. Product cache: GET /public twice → second is faster (Redis hit) (product-service)

Skip exhaustive unit tests. Integration tests on those 5 flows = 95% of real bugs caught.

## TL;DR my opinion

Skip CI for now. Spend that time on **cart persistence + observability dashboards + frontend polish**. Those make the app feel finished and look impressive. CI is a chore that should come after the app is actually worth shipping — it's the lock on the door, not the house.

When you're ready, I'd recommend GHCR over Docker Hub, GitHub Actions matrix per service, and integration tests on 5 critical paths instead of unit-test coverage chasing.