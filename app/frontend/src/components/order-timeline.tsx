"use client";

import * as React from "react";
import { Check, Clock, Loader2, Package, Truck, X, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { OrderStatus } from "@/lib/types";

interface Step {
  id: OrderStatus;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

// The "happy path" steps shown in the timeline. `cancelled` is rendered
// differently — as a terminal red state replacing the remaining steps.
const STEPS: Step[] = [
  { id: "pending",    label: "Order placed", icon: Clock   },
  { id: "processing", label: "Processing",   icon: Loader2 },
  { id: "shipped",    label: "Shipped",      icon: Truck   },
  { id: "delivered",  label: "Delivered",    icon: Package },
];

const ORDER: Record<OrderStatus, number> = {
  pending: 0,
  processing: 1,
  shipped: 2,
  delivered: 3,
  cancelled: -1,
  refunded: 3,
};

interface OrderTimelineProps {
  status: OrderStatus | string;
  className?: string;
}

export function OrderTimeline({ status, className }: OrderTimelineProps) {
  const normalized = (String(status).toLowerCase() as OrderStatus);

  if (normalized === "cancelled") {
    return (
      <div
        className={cn(
          "flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3",
          className
        )}
        role="status"
        aria-label="Order cancelled"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-destructive text-destructive-foreground">
          <X className="h-4 w-4" />
        </span>
        <div>
          <p className="text-sm font-medium text-destructive">Order cancelled</p>
          <p className="text-xs text-muted-foreground">
            This order is no longer being processed.
          </p>
        </div>
      </div>
    );
  }

  if (normalized === "refunded") {
    return (
      <div
        className={cn(
          "flex items-center gap-3 rounded-lg border border-blue-500/30 bg-blue-500/5 p-3",
          className
        )}
        role="status"
        aria-label="Order refunded"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-500 text-white">
          <RotateCcw className="h-4 w-4" />
        </span>
        <div>
          <p className="text-sm font-medium text-blue-600 dark:text-blue-400">Order refunded</p>
          <p className="text-xs text-muted-foreground">
            Funds will return to your original payment method within 5–10 business days.
          </p>
        </div>
      </div>
    );
  }

  const currentIdx = ORDER[normalized] ?? 0;

  return (
    <ol
      className={cn("flex w-full items-start", className)}
      aria-label={`Order progress: currently ${STEPS[currentIdx]?.label}`}
    >
      {STEPS.map((step, i) => {
        const isDone     = i <  currentIdx;
        const isCurrent  = i === currentIdx;
        const Icon       = step.icon;
        const isLast     = i === STEPS.length - 1;

        return (
          <li
            key={step.id}
            className="relative flex flex-1 flex-col items-center text-center"
          >
            {/* connector line to the NEXT step */}
            {!isLast && (
              <span
                className={cn(
                  "absolute left-1/2 top-4 h-0.5 w-full",
                  i < currentIdx ? "bg-primary" : "bg-border"
                )}
                aria-hidden="true"
              />
            )}

            <span
              className={cn(
                "relative z-10 flex h-8 w-8 items-center justify-center rounded-full border-2 transition",
                isDone    && "border-primary bg-primary text-primary-foreground",
                isCurrent && "border-primary bg-background text-primary ring-4 ring-primary/15",
                !isDone && !isCurrent && "border-border bg-background text-muted-foreground"
              )}
              aria-current={isCurrent ? "step" : undefined}
            >
              {isDone ? (
                <Check className="h-4 w-4" />
              ) : (
                <Icon
                  className={cn(
                    "h-4 w-4",
                    isCurrent && step.id === "processing" && "animate-spin"
                  )}
                />
              )}
            </span>

            <span
              className={cn(
                "mt-2 text-xs",
                (isDone || isCurrent)
                  ? "font-medium text-foreground"
                  : "text-muted-foreground"
              )}
            >
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
