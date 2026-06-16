-- carts_db.sql — schema for cart-service.
-- Stores live shopping carts. user_id has NO cross-DB FK (users live in
-- auth_db / users_db). Buyer snapshot columns (user_email,
-- user_first_name) are populated from the gateway-forwarded
-- x-user-email header at every mutation so the abandoned-cart sweeper
-- can render emails without cross-service JOINs.

CREATE TABLE IF NOT EXISTS carts (
  id                       SERIAL PRIMARY KEY,
  user_id                  INTEGER NOT NULL UNIQUE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  abandoned_email_sent_at  TIMESTAMPTZ,
  abandoned_email_count    INTEGER NOT NULL DEFAULT 0,
  user_email               VARCHAR(255),
  user_first_name          VARCHAR(100)
);
CREATE INDEX IF NOT EXISTS idx_carts_last_activity
  ON carts(last_activity_at) WHERE abandoned_email_sent_at IS NULL;

CREATE TABLE IF NOT EXISTS cart_items (
  cart_id          INTEGER NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id       INTEGER NOT NULL,
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  price_snapshot   NUMERIC(12,2) NOT NULL,
  name_snapshot    VARCHAR(200) NOT NULL,
  image_snapshot   TEXT,
  added_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (cart_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_cart_items_cart ON cart_items(cart_id);
