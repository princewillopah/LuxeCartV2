// Package provider defines the abstraction that lets payment-service-go
// talk to multiple payment gateways (Paystack, Flutterwave, …) through one
// uniform interface.
//
// Why an interface? Adding a third gateway later (Stripe, Monnify, etc.)
// becomes a single file that implements Provider. The settlement engine,
// HTTP handlers, and DB layer don't change at all.
//
// All amount fields are in NAIRA (the major unit). Gateway-specific
// conversions (kobo for Paystack, naira for Flutterwave) live INSIDE each
// implementation so the rest of the codebase stays gateway-neutral.
package provider

import (
	"context"
	"encoding/json"
	"errors"
)

// Status is the normalized payment state. Each gateway maps its own vocabulary
// onto these four values.
type Status string

const (
	StatusSuccess   Status = "success"
	StatusFailed    Status = "failed"
	StatusAbandoned Status = "abandoned"
	StatusPending   Status = "pending"
)

// InitializeRequest is everything a gateway needs to spin up a checkout.
type InitializeRequest struct {
	OrderID     int64
	UserID      int64
	Email       string
	AmountNaira float64
	Reference   string
	CallbackURL string
	Metadata    map[string]any
}

// InitializeResponse is the bare minimum the frontend needs to redirect.
type InitializeResponse struct {
	AuthorizationURL string // hosted checkout page
	AccessCode       string // optional, paystack-specific extra
	Reference        string
}

// Transaction is the normalized view of a charge. Gateways translate their
// own payloads into this shape so the settlement engine doesn't have to care
// which one was used.
type Transaction struct {
	Reference       string
	ProviderTxID    string  // gateway's own id, stored on the payments row
	Status          Status  // normalized
	AmountNaira     float64 // major unit
	Currency        string
	GatewayResponse string // human-readable reason / status message
	PaidAt          string // RFC3339 from the gateway, empty if not paid
	Provider        string // "paystack", "flutterwave", …
	Raw             json.RawMessage
}

// WebhookResult is what VerifyWebhook returns after authenticating a webhook
// payload. EventType is the gateway-specific event name (e.g.
// "charge.success") so handlers can ignore irrelevant events.
type WebhookResult struct {
	EventType   string
	Transaction Transaction
}

// Provider is the contract every payment gateway implementation must satisfy.
//
// Implementations must be safe for concurrent use (the HTTP server will call
// them from many goroutines at once). All methods take a context so request
// cancellations propagate down into outbound HTTP calls.
type Provider interface {
	// Name returns the short identifier used in the database `method`
	// column and in the /providers list. Must match the value stored when
	// CreatePending is called.
	Name() string

	// Initialize creates a transaction with the gateway and returns the URL
	// the customer's browser must be redirected to.
	Initialize(ctx context.Context, in InitializeRequest) (InitializeResponse, error)

	// Verify asks the gateway for the authoritative status of a transaction
	// identified by our internal reference (tx_ref / reference).
	Verify(ctx context.Context, reference string) (Transaction, error)

	// VerifyWebhook authenticates the webhook (HMAC for Paystack, hash
	// equality for Flutterwave) and decodes the payload into a normalized
	// Transaction. Returns ok=false when authentication fails or the
	// payload is malformed.
	VerifyWebhook(body []byte, headers map[string]string) (WebhookResult, bool)
}

// Registry maps a provider name to its implementation. It's just a typed map;
// kept here so callers don't reinvent the lookup every time.
type Registry struct {
	providers map[string]Provider
}

func NewRegistry() *Registry {
	return &Registry{providers: make(map[string]Provider)}
}

// Register adds a provider. Last writer wins, so register defaults first and
// overrides later if needed.
func (r *Registry) Register(p Provider) {
	r.providers[p.Name()] = p
}

// Get looks up a provider by name. Returns ErrUnknownProvider when missing.
func (r *Registry) Get(name string) (Provider, error) {
	p, ok := r.providers[name]
	if !ok {
		return nil, ErrUnknownProvider
	}
	return p, nil
}

// Names returns the registered provider names, sorted for stable output.
// Used by GET /providers so the frontend can render its dropdown.
func (r *Registry) Names() []string {
	out := make([]string, 0, len(r.providers))
	for n := range r.providers {
		out = append(out, n)
	}
	// Tiny stable sort — keeps response deterministic for snapshot tests.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j-1] > out[j]; j-- {
			out[j-1], out[j] = out[j], out[j-1]
		}
	}
	return out
}

// ErrUnknownProvider is returned by Registry.Get for an unregistered name.
var ErrUnknownProvider = errors.New("unknown payment provider")
