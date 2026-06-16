// Package httpapi exposes the REST surface of payment-service-go.
//
// All routes are mounted on a chi.Router built in Routes. Handlers are
// stateless; they reach into the API struct's collaborators (store,
// provider registry, settle engine) which are wired in main.
//
// Auth model:
//   - JWT verification is the api-gateway's job. The gateway forwards the
//     trusted user identity as x-user-id / x-user-role / x-user-email.
//   - Webhook endpoints rely on a per-provider signature (HMAC for Paystack,
//     hash equality for Flutterwave) because the caller is the gateway,
//     not our user.
package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/luxecart/payment-service-go/internal/config"
	"github.com/luxecart/payment-service-go/internal/provider"
	"github.com/luxecart/payment-service-go/internal/settle"
	"github.com/luxecart/payment-service-go/internal/store"
)

// defaultProvider is used when the client doesn't specify one. Keeps the
// public API backward-compatible with callers that predate the dropdown.
const defaultProvider = "paystack"

// API is the HTTP layer.
type API struct {
	cfg       config.Config
	store     *store.Store
	providers *provider.Registry
	engine    *settle.Engine
	log       *slog.Logger
}

func New(cfg config.Config, s *store.Store, r *provider.Registry, e *settle.Engine, log *slog.Logger) *API {
	return &API{cfg: cfg, store: s, providers: r, engine: e, log: log}
}

// Routes returns the fully-wired chi router.
func (a *API) Routes(metricsHandler http.Handler) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	r.Use(requestLogger(a.log))

	r.Get("/health", a.health)
	r.Handle("/metrics", metricsHandler)

	// IMPORTANT: webhooks must read the raw body for signature verification.
	// They're mounted explicitly so chi doesn't apply any body-parsing
	// middleware to them.
	//   /webhook              → paystack (kept for backward-compat with
	//                            anything already configured against it)
	//   /webhook/{provider}   → provider-specific
	r.Post("/webhook", a.webhookFor(defaultProvider))
	r.Post("/webhook/{provider}", a.webhookByParam)

	// What gateways are available to the storefront's dropdown?
	r.Get("/providers", a.listProviders)

	r.Post("/initialize", a.initialize)
	r.Get("/verify/{reference}", a.verify)
	r.Get("/order/{orderID}", a.byOrder)
	r.Get("/{paymentID}", a.byID)

	return r
}

// ---- handlers ----

func (a *API) health(w http.ResponseWriter, r *http.Request) {
	checks := map[string]string{"service": "ok"}
	if err := a.store.Ping(r.Context()); err != nil {
		checks["db"] = "down: " + err.Error()
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"status": "degraded", "checks": checks,
		})
		return
	}
	checks["db"] = "ok"
	for _, n := range a.providers.Names() {
		checks[n] = "configured"
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "checks": checks})
}

type providerInfo struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
}

// listProviders is what the checkout dropdown calls to discover what's
// available. Only providers that were actually configured (had keys set at
// boot) appear here.
func (a *API) listProviders(w http.ResponseWriter, _ *http.Request) {
	names := a.providers.Names()
	out := make([]providerInfo, 0, len(names))
	for _, n := range names {
		out = append(out, providerInfo{Name: n, DisplayName: displayNameFor(n)})
	}
	writeJSON(w, http.StatusOK, map[string]any{"providers": out})
}

func displayNameFor(name string) string {
	switch name {
	case "paystack":
		return "Paystack"
	case "flutterwave":
		return "Flutterwave"
	default:
		return strings.ToUpper(name[:1]) + name[1:]
	}
}

type initializeReq struct {
	OrderID  int64   `json:"orderId"`
	Amount   float64 `json:"amount"` // naira
	Email    string  `json:"email"`
	Provider string  `json:"provider,omitempty"` // optional; defaults to "paystack"
}

type initializeRes struct {
	PaymentID        int64  `json:"paymentId"`
	Provider         string `json:"provider"`
	Reference        string `json:"reference"`
	AuthorizationURL string `json:"authorizationUrl"`
	AccessCode       string `json:"accessCode,omitempty"`
}

