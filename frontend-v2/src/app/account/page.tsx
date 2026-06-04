"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Package, User as UserIcon, MapPin, Heart, LogOut } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { useAuth } from "@/store/auth";
import { cn } from "@/lib/utils";

const TABS = [
  { id: "profile", label: "Profile", icon: UserIcon },
  { id: "orders", label: "Orders", icon: Package },
  { id: "addresses", label: "Addresses", icon: MapPin },
  { id: "wishlist", label: "Wishlist", icon: Heart },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function AccountPage() {
  return (
    <React.Suspense fallback={<div className="container py-16" />}>
      <AccountInner />
    </React.Suspense>
  );
}

function AccountInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);

  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  React.useEffect(() => {
    if (mounted && !user) router.push("/auth/login?next=/account");
  }, [mounted, user, router]);

  const tab = (sp.get("tab") as TabId) ?? "profile";

  if (!mounted || !user) return <div className="container py-16" />;

  return (
    <div className="container py-10">
      <h1 className="mb-2 font-display text-4xl font-bold tracking-tight">
        Hi, {user.firstName} 👋
      </h1>
      <p className="mb-8 text-muted-foreground">Manage your account and orders.</p>

      <div className="grid gap-8 lg:grid-cols-[240px_1fr]">
        <aside>
          <nav className="space-y-1">
            {TABS.map((t) => (
              <Link
                key={t.id}
                href={`/account?tab=${t.id}`}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition",
                  tab === t.id
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                )}
              >
                <t.icon className="h-4 w-4" />
                {t.label}
              </Link>
            ))}
            <button
              onClick={() => {
                logout();
                router.push("/");
              }}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition hover:bg-secondary hover:text-destructive"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </nav>
        </aside>

        <div>
          {tab === "profile" && <ProfileTab />}
          {tab === "orders" && <OrdersTab />}
          {tab === "addresses" && (
            <EmptyState
              icon={MapPin}
              title="No saved addresses"
              description="Your shipping addresses will appear here after checkout."
            />
          )}
          {tab === "wishlist" && (
            <EmptyState
              icon={Heart}
              title="Your wishlist is empty"
              description="Save products you love for later."
              actionLabel="Browse products"
              actionHref="/products"
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ProfileTab() {
  const user = useAuth((s) => s.user)!;
  return (
    <Card className="p-6">
      <h2 className="mb-1 text-lg font-semibold">Profile</h2>
      <p className="mb-6 text-sm text-muted-foreground">Account details on file.</p>
      <dl className="grid gap-4 sm:grid-cols-2">
        <Field label="First name" value={user.firstName} />
        <Field label="Last name" value={user.lastName} />
        <Field label="Email" value={user.email} />
        <Field label="Role" value={user.role} />
      </dl>
      <div className="mt-6">
        <Button variant="outline" disabled>
          Edit profile (coming soon)
        </Button>
      </div>
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 font-medium">{value}</dd>
    </div>
  );
}

function OrdersTab() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["orders"],
    queryFn: () => api.listOrders(),
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24 w-full rounded-2xl" />
        ))}
      </div>
    );
  }
  if (isError) {
    return (
      <EmptyState
        title="Couldn't load orders"
        description="The order service may be unavailable. Please try again."
      />
    );
  }
  if (!data || data.length === 0) {
    return (
      <EmptyState
        icon={Package}
        title="No orders yet"
        description="When you place an order, it will show up here."
        actionLabel="Start shopping"
        actionHref="/products"
      />
    );
  }

  const statusVariant = (s: string) =>
    s === "delivered" || s === "paid"
      ? "success"
      : s === "cancelled"
        ? "destructive"
        : s === "shipped"
          ? "default"
          : "warning";

  return (
    <div className="space-y-3">
      {data.map((o) => (
        <Card key={String(o.id)} className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-semibold">Order #{String(o.id).slice(0, 8)}</h3>
                <Badge variant={statusVariant(o.status)}>{o.status}</Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {new Date(o.createdAt).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}{" "}
                · {o.items?.length ?? 0} item{(o.items?.length ?? 0) === 1 ? "" : "s"}
              </p>
            </div>
            <div className="text-right">
              <p className="text-lg font-bold">${Number(o.total ?? 0).toFixed(2)}</p>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
