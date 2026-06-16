-- Users table
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  role VARCHAR(50) DEFAULT 'user',
  phone VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Products table
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  price DECIMAL(10, 2) NOT NULL,
  -- Optional percentage discount applied at sale time. Capped at 90 so we
  -- can't accidentally sell items for free. Effective price is computed as
  -- price * (1 - discount_percent / 100).
  discount_percent INTEGER NOT NULL DEFAULT 0
    CHECK (discount_percent >= 0 AND discount_percent <= 90),
  category VARCHAR(100) NOT NULL,
  stock INTEGER DEFAULT 0,
  brand VARCHAR(100),
  images TEXT[], -- Array of image URLs
  average_rating DECIMAL(3, 2) DEFAULT 0,
  total_reviews INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Orders table
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  total DECIMAL(10, 2) NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  shipping_address JSONB,
  payment_method VARCHAR(50),
  -- Denormalized buyer snapshot. Captured at order-create time so we never
  -- need to JOIN against users_db (different DB under the database-per-
  -- service split) when enriching downstream event payloads.
  user_email      VARCHAR(255),
  user_first_name VARCHAR(100),
  user_last_name  VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Phase D backfill columns for existing rows.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS user_email      VARCHAR(255);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS user_first_name VARCHAR(100);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS user_last_name  VARCHAR(100);

-- Order items table
CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  product_name VARCHAR(255),
  price DECIMAL(10, 2),
  quantity INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Reviews table (comments only, ratings are separate)
CREATE TABLE IF NOT EXISTS reviews (
  id SERIAL PRIMARY KEY,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  user_name VARCHAR(255),
  comment TEXT,
  verified BOOLEAN DEFAULT FALSE,
  helpful INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Ratings table
CREATE TABLE IF NOT EXISTS ratings (
  id SERIAL PRIMARY KEY,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  -- Denormalized snapshot of the rater's display name. Captured at write
  -- time so we never need to JOIN against users_db (different DB under the
  -- database-per-service split). Refreshed on every upsert.
  user_name VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(product_id, user_id)
);

-- Phase D backfill for existing rows when the column was added later.
ALTER TABLE ratings ADD COLUMN IF NOT EXISTS user_name VARCHAR(255);

-- Payments table
--
-- One row per payment attempt. A single order can have multiple rows here
-- if the customer retries (e.g. card declined, second attempt succeeds).
-- `reference` is the Paystack transaction reference and must be unique.
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id),
  user_id INTEGER REFERENCES users(id),
  amount DECIMAL(14, 2),
  method VARCHAR(50),              -- 'paystack' for new payments
  transaction_id VARCHAR(255),     -- legacy column, kept for back-compat
  reference VARCHAR(120) UNIQUE,   -- Paystack transaction reference
  status VARCHAR(50),              -- 'pending' | 'completed' | 'failed' | 'refunded'
  failure_reason TEXT,
  metadata JSONB,                  -- full Paystack response for audit
  paid_at TIMESTAMPTZ,             -- when Paystack confirmed success
  processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_payments_reference ON payments(reference);
CREATE INDEX IF NOT EXISTS idx_payments_order_id  ON payments(order_id);

-- Notifications table
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  type VARCHAR(50),
  title VARCHAR(255),
  message TEXT,
  data JSONB,
  read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Wishlists table — one row per (user, product) pair the user has saved
CREATE TABLE IF NOT EXISTS wishlists (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  added_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, product_id)
);

