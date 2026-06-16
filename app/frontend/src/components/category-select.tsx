"use client";

import * as React from "react";
import { Label } from "@/components/ui/input";
import { PRODUCT_CATEGORIES } from "@/lib/categories";
import { cn } from "@/lib/utils";

interface Props {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  className?: string;
  label?: string;
}

/**
 * Category picker with a fixed list from PRODUCT_CATEGORIES plus an
 * "+ Custom…" escape hatch so admins can type something one-off.
 * Existing custom values (e.g. on legacy products) are preserved and
 * shown alongside the canonical list.
 */
export function CategorySelect({
  id = "category",
  value,
  onChange,
  required,
  className,
  label = "Category",
}: Props) {
  const isCanonical = (PRODUCT_CATEGORIES as readonly string[]).includes(value);
  const [custom, setCustom] = React.useState(!isCanonical && value !== "");

  // Build the option list — canonical first, then the existing custom value
  // (so legacy products keep displaying their category until the admin edits it).
  const options = React.useMemo(() => {
    const set = new Set<string>(PRODUCT_CATEGORIES);
    if (value && !set.has(value)) set.add(value);
    return Array.from(set);
  }, [value]);

  return (
    <div className={cn("space-y-1.5", className)}>
      {label && <Label htmlFor={id}>{label}</Label>}
      {custom ? (
        <div className="flex gap-2">
          <input
            id={id}
            type="text"
            required={required}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Enter custom category"
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-soft transition placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
          />
          <button
            type="button"
            onClick={() => {
              setCustom(false);
              onChange(PRODUCT_CATEGORIES[0]);
            }}
            className="text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Use list
          </button>
        </div>
      ) : (
        <select
          id={id}
          required={required}
          value={value || ""}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "__custom__") {
              setCustom(true);
              onChange("");
            } else {
              onChange(v);
            }
          }}
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-soft transition focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
        >
          {!value && <option value="">Select a category…</option>}
          {options.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
          <option value="__custom__">+ Custom…</option>
        </select>
      )}
    </div>
  );
}
