"use client";

import { RouteError } from "@/components/route-error";

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteError
      error={error}
      reset={reset}
      title="Admin error"
      fallbackMessage="We had trouble loading the admin panel. Please try again."
      backHref="/admin"
      backLabel="Back to dashboard"
    />
  );
}
