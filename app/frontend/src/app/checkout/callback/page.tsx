"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useCart } from "@/store/cart";
import { formatPrice } from "@/lib/price";

/**
 * /checkout/callback
 *
 * Where Paystack drops the customer after they finish (or abandon)
 * payment on its hosted page. Paystack appends both `?reference=` and
 * `?trxref=` — they're the same value, we accept either.
 *
 * Behaviour:
 *   - Calls GET /api/payments/verify/:reference to re-confirm with
 *     Paystack server-to-server (never trust the URL alone).
 *   - On success: clear the cart, show a confirmation and a CTA to
 *     view the order.
 *   - On failure: show what went wrong + a CTA to retry from the cart.
 *
 * The page is wrapped in <Suspense> because `useSearchParams` opts the
 * route out of static prerendering in Next 15.
 */
export default function CheckoutCallbackPage() {
  return (
    <React.Suspense
      fallback={
        <div className="container max-w-xl py-16">
          <Card className="space-y-6 p-8 text-center">
            <Loader2 className="mx-auto h-12 w-12 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Loading…</p>
          </Card>
        </div>
      }
    >
      <CallbackInner />
    </React.Suspense>
  );
}

function CallbackInner() {
  const params = useSearchParams();
  const router = useRouter();
  const clearCart = useCart((s) => s.clear);

  const reference =
    params.get("reference") ||
    params.get("trxref") ||
    params.get("tx_ref") || // Flutterwave
    "";

  // 'pending' = waiting on verify, 'success' / 'failed' = terminal
  const [state, setState] = React.useState<
    "pending" | "success" | "failed"
  >("pending");
  const [message, setMessage] = React.useState<string>("");
  const [info, setInfo] = React.useState<{
    orderId: number;
    amount: number;
  } | null>(null);

  // React strict-mode renders effects twice in dev — guard so we only
  // hit /verify once. Verify itself is idempotent so even if it did fire
  // twice the worst case is a duplicate Paystack lookup.
  const ranRef = React.useRef(false);

  React.useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    if (!reference) {
      setState("failed");
      setMessage("Missing payment reference.");
      return;
    }

    (async () => {
      try {
        const res = await api.verifyPayment(reference);
        if (res.status === "success") {
          // Phase 6: pass syncServer so the user's persistent cart is
          // also wiped (otherwise the abandoned-cart sweeper would
          // think they still had items in their cart and email them).
          clearCart({ syncServer: true });
          setState("success");
          setInfo({ orderId: res.orderId, amount: res.amount });
        } else {
          setState("failed");
          setMessage(
            res.status === "abandoned"
              ? "You cancelled the payment."
              : "Payment did not complete."
          );
          setInfo({ orderId: res.orderId, amount: res.amount });
        }
      } catch (err) {
        setState("failed");
        setMessage(
          err instanceof ApiError ? err.message : "Could not verify payment."
        );
      }
    })();
  }, [reference, clearCart]);

  return (
    <div className="container max-w-xl py-16">
      <Card className="space-y-6 p-8 text-center">
        {state === "pending" && (
          <>
            <Loader2 className="mx-auto h-12 w-12 animate-spin text-primary" />
            <div>
              <h1 className="font-display text-2xl font-bold">
                Confirming your payment…
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                This usually takes a few seconds.
              </p>
            </div>
          </>
        )}

        {state === "success" && (
          <>
            <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-500" />
            <div>
              <h1 className="font-display text-2xl font-bold">
                Payment received
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Thank you! Your order has been placed.
              </p>
              {info && (
                <p className="mt-4 text-sm">
                  Order <span className="font-semibold">#{info.orderId}</span> ·{" "}
                  <span className="font-semibold">
                    {formatPrice(info.amount)}
                  </span>
                </p>
              )}
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
              <Button asChild>
                <Link href="/account?tab=orders">View my orders</Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href="/products">Continue shopping</Link>
              </Button>
            </div>
          </>
        )}

        {state === "failed" && (
          <>
            <XCircle className="mx-auto h-12 w-12 text-destructive" />
            <div>
              <h1 className="font-display text-2xl font-bold">
                Payment not completed
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                {message || "Something went wrong with your payment."}
              </p>
              {reference && (
                <p className="mt-4 break-all text-xs text-muted-foreground">
                  Reference: <span className="font-mono">{reference}</span>
                </p>
              )}
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
              <Button onClick={() => router.push("/cart")}>
                Back to cart
              </Button>
              <Button variant="outline" asChild>
                <Link href="/products">Continue shopping</Link>
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
