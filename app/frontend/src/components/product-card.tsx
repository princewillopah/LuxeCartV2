"use client";

import * as React from "react";
import Link from "next/link";
import { Heart, ShoppingBag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { StarRating } from "@/components/star-rating";
import type { Product } from "@/lib/types";
import { useAddToCart } from "@/lib/use-add-to-cart";
import { useWishlist } from "@/lib/use-wishlist";
import { effectivePrice, formatPrice, hasDiscount, savings } from "@/lib/price";
import { cn } from "@/lib/utils";

export function ProductCard({ product }: { product: Product }) {
  const addToCart = useAddToCart();
  const wishlist = useWishlist();
  const lowStock = product.stock > 0 && product.stock < 10;
  const outOfStock = product.stock <= 0;
  const isWished = wishlist.has(product.id);
  const discounted = hasDiscount(product);
  const salePrice = effectivePrice(product);
  const saved = savings(product);

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
          {discounted && (
            <Badge variant="destructive" className="font-semibold">
              -{product.discountPercent}%
            </Badge>
          )}
        </div>
        <button
          type="button"
          aria-label={isWished ? "Remove from wishlist" : "Add to wishlist"}
          aria-pressed={isWished}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            wishlist.toggle(product.id);
          }}
          className={cn(
            "absolute right-3 top-3 inline-flex h-9 w-9 items-center justify-center rounded-full",
            "bg-background/85 backdrop-blur transition hover:bg-background hover:scale-110",
            "shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          )}
        >
          <Heart
            className={cn(
              "h-4 w-4 transition",
              isWished
                ? "fill-red-500 text-red-500"
                : "text-muted-foreground"
            )}
          />
        </button>
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

        <StarRating
          value={product.averageRating ?? 0}
          count={product.totalReviews ?? 0}
        />

        <div className="mt-auto flex items-end justify-between gap-2 pt-2">
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-bold">{formatPrice(salePrice)}</span>
              {discounted && (
                <span className="text-sm text-muted-foreground line-through">
                  {formatPrice(product.price)}
                </span>
              )}
            </div>
            {discounted && (
              <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                Save {formatPrice(saved)}
              </p>
            )}
          </div>
          <Button
            size="sm"
            disabled={outOfStock}
            onClick={() => addToCart(product, 1)}
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
