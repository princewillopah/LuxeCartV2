-- users_db.sql — schema for user-service.
-- Owns: read-side projection of users (synced from auth_db via Kafka),
-- saved shipping addresses, and wishlist.
-- The `users` table here is a PROJECTION — auth_db is the writer.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  -- Sentinel value '<projection>' indicates the row was created from a
  -- Kafka event and not via auth-service direct write. Schema keeps the
  -- column NOT NULL so the shape matches auth_db.users for sanity.
  password VARCHAR(255) NOT NULL DEFAULT '<projection>',
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  role VARCHAR(50) DEFAULT 'user',
  phone VARCHAR(50),
  -- Mirrored from auth_db so the projection can answer GET /me without
  -- a cross-service round-trip. auth-service owns the write.
  email_verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Saved shipping/billing addresses per user.
CREATE TABLE IF NOT EXISTS user_addresses (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  full_name   VARCHAR(120) NOT NULL,
  line1       VARCHAR(200) NOT NULL,
  line2       VARCHAR(200),
  city        VARCHAR(100) NOT NULL,
  state       VARCHAR(100) NOT NULL,
  postal      VARCHAR(20),
  country     VARCHAR(100) NOT NULL DEFAULT 'Nigeria',
  phone       VARCHAR(40),
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_addresses_user ON user_addresses(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_addresses_default
  ON user_addresses(user_id) WHERE is_default;

-- Wishlist. product_id has NO FK (products live in products_db).
CREATE TABLE IF NOT EXISTS wishlists (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL,
  added_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_wishlists_user_id    ON wishlists(user_id);
CREATE INDEX IF NOT EXISTS idx_wishlists_product_id ON wishlists(product_id);
