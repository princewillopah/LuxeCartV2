"use client";

import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface PaginationProps {
  /** Current 1-based page. */
  page: number;
  /** Total number of items across all pages. */
  total: number;
  /** Items per page. */
  limit: number;
  /** Called with the new 1-based page when the user clicks Prev/Next. */
  onPageChange: (page: number) => void;
  /** Optional className for the outer container. */
  className?: string;
}

/**
 * Minimal Prev / "Page X of Y" / Next pager used by every admin list page.
 * Hides itself when there's only one page so empty/small datasets don't
 * carry visual noise. The buttons are disabled at the boundaries.
 */
export function Pagination({ page, total, limit, onPageChange, className }: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  if (totalPages <= 1) return null;

  const from = (page - 1) * limit + 1;
  const to   = Math.min(page * limit, total);

  return (
    <div className={`flex items-center justify-between gap-4 py-3 ${className ?? ""}`}>
      <p className="text-sm text-muted-foreground">
        Showing <span className="font-medium text-foreground">{from}</span>–
        <span className="font-medium text-foreground">{to}</span> of{" "}
        <span className="font-medium text-foreground">{total}</span>
      </p>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Prev
        </Button>
        <span className="text-sm tabular-nums">
          Page {page} of {totalPages}
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
        >
          Next
          <ChevronRight className="h-4 w-4 ml-1" />
        </Button>
      </div>
    </div>
  );
}
