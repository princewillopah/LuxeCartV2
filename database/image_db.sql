-- LuxeCart — image_db
-- Per-service schema for image metadata.
-- (Mounted into the `postgres` container; image-service connects with its
--  own DATABASE_URL that points at this schema/db.)

CREATE DATABASE image_db;

\connect image_db;

-- The image-service also creates this table at boot via initSchema(),
-- but we materialize it here so the schema is reviewable in version control.
CREATE TABLE IF NOT EXISTS images (
  id           UUID PRIMARY KEY,
  key          TEXT NOT NULL UNIQUE,
  url          TEXT NOT NULL,
  owner_type   TEXT NOT NULL,           -- 'product', 'user', 'review', ...
  owner_id     TEXT,
  content_type TEXT,
  size_bytes   BIGINT,
  uploaded_by  TEXT,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | ready | deleted
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_images_owner  ON images(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_images_status ON images(status);
