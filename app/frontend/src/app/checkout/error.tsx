"use client";

import { RouteError } from "@/components/route-error";

export default function CheckoutError({
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
      title="Checkout error"
      fallbackMessage="Something went wrong while preparing checkout. Your cart is safe — please try again."
      backHref="/cart"
      backLabel="Back to cart"
    />
  );
}
