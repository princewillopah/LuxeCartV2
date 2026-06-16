"use client";

import { RouteError } from "@/components/route-error";

export default function AccountError({
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
      title="Couldn't load your account"
      fallbackMessage="We had trouble loading your account details. Please try again."
    />
  );
}
