# LuxeCart developer commands — run with `just <task>`
# Install just: https://github.com/casey/just  (brew install just / cargo install just)

set shell := ["bash", "-cu"]

default:
    @just --list

# ─── docker compose ───────────────────────────────────────────────────────
up:
    docker compose up -d

down:
    docker compose down

logs service="":
    docker compose logs -f --tail=200 {{service}}

ps:
    docker compose ps

# Bring up only what's needed to develop the new UI
frontend-stack:
    docker compose up -d --build api-gateway frontend-v2 postgres redis rabbitmq

# Rebuild + restart the new Next.js frontend only
frontend-rebuild:
    docker compose up -d --build --force-recreate frontend-v2

# Rebuild one backend service (matrix-style)
service-rebuild name:
    docker compose up -d --build --force-recreate {{name}}

# ─── frontend-v2 (host node) ───────────────────────────────────────────────
dev:
    cd frontend-v2 && npm install && npm run dev

build:
    cd frontend-v2 && npm run build

typecheck:
    cd frontend-v2 && npm run typecheck

lint:
    cd frontend-v2 && npm run lint

# ─── health checks ─────────────────────────────────────────────────────────
health:
    @echo "── api-gateway"  && curl -fsS http://localhost:3000/health | jq .  || true
    @echo "── frontend-v2"  && curl -fsS http://localhost:3001/health | jq .  || true
    @echo "── grafana"      && curl -fsSI http://localhost:3100 | head -1     || true
    @echo "── prometheus"   && curl -fsSI http://localhost:9090 | head -1     || true

# Quick smoke-test of the gateway routes the new UI depends on
api-smoke:
    @echo "GET /health"                && curl -fsS http://localhost:3000/health | jq .
    @echo "GET /api/products/public"   && curl -fsS http://localhost:3000/api/products/public | jq 'length'
    @echo "(register a throwaway user)" \
      && curl -fsS -X POST http://localhost:3000/api/auth/register \
         -H 'Content-Type: application/json' \
         -d '{"email":"smoke+$(date +%s)@luxe.test","password":"Passw0rd!","firstName":"S","lastName":"T"}' | jq '.user.email'

# Clean everything (DESTRUCTIVE — wipes volumes)
nuke:
    docker compose down -v
    @echo "All containers and volumes removed."
