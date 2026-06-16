-- Reseed for NGN switch.
--
-- Wipes commerce data (products + everything that references them) and
-- inserts a fresh catalogue priced in naira. Users are left alone so
-- existing logins (including the seed admin) still work.
--
-- Run from the repo root:
--   docker compose exec -T postgres sh -lc \
--     'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' \
--     < database/seed-ngn.sql

BEGIN;

-- Truncate in dependency order. CASCADE picks up wishlists/ratings/reviews/
-- order_items + image rows automatically.
TRUNCATE TABLE
  payments,
  order_items,
  orders,
  wishlists,
  ratings,
  reviews,
  products
RESTART IDENTITY CASCADE;

-- Catalogue. Prices chosen to span the realistic Nigerian retail range
-- so the cart math, free-shipping threshold (₦50,000) and discount badges
-- all have something to render.
--
-- Columns: name, description, price, discount_percent, category, stock, brand
INSERT INTO products (name, description, price, discount_percent, category, stock, brand) VALUES
-- Electronics
('iPhone 17 Pro', 'Apple iPhone 17 Pro 256GB, Titanium finish, A19 Bionic chip.', 1850000, 0,  'Electronics', 12, 'Apple'),
('Samsung Galaxy S25 Ultra', '512GB, 200MP camera, S Pen included.', 1450000, 10, 'Electronics', 20, 'Samsung'),
('Sony WH-1000XM5 Headphones', 'Industry-leading noise cancellation, 30hr battery.', 285000,  15, 'Electronics', 40, 'Sony'),
('MacBook Air 15" M3', 'Apple silicon, 16GB RAM, 512GB SSD.', 2150000, 0,  'Electronics', 8,  'Apple'),
('JBL Flip 6 Speaker', 'Portable Bluetooth speaker, IP67 waterproof.', 95000,   25, 'Electronics', 60, 'JBL'),

-- Accessories
('Ray-Ban Aviator Classic', 'Gold frame, green G-15 lenses.', 145000,  0,  'Accessories', 35, 'Ray-Ban'),
('Apple Watch Series 10', '45mm aluminium, GPS + Cellular.', 525000,  10, 'Accessories', 18, 'Apple'),
('Fossil Leather Wallet', 'Genuine leather, RFID-blocking.', 35000,   0,  'Accessories', 80, 'Fossil'),

-- Sports
('Nike Pegasus 41 Running Shoes', 'Mens running shoe, Air Zoom cushioning.', 78000,   20, 'Sports', 50, 'Nike'),
('Adidas Predator Football Boots', 'Firm-ground studs, kangaroo leather.', 110000,  0,  'Sports', 25, 'Adidas'),
('Wilson Pro Staff Tennis Racket', '97 sq in head, 315g weight.', 145000,  0,  'Sports', 15, 'Wilson'),

-- Home & Kitchen
('Philips 3000 Air Fryer', '4.1L capacity, rapid air technology.', 165000,  15, 'Home & Kitchen', 30, 'Philips'),
('Le Creuset Cast Iron Pot', '24cm round French oven, cerise red.', 220000,  0,  'Home & Kitchen', 12, 'Le Creuset'),
('Nespresso Vertuo Coffee Machine', 'Centrifusion brewing, 5 cup sizes.', 195000,  10, 'Home & Kitchen', 22, 'Nespresso'),

-- Beauty
('Dyson Airwrap Complete', 'Multi-styler, all hair types, 6 attachments.', 685000,  0,  'Beauty', 14, 'Dyson'),
('La Mer Crème Moisturizing 60ml', 'Iconic moisturising cream.', 425000,  0,  'Beauty', 20, 'La Mer'),
('Maybelline Fit Me Foundation', 'Lightweight, full coverage. 30ml.', 12500,   30, 'Beauty', 200,'Maybelline'),

-- Books
('Atomic Habits — James Clear', 'International bestseller. Paperback, 320 pages.', 18000,   0,  'Books', 100,'Penguin'),
('The Psychology of Money — Morgan Housel', 'Timeless lessons on wealth & happiness.', 16500,   10, 'Books', 80, 'Harriman House'),

-- Clothing
('Levi''s 501 Original Jeans', 'Straight fit, dark wash. Mens.', 65000,   0,  'Clothing', 70, 'Levi''s'),
('Nike Tech Fleece Hoodie', 'Lightweight, breathable, full-zip.', 92000,   15, 'Clothing', 45, 'Nike'),

-- Toys
('LEGO Star Wars Millennium Falcon', '1351 pieces, ages 9+.', 185000,  0,  'Toys', 16, 'LEGO');

COMMIT;

-- Quick sanity-check
SELECT id, name, price, discount_percent, category, stock FROM products ORDER BY id;
