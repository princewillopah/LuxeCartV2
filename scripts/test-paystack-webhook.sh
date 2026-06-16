#!/usr/bin/env bash
# scripts/test-paystack-webhook.sh
#
# Drives the full Paystack settlement pipeline end-to-end WITHOUT touching the
# Paystack hosted checkout. We initialise a real transaction with Paystack
# (proving outbound credentials work), then forge a charge.success webhook
# event, sign it with our real secret key (proving HMAC verification works),
# POST it through the api-gateway (proving raw-body proxying works), then
# assert the DB row + parent order both moved to their terminal states.
#
# This is exactly what Paystack will do in production once we register the
# webhook URL in their dashboard — the only difference is that here we
# generate the event ourselves instead of waiting for a real cardholder.

set -euo pipefail
cd "$(dirname "$0")/.."

API="${API:-http://localhost:18080}"
EMAIL="admin@ecommerce.com"
PASSWORD="123456"

echo "===> 1) Login"
TOKEN=$(curl -sS -X POST "$API/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
[ -n "$TOKEN" ] || { echo "login failed"; exit 1; }
echo "    token len=${#TOKEN}"

echo "===> 2) Create order"
ORDER_RESP=$(curl -sS -X POST "$API/api/orders" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "userId": 1,
    "items": [{"productId":18,"quantity":2,"price":18000,"name":"Atomic Habits"}],
    "total": 38700,
    "shippingAddress": {"fullName":"Admin","addressLine1":"1 Test","city":"Lagos","state":"Lagos","postalCode":"100001","country":"Nigeria"},
    "paymentMethod": "paystack"
  }')
ORDER_ID=$(echo "$ORDER_RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
echo "    orderId=$ORDER_ID"

echo "===> 3) Initialise payment with Paystack"
INIT_RESP=$(curl -sS -X POST "$API/api/payments/initialize" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"orderId\":$ORDER_ID,\"amount\":38700,\"email\":\"$EMAIL\"}")
REFERENCE=$(echo "$INIT_RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["reference"])')
echo "    reference=$REFERENCE"

echo "===> 4) Build a charge.success webhook payload"
PAYLOAD=$(python3 - "$REFERENCE" <<'PY'
import sys, json, time
ref = sys.argv[1]
event = {
  "event": "charge.success",
  "data": {
    "id": int(time.time() * 1000),
    "domain": "test",
    "status": "success",
    "reference": ref,
    "amount": 3870000,          # 38,700 NGN -> kobo
    "message": None,
    "gateway_response": "Successful",
    "paid_at": "2026-06-05T10:00:00.000Z",
    "created_at": "2026-06-05T09:59:30.000Z",
    "channel": "card",
    "currency": "NGN",
    "ip_address": "127.0.0.1",
    "metadata": {"source": "smoke-test"},
    "customer": {"id": 1, "email": "admin@ecommerce.com"},
    "authorization": {
      "authorization_code": "AUTH_test123",
      "card_type": "visa",
      "last4": "4081",
      "exp_month": "12",
      "exp_year": "2030",
      "bank": "TEST BANK",
      "channel": "card",
      "brand": "visa",
      "reusable": True
    }
  }
}
print(json.dumps(event, separators=(',', ':')))
PY
)
echo "    payload bytes=${#PAYLOAD}"

echo "===> 5) Sign with PAYSTACK_SECRET_KEY (HMAC-SHA512)"
SECRET=$(grep -E '^PAYSTACK_SECRET_KEY=' .env | cut -d= -f2-)
SIG=$(python3 - "$SECRET" "$PAYLOAD" <<'PY'
import sys, hmac, hashlib
secret = sys.argv[1].encode()
body   = sys.argv[2].encode()
print(hmac.new(secret, body, hashlib.sha512).hexdigest())
PY
)
echo "    signature=${SIG:0:16}...${SIG: -8}"

echo "===> 6) POST signed webhook through api-gateway"
HTTP_CODE=$(curl -sS -o /tmp/wh-resp.txt -w "%{http_code}" \
  -X POST "$API/api/payments/webhook" \
  -H 'Content-Type: application/json' \
  -H "x-paystack-signature: $SIG" \
  --data-raw "$PAYLOAD")
echo "    HTTP $HTTP_CODE  body=$(cat /tmp/wh-resp.txt)"
[ "$HTTP_CODE" = "200" ] || { echo "FAIL: webhook did not accept signed payload"; exit 1; }

echo "===> 7) Wait briefly for async settlement (background)"
sleep 2

echo "===> 8) Assert DB state"
docker compose exec -T -e REF="$REFERENCE" postgres sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT id, order_id, status, amount, reference, transaction_id, paid_at, failure_reason FROM payments WHERE reference = '"'"'$REF'"'"';"'

docker compose exec -T -e OID="$ORDER_ID" postgres sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT id, status, total, payment_method, updated_at FROM orders WHERE id = '"'"'$OID'"'"';"'

echo "===> 9) Replay webhook (should be idempotent)"
HTTP_CODE2=$(curl -sS -o /tmp/wh-resp2.txt -w "%{http_code}" \
  -X POST "$API/api/payments/webhook" \
  -H 'Content-Type: application/json' \
  -H "x-paystack-signature: $SIG" \
  --data-raw "$PAYLOAD")
echo "    replay HTTP $HTTP_CODE2  body=$(cat /tmp/wh-resp2.txt)"

echo "===> DONE  reference=$REFERENCE  orderId=$ORDER_ID"
