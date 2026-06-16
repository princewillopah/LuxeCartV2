// Package flutterwave is a thin client over the Flutterwave v3 REST API that
// satisfies provider.Provider.
//
// Differences from Paystack worth knowing:
//   - Flutterwave uses NAIRA directly (no kobo conversion).
//   - Our internal reference maps to Flutterwave's `tx_ref`.
//   - Webhook auth is a SIMPLE EQUALITY check on the `verif-hash` header
//     against a secret configured in the FW dashboard — NOT HMAC.
//   - Verify endpoint we use is /transactions/verify_by_reference?tx_ref=...
//     which lets us look up by our own reference (no FW transaction id needed).
//
// Transport note: api.flutterwave.com is fronted by Cloudflare with a strict
// WAF. Through trial-and-error we learned the WAF rejects:
//   - Raw IPs in redirect_url (e.g. http://1.2.3.4:8080/...). See
//     sanitizeRedirectURL — we rewrite IPs to <ip>.nip.io.
//   - The '#' character in customizations.description ("Order #99" → 403,
//     "Order 99" → 200). Probably a CSS/XSS rule. We avoid it in payloads.
// We shell out to curl rather than use Go's net/http because curl is easier
// to debug against the WAF if its rules tighten further; the binary lives in
// the runtime image (see Dockerfile).
package flutterwave

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os/exec"
	"strings"

	"github.com/luxecart/payment-service-go/internal/provider"
)

const providerName = "flutterwave"

// Client is safe for concurrent use (each call spawns its own curl process).
type Client struct {
	baseURL     string
	secretKey   string
	webhookHash string // value FW sends back in `verif-hash`; configured in their dashboard
	siteTitle   string // shown on the hosted page
}

// Compile-time check: Client must satisfy provider.Provider.
var _ provider.Provider = (*Client)(nil)

// New builds a Flutterwave client. webhookHash is the secret string you set
// in the FW dashboard under Settings → Webhooks (verif-hash). It can be empty
// during dev — VerifyWebhook will then reject every webhook.
func New(baseURL, secretKey, webhookHash, siteTitle string) *Client {
	if siteTitle == "" {
		siteTitle = "LuxeCart"
	}
	return &Client{
		baseURL:     strings.TrimRight(baseURL, "/"),
		secretKey:   secretKey,
		webhookHash: webhookHash,
		siteTitle:   siteTitle,
	}
}

func (c *Client) Name() string { return providerName }

// Initialize POSTs /payments and returns the hosted-page URL.
//
// Flutterwave docs: https://developer.flutterwave.com/reference/initiate-payment
func (c *Client) Initialize(ctx context.Context, in provider.InitializeRequest) (provider.InitializeResponse, error) {
	payload := flwInitRequest{
		TxRef:       in.Reference,
		Amount:      fmt.Sprintf("%.2f", in.AmountNaira),
		Currency:    "NGN",
		RedirectURL: sanitizeRedirectURL(in.CallbackURL),
		Customer: flwCustomer{
			Email: in.Email,
		},
		Customizations: flwCustomizations{
			Title:       c.siteTitle,
			Description: fmt.Sprintf("Order %d", in.OrderID),
		},
		Meta: in.Metadata,
	}
	body, err := c.do(ctx, "POST", "/payments", payload)
	if err != nil {
		return provider.InitializeResponse{}, err
	}
	var env flwEnvelope[flwInitData]
	if err := json.Unmarshal(body, &env); err != nil {
		return provider.InitializeResponse{}, fmt.Errorf("decode initialize: %w", err)
	}
	if env.Status != "success" {
		return provider.InitializeResponse{}, fmt.Errorf("flutterwave error: %s", env.Message)
	}
	return provider.InitializeResponse{
		AuthorizationURL: env.Data.Link,
		// FW has no AccessCode equivalent — leave empty.
	}, nil
}

