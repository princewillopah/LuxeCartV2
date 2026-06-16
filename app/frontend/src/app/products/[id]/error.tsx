"use client";

import { RouteError } from "@/components/route-error";

export default function ProductDetailError({
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
      title="Couldn't load this product"
      fallbackMessage="The product may have been removed, or our server is temporarily unreachable."
      backHref="/products"
      backLabel="Back to shop"
    />
  );
}
