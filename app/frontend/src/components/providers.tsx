"use client";

import * as React from "react";
import {
  QueryClient,
  QueryClientProvider,
  isServer,
} from "@tanstack/react-query";
import { Toaster } from "sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { useAuth } from "@/store/auth";
import { useCart } from "@/store/cart";

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60 * 1000,
        gcTime: 5 * 60 * 1000,
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  });
}

let browserClient: QueryClient | undefined;
function getClient() {
  if (isServer) return makeClient();
  if (!browserClient) browserClient = makeClient();
  return browserClient;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const client = getClient();

  // Clear all cached queries when the logged-in user changes (login as a
  // different user, or logout) — otherwise the previous user's data would
  // briefly bleed into the new session. The auth store dispatches this
  // event from `setAuth` and `logout`.
  React.useEffect(() => {
    function handleAuthChange() {
      client.clear();
    }
    window.addEventListener("luxecart:auth-changed", handleAuthChange);
    return () =>
      window.removeEventListener("luxecart:auth-changed", handleAuthChange);
  }, [client]);

  // Phase 6: on first page load, if the user is already authenticated
  // (token survived from a previous tab/session), pull their
  // server-persisted cart so the storefront reflects what they had
  // saved — possibly from another device. We pass merge:true so any
  // guest items added before the persisted login are folded in too.
  const token = useAuth((s) => s.token);
  const hydratedRef = React.useRef(false);
  React.useEffect(() => {
    if (!token || hydratedRef.current) return;
    hydratedRef.current = true;
    void useCart.getState().hydrateFromServer({ merge: true });
  }, [token]);

  return (
    <QueryClientProvider client={client}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        {children}
        <Toaster position="top-right" richColors closeButton />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
