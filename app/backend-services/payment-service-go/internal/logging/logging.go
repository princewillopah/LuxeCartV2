// Package logging configures the process-wide slog logger.
//
// JSON output, one line per record. The "service" attribute is stamped on
// every record so when these get shipped to Loki / CloudWatch they're
// trivially filterable.
package logging

import (
	"log/slog"
	"os"
)

// Setup installs a JSON slog handler as the default logger.
func Setup(service string) *slog.Logger {
	h := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})
	l := slog.New(h).With("service", service)
	slog.SetDefault(l)
	return l
}
