-- orders_db.sql — schema for order-service.
-- Owns orders, order_items, order_status_history. user_id / product_id
-- have NO cross-DB FKs. user_email/user_first_name/user_last_name and
-- product_name are denormalised snapshots so downstream events and
-- analytics never need to JOIN against other services' DBs.

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  total DECIMAL(10, 2) NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  shipping_address JSONB,
  payment_method VARCHAR(50),
  user_email      VARCHAR(255),
  user_first_name VARCHAR(100),
  user_last_name  VARCHAR(100),
  tracking_number VARCHAR(64),
  cancelled_at    TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  refunded_at     TIMESTAMPTZ,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER,
  product_name VARCHAR(255),
  price DECIMAL(10, 2),
  quantity INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_status_history (
  id            SERIAL PRIMARY KEY,
  order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status   VARCHAR(32),
  to_status     VARCHAR(32) NOT NULL,
  actor_id      INTEGER,
  actor_role    VARCHAR(16),
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_order_status_history_order
  ON order_status_history(order_id, created_at);
