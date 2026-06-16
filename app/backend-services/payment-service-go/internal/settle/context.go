// Package settle — context helper.
//
// Background goroutines that publish events must NOT use the request's
// context (the HTTP handler may have already returned, cancelling it).
// contextDetached returns a fresh, time-bounded context for that purpose.
package settle

import (
	"context"
	"time"
)

func contextDetached() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 5*time.Second)
}
