"use client";

import { RouteError } from "@/components/route-error";

export default function CartError({
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
      title="Cart unavailable"
      fallbackMessage="We couldn't load your cart right now. Your items are still saved."
      backHref="/products"
      backLabel="Continue shopping"
    />
  );
}
