import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CartItem, Product } from "@/lib/types";
import { effectivePrice } from "@/lib/price";
import { api } from "@/lib/api";
import { useAuth } from "@/store/auth";

/**
 * Cart store (Phase 6 — server-persisted)
 *
 * Local-first, optimistic UI. Every mutation updates zustand
 * (which `persist` mirrors to localStorage) immediately, then
 * fire-and-forgets the corresponding server call when the user
 * is authenticated. If the server returns a different shape (e.g.
 * the price snapshot was capped server-side) we replace local
 * state with the server's response.
 *
 * When the user is a guest (no token) the store behaves exactly
 * like before — pure localStorage. The next login triggers
 * `hydrateFromServer({ merge: true })` which POSTs the guest
 * cart to /api/cart/merge and replaces local state with the
 * merged result.
 */
interface CartState {
  items: CartItem[];
  /** True while a hydrate-on-login round-trip is in flight. */
  hydrating: boolean;
  add: (product: Product, quantity?: number) => void;
  remove: (productId: string | number) => void;
  setQty: (productId: string | number, quantity: number) => void;
  /**
   * Empty the cart. By default (`{ syncServer: false }`) the
   * server isn't touched — used when wiping per-user state on
   * logout/login-switch (the OUTGOING user's server cart should
   * survive). Pass `{ syncServer: true }` from the manual "clear
   * cart" button and from the post-checkout success page.
   */
  clear: (opts?: { syncServer?: boolean }) => void;
  count: () => number;
  subtotal: () => number;
  /**
   * Pull the latest cart from the server. If `merge` is true and
   * the local cart already has items (i.e. the user was shopping
   * as a guest before logging in), POST those to /api/cart/merge
   * first so they aren't lost.
   */
  hydrateFromServer: (opts?: { merge?: boolean }) => Promise<void>;
}

/** Are we currently logged in? Read lazily so we never deadlock the auth store. */
function isAuthed() {
  try {
    return !!useAuth.getState().token;
  } catch {
    return false;
  }
}

/** Replace local items from a server response. Tolerant of partial shapes. */
function adopt(
  set: (s: Partial<CartState>) => void,
  items: CartItem[] | undefined,
) {
  if (!Array.isArray(items)) return;
  set({ items });
}

export const useCart = create<CartState>()(
  persist(
    (set, get) => ({
      items: [],
      hydrating: false,

      add: (product, quantity = 1) => {
        // Optimistic local update first so the UI feels instant.
        const price = effectivePrice(product);
        const image = product.images?.[0];
        set((s) => {
          const existing = s.items.find((i) => i.productId === product.id);
          if (existing) {
            return {
              items: s.items.map((i) =>
                i.productId === product.id
                  ? { ...i, quantity: i.quantity + quantity }
                  : i,
              ),
            };
          }
          return {
            items: [
              ...s.items,
              {
                productId: product.id,
                name: product.name,
                price,
                image,
                quantity,
              },
            ],
          };
        });
        // Fire-and-forget server sync. If it fails we keep the
        // optimistic state — the next hydrate (or page refresh) will
        // reconcile.
        if (isAuthed()) {
          api
            .addCartItem({
              productId: product.id,
              quantity,
              price,
              name: product.name,
              image,
            })
            .then((res) => adopt(set, res?.items))
            .catch(() => {
              /* tolerated — optimistic state already applied */
            });
        }
      },

      remove: (productId) => {
        set((s) => ({
          items: s.items.filter((i) => i.productId !== productId),
        }));
        if (isAuthed()) {
          api
            .removeCartItem(productId)
            .then((res) => adopt(set, res?.items))
            .catch(() => {});
        }
      },

      setQty: (productId, quantity) => {
        set((s) => ({
          items:
            quantity <= 0
              ? s.items.filter((i) => i.productId !== productId)
              : s.items.map((i) =>
                  i.productId === productId ? { ...i, quantity } : i,
                ),
        }));
        if (isAuthed()) {
          api
            .setCartItemQty(productId, quantity)
            .then((res) => adopt(set, res?.items))
            .catch(() => {});
        }
      },

      clear: (opts) => {
        set({ items: [] });
        if (opts?.syncServer && isAuthed()) {
          api.clearCart().catch(() => {});
        }
      },

      count: () => get().items.reduce((n, i) => n + i.quantity, 0),
      subtotal: () =>
        get().items.reduce((n, i) => n + i.price * i.quantity, 0),

      hydrateFromServer: async (opts) => {
        if (!isAuthed()) return;
        const merge = opts?.merge ?? false;
        set({ hydrating: true });
        try {
          const local = get().items;
          // If we have a non-empty guest cart and merging is requested,
          // hand it off to /merge so nothing is lost.
          let res: { items: CartItem[] } | undefined;
          if (merge && local.length > 0) {
            res = await api.mergeGuestCart(local);
          } else {
            res = await api.getCart();
          }
          adopt(set, res?.items);
        } catch {
          /* leave local state alone on failure */
        } finally {
          set({ hydrating: false });
        }
      },
    }),
    { name: "luxecart-cart" },
  ),
);
