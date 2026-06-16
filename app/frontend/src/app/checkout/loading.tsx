/** Phase 9 — Loading skeleton for the checkout page. */

import { Skeleton } from "@/components/ui/skeleton";

export default function CheckoutLoading() {
  return (
    <div className="container py-10">
      <Skeleton className="mb-8 h-10 w-40" />
      <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
        <div className="space-y-4 rounded-xl border border-border bg-card p-6 shadow-soft">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
          <Skeleton className="mt-4 h-12 w-44" />
        </div>
        <aside className="space-y-3 rounded-xl border border-border bg-card p-6 shadow-soft">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="mt-4 h-10 w-full" />
        </aside>
      </div>
    </div>
  );
}
