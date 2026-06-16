// Package store wraps Postgres access for the payment-service.
//
// We use pgx directly (not database/sql) for two reasons:
//   - native types (numeric, jsonb, timestamptz) round-trip without faff
//   - the pool ships connection-health, named statements, and tracing hooks
//
// Every method takes a context.Context so cancellations (request timeout,
// shutdown signal) propagate down into the driver.
package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Payment mirrors the public.payments row 1:1.
type Payment struct {
	ID             int64
	OrderID        int64
	UserID         int64
	Amount         float64 // naira; pgx hands us numeric as string/decimal, we cast
	Currency       string
	Method         string
	Reference      string
	TransactionID  *string
	Status         string
	FailureReason  *string
	Metadata       json.RawMessage
	PaidAt         *time.Time
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// Store is the only handle the rest of the service has on the DB. Wrap a
// real *pgxpool.Pool. Keep methods small and named after intent, not SQL.
type Store struct {
	pool *pgxpool.Pool
}

// New opens the pool. Caller must call Close on shutdown.
func New(ctx context.Context, dsn string) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse dsn: %w", err)
	}
	// Sensible defaults for a small service. Tuneable via env later.
	cfg.MaxConns = 10
	cfg.MinConns = 1
	cfg.MaxConnLifetime = 30 * time.Minute
	cfg.HealthCheckPeriod = 30 * time.Second

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() { s.pool.Close() }

// Ping is the liveness probe target.
func (s *Store) Ping(ctx context.Context) error {
	pctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return s.pool.Ping(pctx)
}

// CreatePending inserts a new pending payment. We insert BEFORE calling
// Paystack so we never lose track of a transaction we kicked off.
func (s *Store) CreatePending(
	ctx context.Context, orderID, userID int64, amount float64,
	method, reference string,
) (Payment, error) {
	row := s.pool.QueryRow(ctx, `
		INSERT INTO payments (order_id, user_id, amount, method, reference, status)
		VALUES ($1, $2, $3, $4, $5, 'pending')
		RETURNING id, order_id, user_id, amount, currency, method, reference,
		          transaction_id, status, failure_reason, metadata, paid_at,
		          created_at, updated_at
	`, orderID, userID, amount, method, reference)
	return scanPayment(row)
}

// MarkInitFailed flips a freshly-created row to failed when Paystack init itself
// errors. Stops orphan "pending" rows that will never settle.
func (s *Store) MarkInitFailed(ctx context.Context, id int64, reason string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE payments SET status = 'failed', failure_reason = $1 WHERE id = $2`,
		reason, id,
	)
	return err
}

// ByReference reads a row by its Paystack reference. Returns ErrNoRows-style
// false-found when missing.
func (s *Store) ByReference(ctx context.Context, ref string) (Payment, bool, error) {
	row := s.pool.QueryRow(ctx, selectPaymentByRef, ref)
	p, err := scanPayment(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Payment{}, false, nil
		}
		return Payment{}, false, err
	}
	return p, true, nil
}

// ByID reads a row by id. For admin / customer "payments for my order" lookups.
func (s *Store) ByID(ctx context.Context, id int64) (Payment, bool, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT id, order_id, user_id, amount, currency, method, reference,
		       transaction_id, status, failure_reason, metadata, paid_at,
		       created_at, updated_at
		  FROM payments WHERE id = $1`, id)
	p, err := scanPayment(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Payment{}, false, nil
		}
		return Payment{}, false, err
	}
	return p, true, nil
}

// ByOrderID is used by the customer-facing "order details" page.
func (s *Store) ByOrderID(ctx context.Context, orderID int64) ([]Payment, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, order_id, user_id, amount, currency, method, reference,
		       transaction_id, status, failure_reason, metadata, paid_at,
		       created_at, updated_at
		  FROM payments WHERE order_id = $1 ORDER BY created_at DESC`, orderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Payment
	for rows.Next() {
		p, err := scanPayment(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// SettleSuccessful atomically marks a payment as completed and stamps the
// Paystack transaction id + raw metadata. SELECT ... FOR UPDATE makes it
// safe for /verify and /webhook to race — second caller is a no-op.
//
// Returns (payment, alreadySettled, error). alreadySettled=true means the
// row was already terminal when we looked at it.
func (s *Store) SettleSuccessful(
	ctx context.Context, reference, transactionID string, metadata json.RawMessage,
) (Payment, bool, error) {
	return s.settle(ctx, reference, "completed", "", transactionID, metadata)
}

// SettleFailed is the mirror of SettleSuccessful.
func (s *Store) SettleFailed(
	ctx context.Context, reference, reason, transactionID string, metadata json.RawMessage,
) (Payment, bool, error) {
	return s.settle(ctx, reference, "failed", reason, transactionID, metadata)
}

// internal helper that owns the transaction + idempotency guard.
func (s *Store) settle(
	ctx context.Context,
	reference, nextStatus, failureReason, transactionID string,
	metadata json.RawMessage,
) (Payment, bool, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Payment{}, false, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }() // safe: no-op after commit

	row := tx.QueryRow(ctx,
		`SELECT id, order_id, user_id, amount, currency, method, reference,
		        transaction_id, status, failure_reason, metadata, paid_at,
		        created_at, updated_at
		   FROM payments WHERE reference = $1 FOR UPDATE`, reference)
	current, err := scanPayment(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Payment{}, false, ErrNotFound
		}
		return Payment{}, false, err
	}

	if current.Status == "completed" || current.Status == "failed" {
		return current, true, nil
	}

	var paidAt *time.Time
	if nextStatus == "completed" {
		now := time.Now().UTC()
		paidAt = &now
	}
	var failure *string
	if failureReason != "" {
		failure = &failureReason
	}
	var txid *string
	if transactionID != "" {
		txid = &transactionID
	}

	rowU := tx.QueryRow(ctx, `
		UPDATE payments
		   SET status = $1,
		       failure_reason = COALESCE($2, failure_reason),
		       paid_at = COALESCE($3, paid_at),
		       transaction_id = COALESCE($4, transaction_id),
		       metadata = COALESCE($5::jsonb, metadata)
		 WHERE id = $6
		 RETURNING id, order_id, user_id, amount, currency, method, reference,
		           transaction_id, status, failure_reason, metadata, paid_at,
		           created_at, updated_at
	`, nextStatus, failure, paidAt, txid, metadata, current.ID)
	updated, err := scanPayment(rowU)
	if err != nil {
		return Payment{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Payment{}, false, fmt.Errorf("commit: %w", err)
	}
	return updated, false, nil
}

// ErrNotFound is returned when a referenced payment doesn't exist.
var ErrNotFound = errors.New("payment not found")

// ---- internals ----

const selectPaymentByRef = `
	SELECT id, order_id, user_id, amount, currency, method, reference,
	       transaction_id, status, failure_reason, metadata, paid_at,
	       created_at, updated_at
	  FROM payments WHERE reference = $1`

// rowScanner is the smallest interface both pgx.Row and pgx.Rows satisfy.
type rowScanner interface {
	Scan(dest ...any) error
}

func scanPayment(r rowScanner) (Payment, error) {
	var p Payment
	err := r.Scan(
		&p.ID, &p.OrderID, &p.UserID, &p.Amount, &p.Currency, &p.Method,
		&p.Reference, &p.TransactionID, &p.Status, &p.FailureReason,
		&p.Metadata, &p.PaidAt, &p.CreatedAt, &p.UpdatedAt,
	)
	return p, err
}
