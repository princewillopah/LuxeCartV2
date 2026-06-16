"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  Loader2,
  Minus,
  Plus,
  ShieldCheck,
  ShoppingBag,
  Star,
  Truck,
} from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { StarRating } from "@/components/star-rating";
import { useAuth } from "@/store/auth";
import { useAddToCart } from "@/lib/use-add-to-cart";
import { effectivePrice, formatPrice, hasDiscount, savings } from "@/lib/price";
import { cn } from "@/lib/utils";
import type { Product } from "@/lib/types";

export default function ProductDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const addToCart = useAddToCart();
  const [qty, setQty] = React.useState(1);
  const [imageIdx, setImageIdx] = React.useState(0);

  const { data: product, isLoading, isError } = useQuery({
    queryKey: ["product", params.id],
    queryFn: () => api.getProduct(params.id),
    enabled: !!params.id,
    // Show the product instantly using whatever the listing page already loaded,
    // then refetch in the background. Eliminates the skeleton flash on navigation.
    placeholderData: () => {
      const lists = queryClient.getQueriesData<Product[]>({ queryKey: ["products"] });
      for (const [, list] of lists) {
        const match = list?.find((p) => String(p.id) === String(params.id));
        if (match) return match;
      }
      return undefined;
    },
  });

  if (isLoading) {
    return (
      <div className="container grid gap-10 py-10 md:grid-cols-2">
        <Skeleton className="aspect-square w-full rounded-2xl" />
        <div className="space-y-4">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-10 w-3/4" />
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-12 w-48" />
        </div>
      </div>
    );
  }

  if (isError || !product) {
    return (
      <div className="container py-16">
        <EmptyState
          title="Product not found"
          description="It may have been removed or the link is wrong."
          actionLabel="Back to shop"
          actionHref="/products"
        />
      </div>
    );
  }

  const images = product.images?.length ? product.images : [];
  const activeImage = images[imageIdx];
  const outOfStock = product.stock <= 0;
  const discounted = hasDiscount(product);
  const salePrice = effectivePrice(product);
  const saved = savings(product);

  return (
    <div className="container py-8">
      <button
        onClick={() => router.back()}
        className="mb-6 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" /> Back
      </button>

      <div className="grid gap-10 md:grid-cols-2">
        {/* Gallery */}
        <div className="space-y-3">
          <div className="relative aspect-square overflow-hidden rounded-2xl bg-gradient-to-br from-brand-50 to-brand-100 dark:from-brand-950 dark:to-brand-900">
            {discounted && (
              <Badge
                variant="destructive"
                className="absolute left-3 top-3 z-10 font-semibold"
              >
                -{product.discountPercent}%
              </Badge>
            )}
            {activeImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={activeImage}
                alt={product.name}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-9xl font-bold text-brand-300/40 dark:text-brand-700/40">
                {product.name.charAt(0)}
              </div>
            )}
          </div>
          {images.length > 1 && (
            <div className="grid grid-cols-5 gap-2">
              {images.map((src, i) => (
                <button
                  key={src + i}
                  onClick={() => setImageIdx(i)}
                  className={`aspect-square overflow-hidden rounded-lg border-2 transition ${
                    i === imageIdx ? "border-primary" : "border-transparent opacity-70 hover:opacity-100"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt="" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Info */}
        <div className="flex flex-col gap-5">
          <div>
            {product.brand && (
              <p className="text-sm uppercase tracking-wider text-muted-foreground">
                {product.brand}
              </p>
            )}
            <h1 className="mt-1 font-display text-3xl font-bold tracking-tight md:text-4xl">
              {product.name}
            </h1>
            <div className="mt-3 flex items-center gap-3">
              <StarRating
                value={product.averageRating ?? 0}
                count={product.totalReviews ?? 0}
                size="md"
              />
              <span className="text-muted-foreground">·</span>
              <Link href={`/products?category=${encodeURIComponent(product.category)}`} className="text-sm text-primary hover:underline">
                {product.category}
              </Link>
            </div>
          </div>

          <div className="space-y-1">
            <div className="flex items-baseline gap-3">
              <span className="text-4xl font-bold">{formatPrice(salePrice)}</span>
              {discounted && (
                <span className="text-lg text-muted-foreground line-through">
                  {formatPrice(product.price)}
                </span>
              )}
              {outOfStock ? (
                <Badge variant="destructive">Sold out</Badge>
              ) : product.stock < 10 ? (
                <Badge variant="warning">Only {product.stock} left</Badge>
              ) : (
                <Badge variant="success">In stock</Badge>
              )}
            </div>
            {discounted && (
              <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
                You save {formatPrice(saved)} ({product.discountPercent}% off)
              </p>
            )}
          </div>

          <p className="text-muted-foreground leading-relaxed">
            {product.description}
          </p>

          {/* Qty + add to cart */}
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <div className="inline-flex h-12 items-center rounded-md border border-input bg-background">
              <Button
                variant="ghost"
                size="icon"
                className="h-12 w-12"
                onClick={() => setQty((q) => Math.max(1, q - 1))}
                aria-label="Decrease quantity"
              >
                <Minus className="h-4 w-4" />
              </Button>
              <span className="w-10 text-center font-semibold">{qty}</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-12 w-12"
                onClick={() => setQty((q) => Math.min(product.stock || 99, q + 1))}
                aria-label="Increase quantity"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <Button
              size="lg"
              disabled={outOfStock}
              className="min-w-[180px]"
              onClick={() => addToCart(product, qty)}
            >
              <ShoppingBag className="h-4 w-4" /> Add to cart
            </Button>
          </div>

          {/* Trust strip */}
          <div className="mt-6 grid gap-3 border-t border-border/60 pt-6 text-sm sm:grid-cols-2">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Truck className="h-4 w-4 text-primary" /> Free shipping over ₦50,000
            </div>
            <div className="flex items-center gap-2 text-muted-foreground">
              <ShieldCheck className="h-4 w-4 text-primary" /> 30-day returns
            </div>
          </div>
        </div>
      </div>

      <ReviewsSection productId={product.id} />
    </div>
  );
}

function ReviewsSection({ productId }: { productId: string | number }) {
  const user = useAuth((s) => s.user);
  const queryClient = useQueryClient();

  const { data: reviews, isLoading } = useQuery({
    queryKey: ["reviews", productId],
    queryFn: () => api.listReviews(productId),
  });

  const [rating, setRating] = React.useState<number>(0);
  const [hoverRating, setHoverRating] = React.useState<number>(0);
  const [comment, setComment] = React.useState<string>("");
  const [submitting, setSubmitting] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) {
      toast.error("Please sign in to leave a review");
      return;
    }
    if (rating < 1) {
      toast.error("Please pick a star rating");
      return;
    }
    if (!comment.trim()) {
      toast.error("Please write a short comment");
      return;
    }
    setSubmitting(true);
    try {
      await Promise.all([
        api.submitRating({
          productId,
          userId: user.id,
          rating,
          userFirstName: user.firstName,
          userLastName: user.lastName,
        }),
        api.createReview({
          productId,
          userId: user.id,
          userName: `${user.firstName} ${user.lastName}`.trim(),
          comment: comment.trim(),
        }),
      ]);
      toast.success("Thanks for your review!");
      setComment("");
      setRating(0);
      setHoverRating(0);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["reviews", productId] }),
        queryClient.invalidateQueries({ queryKey: ["product", String(productId)] }),
        // Listing pages are cached per-category — refresh them so the new
        // average rating / review count shows up immediately on /products.
        queryClient.invalidateQueries({ queryKey: ["products"] }),
      ]);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Failed to submit";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="mt-16 border-t border-border/60 pt-10">
      <h2 className="font-display text-2xl font-bold tracking-tight">Customer reviews</h2>

      {/* Write a review */}
      <div className="mt-6 rounded-2xl border border-border/60 bg-card/50 p-6">
        <h3 className="text-lg font-semibold">Write a review</h3>
        {!user ? (
          <p className="mt-2 text-sm text-muted-foreground">
            <Link href="/auth/login" className="text-primary hover:underline">
              Sign in
            </Link>{" "}
            to share your experience with this product.
          </p>
        ) : (
          <form onSubmit={submit} className="mt-4 space-y-4">
            <div>
              <p className="mb-2 text-sm font-medium">Your rating</p>
              <div className="flex items-center gap-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onMouseEnter={() => setHoverRating(n)}
                    onMouseLeave={() => setHoverRating(0)}
                    onClick={() => setRating(n)}
                    aria-label={`Rate ${n} star${n === 1 ? "" : "s"}`}
                    className="rounded p-1 transition hover:scale-110"
                  >
                    <Star
                      className={cn(
                        "h-7 w-7 transition",
                        (hoverRating || rating) >= n
                          ? "fill-amber-400 text-amber-400"
                          : "text-muted-foreground/40"
                      )}
                    />
                  </button>
                ))}
                {rating > 0 && (
                  <span className="ml-2 text-sm text-muted-foreground">
                    {rating} / 5
                  </span>
                )}
              </div>
            </div>
            <div>
              <label htmlFor="review-comment" className="mb-2 block text-sm font-medium">
                Your review
              </label>
              <textarea
                id="review-comment"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={4}
                placeholder="What did you think of this product?"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                required
              />
            </div>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Submit review
            </Button>
          </form>
        )}
      </div>

      {/* Existing reviews */}
      <div className="mt-8 space-y-4">
        {isLoading ? (
          <>
            <Skeleton className="h-24 w-full rounded-xl" />
            <Skeleton className="h-24 w-full rounded-xl" />
          </>
        ) : !reviews || reviews.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/60 p-8 text-center text-sm text-muted-foreground">
            No reviews yet — be the first!
          </p>
        ) : (
          reviews.map((r) => (
            <article
              key={String(r.id)}
              className="rounded-xl border border-border/60 bg-card/30 p-5"
            >
              <header className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-semibold">{r.userName || "Anonymous"}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(r.createdAt).toLocaleDateString()}
                  </p>
                </div>
                {r.rating ? (
                  <div className="flex items-center gap-0.5">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <Star
                        key={n}
                        className={cn(
                          "h-4 w-4",
                          n <= (r.rating ?? 0)
                            ? "fill-amber-400 text-amber-400"
                            : "text-muted-foreground/30"
                        )}
                      />
                    ))}
                  </div>
                ) : null}
              </header>
              <p className="mt-3 text-sm leading-relaxed">{r.comment}</p>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
