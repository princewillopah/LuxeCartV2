import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { User } from "@/lib/types";
import { useCart } from "@/store/cart";
import { api } from "@/lib/api";

interface AuthState {
  token: string | null;
  refreshToken: string | null;
  user: User | null;
  setAuth: (token: string, user: User, refreshToken?: string | null) => void;
  setToken: (token: string, refreshToken?: string | null) => void;
  logout: () => void;
}

/**
 * Clear any per-user client-side state. Called whenever the logged-in
 * identity changes (login as a different user, or logout) so one user
 * never sees another user's cart, orders, or other cached data.
 */
function wipePerUserState() {
  if (typeof window === "undefined") return;
  // Cart — wipe both the in-memory store *and* the persisted copy.
  // Calling `clear()` triggers zustand `persist` to write the empty
  // state back to localStorage, so a single call covers both.
  try {
    useCart.getState().clear();
  } catch {
    /* ignore */
  }
  // React Query cache (orders, account data, etc.) — picked up by
  // the Providers component via a CustomEvent listener.
  window.dispatchEvent(new CustomEvent("luxecart:auth-changed"));
}

export const useAuth = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      refreshToken: null,
      user: null,
      setAuth: (token, user, refreshToken) => {
        const prev = get().user;
        // If a different user logs in (or someone logs in over a guest
        // session), wipe the previous user's cached state first.
        if (!prev || prev.id !== user.id) {
          wipePerUserState();
        }
        set({
          token,
          user,
          // If a refresh token wasn't provided (older backend, or test path),
          // keep whatever's already there rather than clobbering it.
          refreshToken: refreshToken ?? get().refreshToken ?? null,
        });
        // Phase 6: pull the user's server-persisted cart, merging in
        // any guest items that were sitting in localStorage so they're
        // not lost on login. Fire-and-forget — the UI updates when the
        // promise resolves and a transient failure just means the user
        // sees their guest-only cart until the next refresh.
        try {
          // Defer the import so we don't widen the auth↔cart import
          // cycle further. cart.ts already imports useAuth lazily.
          void useCart.getState().hydrateFromServer({ merge: true });
        } catch {
          /* ignore */
        }
      },
      // Used by the silent-refresh flow in lib/api.ts after a 401.
      setToken: (token, refreshToken) =>
        set({
          token,
          refreshToken: refreshToken ?? get().refreshToken ?? null,
        }),
      logout: () => {
        // Fire-and-forget revoke on the server. We don't await this — the
        // user's local state should clear instantly, and a network blip
        // shouldn't block sign-out. The backend's /logout endpoint is also
        // idempotent so retries are safe.
        const rt = get().refreshToken;
        if (rt) {
          void api.logout(rt);
        }
        wipePerUserState();
        set({ token: null, refreshToken: null, user: null });
      },
    }),
    { name: "luxecart-auth" },
  ),
);
