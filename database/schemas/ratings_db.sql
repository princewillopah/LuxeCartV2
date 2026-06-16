-- ratings_db.sql — schema for rating-service.
-- user_name is a denormalised snapshot of the rater's display name.
-- product_id / user_id have no cross-DB FKs.

CREATE TABLE IF NOT EXISTS ratings (
  id SERIAL PRIMARY KEY,
  product_id INTEGER,
  user_id INTEGER,
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  user_name VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(product_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_ratings_product_id ON ratings(product_id);
