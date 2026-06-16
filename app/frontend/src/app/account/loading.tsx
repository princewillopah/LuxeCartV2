/** Phase 9 — Loading skeleton for the account page (tabs + content). */

import { Skeleton } from "@/components/ui/skeleton";

export default function AccountLoading() {
  return (
    <div className="container py-10">
      <Skeleton className="mb-2 h-10 w-56" />
      <Skeleton className="mb-8 h-4 w-72" />

      <div className="grid gap-6 md:grid-cols-[200px_1fr]">
        {/* Tab strip / sidebar */}
        <nav className="flex gap-2 overflow-x-auto md:flex-col md:gap-1">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full min-w-[120px]" />
          ))}
        </nav>

        {/* Tab content */}
        <div className="space-y-4 rounded-xl border border-border bg-card p-6 shadow-soft">
          <Skeleton className="h-6 w-48" />
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
