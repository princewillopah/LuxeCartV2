-- payments_db schema for the Go payment-service.
--
-- This is a brand-new logical database living inside the same Postgres
-- container so we get DB-per-service isolation without standing up a
-- second pg process locally. When this moves to AWS, dropping into a
-- separate RDS instance is just a connection-string change.
--
-- Bootstrap (run once):
--   CREATE DATABASE payments_db OWNER ecommerce;
--   \c payments_db
--   <this file>

CREATE TABLE IF NOT EXISTS payments (
    id              BIGSERIAL PRIMARY KEY,
    order_id        BIGINT NOT NULL,                   -- soft FK to ecommerce.orders
    user_id         BIGINT NOT NULL,                   -- soft FK to ecommerce.users
    amount          NUMERIC(14,2) NOT NULL,            -- naira value with 2dp
    currency        VARCHAR(3) NOT NULL DEFAULT 'NGN',
    method          VARCHAR(50) NOT NULL DEFAULT 'paystack',
    reference       VARCHAR(120) NOT NULL UNIQUE,      -- LC-{orderId}-{ts}-{rand}
    transaction_id  VARCHAR(255),                      -- Paystack numeric id
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'completed', 'failed')),
    failure_reason  TEXT,
    metadata        JSONB,                             -- raw Paystack transaction object
    paid_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments (order_id);
CREATE INDEX IF NOT EXISTS idx_payments_user_id  ON payments (user_id);
CREATE INDEX IF NOT EXISTS idx_payments_status   ON payments (status);

-- Keep updated_at fresh without leaning on app code.
CREATE OR REPLACE FUNCTION payments_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payments_updated_at ON payments;
CREATE TRIGGER trg_payments_updated_at
BEFORE UPDATE ON payments
FOR EACH ROW EXECUTE FUNCTION payments_set_updated_at();