-- Email verification & password reset tokens.
-- One active token per user per purpose; older ones are overwritten on reissue.
CREATE TABLE IF NOT EXISTS auth_tokens (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  CHAR(64) NOT NULL,                    -- SHA-256 hex of the raw token
  purpose     VARCHAR(32) NOT NULL,                 -- 'email_verify' | 'password_reset'
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_hash    ON auth_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user    ON auth_tokens(user_id, purpose);

-- Email verification flag on users (idempotent)
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

-- Account lockout columns. We count consecutive failed logins and lock the
-- account temporarily once a threshold is hit. Both columns default to safe
-- "not locked" values so existing rows behave correctly.
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- Auth audit log — append-only record of security-relevant events. The
-- frontend never reads this; it exists for admin forensics ("did account X
-- get locked?", "did anyone try to reset password Y?") and to satisfy any
-- future compliance ask. user_id is nullable so we can log attempted
-- actions against emails that don't actually exist (account enumeration
-- probes) without violating the FK.
CREATE TABLE IF NOT EXISTS auth_audit_log (
  id          BIGSERIAL PRIMARY KEY,
  event       VARCHAR(64) NOT NULL,         -- 'login.success' | 'login.failed' | 'login.locked' | 'register' | 'logout' | 'refresh.reuse' | 'password.reset' | 'email.verified'
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  email       VARCHAR(255),                 -- captured separately so probes against non-existent emails are still recorded
  ip          TEXT,
  user_agent  TEXT,
  detail      JSONB,                        -- free-form per-event payload
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_audit_event   ON auth_audit_log(event, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_audit_user    ON auth_audit_log(user_id, created_at DESC);

-- Refresh tokens.
-- We hand out short-lived access JWTs (15 min) plus a long-lived opaque
-- refresh token (7 days) that the frontend swaps for a new access JWT
-- whenever the access JWT expires. We store only the SHA-256 hash so a DB
-- leak doesn't yield usable tokens.
--
-- Rotation: every successful /refresh call issues a NEW refresh token and
-- marks the old one used_at. If a token marked used_at is presented again,
-- that's reuse — likely theft — and we revoke all tokens for that user.
--
-- Logout: marks the presented refresh token revoked_at. The access JWT can
-- still be valid for up to 15 min after logout (we accept this trade-off
-- vs. building a distributed JWT blocklist).
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  CHAR(64) NOT NULL,                    -- SHA-256 hex of the raw token
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,                          -- set on rotation
  revoked_at  TIMESTAMPTZ,                          -- set on logout / theft
  user_agent  TEXT,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

-- ── Phase 4: stock reservations ──────────────────────────────────────────
-- We now decrement `products.stock` at order-creation time (not lazily on
-- the order.created event) and record each line as an "active" reservation.
-- Lifecycle:
--   active    → just created, payment not yet settled
--   committed → payment.completed received, sale is permanent
--   released  → payment.failed / cancelled / admin release; stock was
--               restored back to products.stock at the moment of release
--   expired   → swept by the abandoned-reservation job (stock restored)
--
-- products.stock keeps its existing meaning: "available to buy right now".
-- That preserves storefront semantics — what you see is what you can grab.
--
-- Idempotency: UNIQUE (order_id, product_id) ensures a retried POST /reserve
-- for the same order can't double-deduct. The reserve handler is a NO-OP
-- when an active row already exists for that pair.
CREATE TABLE IF NOT EXISTS reservations (
  id            SERIAL PRIMARY KEY,
  order_id      INTEGER NOT NULL,
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  status        VARCHAR(16) NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'committed', 'released', 'expired')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  resolved_at   TIMESTAMPTZ,                 -- set when status leaves 'active'
  resolved_by   VARCHAR(64),                 -- 'payment.completed' | 'payment.failed' | 'sweeper' | 'admin'
  UNIQUE (order_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_reservations_order  ON reservations(order_id);
CREATE INDEX IF NOT EXISTS idx_reservations_active ON reservations(status, expires_at)
  WHERE status = 'active';

-- ── Phase 3: order lifecycle history ─────────────────────────────────────
-- Every transition through the order state machine appends a row here.
-- This is the source of truth for the customer's order-tracking timeline
-- AND the admin audit trail ("who cancelled this and when?").
--
-- We deliberately don't FK actor_id to users(id) — admin accounts may be
-- deleted later, and we want the history to survive. Same reason note is
-- free text rather than referencing a separate notes table.
CREATE TABLE IF NOT EXISTS order_status_history (
  id            SERIAL PRIMARY KEY,
  order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status   VARCHAR(32),
  to_status     VARCHAR(32) NOT NULL,
  actor_id      INTEGER,          -- user id of admin (or customer for self-cancel); NULL when system-driven
  actor_role    VARCHAR(16),      -- 'admin' | 'customer' | 'system'
  note          TEXT,             -- optional human-written reason
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_order_status_history_order ON order_status_history(order_id, created_at);

-- Phase 3 schema additions on `orders` itself. NULL for legacy rows.
DO $$ BEGIN
  ALTER TABLE orders ADD COLUMN tracking_number VARCHAR(64);
EXCEPTION WHEN duplicate_column THEN END $$;
DO $$ BEGIN
  ALTER TABLE orders ADD COLUMN cancelled_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN END $$;
DO $$ BEGIN
  ALTER TABLE orders ADD COLUMN delivered_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN END $$;
DO $$ BEGIN
  ALTER TABLE orders ADD COLUMN refunded_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN END $$;

-- Saved shipping/billing addresses per user. Customers add these from the
-- account page and the checkout pre-fills from the default (or any picked)
-- entry, so they don't have to retype the form each order. One row per
-- saved address; `is_default` is enforced as at-most-one per user by the
-- partial unique index below.
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

-- ── Phase 6: persistent cart + abandoned-cart sweeper ──────────────────
-- Until Phase 6 the cart-service was Redis-only with a 7-day TTL. Carts
-- now live in Postgres so they survive arbitrary downtime, can be queried
-- by the abandoned-cart sweeper, and we have proper SQL for analytics.
-- Redis is still used as a hot read-cache (cache-aside, 5-min TTL).
--
-- One row per user (UNIQUE user_id) so we never have two carts for the
-- same person. `last_activity_at` is bumped on every mutation and is the
-- column the sweeper scans against.
--
-- `abandoned_email_sent_at` makes the abandoned-email logic one-shot:
-- once we email the user, we don't email them again until they come back
-- and the sweeper resets it (logic in cart-service: any new add/remove
-- nulls it out so the next abandonment can fire a fresh email).
CREATE TABLE IF NOT EXISTS carts (
  id                       SERIAL PRIMARY KEY,
  user_id                  INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  abandoned_email_sent_at  TIMESTAMPTZ,
  abandoned_email_count    INTEGER NOT NULL DEFAULT 0,
  -- Denormalized buyer snapshot. Captured from the gateway-forwarded
  -- x-user-email header at every cart mutation so the abandoned-cart
  -- sweeper can render the email without JOIN-ing against users
  -- (different DB under the database-per-service split).
  user_email               VARCHAR(255),
  user_first_name          VARCHAR(100)
);
-- Phase D backfill for existing rows.
ALTER TABLE carts ADD COLUMN IF NOT EXISTS user_email      VARCHAR(255);
ALTER TABLE carts ADD COLUMN IF NOT EXISTS user_first_name VARCHAR(100);
CREATE INDEX IF NOT EXISTS idx_carts_last_activity
  ON carts(last_activity_at) WHERE abandoned_email_sent_at IS NULL;

-- One row per (cart, product). PK on (cart_id, product_id) gives us
-- idempotent upsert via ON CONFLICT.
--
-- We snapshot the price/name/image at the moment the user added the item
-- so a later product edit can't silently change what the customer thinks
-- they're paying for. The order-service's order_items table does the
-- same thing for orders.
--
-- product_id has NO FK to products: if a product is deleted the cart row
-- should remain so the user sees a "this item is no longer available"
-- placeholder rather than an empty cart with no explanation. The
-- frontend filters those out at checkout.
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

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_reviews_product_id ON reviews(product_id);
CREATE INDEX IF NOT EXISTS idx_ratings_product_id ON ratings(product_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_wishlists_user_id    ON wishlists(user_id);
CREATE INDEX IF NOT EXISTS idx_wishlists_product_id ON wishlists(product_id);

-- Insert seed admin user (password: 123456)
-- Password will be updated on first startup by auth service
INSERT INTO users (email, password, first_name, last_name, role) 
VALUES ('admin@ecommerce.com', 'NEEDS_BCRYPT_HASH', 'Admin', 'User', 'admin')
ON CONFLICT (email) DO NOTHING;

-- Insert seed regular users (password: 123456 for all)
INSERT INTO users (email, password, first_name, last_name, role) VALUES
('john@example.com', 'NEEDS_BCRYPT_HASH', 'John', 'Doe', 'user'),
('jane@example.com', 'NEEDS_BCRYPT_HASH', 'Jane', 'Smith', 'user'),
('bob@example.com', 'NEEDS_BCRYPT_HASH', 'Bob', 'Johnson', 'user'),
('alice@example.com', 'NEEDS_BCRYPT_HASH', 'Alice', 'Williams', 'user')
ON CONFLICT (email) DO NOTHING;

-- Insert seed products
INSERT INTO products (name, description, price, category, stock, brand, images) VALUES
('Wireless Headphones', 'Premium noise-cancelling wireless headphones with 30-hour battery life', 299.99, 'Electronics', 50, 'AudioTech', ARRAY['https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=500']),
('Smart Watch Pro', 'Advanced fitness tracking with heart rate monitor and GPS', 399.99, 'Electronics', 35, 'TechWear', ARRAY['https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=500']),
('Leather Backpack', 'Handcrafted genuine leather backpack with laptop compartment', 189.99, 'Accessories', 25, 'UrbanCarry', ARRAY['https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=500']),
('Running Shoes', 'Lightweight performance running shoes with responsive cushioning', 129.99, 'Sports', 60, 'SpeedRunner', ARRAY['https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=500']),
('Coffee Maker', 'Programmable coffee maker with thermal carafe and auto-brew', 79.99, 'Home & Kitchen', 40, 'BrewMaster', ARRAY['https://images.unsplash.com/photo-1517668808822-9ebb02f2a0e6?w=500']),
('Yoga Mat Premium', 'Extra-thick non-slip yoga mat with carrying strap', 49.99, 'Sports', 80, 'ZenFit', ARRAY['https://images.unsplash.com/photo-1601925260368-ae2f83cf8b7f?w=500'])
ON CONFLICT DO NOTHING;
