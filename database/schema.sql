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
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

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
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(product_id, user_id)
);

-- Payments table
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id),
  user_id INTEGER REFERENCES users(id),
  amount DECIMAL(10, 2),
  method VARCHAR(50),
  transaction_id VARCHAR(255),
  status VARCHAR(50),
  failure_reason TEXT,
  processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

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

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_reviews_product_id ON reviews(product_id);
CREATE INDEX IF NOT EXISTS idx_ratings_product_id ON ratings(product_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);

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
