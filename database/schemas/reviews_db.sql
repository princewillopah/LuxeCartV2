-- reviews_db.sql — schema for review-service.
-- user_name is a denormalised snapshot of the reviewer's display name.
-- product_id / user_id have no cross-DB FKs.

CREATE TABLE IF NOT EXISTS reviews (
  id SERIAL PRIMARY KEY,
  product_id INTEGER,
  user_id INTEGER,
  user_name VARCHAR(255),
  comment TEXT,
  verified BOOLEAN DEFAULT FALSE,
  helpful INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_reviews_product_id ON reviews(product_id);
