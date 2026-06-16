// Package settle coordinates the "gateway says X, write that to our DB,
// publish lifecycle event" workflow for ANY payment provider.
//
// Lives in its own package so /verify and /webhook share exactly one code
// path — no risk of those two endpoints disagreeing on what "settled" means.
package settle

import (
	"context"
	"log/slog"

	"github.com/luxecart/payment-service-go/internal/events"
	"github.com/luxecart/payment-service-go/internal/provider"
	"github.com/luxecart/payment-service-go/internal/store"
)

// Result is what callers care about after a settlement attempt.
type Result struct {
	Payment        store.Payment
	AlreadySettled bool // row was already terminal when we looked
}

// Engine wires together the components needed to settle.
type Engine struct {
	store *store.Store
	pub   *events.Publisher
	log   *slog.Logger
}

func New(s *store.Store, p *events.Publisher, log *slog.Logger) *Engine {
	return &Engine{store: s, pub: p, log: log}
}

// Apply runs the idempotent settlement for the given normalized transaction.
// Safe to call concurrently for the same reference — the DB FOR UPDATE lock
// inside the store ensures only one of them does the actual update.
func (e *Engine) Apply(ctx context.Context, trx provider.Transaction) (Result, error) {
	switch trx.Status {
	case provider.StatusSuccess:
		return e.applySuccess(ctx, trx)
	case provider.StatusFailed, provider.StatusAbandoned:
		return e.applyFailure(ctx, trx)
	default:
		// pending / unknown — leave the row in pending and report so the
		// caller can decide what to surface to the user.
		existing, found, err := e.store.ByReference(ctx, trx.Reference)
		if err != nil {
			return Result{}, err
		}
		if !found {
			return Result{}, store.ErrNotFound
		}
		return Result{Payment: existing, AlreadySettled: false}, nil
	}
}

func (e *Engine) applySuccess(ctx context.Context, trx provider.Transaction) (Result, error) {
	payment, already, err := e.store.SettleSuccessful(ctx, trx.Reference, trx.ProviderTxID, trx.Raw)
	if err != nil {
		return Result{}, err
	}
	if !already {
		// fire-and-forget; settlement is already durable in DB
		go func() {
			pubCtx, cancel := contextDetached()
			defer cancel()
			if err := e.pub.Publish(pubCtx, "payment.completed", map[string]any{
				"paymentId":     payment.ID,
				"orderId":       payment.OrderID,
				"userId":        payment.UserID,
				"amount":        payment.Amount,
				"reference":     payment.Reference,
				"transactionId": trx.ProviderTxID,
				"method":        payment.Method,
				"provider":      trx.Provider,
				"processedAt":   payment.PaidAt,
			}); err != nil {
				e.log.Error("publish payment.completed failed",
					"err", err, "reference", payment.Reference)
			}
		}()
	}
	return Result{Payment: payment, AlreadySettled: already}, nil
}

func (e *Engine) applyFailure(ctx context.Context, trx provider.Transaction) (Result, error) {
	reason := trx.GatewayResponse
	if reason == "" {
		reason = "Payment not successful"
	}
	payment, already, err := e.store.SettleFailed(ctx, trx.Reference, reason, trx.ProviderTxID, trx.Raw)
	if err != nil {
		return Result{}, err
	}
	if !already {
		go func() {
			pubCtx, cancel := contextDetached()
			defer cancel()
			if err := e.pub.Publish(pubCtx, "payment.failed", map[string]any{
				"paymentId": payment.ID,
				"orderId":   payment.OrderID,
				"userId":    payment.UserID,
				"amount":    payment.Amount,
				"reference": payment.Reference,
				"provider":  trx.Provider,
				"reason":    reason,
			}); err != nil {
				e.log.Error("publish payment.failed failed",
					"err", err, "reference", payment.Reference)
			}
		}()
	}
	return Result{Payment: payment, AlreadySettled: already}, nil
}
