"use client";

import * as React from "react";
import { useAuth } from "@/store/auth";
import { EmptyState } from "@/components/empty-state";

/**
 * Client-side admin gate. Returns the children only when the persisted
 * auth store has hydrated AND the user has `role === "admin"`. Otherwise
 * shows a friendly empty state. Used at the top of every /admin/* page.
 */
export function AdminGuard({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const user = useAuth((s) => s.user);

  if (!mounted) return <div className="container py-16" />;

  if (!user) {
    return (
      <div className="container py-16">
        <EmptyState
          title="Sign in required"
          description="Sign in as an admin to access the back office."
          actionLabel="Sign in"
          actionHref="/auth/login?next=/admin"
        />
      </div>
    );
  }

  if (user.role !== "admin") {
    return (
      <div className="container py-16">
        <EmptyState
          title="Admin only"
          description="This area is restricted to admin accounts."
          actionLabel="Back home"
          actionHref="/"
        />
      </div>
    );
  }

  return <>{children}</>;
}
