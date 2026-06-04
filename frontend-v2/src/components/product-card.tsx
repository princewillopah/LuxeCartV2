"use client";

import * as React from "react";
import Link from "next/link";
import { Star, ShoppingBag } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { Product } from "@/lib/types";
import { useCart } from "@/store/cart";
import { cn } from "@/lib/utils";

export function ProductCard({ product }: { product: Product }) {
  const add = useCart((s) => s.add);
  const lowStock = product.stock > 0 && product.stock < 10;
  const outOfStock = product.stock <= 0;

  return (
    <Card className="group flex flex-col overflow-hidden transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-glow">
      <Link
        href={`/products/${product.id}`}
        className="relative block aspect-square overflow-hidden bg-gradient-to-br from-brand-50 to-brand-100 dark:from-brand-950 dark:to-brand-900"
      >
        {product.images?.[0] ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.images[0]}
            alt={product.name}
            className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-6xl font-bold text-brand-300/40 dark:text-brand-700/40">
            {product.name.charAt(0)}
          </div>
        )}
        <div className="absolute left-3 top-3 flex flex-col gap-1">
          {outOfStock && <Badge variant="destructive">Sold out</Badge>}
          {!outOfStock && lowStock && <Badge variant="warning">Low stock</Badge>}
        </div>
      </Link>

      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {product.brand && (
              <p className="truncate text-xs uppercase tracking-wider text-muted-foreground">
                {product.brand}
              </p>
            )}
            <Link
              href={`/products/${product.id}`}
              className="line-clamp-2 font-semibold leading-tight hover:text-primary"
            >
              {product.name}
            </Link>
          </div>
        </div>

        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
          <span className="font-medium text-foreground">
            {(product.averageRating ?? 0).toFixed(1)}
          </span>
          <span>({product.totalReviews ?? 0})</span>
        </div>

        <div className="mt-auto flex items-center justify-between pt-2">
          <span className="text-lg font-bold">
            ${product.price.toFixed(2)}
          </span>
          <Button
            size="sm"
            disabled={outOfStock}
            onClick={() => {
              add(product, 1);
              toast.success("Added to cart", { description: product.name });
            }}
            className={cn(outOfStock && "opacity-50")}
          >
            <ShoppingBag className="h-4 w-4" />
            Add
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function ProductCardSkeleton() {
  return (
    <Card className="overflow-hidden">
      <div className="aspect-square animate-pulse bg-muted" />
      <div className="space-y-2 p-4">
        <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
        <div className="h-4 w-4/5 animate-pulse rounded bg-muted" />
        <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
        <div className="mt-2 flex items-center justify-between">
          <div className="h-6 w-16 animate-pulse rounded bg-muted" />
          <div className="h-8 w-16 animate-pulse rounded bg-muted" />
        </div>
      </div>
    </Card>
  );
}