func (a *API) initialize(w http.ResponseWriter, r *http.Request) {
	userID, ok := userIDFromHeader(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "missing x-user-id header")
		return
	}

	var in initializeReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if in.OrderID <= 0 || in.Amount <= 0 || in.Email == "" {
		writeErr(w, http.StatusBadRequest, "orderId, amount, email are required")
		return
	}
	if in.Provider == "" {
		in.Provider = defaultProvider
	}
	prov, err := a.providers.Get(in.Provider)
	if err != nil {
		writeErr(w, http.StatusBadRequest,
			fmt.Sprintf("payment provider %q is not configured", in.Provider))
		return
	}

	reference := newReference(in.OrderID)
	payment, err := a.store.CreatePending(
		r.Context(), in.OrderID, userID, in.Amount, prov.Name(), reference,
	)
	if err != nil {
		a.log.Error("create pending payment failed", "err", err)
		writeErr(w, http.StatusInternalServerError, "could not create payment")
		return
	}

	callbackURL := strings.TrimRight(a.cfg.PublicFrontendURL, "/") + "/checkout/callback"

	resp, err := prov.Initialize(r.Context(), provider.InitializeRequest{
		OrderID:     in.OrderID,
		UserID:      userID,
		Email:       in.Email,
		AmountNaira: in.Amount,
		Reference:   reference,
		CallbackURL: callbackURL,
		Metadata: map[string]any{
			"orderId": fmt.Sprint(in.OrderID),
			"userId":  fmt.Sprint(userID),
		},
	})
	if err != nil {
		_ = a.store.MarkInitFailed(r.Context(), payment.ID, err.Error())
		a.log.Error("provider initialize failed",
			"provider", prov.Name(), "err", err, "reference", reference)
		// Pass the provider's own error text through to the client so the
		// checkout-page toast can show it. Provider errors are already
		// truncated and don't contain secrets (we only log keys, never
		// embed them in error strings). Capped here defensively.
		writeErr(w, http.StatusBadGateway,
			fmt.Sprintf("%s: %s", prov.Name(), truncate(err.Error(), 240)))
		return
	}

	writeJSON(w, http.StatusCreated, initializeRes{
		PaymentID:        payment.ID,
		Provider:         prov.Name(),
		Reference:        reference,
		AuthorizationURL: resp.AuthorizationURL,
		AccessCode:       resp.AccessCode,
	})
}

type verifyRes struct {
	Reference      string  `json:"reference"`
	Provider       string  `json:"provider"`
	Status         string  `json:"status"` // success | failed | abandoned | pending
	Amount         float64 `json:"amount"`
	Currency       string  `json:"currency"`
	OrderID        int64   `json:"orderId"`
	PaymentID      int64   `json:"paymentId"`
	AlreadySettled bool    `json:"alreadySettled"`
}

// verify dispatches to the correct provider based on the row's `method`
// column. That way the URL stays /verify/{reference} for every gateway.
func (a *API) verify(w http.ResponseWriter, r *http.Request) {
	reference := chi.URLParam(r, "reference")
	if reference == "" {
		writeErr(w, http.StatusBadRequest, "reference required")
		return
	}
	row, found, err := a.store.ByReference(r.Context(), reference)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "lookup failed")
		return
	}
	if !found {
		writeErr(w, http.StatusNotFound, "unknown payment reference")
		return
	}
	prov, err := a.providers.Get(row.Method)
	if err != nil {
		writeErr(w, http.StatusInternalServerError,
			fmt.Sprintf("payment was created with provider %q which is not configured", row.Method))
		return
	}
	trx, err := prov.Verify(r.Context(), reference)
	if err != nil {
		a.log.Error("provider verify failed",
			"provider", prov.Name(), "err", err, "reference", reference)
		writeErr(w, http.StatusBadGateway,
			fmt.Sprintf("%s verify failed", prov.Name()))
		return
	}
	res, err := a.engine.Apply(r.Context(), trx)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "unknown payment reference")
			return
		}
		a.log.Error("settle failed", "err", err, "reference", reference)
		writeErr(w, http.StatusInternalServerError, "settlement failed")
		return
	}

	// DB-row-wins for terminal states (see Node-service decision doc).
	status := string(trx.Status)
	if res.AlreadySettled {
		if res.Payment.Status == "completed" {
			status = "success"
		} else if res.Payment.Status == "failed" {
			status = "failed"
		}
	}

	writeJSON(w, http.StatusOK, verifyRes{
		Reference:      reference,
		Provider:       prov.Name(),
		Status:         status,
		Amount:         trx.AmountNaira,
		Currency:       trx.Currency,
		OrderID:        res.Payment.OrderID,
		PaymentID:      res.Payment.ID,
		AlreadySettled: res.AlreadySettled,
	})
}

