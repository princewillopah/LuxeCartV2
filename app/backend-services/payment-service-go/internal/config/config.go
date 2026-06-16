// Package config loads environment-driven configuration once at startup.
//
// All settings are read from environment variables — no flags, no files —
// because that's how Kubernetes (and 12-factor apps generally) expect to be
// configured. Anything sensitive (DB password, Paystack secret) flows through
// the same channel.
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
)

// Config is the fully-resolved runtime configuration. Built once at boot,
// passed around by value so no goroutine ever races on it.
type Config struct {
	// HTTP
	Port int

	// Postgres
	DatabaseURL string

	// Kafka
	KafkaBrokers string

	// Paystack
	PaystackSecretKey string
	PaystackPublicKey string
	PaystackBaseURL   string

	// Flutterwave (optional — service still boots without these, but the
	// flutterwave provider will not be registered, so the gateway dropdown
	// will not list it).
	FlutterwaveSecretKey  string
	FlutterwavePublicKey  string
	FlutterwaveWebhookHash string
	FlutterwaveBaseURL    string
	FlutterwaveSiteTitle  string

	// Public-facing URLs the user is bounced to after the gateway finishes.
	PublicFrontendURL string

	// Service identity (for logs + metrics labels)
	ServiceName string
}

// Load reads + validates env. Returns an error rather than panicking so main
// can log it cleanly and exit non-zero.
func Load() (Config, error) {
	cfg := Config{
		ServiceName:       getenv("SERVICE_NAME", "payment-service-go"),
		Port:              getenvInt("PORT", 3018),
		DatabaseURL:       os.Getenv("DATABASE_URL"),
		KafkaBrokers:      os.Getenv("KAFKA_BROKERS"),
		PaystackSecretKey: os.Getenv("PAYSTACK_SECRET_KEY"),
		PaystackPublicKey: os.Getenv("PAYSTACK_PUBLIC_KEY"),
		PaystackBaseURL:   getenv("PAYSTACK_BASE_URL", "https://api.paystack.co"),
		FlutterwaveSecretKey:   os.Getenv("FLUTTERWAVE_SECRET_KEY"),
		FlutterwavePublicKey:   os.Getenv("FLUTTERWAVE_PUBLIC_KEY"),
		FlutterwaveWebhookHash: os.Getenv("FLUTTERWAVE_WEBHOOK_HASH"),
		FlutterwaveBaseURL:     getenv("FLUTTERWAVE_BASE_URL", "https://api.flutterwave.com/v3"),
		FlutterwaveSiteTitle:   getenv("FLUTTERWAVE_SITE_TITLE", "LuxeCart"),
		PublicFrontendURL: os.Getenv("PUBLIC_FRONTEND_URL"),
	}

	var missing []string
	if cfg.DatabaseURL == "" {
		missing = append(missing, "DATABASE_URL")
	}
	if cfg.KafkaBrokers == "" {
		missing = append(missing, "KAFKA_BROKERS")
	}
	if cfg.PaystackSecretKey == "" {
		missing = append(missing, "PAYSTACK_SECRET_KEY")
	}
	if cfg.PublicFrontendURL == "" {
		missing = append(missing, "PUBLIC_FRONTEND_URL")
	}
	if len(missing) > 0 {
		return cfg, fmt.Errorf("missing required env: %v", missing)
	}

	if cfg.Port <= 0 || cfg.Port > 65535 {
		return cfg, errors.New("PORT out of range")
	}
	return cfg, nil
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func getenvInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}
