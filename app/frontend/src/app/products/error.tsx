"use client";

import { RouteError } from "@/components/route-error";

export default function ProductsError({
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
      title="Couldn't load products"
      fallbackMessage="We had trouble fetching the catalog. Please try again in a moment."
    />
  );
}
