-- products_db.sql — schema for product-service (Spring Boot).
-- Owns the canonical product catalog. Other services receive product
-- snapshots via the `ecommerce.product.*` Kafka topics or query the
-- product-service HTTP API.

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  price DECIMAL(10, 2) NOT NULL,
  discount_percent INTEGER NOT NULL DEFAULT 0
    CHECK (discount_percent >= 0 AND discount_percent <= 90),
  category VARCHAR(100) NOT NULL,
  stock INTEGER DEFAULT 0,
  brand VARCHAR(100),
  images TEXT[],
  average_rating DECIMAL(3, 2) DEFAULT 0,
  total_reviews INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
