# LuxeCart — API Gateway Audit

> Generated from inspecting `services/api-gateway-service/server.js`.
> All routes are mounted under the gateway listening on **`:3000`** in compose.

## Auth header

Protected routes require:

```
Authorization: Bearer <jwt>
```

JWT is issued by `POST /api/auth/login` and `POST /api/auth/register`.

## Public routes (no auth)

| Method | Path                                  | Service        | Notes                                     |
|------- |---------------------------------------|----------------|-------------------------------------------|
| GET    | `/health`                             | gateway        | gateway liveness                          |
| GET    | `/metrics`                            | gateway        | Prometheus exposition                     |
| POST   | `/api/auth/register`                  | auth-service   | `{email, password, firstName, lastName}`  |
| POST   | `/api/auth/login`                     | auth-service   | `{email, password}`                       |
| GET    | `/api/products/public`                | product        | optional `?category=`                     |
| GET    | `/api/products/public/:id`            | product        | single product                            |
| GET    | `/api/reviews/public/:productId`      | review         | reviews for a product                     |
| GET    | `/api/search?q=`                      | search         | Elasticsearch-backed                      |
| GET    | `/api/recommendations`                | recommendation | (also handles `/recommendations/...`)     |

## Authenticated routes

| Method | Path                            | Service        |
|------- |---------------------------------|----------------|
| ANY    | `/api/users/**`                 | user-service   |
| ANY    | `/api/products/**`              | product        |
| ANY    | `/api/cart/**`                  | cart           |
| ANY    | `/api/orders/**`                | order          |
| ANY    | `/api/reviews/**`               | review         |
| ANY    | `/api/ratings/**`               | rating         |
| ANY    | `/api/payments/**`              | payment        |
| ANY    | `/api/notifications/**`         | notification   |
| ANY    | `/api/inventory/**`             | inventory      |

## Admin-only routes

| Method | Path                  | Service    |
|------- |-----------------------|------------|
| ANY    | `/api/admin/**`       | admin      |
| ANY    | `/api/analytics/**`   | analytics  |
| ANY    | `/api/email/**`       | email      |

## Known data shapes (from product-service)

```ts
type Product = {
  id: string | number;
  name: string;
  description: string;
  price: number;
  category: string;
  stock: number;
  brand?: string;
  images?: string[];
  averageRating?: number;
  totalReviews?: number;
  createdAt?: string;
};

type AuthResponse = {
  token: string;
  user: {
    id: string | number;
    email: string;
    firstName: string;
    lastName: string;
    role: "user" | "admin";
  };
  message?: string;
};
```

## CORS

Gateway sets `origin: '*'` and allows `GET, POST, PUT, DELETE, PATCH, OPTIONS`.
Safe for dev. For production:

```js
const corsOptions = {
  origin: process.env.CORS_ORIGIN?.split(",") ?? ["https://luxecart.com"],
  credentials: true,
};
```

## Smoke-test commands

```bash
# Gateway up?
curl -s http://localhost:3000/health | jq

# Product catalog
curl -s http://localhost:3000/api/products/public | jq 'length'

# Register a throwaway user
curl -s -X POST http://localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@luxe.test","password":"Passw0rd!","firstName":"Demo","lastName":"User"}' | jq

# Login
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@luxe.test","password":"Passw0rd!"}' | jq -r .token)

# Authenticated call
curl -s http://localhost:3000/api/cart -H "Authorization: Bearer $TOKEN" | jq
```

## Known gaps the new UI needs

These are not yet implemented (or unverified) on the backend — track them as issues:

- [ ] `GET /api/users/me` — currently unverified; UI assumes it exists
- [ ] Cart endpoints: PUT/DELETE per item (UI uses local-only cart for now)
- [ ] Search facets (categories, brands, price buckets)
- [ ] Email verification flow (`/api/auth/verify-email/:token`)
- [ ] Password reset (`/api/auth/forgot`, `/api/auth/reset`)
- [ ] Order status webhooks (UI would surface real-time updates)
