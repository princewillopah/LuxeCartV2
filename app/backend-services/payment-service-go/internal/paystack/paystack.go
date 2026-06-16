// Package paystack is a thin client over the Paystack REST API that satisfies
// provider.Provider.
//
// We only need three calls: initialize, verify, and the webhook signature
// helper. No SDK dependency — stdlib net/http does the job and stays portable
// across distroless images.
//
// Paystack works in KOBO (1/100 of a naira). The conversion happens here so
// nothing outside this package has to know.
package paystack

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"time"

	"github.com/luxecart/payment-service-go/internal/provider"
)

const providerName = "paystack"

// Client is safe for concurrent use; the embedded http.Client is.
type Client struct {
	baseURL    string
	secretKey  string
	httpClient *http.Client
}

// Compile-time check: Client must satisfy provider.Provider.
var _ provider.Provider = (*Client)(nil)

func New(baseURL, secretKey string) *Client {
	return &Client{
		baseURL:   baseURL,
		secretKey: secretKey,
		httpClient: &http.Client{
			Timeout: 15 * time.Second,
		},
	}
}

func (c *Client) Name() string { return providerName }

// Initialize POSTs /transaction/initialize and returns the hosted-page URL.
func (c *Client) Initialize(ctx context.Context, in provider.InitializeRequest) (provider.InitializeResponse, error) {
	amountKobo := int64(math.Round(in.AmountNaira * 100))
	payload := paystackInitRequest{
		Email:       in.Email,
		Amount:      amountKobo,
		Currency:    "NGN",
		Reference:   in.Reference,
		CallbackURL: in.CallbackURL,
		Metadata:    in.Metadata,
	}
	body, err := c.do(ctx, http.MethodPost, "/transaction/initialize", payload)
	if err != nil {
		return provider.InitializeResponse{}, err
	}
	var env paystackEnvelope[paystackInitData]
	if err := json.Unmarshal(body, &env); err != nil {
		return provider.InitializeResponse{}, fmt.Errorf("decode initialize: %w", err)
	}
	if !env.Status {
		return provider.InitializeResponse{}, fmt.Errorf("paystack error: %s", env.Message)
	}
	return provider.InitializeResponse{
		AuthorizationURL: env.Data.AuthorizationURL,
		AccessCode:       env.Data.AccessCode,
		Reference:        env.Data.Reference,
	}, nil
}