// Verify GETs /transactions/verify_by_reference?tx_ref=:reference and
// normalizes the response.
func (c *Client) Verify(ctx context.Context, reference string) (provider.Transaction, error) {
	q := url.Values{}
	q.Set("tx_ref", reference)
	body, err := c.do(ctx, "GET", "/transactions/verify_by_reference?"+q.Encode(), nil)
	if err != nil {
		return provider.Transaction{}, err
	}
	var rawEnv struct {
		Status  string          `json:"status"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &rawEnv); err != nil {
		return provider.Transaction{}, fmt.Errorf("decode verify envelope: %w", err)
	}
	if rawEnv.Status != "success" {
		return provider.Transaction{}, fmt.Errorf("flutterwave error: %s", rawEnv.Message)
	}
	var raw flwTransaction
	if err := json.Unmarshal(rawEnv.Data, &raw); err != nil {
		return provider.Transaction{}, fmt.Errorf("decode verify data: %w", err)
	}
	return toNormalized(raw, rawEnv.Data), nil
}

// VerifyWebhook authenticates a Flutterwave webhook by comparing the
// verif-hash header against the secret we configured in the dashboard.
// Uses constant-time compare to avoid timing leaks.
func (c *Client) VerifyWebhook(body []byte, headers map[string]string) (provider.WebhookResult, bool) {
	if c.webhookHash == "" {
		// Misconfigured — refuse everything. Better than silently accepting.
		return provider.WebhookResult{}, false
	}
	got := headerLookup(headers, "verif-hash")
	if subtle.ConstantTimeCompare([]byte(got), []byte(c.webhookHash)) != 1 {
		return provider.WebhookResult{}, false
	}
	var ev struct {
		Event string          `json:"event"`
		Data  json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &ev); err != nil {
		return provider.WebhookResult{}, false
	}
	var raw flwTransaction
	if err := json.Unmarshal(ev.Data, &raw); err != nil {
		return provider.WebhookResult{}, false
	}
	return provider.WebhookResult{
		EventType:   ev.Event,
		Transaction: toNormalized(raw, ev.Data),
	}, true
}

// ---- internals ----

type flwInitRequest struct {
	TxRef          string            `json:"tx_ref"`
	Amount         string            `json:"amount"` // FW accepts string or number; string avoids float JSON quirks
	Currency       string            `json:"currency"`
	RedirectURL    string            `json:"redirect_url"`
	Customer       flwCustomer       `json:"customer"`
	Customizations flwCustomizations `json:"customizations"`
	Meta           map[string]any    `json:"meta,omitempty"`
}

type flwCustomer struct {
	Email       string `json:"email"`
	PhoneNumber string `json:"phonenumber,omitempty"`
	Name        string `json:"name,omitempty"`
}

type flwCustomizations struct {
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	Logo        string `json:"logo,omitempty"`
}

type flwInitData struct {
	Link string `json:"link"`
}

type flwTransaction struct {
	ID                int64   `json:"id"`
	TxRef             string  `json:"tx_ref"`
	Status            string  `json:"status"` // successful | failed | pending
	Amount            float64 `json:"amount"`
	Currency          string  `json:"currency"`
	ProcessorResponse string  `json:"processor_response"`
	CreatedAt         string  `json:"created_at"`
}

type flwEnvelope[T any] struct {
	Status  string `json:"status"`
	Message string `json:"message"`
	Data    T      `json:"data"`
}

func toNormalized(t flwTransaction, raw json.RawMessage) provider.Transaction {
	status := provider.StatusPending
	switch strings.ToLower(t.Status) {
	case "successful":
		status = provider.StatusSuccess
	case "failed":
		status = provider.StatusFailed
	case "cancelled", "abandoned":
		status = provider.StatusAbandoned
	}
	return provider.Transaction{
		Reference:       t.TxRef,
		ProviderTxID:    fmt.Sprintf("%d", t.ID),
		Status:          status,
		AmountNaira:     t.Amount,
		Currency:        t.Currency,
		GatewayResponse: t.ProcessorResponse,
		PaidAt:          t.CreatedAt,
		Provider:        providerName,
		Raw:             raw,
	}
}

// do shells out to curl. We tell curl to print "HTTPSTATUS:%{http_code}" on
// its own line after the response body so we can recover both status and body
// from a single invocation.
func (c *Client) do(ctx context.Context, method, path string, payload any) ([]byte, error) {
	args := []string{
		"-sS", // silent but show errors on stderr
		"-X", method,
		"-H", "Accept: application/json",
		"-H", "Authorization: Bearer " + c.secretKey,
		"--max-time", "15",
		"-w", "\nHTTPSTATUS:%{http_code}",
	}
	var stdin []byte
	if payload != nil {
		buf, err := json.Marshal(payload)
		if err != nil {
			return nil, fmt.Errorf("marshal: %w", err)
		}
		args = append(args,
			"-H", "Content-Type: application/json",
			"--data-binary", "@-",
		)
		stdin = buf
	}
	args = append(args, c.baseURL+path)
	return runCurl(ctx, args, stdin)
}

// runCurl executes curl and returns the response body. The trailing
// "HTTPSTATUS:NNN" line is stripped from the body; non-2xx codes become errors.
func runCurl(ctx context.Context, args []string, stdin []byte) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "curl", args...)
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()

	out := stdout.Bytes()
	const marker = "\nHTTPSTATUS:"
	idx := bytes.LastIndex(out, []byte(marker))
	if idx < 0 {
		if runErr != nil {
			return nil, fmt.Errorf("curl: %w: %s", runErr, strings.TrimSpace(stderr.String()))
		}
		return nil, errors.New("curl: no HTTPSTATUS marker in output")
	}
	body := out[:idx]
	statusStr := strings.TrimSpace(string(out[idx+len(marker):]))
	var status int
	if _, err := fmt.Sscanf(statusStr, "%d", &status); err != nil {
		return nil, fmt.Errorf("curl: parse status %q: %w", statusStr, err)
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("flutterwave http %d: %s", status, truncate(body, 256))
	}
	return body, nil
}

func headerLookup(h map[string]string, key string) string {
	if v, ok := h[key]; ok {
		return v
	}
	for k, v := range h {
		if strings.EqualFold(k, key) {
			return v
		}
	}
	return ""
}

// sanitizeRedirectURL works around Cloudflare WAF: a payload containing a
// raw-IP URL like http://4.180.228.58:18081/checkout/callback gets a 403
// (likely an SSRF protection rule on api.flutterwave.com). We swap the raw
// IP for a `<ip>.nip.io` hostname, which is a free wildcard DNS that
// resolves to the same IP, so the user's browser still lands on the right
// host but the URL parses as a hostname and clears the WAF rule.
//
// Non-IP hostnames (including "localhost") are returned untouched.
func sanitizeRedirectURL(raw string) string {
	if raw == "" {
		return raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return raw
	}
	host := u.Hostname()
	if net.ParseIP(host) == nil {
		// Already a hostname — fine.
		return raw
	}
	port := u.Port()
	newHost := host + ".nip.io"
	if port != "" {
		newHost += ":" + port
	}
	u.Host = newHost
	return u.String()
}

func truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "…"
}
