/**
 * Phase 9 — Loading skeleton for admin sub-routes. The admin layout
 * (which renders the sidebar nav + AdminGuard) is already on screen
 * by the time this fires, so we only skeleton the content area.
 */

import { Skeleton } from "@/components/ui/skeleton";

export default function AdminLoading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-9 w-48" />
      <div className="rounded-xl border border-border bg-card p-4 shadow-soft">
        <div className="mb-4 flex items-center justify-between gap-2">
          <Skeleton className="h-10 w-72" />
          <Skeleton className="h-10 w-32" />
        </div>
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
