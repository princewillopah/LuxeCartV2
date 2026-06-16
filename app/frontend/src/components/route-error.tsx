"use client";

/**
 * Phase 9 — Shared route-error UI used by `error.tsx` files under
 * /products, /cart, /checkout, /account, /admin. Centralizes the
 * markup so every route boundary shows the same friendly fallback
 * with a consistent reset + home action.
 */

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface RouteErrorProps {
  /** The thrown Error object (Next 14 error-boundary contract). */
  error: Error & { digest?: string };
  /** Re-attempts the failed render. */
  reset: () => void;
  /** Heading shown above the message. Default: "Something went wrong". */
  title?: string;
  /** Optional friendly fallback message when error.message is empty/cryptic. */
  fallbackMessage?: string;
  /** Optional secondary link (e.g. back to listing). */
  backHref?: string;
  /** Label for the back link. */
  backLabel?: string;
}

export function RouteError({
  error,
  reset,
  title = "Something went wrong",
  fallbackMessage = "An unexpected error occurred. Please try again.",
  backHref,
  backLabel = "Go back",
}: RouteErrorProps) {
  React.useEffect(() => {
    // eslint-disable-next-line no-console
    console.error(`[route error]`, error);
  }, [error]);

  return (
    <div className="container flex min-h-[60dvh] flex-col items-center justify-center gap-5 py-16 text-center">
      <div
        aria-hidden="true"
        className="grid h-14 w-14 place-items-center rounded-2xl bg-destructive/10 text-destructive"
      >
        <AlertTriangle className="h-7 w-7" />
      </div>
      <div className="space-y-2">
        <h2 className="font-display text-2xl font-bold tracking-tight md:text-3xl">
          {title}
        </h2>
        <p className="max-w-md text-muted-foreground">
          {error.message || fallbackMessage}
        </p>
        {error.digest && (
          <p className="text-xs font-mono text-muted-foreground/70">
            Ref: {error.digest}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button onClick={reset}>
          <RefreshCw className="h-4 w-4" /> Try again
        </Button>
        {backHref ? (
          <Button variant="outline" asChild>
            <Link href={backHref}>{backLabel}</Link>
          </Button>
        ) : (
          <Button variant="outline" asChild>
            <Link href="/">
              <Home className="h-4 w-4" /> Go home
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}
