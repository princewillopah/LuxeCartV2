"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpDown, Filter, X } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ProductCard, ProductCardSkeleton } from "@/components/product-card";
import { EmptyState } from "@/components/empty-state";
import type { Product } from "@/lib/types";

const CATEGORIES = [
  "all",
  "Electronics",
  "Fashion",
  "Home & Living",
  "Beauty",
  "Sports",
  "Books",
];

type Sort = "new" | "price-asc" | "price-desc" | "rating";

function sortProducts(list: Product[], sort: Sort | null): Product[] {
  const copy = [...list];
  switch (sort) {
    case "price-asc":
      return copy.sort((a, b) => a.price - b.price);
    case "price-desc":
      return copy.sort((a, b) => b.price - a.price);
    case "rating":
      return copy.sort(
        (a, b) => (b.averageRating ?? 0) - (a.averageRating ?? 0)
      );
    case "new":
    default:
      return copy.sort(
        (a, b) =>
          new Date(b.createdAt ?? 0).getTime() -
          new Date(a.createdAt ?? 0).getTime()
      );
  }
}

export default function ProductsPage() {
  return (
    <React.Suspense fallback={<div className="container py-16" />}>
      <ProductsInner />
    </React.Suspense>
  );
}

function ProductsInner() {
  const sp = useSearchParams();
  const router = useRouter();
  const category = sp.get("category") ?? "all";
  const q = sp.get("q") ?? "";
  const sort = (sp.get("sort") as Sort | null) ?? "new";
  const min = Number(sp.get("min") ?? 0);
  const max = Number(sp.get("max") ?? 0);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["products", category],
    queryFn: () => api.listProducts({ category }),
  });

  const filtered = React.useMemo(() => {
    let list = data ?? [];
    if (q) {
      const ql = q.toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(ql) ||
          p.brand?.toLowerCase().includes(ql) ||
          p.description?.toLowerCase().includes(ql)
      );
    }
    if (min > 0) list = list.filter((p) => p.price >= min);
    if (max > 0) list = list.filter((p) => p.price <= max);
    return sortProducts(list, sort);
  }, [data, q, min, max, sort]);

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(sp.toString());
    if (!value || value === "all") next.delete(key);
    else next.set(key, value);
    router.push(`/products?${next.toString()}`);
  }

  const activeFilters: Array<{ key: string; label: string }> = [];
  if (category !== "all") activeFilters.push({ key: "category", label: category });
  if (q) activeFilters.push({ key: "q", label: `“${q}”` });
  if (min > 0) activeFilters.push({ key: "min", label: `≥ $${min}` });
  if (max > 0) activeFilters.push({ key: "max", label: `≤ $${max}` });

  return (
    <div className="container py-10">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl font-bold tracking-tight">
            {category === "all" ? "All Products" : category}
          </h1>
          <p className="mt-1 text-muted-foreground">
            {isLoading
              ? "Loading…"
              : `${filtered.length} product${filtered.length === 1 ? "" : "s"} found`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ArrowUpDown className="h-4 w-4 text-muted-foreground" />
          <select
            value={sort}
            onChange={(e) => setParam("sort", e.target.value)}
            className="h-10 rounded-md border border-input bg-background px-3 text-sm shadow-soft focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
          >
            <option value="new">Newest</option>
            <option value="price-asc">Price: Low to High</option>
            <option value="price-desc">Price: High to Low</option>
            <option value="rating">Top Rated</option>
          </select>
        </div>
      </div>

      <div className="grid gap-8 lg:grid-cols-[260px_1fr]">
        {/* Filters */}
        <aside className="space-y-6">
          <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold">
              <Filter className="h-4 w-4 text-primary" /> Categories
            </div>
            <ul className="space-y-1">
              {CATEGORIES.map((c) => {
                const active = (c === "all" && category === "all") || c === category;
                return (
                  <li key={c}>
                    <button
                      onClick={() => setParam("category", c)}
                      className={`block w-full rounded-md px-3 py-1.5 text-left text-sm transition ${
                        active
                          ? "bg-primary/10 font-medium text-primary"
                          : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                      }`}
                    >
                      {c === "all" ? "All" : c}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
            <h3 className="mb-4 text-sm font-semibold">Price range</h3>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                placeholder="Min"
                defaultValue={min || ""}
                onBlur={(e) => setParam("min", e.target.value || null)}
              />
              <span className="text-muted-foreground">—</span>
              <Input
                type="number"
                placeholder="Max"
                defaultValue={max || ""}
                onBlur={(e) => setParam("max", e.target.value || null)}
              />
            </div>
          </div>
        </aside>

        {/* Grid */}
        <div className="space-y-4">
          {activeFilters.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Active:</span>
              {activeFilters.map((f) => (
                <Badge
                  key={f.key}
                  variant="secondary"
                  className="cursor-pointer gap-1"
                  onClick={() => setParam(f.key, null)}
                >
                  {f.label} <X className="h-3 w-3" />
                </Badge>
              ))}
              <Button
                variant="link"
                size="sm"
                onClick={() => router.push("/products")}
              >
                Clear all
              </Button>
            </div>
          )}

          {isLoading ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <ProductCardSkeleton key={i} />
              ))}
            </div>
          ) : isError ? (
            <EmptyState
              title="Couldn't load products"
              description="The product service may be down. Check that docker compose is running."
              actionLabel="Try again"
              actionHref="/products"
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              title="No products match your filters"
              description="Try removing some filters or browsing all categories."
              actionLabel="Browse all"
              actionHref="/products"
            />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {filtered.map((p) => (
                <ProductCard key={String(p.id)} product={p} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
