"use client";

import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ProductCard, ProductCardSkeleton } from "@/components/product-card";

const CATEGORY_GRADIENTS = [
  "from-brand-500 to-brand-700",
  "from-brand-400 to-brand-600",
  "from-brand-600 to-brand-900",
  "from-brand-300 to-brand-500",
  "from-brand-500 to-brand-800",
  "from-brand-400 to-brand-700",
  "from-brand-600 to-brand-800",
  "from-brand-300 to-brand-600",
];

/** Top-rated products pulled live from product-service. */
export function FeaturedProductsSection() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["products", "featured", 8],
    queryFn: () => api.listFeaturedProducts(8),
    staleTime: 60_000,
  });

  return (
    <section className="container py-16">
      <div className="mb-8 flex items-end justify-between">
        <div>
          <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-3 py-1 text-xs font-medium text-primary">
            <Sparkles className="h-3.5 w-3.5" /> Featured
          </span>
          <h2 className="mt-3 font-display text-3xl font-bold tracking-tight md:text-4xl">
            Loved by our customers
          </h2>
          <p className="mt-2 text-muted-foreground">
            Top-rated products picked just for you.
          </p>
        </div>
        <Button variant="ghost" asChild>
          <Link href="/products">
            View all <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </div>

      {isError ? (
        <p className="rounded-2xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          Couldn’t load featured products. Try refreshing.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {isLoading
            ? Array.from({ length: 8 }).map((_, i) => (
                <ProductCardSkeleton key={i} />
              ))
            : data?.map((p) => <ProductCard key={String(p.id)} product={p} />)}
        </div>
      )}
    </section>
  );
}

/** Real category cards with live product counts. */
export function CategoriesSection() {
  const { data, isLoading } = useQuery({
    queryKey: ["products", "categories"],
    queryFn: () => api.listCategoriesWithCount(),
    staleTime: 5 * 60_000,
  });

  // Show up to 8 categories; fall back to skeletons while loading.
  const items = (data ?? []).slice(0, 8);

  return (
    <section className="container pb-20">
      <div className="mb-8 flex items-end justify-between">
        <div>
          <h2 className="font-display text-3xl font-bold tracking-tight md:text-4xl">
            Shop by category
          </h2>
          <p className="mt-2 text-muted-foreground">
            Find exactly what you’re looking for.
          </p>
        </div>
        <Button variant="ghost" asChild>
          <Link href="/products">
            View all <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="aspect-[4/3] animate-pulse rounded-2xl bg-muted"
            />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          No categories yet. Add a product to get started.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {items.map((c, i) => (
            <Link
              key={c.name}
              href={`/products?category=${encodeURIComponent(c.name)}`}
              className="group relative overflow-hidden rounded-2xl border border-border p-6 shadow-soft transition hover:-translate-y-0.5 hover:shadow-glow"
            >
              <div
                className={`absolute inset-0 bg-gradient-to-br ${CATEGORY_GRADIENTS[i % CATEGORY_GRADIENTS.length]} opacity-90`}
              />
              <div className="absolute inset-0 bg-grid opacity-10" />
              <div className="relative">
                <p className="text-xs font-semibold uppercase tracking-wider text-white/80">
                  {c.count} product{c.count === 1 ? "" : "s"}
                </p>
                <h3 className="mt-1 text-xl font-bold text-white">{c.name}</h3>
                <span className="mt-6 inline-flex items-center gap-1 text-sm font-medium text-white">
                  Shop now
                  <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
