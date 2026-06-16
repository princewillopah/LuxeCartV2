"use client";

import * as React from "react";
import { Star, StarHalf } from "lucide-react";
import { cn } from "@/lib/utils";

interface StarRatingProps {
  /** Rating value, 0–max. Fractions render half-stars (>= 0.25 and < 0.75 → half). */
  value: number;
  /** Number of stars to display. Defaults to 5. */
  max?: number;
  /** Total number of reviews — shown in parentheses next to the stars. */
  count?: number;
  /** Tailwind size class for each star icon. */
  size?: "sm" | "md" | "lg";
  /** Hide the trailing "(n)" count, e.g. on detail pages where it's shown elsewhere. */
  hideCount?: boolean;
  className?: string;
}

const SIZE_CLASSES: Record<NonNullable<StarRatingProps["size"]>, string> = {
  sm: "h-3.5 w-3.5",
  md: "h-4 w-4",
  lg: "h-5 w-5",
};

/**
 * Renders an e-commerce-style star rating: filled / half / empty stars,
 * optionally followed by the review count in parentheses.
 *
 *   <StarRating value={4.3} count={128} />  →  ★★★★☆ (128)
 */
export function StarRating({
  value,
  max = 5,
  count,
  size = "sm",
  hideCount = false,
  className,
}: StarRatingProps) {
  const safe = Math.max(0, Math.min(max, Number.isFinite(value) ? value : 0));
  const sizeCls = SIZE_CLASSES[size];

  const stars: React.ReactNode[] = [];
  for (let i = 0; i < max; i++) {
    const diff = safe - i;
    if (diff >= 0.75) {
      stars.push(
        <Star
          key={i}
          className={cn(sizeCls, "fill-amber-400 text-amber-400")}
          aria-hidden
        />
      );
    } else if (diff >= 0.25) {
      stars.push(
        <span key={i} className={cn(sizeCls, "relative inline-block")} aria-hidden>
          <Star className={cn(sizeCls, "absolute inset-0 text-amber-400")} />
          <StarHalf className={cn(sizeCls, "absolute inset-0 fill-amber-400 text-amber-400")} />
        </span>
      );
    } else {
      stars.push(
        <Star
          key={i}
          className={cn(sizeCls, "text-amber-400/40")}
          aria-hidden
        />
      );
    }
  }

  const label = `Rated ${safe.toFixed(1)} out of ${max}${
    typeof count === "number" ? ` based on ${count} review${count === 1 ? "" : "s"}` : ""
  }`;

  return (
    <div
      className={cn("flex items-center gap-1 text-xs text-muted-foreground", className)}
      role="img"
      aria-label={label}
    >
      <span className="flex items-center gap-0.5">{stars}</span>
      {!hideCount && (
        <span className="ml-0.5">({count ?? 0})</span>
      )}
    </div>
  );
}
