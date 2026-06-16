"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/store/auth";

/**
 * Loads the set of product IDs the current user has wishlisted, and exposes
 * `toggle(id)` for components (e.g. the heart button on a product card).
 *
 * Optimistic: the heart fills instantly; we revert on server error.
 */
export function useWishlist() {
  const user = useAuth((s) => s.user);
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: ids } = useQuery({
    queryKey: ["wishlist-ids"],
    queryFn: () => api.listWishlistIds(),
    enabled: !!user,
    staleTime: 60_000,
  });

  const idSet = React.useMemo(
    () => new Set((ids ?? []).map((id) => String(id))),
    [ids]
  );

  const mutation = useMutation({
    mutationFn: async ({
      productId,
      next,
    }: {
      productId: string | number;
      next: boolean;
    }) => {
      if (next) return api.addToWishlist(productId);
      return api.removeFromWishlist(productId);
    },
    onMutate: async ({ productId, next }) => {
      await queryClient.cancelQueries({ queryKey: ["wishlist-ids"] });
      const prev = queryClient.getQueryData<Array<string | number>>(["wishlist-ids"]);
      const key = String(productId);
      const updated = next
        ? [...new Set([...(prev ?? []).map(String), key])]
        : (prev ?? []).filter((id) => String(id) !== key);
      queryClient.setQueryData(["wishlist-ids"], updated);
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["wishlist-ids"], ctx.prev);
      toast.error("Couldn't update wishlist");
    },
    onSuccess: (_data, { next }) => {
      toast.success(next ? "Added to wishlist" : "Removed from wishlist");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["wishlist"] });
      queryClient.invalidateQueries({ queryKey: ["wishlist-ids"] });
    },
  });

  const toggle = React.useCallback(
    (productId: string | number) => {
      if (!user) {
        toast.error("Sign in to use your wishlist");
        router.push("/auth/login?next=/account?tab=wishlist");
        return;
      }
      const next = !idSet.has(String(productId));
      mutation.mutate({ productId, next });
    },
    [user, idSet, mutation, router]
  );

  return {
    has: (productId: string | number) => idSet.has(String(productId)),
    toggle,
    isPending: mutation.isPending,
  };
}
