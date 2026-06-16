-- inventory_db.sql — schema for inventory-service.
-- product_id has no cross-DB FK (products live in products_db). Stock
-- itself is owned by product-service; this DB stores only RESERVATIONS
-- (the soft-lock state machine: active / committed / released / expired).

CREATE TABLE IF NOT EXISTS reservations (
  id            SERIAL PRIMARY KEY,
  order_id      INTEGER NOT NULL,
  product_id    INTEGER NOT NULL,
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  status        VARCHAR(16) NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'committed', 'released', 'expired')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  resolved_at   TIMESTAMPTZ,
  resolved_by   VARCHAR(64),
  UNIQUE (order_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_reservations_order  ON reservations(order_id);
CREATE INDEX IF NOT EXISTS idx_reservations_active ON reservations(status, expires_at)
  WHERE status = 'active';
