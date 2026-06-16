"use client";

import { useRouter, usePathname } from "next/navigation";
import { toast } from "sonner";
import { useAuth } from "@/store/auth";
import { useCart } from "@/store/cart";
import type { Product } from "@/lib/types";

/**
 * Centralised "add to cart" with login gating.
 *
 * Behaviour:
 *   - Anonymous user → toast + redirect to /auth/login?next=<current path>.
 *     We do NOT auto-add after login because we don't have a server-side
 *     cart yet; the user can click again once they're back. (Cart contents
 *     they had prior are preserved in localStorage.)
 *   - Authenticated user → add and toast.
 *
 * Returns a callable `(product, qty?) => void`.
 */
export function useAddToCart() {
  const user = useAuth((s) => s.user);
  const add = useCart((s) => s.add);
  const router = useRouter();
  const pathname = usePathname();

  return (product: Product, quantity = 1) => {
    if (!user) {
      toast.info("Please sign in to add items to your cart.");
      const next = encodeURIComponent(pathname || "/products");
      router.push(`/auth/login?next=${next}`);
      return;
    }
    add(product, quantity);
    toast.success(
      quantity === 1
        ? "Added to cart"
        : `Added ${quantity} × ${product.name}`,
      { description: quantity === 1 ? product.name : undefined },
    );
  };
}
