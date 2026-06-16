/**
 * Phase 9 — Server-side loading skeleton for the product detail page.
 * Same shape as the inline `isLoading` block inside `page.tsx`, but
 * shown during the navigation transition BEFORE the client component
 * mounts so the user sees something immediately.
 */

import { Skeleton } from "@/components/ui/skeleton";

export default function ProductDetailLoading() {
  return (
    <div className="container py-8">
      {/* Back link placeholder */}
      <Skeleton className="mb-6 h-5 w-16" />

      <div className="grid gap-10 md:grid-cols-2">
        {/* Gallery */}
        <div className="space-y-3">
          <Skeleton className="aspect-square w-full rounded-2xl" />
          <div className="grid grid-cols-5 gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="aspect-square rounded-lg" />
            ))}
          </div>
        </div>

        {/* Info */}
        <div className="space-y-5">
          <div className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-10 w-4/5" />
            <Skeleton className="h-5 w-1/2" />
          </div>
          <Skeleton className="h-12 w-2/5" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
          <div className="flex gap-3 pt-2">
            <Skeleton className="h-12 w-32" />
            <Skeleton className="h-12 w-44" />
          </div>
          <div className="grid gap-3 border-t border-border/60 pt-6 sm:grid-cols-2">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-full" />
          </div>
        </div>
      </div>
    </div>
  );
}
