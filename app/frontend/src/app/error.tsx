"use client";

/**
 * Phase 9 — Top-level error boundary. Catches anything thrown beneath
 * the root layout (but ABOVE per-route boundaries, which take
 * precedence when present). Lives inside Providers so it has access
 * to Tailwind / fonts / theme — unlike global-error.tsx which is the
 * absolute last resort.
 */

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, Home, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    // Surface to the browser console — useful in dev, harmless in prod.
    // eslint-disable-next-line no-console
    console.error("[root error]", error);
  }, [error]);

  return (
    <div className="container flex min-h-[70dvh] flex-col items-center justify-center gap-5 text-center">
      <div className="grid h-16 w-16 place-items-center rounded-2xl bg-destructive/10 text-destructive">
        <AlertTriangle className="h-8 w-8" />
      </div>
      <div className="space-y-2">
        <h1 className="font-display text-3xl font-bold tracking-tight md:text-4xl">
          Something went wrong
        </h1>
        <p className="max-w-md text-muted-foreground">
          {error.message || "An unexpected error occurred while loading this page."}
        </p>
        {error.digest && (
          <p className="text-xs font-mono text-muted-foreground/70">
            Ref: {error.digest}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button onClick={reset} size="lg">
          <RefreshCw className="h-4 w-4" /> Try again
        </Button>
        <Button variant="outline" size="lg" asChild>
          <Link href="/">
            <Home className="h-4 w-4" /> Go home
          </Link>
        </Button>
      </div>
    </div>
  );
}
