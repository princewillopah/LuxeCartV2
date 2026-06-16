/** Phase 9 — Loading skeleton for the cart page. */

import { Skeleton } from "@/components/ui/skeleton";

export default function CartLoading() {
  return (
    <div className="container py-10">
      <Skeleton className="mb-8 h-10 w-48" />
      <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="flex gap-4 rounded-xl border border-border bg-card p-4 shadow-soft"
            >
              <Skeleton className="h-24 w-24 shrink-0 rounded-lg" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-4 w-1/4" />
              </div>
              <Skeleton className="h-8 w-24" />
            </div>
          ))}
        </div>
        <aside className="space-y-3 rounded-xl border border-border bg-card p-6 shadow-soft">
          <Skeleton className="h-6 w-32" />
          <div className="space-y-2 pt-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
          </div>
          <Skeleton className="mt-4 h-12 w-full" />
        </aside>
      </div>
    </div>
  );
}