// Verify GETs /transaction/verify/:reference and normalizes the response.
func (c *Client) Verify(ctx context.Context, reference string) (provider.Transaction, error) {
	body, err := c.do(ctx, http.MethodGet, "/transaction/verify/"+reference, nil)
	if err != nil {
		return provider.Transaction{}, err
	}
	var rawEnv struct {
		Status  bool            `json:"status"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &rawEnv); err != nil {
		return provider.Transaction{}, fmt.Errorf("decode verify envelope: %w", err)
	}
	if !rawEnv.Status {
		return provider.Transaction{}, fmt.Errorf("paystack error: %s", rawEnv.Message)
	}
	var raw paystackTransaction
	if err := json.Unmarshal(rawEnv.Data, &raw); err != nil {
		return provider.Transaction{}, fmt.Errorf("decode verify data: %w", err)
	}
	return toNormalized(raw, rawEnv.Data), nil
}

// VerifyWebhook authenticates a Paystack webhook using HMAC-SHA512 and
// decodes it. Header expected: x-paystack-signature (hex).
func (c *Client) VerifyWebhook(body []byte, headers map[string]string) (provider.WebhookResult, bool) {
	sig := headerLookup(headers, "x-paystack-signature")
	if sig == "" || !c.verifySignature(body, sig) {
		return provider.WebhookResult{}, false
	}
	var ev struct {
		Event string          `json:"event"`
		Data  json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &ev); err != nil {
		return provider.WebhookResult{}, false
	}
	var raw paystackTransaction
	if err := json.Unmarshal(ev.Data, &raw); err != nil {
		return provider.WebhookResult{}, false
	}
	return provider.WebhookResult{
		EventType:   ev.Event,
		Transaction: toNormalized(raw, ev.Data),
	}, true
}

// verifySignature constant-time compares the HMAC-SHA512 of body against header.
func (c *Client) verifySignature(body []byte, header string) bool {
	mac := hmac.New(sha512.New, []byte(c.secretKey))
	mac.Write(body)
	expected := mac.Sum(nil)

	got, err := hex.DecodeString(header)
	if err != nil {
		return false
	}
	return hmac.Equal(expected, got)
}

// ---- internals ----

type paystackInitRequest struct {
	Email       string         `json:"email"`
	Amount      int64          `json:"amount"` // kobo
	Currency    string         `json:"currency"`
	Reference   string         `json:"reference"`
	CallbackURL string         `json:"callback_url,omitempty"`
	Metadata    map[string]any `json:"metadata,omitempty"`
}

type paystackInitData struct {
	AuthorizationURL string `json:"authorization_url"`
	AccessCode       string `json:"access_code"`
	Reference        string `json:"reference"`
}

type paystackTransaction struct {
	ID              json.Number `json:"id"`
	Status          string      `json:"status"` // success | failed | abandoned | ongoing
	Reference       string      `json:"reference"`
	Amount          int64       `json:"amount"` // kobo
	Currency        string      `json:"currency"`
	GatewayResponse string      `json:"gateway_response"`
	Channel         string      `json:"channel"`
	PaidAt          string      `json:"paid_at"`
}

type paystackEnvelope[T any] struct {
	Status  bool   `json:"status"`
	Message string `json:"message"`
	Data    T      `json:"data"`
}

func toNormalized(t paystackTransaction, raw json.RawMessage) provider.Transaction {
	status := provider.StatusPending
	switch t.Status {
	case "success":
		status = provider.StatusSuccess
	case "failed":
		status = provider.StatusFailed
	case "abandoned":
		status = provider.StatusAbandoned
	}
	return provider.Transaction{
		Reference:       t.Reference,
		ProviderTxID:    t.ID.String(),
		Status:          status,
		AmountNaira:     float64(t.Amount) / 100,
		Currency:        t.Currency,
		GatewayResponse: t.GatewayResponse,
		PaidAt:          t.PaidAt,
		Provider:        providerName,
		Raw:             raw,
	}
}

func (c *Client) do(ctx context.Context, method, path string, payload any) ([]byte, error) {
	var body io.Reader
	if payload != nil {
		buf, err := json.Marshal(payload)
		if err != nil {
			return nil, fmt.Errorf("marshal: %w", err)
		}
		body = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.secretKey)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http: %w", err)
	}
	defer res.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(res.Body, 1<<20)) // 1MiB cap
	if err != nil {
		return nil, fmt.Errorf("read: %w", err)
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		// Paystack errors come back as {"status":false,"message":"…"}.
		// Surface the message verbatim so callers (and ultimately the UI
		// toast) get something actionable like "Amount is greater than
		// maximum allowed for your business" instead of an HTTP status.
		var env struct {
			Message string `json:"message"`
		}
		if err := json.Unmarshal(respBody, &env); err == nil && env.Message != "" {
			return nil, fmt.Errorf("paystack: %s", env.Message)
		}
		return nil, fmt.Errorf("paystack %s %s: %s (%d)",
			method, path, truncate(respBody, 256), res.StatusCode)
	}
	return respBody, nil
}

func headerLookup(h map[string]string, key string) string {
	if v, ok := h[key]; ok {
		return v
	}
	for k, v := range h {
		if equalFold(k, key) {
			return v
		}
	}
	return ""
}

func equalFold(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		ca, cb := a[i], b[i]
		if 'A' <= ca && ca <= 'Z' {
			ca += 'a' - 'A'
		}
		if 'A' <= cb && cb <= 'Z' {
			cb += 'a' - 'A'
		}
		if ca != cb {
			return false
		}
	}
	return true
}

func truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "…"
}