// webhookByParam routes /webhook/{provider} to the right handler.
func (a *API) webhookByParam(w http.ResponseWriter, r *http.Request) {
	a.webhookFor(chi.URLParam(r, "provider"))(w, r)
}

// webhookFor returns a handler bound to a specific provider name. We curry
// because chi's router parameter live in the URL but we want to share one
// implementation across /webhook (paystack alias) and /webhook/{provider}.
func (a *API) webhookFor(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		prov, err := a.providers.Get(name)
		if err != nil {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1MiB cap
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		// Flatten headers into a map[string]string so providers can probe
		// without depending on net/http types.
		flat := make(map[string]string, len(r.Header))
		for k, v := range r.Header {
			if len(v) > 0 {
				flat[k] = v[0]
			}
		}
		hook, ok := prov.VerifyWebhook(body, flat)
		if !ok {
			a.log.Warn("webhook signature mismatch",
				"provider", name, "ip", r.RemoteAddr)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}

		// ACK immediately so the gateway doesn't retry. Settlement runs async.
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("OK"))

		// Ignore events we don't care about (e.g. customer.created).
		if !isSettlementEvent(name, hook.EventType) {
			return
		}

		go func() {
			ctx, cancel := contextDetached()
			defer cancel()
			if _, err := a.engine.Apply(ctx, hook.Transaction); err != nil {
				a.log.Error("webhook settle failed",
					"provider", name, "err", err,
					"reference", hook.Transaction.Reference)
			}
		}()
	}
}

// isSettlementEvent filters out non-charge events that share the webhook URL.
func isSettlementEvent(providerName, eventType string) bool {
	switch providerName {
	case "paystack":
		return eventType == "charge.success" || eventType == "charge.failed"
	case "flutterwave":
		// FW uses "charge.completed" for both success and failure — the
		// transaction status field is what tells them apart.
		return eventType == "charge.completed"
	}
	// Unknown provider — try to settle anyway; idempotency makes it safe.
	return true
}

func (a *API) byID(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "paymentID"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid payment id")
		return
	}
	p, found, err := a.store.ByID(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "lookup failed")
		return
	}
	if !found {
		writeErr(w, http.StatusNotFound, "payment not found")
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (a *API) byOrder(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "orderID"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid order id")
		return
	}
	ps, err := a.store.ByOrderID(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "lookup failed")
		return
	}
	writeJSON(w, http.StatusOK, ps)
}

// ---- helpers ----

func userIDFromHeader(r *http.Request) (int64, bool) {
	v := r.Header.Get("x-user-id")
	if v == "" {
		return 0, false
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

// newReference builds a globally-unique transaction reference. Format:
//
//	LC-{orderId}-{unixMillis}-{8hex}
//
// Matches the Node service so existing references stay parseable.
func newReference(orderID int64) string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return fmt.Sprintf("LC-%d-%d-%s",
		orderID,
		time.Now().UnixMilli(),
		hex.EncodeToString(b),
	)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// truncate caps an error string before it's sent to the UI so a noisy
// provider response can't blow up the toast or leak excessive detail.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
