// Command server is the entry point for payment-service-go.
//
// Boots the HTTP server, opens the Postgres pool, dials RabbitMQ, then waits
// for SIGTERM. On shutdown it gives in-flight requests up to 10 seconds to
// drain before tearing down dependencies. This is what makes Kubernetes
// rolling deploys safe — no truncated webhooks, no half-written DB writes.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/luxecart/payment-service-go/internal/config"
	"github.com/luxecart/payment-service-go/internal/events"
	"github.com/luxecart/payment-service-go/internal/flutterwave"
	"github.com/luxecart/payment-service-go/internal/httpapi"
	"github.com/luxecart/payment-service-go/internal/logging"
	"github.com/luxecart/payment-service-go/internal/paystack"
	"github.com/luxecart/payment-service-go/internal/provider"
	"github.com/luxecart/payment-service-go/internal/settle"
	"github.com/luxecart/payment-service-go/internal/store"
)

func main() {
	if err := run(); err != nil {
		// slog isn't set up yet if run() failed in config.Load(), so fall
		// back to stdlib for a single clean exit message.
		fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	log := logging.Setup(cfg.ServiceName)
	log.Info("starting", "port", cfg.Port)

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()

	// --- dependencies ---
	st, err := store.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("store: %w", err)
	}
	defer st.Close()
	log.Info("postgres connected")

	pub := events.New(cfg.KafkaBrokers, cfg.ServiceName, log)
	if err := pub.Connect(); err != nil {
		// Non-fatal: kafka-go writers connect lazily, this rarely returns an error.
		log.Warn("kafka initial connect failed; will retry on demand", "err", err)
	} else {
		log.Info("kafka publisher ready", "brokers", cfg.KafkaBrokers)
	}
	defer pub.Close()

	ps := paystack.New(cfg.PaystackBaseURL, cfg.PaystackSecretKey)

	// Build the provider registry. Paystack is always registered because
	// its key is required. Flutterwave is optional — only registered if a
	// secret key was provided.
	reg := provider.NewRegistry()
	reg.Register(ps)
	log.Info("provider registered", "name", ps.Name())
	if cfg.FlutterwaveSecretKey != "" {
		fw := flutterwave.New(
			cfg.FlutterwaveBaseURL,
			cfg.FlutterwaveSecretKey,
			cfg.FlutterwaveWebhookHash,
			cfg.FlutterwaveSiteTitle,
		)
		reg.Register(fw)
		log.Info("provider registered", "name", fw.Name())
	} else {
		log.Info("flutterwave not configured; skipping",
			"hint", "set FLUTTERWAVE_SECRET_KEY to enable")
	}

	engine := settle.New(st, pub, log)
	api := httpapi.New(cfg, st, reg, engine, log)

	// --- http server ---
	srv := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.Port),
		Handler:           api.Routes(promhttp.Handler()),
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	serveErr := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
		}
	}()

	select {
	case err := <-serveErr:
		return fmt.Errorf("http: %w", err)
	case <-ctx.Done():
		log.Info("signal received, shutting down")
	}

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error("http shutdown error", "err", err)
	}
	log.Info("bye")
	_ = slog.Default()
	return nil
}
