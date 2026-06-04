# LuxeCart — Frontend v2

Modern Next.js 15 storefront. White / blue / dark-blue theme. Replaces the
legacy single-file React + CDN frontend.

## Stack

- **Next.js 15** (App Router, standalone output)
- **TypeScript** (strict)
- **Tailwind CSS** + shadcn-style primitives
- **next-themes** for dark mode
- **Lucide** icons
- **TanStack Query** + **Zustand** (wired as deps; will be used as pages grow)

## Local dev (without Docker)

```bash
cd frontend-v2
npm install
cp .env.example .env.local
npm run dev
# open http://localhost:3000
```

## Run via docker-compose (recommended)

From the repo root:

```bash
docker compose up -d --build frontend-v2 api-gateway
# open http://localhost:3001
```

The legacy frontend keeps running on port `80` until v2 reaches parity.

## Structure

```
src/
├── app/
│   ├── layout.tsx        # root layout, theme provider, header/footer
│   ├── page.tsx          # home page
│   ├── globals.css       # tailwind + design tokens
│   └── health/route.ts   # /health for container probes
├── components/
│   ├── site-header.tsx
│   ├── site-footer.tsx
│   ├── theme-provider.tsx
│   ├── theme-toggle.tsx
│   ├── api-status.tsx
│   └── ui/button.tsx
└── lib/utils.ts
```

## Build pages next (in order)

1. `/products` — list with filters
2. `/products/[id]` — detail page
3. `/cart` — cart drawer + page
4. `/auth/login`, `/auth/register`
5. `/checkout` — wizard
6. `/account/*` — profile, orders, addresses
