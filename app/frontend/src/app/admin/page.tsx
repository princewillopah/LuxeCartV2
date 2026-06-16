"use client";

import * as React from "react";
import Link from "next/link";
import {
  Wallet,
  Package,
  ShoppingBag,
  Users,
  ArrowRight,
} from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { formatPrice } from "@/lib/price";
import type { DashboardStats } from "@/lib/types";

const CARDS: Array<{
  key: keyof DashboardStats;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  format?: (n: number) => string;
  href?: string;
}> = [
  { key: "totalRevenue", label: "Revenue", icon: Wallet, format: (n) => formatPrice(n) },
  { key: "totalOrders", label: "Orders", icon: ShoppingBag, href: "/admin/orders" },
  { key: "totalProducts", label: "Products", icon: Package, href: "/admin/products" },
  { key: "totalUsers", label: "Users", icon: Users, href: "/admin/users" },
];

export default function AdminDashboardPage() {
  const [stats, setStats] = React.useState<DashboardStats | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    api
      .adminDashboardStats()
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch((e: Error) => {
        if (!cancelled) toast.error(e.message || "Failed to load stats");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-3xl font-bold tracking-tight">
          Admin dashboard
        </h1>
        <p className="text-sm text-muted-foreground">
          Snapshot of orders, products, customers and revenue.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {CARDS.map(({ key, label, icon: Icon, format, href }) => {
          const raw = stats?.[key] ?? 0;
          const value = format ? format(Number(raw)) : Number(raw).toLocaleString();
          const inner = (
            <Card className="flex h-full flex-col gap-3 p-5 transition-shadow hover:shadow-glow">
              <div className="flex items-center justify-between text-muted-foreground">
                <span className="text-xs font-medium uppercase tracking-wide">
                  {label}
                </span>
                <Icon className="h-4 w-4" />
              </div>
              {loading ? (
                <Skeleton className="h-8 w-24" />
              ) : (
                <div className="text-3xl font-bold">{value}</div>
              )}
              {href && (
                <span className="mt-auto flex items-center gap-1 text-xs font-medium text-primary">
                  View <ArrowRight className="h-3 w-3" />
                </span>
              )}
            </Card>
          );
          return href ? (
            <Link key={key} href={href} className="block">
              {inner}
            </Link>
          ) : (
            <div key={key}>{inner}</div>
          );
        })}
      </div>

      <Card className="p-6">
        <h2 className="text-lg font-semibold">Quick actions</h2>
        <p className="text-sm text-muted-foreground">
          Jump straight to a common back-office task.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Link
            href="/admin/products/new"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-soft hover:bg-primary/90"
          >
            + Add product
          </Link>
          <Link
            href="/admin/products"
            className="rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-secondary"
          >
            Manage products
          </Link>
          <Link
            href="/admin/orders"
            className="rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-secondary"
          >
            Manage orders
          </Link>
        </div>
      </Card>
    </div>
  );
}
