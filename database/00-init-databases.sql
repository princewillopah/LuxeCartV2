-- 00-init-databases.sql
--
-- Mounted at /docker-entrypoint-initdb.d on a FRESH postgres volume. The
-- entrypoint script runs every *.sql / *.sh file in alphabetical order
-- and only during initial DB initialization, so this is safe to commit.
--
-- For an existing volume (this project's case) the databases are created
-- manually once via:
--   docker compose exec -T postgres psql -U $POSTGRES_USER -d postgres < 00-init-databases.sql
--
-- Each microservice owns exactly one database; no cross-DB joins are
-- ever performed (cross-service queries go via HTTP or Kafka projection).

CREATE DATABASE auth_db;
CREATE DATABASE users_db;
CREATE DATABASE products_db;
CREATE DATABASE carts_db;
CREATE DATABASE orders_db;
CREATE DATABASE reviews_db;
CREATE DATABASE ratings_db;
CREATE DATABASE inventory_db;
CREATE DATABASE notifications_db;
CREATE DATABASE analytics_db;
CREATE DATABASE recommendation_db;
