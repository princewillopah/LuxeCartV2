"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpDown, Filter, Tag, X } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ProductCard, ProductCardSkeleton } from "@/components/product-card";
import { EmptyState } from "@/components/empty-state";
import { Pagination } from "@/components/pagination";
import type { Product } from "@/lib/types";

type Sort = "new" | "price-asc" | "price-desc" | "rating";

/**
 * Parse a comma-separated URL param into a deduped, non-empty list.
 *   "Electronics,Books"  -> ["Electronics", "Books"]
 *   "Electronics"        -> ["Electronics"]
 *   ""  | null           -> []
 * Backwards-compatible with the previous single-value form.
 */
function parseList(raw: string | null): string[] {
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );
}

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
  // Multi-select category + brand. URL param is comma-separated so it
  // stays shareable/bookmarkable. Empty list = no filter (= "all").
  const selectedCategories = parseList(sp.get("category"));
  const selectedBrands     = parseList(sp.get("brand"));
  const q = sp.get("q") ?? "";
  const sort = (sp.get("sort") as Sort | null) ?? "new";
  const min = Number(sp.get("min") ?? 0);
  const max = Number(sp.get("max") ?? 0);

  // Fetch ALL products once and apply category/brand/q/price filters
  // client-side. The /public endpoint is Redis-cached and the catalog
  // is small enough that this keeps the multi-select responsive without
  // re-querying on every checkbox toggle.
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["products", "all"],
    queryFn: () => api.listProducts(),
  });

  // Live category list with product counts (for the checkbox group).
  // Falls back to deriving from `data` if the dedicated endpoint is
  // unavailable, so the filter still renders something useful.
  const { data: catCounts } = useQuery({
    queryKey: ["products", "categories"],
    queryFn: () => api.listCategoriesWithCount(),
  });
  const categoryOptions = React.useMemo(() => {
    if (catCounts && catCounts.length > 0) return catCounts;
    const map = new Map<string, number>();
    for (const p of data ?? []) {
      map.set(p.category, (map.get(p.category) ?? 0) + 1);
    }
    return Array.from(map, ([name, count]) => ({ name, count })).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }, [catCounts, data]);

  // Brand options are derived from the loaded products so the list
  // only ever shows brands that actually have stock in the catalog.
  const brandOptions = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const p of data ?? []) {
      const b = (p.brand ?? "").trim();
      if (!b) continue;
      map.set(b, (map.get(b) ?? 0) + 1);
    }
    return Array.from(map, ([name, count]) => ({ name, count })).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }, [data]);

  const filtered = React.useMemo(() => {
    let list = data ?? [];
    if (selectedCategories.length > 0) {
      const set = new Set(selectedCategories);
      list = list.filter((p) => set.has(p.category));
    }
    if (selectedBrands.length > 0) {
      const set = new Set(selectedBrands);
      list = list.filter((p) => p.brand != null && set.has(p.brand));
    }
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
  }, [data, selectedCategories, selectedBrands, q, min, max, sort]);

  // ── Pagination (client-side, applied AFTER filter+sort) ────────────────
  // Why client-side: the existing search / price-range / sort all run
  // locally on the fetched list, so paginating client-side keeps every
  // filter behaviour identical. We just slice the already-filtered
  // array. With ~49 products and Redis-cached `/public`, this is cheap.
  const PAGE_SIZE = 12;
  const [page, setPage] = React.useState(1);
  // Whenever the user changes any filter we jump back to page 1 —
  // otherwise they could be stranded on page 4 of a 2-page result.
  React.useEffect(() => {
    setPage(1);
    // Joining the arrays gives a stable string key so the effect only
    // fires when the actual set of selected values changes.
  }, [selectedCategories.join(","), selectedBrands.join(","), q, min, max, sort]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paged = React.useMemo(
    () => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage]
  );

  /** Replace a single URL param (or remove it when value is null/empty/"all"). */
  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(sp.toString());
    if (!value || value === "all") next.delete(key);
    else next.set(key, value);
    router.push(`/products?${next.toString()}`);
  }

  /** Toggle one value inside a comma-separated multi-select URL param. */
  function toggleListParam(key: string, value: string, currentList: string[]) {
    const next = new Set(currentList);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    const joined = Array.from(next).join(",");
    setParam(key, joined || null);
  }

  /** Remove one value from a comma-separated multi-select URL param. */
  function removeFromListParam(key: string, value: string, currentList: string[]) {
    const joined = currentList.filter((v) => v !== value).join(",");
    setParam(key, joined || null);
  }

  // Active-filter chips: one per category + one per brand + q/price.
  type Chip = { id: string; label: string; onClear: () => void };
  const activeFilters: Chip[] = [];
  for (const c of selectedCategories) {
    activeFilters.push({
      id: `category:${c}`,
      label: c,
      onClear: () => removeFromListParam("category", c, selectedCategories),
    });
  }
  for (const b of selectedBrands) {
    activeFilters.push({
      id: `brand:${b}`,
      label: b,
      onClear: () => removeFromListParam("brand", b, selectedBrands),
    });
  }
  if (q) activeFilters.push({ id: "q", label: `“${q}”`, onClear: () => setParam("q", null) });
  if (min > 0) activeFilters.push({ id: "min", label: `≥ $${min}`, onClear: () => setParam("min", null) });
  if (max > 0) activeFilters.push({ id: "max", label: `≤ $${max}`, onClear: () => setParam("max", null) });

  const headingLabel =
    selectedCategories.length === 0
      ? "All Products"
      : selectedCategories.length === 1
        ? selectedCategories[0]
        : `${selectedCategories.length} categories`;

  return (
    <div className="container py-10">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl font-bold tracking-tight">
            {headingLabel}
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
          {/* Categories — multi-select checkbox group */}
          <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Filter className="h-4 w-4 text-primary" /> Categories
              </div>
              {selectedCategories.length > 0 && (
                <button
                  type="button"
                  onClick={() => setParam("category", null)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Clear
                </button>
              )}
            </div>
            <ul className="max-h-72 space-y-1 overflow-y-auto pr-1">
              {categoryOptions.length === 0 ? (
                <li className="text-sm text-muted-foreground">No categories yet.</li>
              ) : (
                categoryOptions.map((c) => {
                  const checked = selectedCategories.includes(c.name);
                  return (
                    <li key={c.name}>
                      <label
                        className={`flex cursor-pointer items-center justify-between gap-2 rounded-md px-3 py-1.5 text-sm transition ${
                          checked
                            ? "bg-primary/10 text-primary"
                            : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-input text-primary focus:ring-ring/30"
                            checked={checked}
                            onChange={() =>
                              toggleListParam("category", c.name, selectedCategories)
                            }
                          />
                          <span className={checked ? "font-medium" : ""}>{c.name}</span>
                        </span>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {c.count}
                        </span>
                      </label>
                    </li>
                  );
                })
              )}
            </ul>
          </div>

          {/* Brands — multi-select checkbox group, derived from loaded products */}
          <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Tag className="h-4 w-4 text-primary" /> Brands
              </div>
              {selectedBrands.length > 0 && (
                <button
                  type="button"
                  onClick={() => setParam("brand", null)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Clear
                </button>
              )}
            </div>
            <ul className="max-h-72 space-y-1 overflow-y-auto pr-1">
              {brandOptions.length === 0 ? (
                <li className="text-sm text-muted-foreground">
                  {isLoading ? "Loading…" : "No brands available."}
                </li>
              ) : (
                brandOptions.map((b) => {
                  const checked = selectedBrands.includes(b.name);
                  return (
                    <li key={b.name}>
                      <label
                        className={`flex cursor-pointer items-center justify-between gap-2 rounded-md px-3 py-1.5 text-sm transition ${
                          checked
                            ? "bg-primary/10 text-primary"
                            : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-input text-primary focus:ring-ring/30"
                            checked={checked}
                            onChange={() =>
                              toggleListParam("brand", b.name, selectedBrands)
                            }
                          />
                          <span className={checked ? "font-medium" : ""}>{b.name}</span>
                        </span>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {b.count}
                        </span>
                      </label>
                    </li>
                  );
                })
              )}
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
                  key={f.id}
                  variant="secondary"
                  className="cursor-pointer gap-1"
                  onClick={f.onClear}
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
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {paged.map((p) => (
                  <ProductCard key={String(p.id)} product={p} />
                ))}
              </div>
              <Pagination
                page={safePage}
                total={filtered.length}
                limit={PAGE_SIZE}
                onPageChange={(p) => {
                  setPage(p);
                  // Scroll back to the top of the grid so the user
                  // doesn't land mid-page after clicking Next.
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
