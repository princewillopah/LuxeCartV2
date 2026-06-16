"use client";

import * as React from "react";
import Link from "next/link";
import {
  Check,
  ChevronRight,
  CreditCard,
  Loader2,
  MapPin,
  Package,
  ShieldCheck,
  Star,
} from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { EmptyState } from "@/components/empty-state";
import { useCart } from "@/store/cart";
import { useAuth } from "@/store/auth";
import {
  formatPrice,
  FREE_SHIPPING_THRESHOLD,
  SHIPPING_FEE,
  TAX_RATE,
} from "@/lib/price";
import { cn } from "@/lib/utils";
import type { Address } from "@/lib/types";

type Step = 0 | 1;

const STEPS: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { label: "Shipping", icon: MapPin },
  { label: "Review & Pay", icon: Package },
];

export default function CheckoutPage() {
  const items = useCart((s) => s.items);
  const user = useAuth((s) => s.user);

  const [step, setStep] = React.useState<Step>(0);
  const [submitting, setSubmitting] = React.useState(false);
  const [providers, setProviders] = React.useState<
    { name: string; displayName: string }[]
  >([]);
  const [provider, setProvider] = React.useState<string>("paystack");
  const [address, setAddress] = React.useState({
    fullName: user ? `${user.firstName} ${user.lastName}`.trim() : "",
    line1: "",
    line2: "",
    city: "",
    state: "",
    postal: "",
    country: "Nigeria",
  });

  // Saved addresses for the picker at the top of step 0. When the user
  // has at least one saved address, we pre-fill from the default one and
  // hide the form behind a "Use a different address" toggle so repeat
  // customers can blast through checkout.
  const [savedAddresses, setSavedAddresses] = React.useState<Address[]>([]);
  const [pickedAddressId, setPickedAddressId] = React.useState<number | null>(null);
  const [showForm, setShowForm] = React.useState(false);
  const [saveForLater, setSaveForLater] = React.useState(false);

  const subtotal = items.reduce((n, i) => n + i.price * i.quantity, 0);
  const shipping =
    subtotal === 0 || subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE;
  const tax = subtotal * TAX_RATE;
  const total = subtotal + shipping + tax;

  // Fetch which gateways the backend is wired up with. If only one comes
  // back, the dropdown still renders but is effectively single-choice; if
  // the call fails we silently fall back to the paystack default so the
  // checkout doesn't break.
  React.useEffect(() => {
    if (!user) return;
    let cancelled = false;
    api
      .getPaymentProviders()
      .then((res) => {
        if (cancelled) return;
        setProviders(res.providers);
        if (res.providers.length > 0 && !res.providers.find((p) => p.name === provider)) {
          setProvider(res.providers[0].name);
        }
      })
      .catch(() => {
        // Backend unreachable or older — keep the paystack default.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Pull saved addresses on mount. Pre-fills the form with the default
  // so the user can just hit Continue. If there are none we fall back
  // to the empty form (existing behaviour).
  React.useEffect(() => {
    if (!user) return;
    let cancelled = false;
    api.listMyAddresses()
      .then((list) => {
        if (cancelled) return;
        setSavedAddresses(list);
        const def = list.find((a) => a.isDefault) ?? list[0];
        if (def) {
          setPickedAddressId(def.id as number);
          setAddress({
            fullName: def.fullName,
            line1: def.line1,
            line2: def.line2 ?? "",
            city: def.city,
            state: def.state,
            postal: def.postal ?? "",
            country: def.country,
          });
        } else {
          // No saved addresses — show the form by default.
          setShowForm(true);
        }
      })
      .catch(() => {
        // user-service down or older — fall back to manual form.
        setShowForm(true);
      });
    return () => { cancelled = true; };
  }, [user]);

  function pickSavedAddress(a: Address) {
    setPickedAddressId(a.id as number);
    setAddress({
      fullName: a.fullName,
      line1: a.line1,
      line2: a.line2 ?? "",
      city: a.city,
      state: a.state,
      postal: a.postal ?? "",
      country: a.country,
    });
    setShowForm(false);
    setSaveForLater(false);
  }

  if (items.length === 0) {
    return (
      <div className="container py-16">
        <EmptyState
          icon={Package}
          title="Your cart is empty"
          description="Add some products before checking out."
          actionLabel="Continue shopping"
          actionHref="/products"
        />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="container py-16">
        <EmptyState
          title="Sign in to continue"
          description="You need an account to complete checkout."
          actionLabel="Sign in"
          actionHref="/auth/login?next=/checkout"
        />
      </div>
    );
  }

  /**
   * Place the order + kick off Paystack in one click.
   *
   * 1. Create the order in 'pending' state.
   * 2. Open a Paystack transaction tied to that order.
   * 3. Redirect the browser to Paystack's hosted page.
   *
   * We DON'T clear the cart yet — only the callback page does that, and
   * only after Paystack confirms the charge succeeded. If the user
   * cancels or the network fails, they can come back and try again
   * without re-adding everything.
   */
  async function startPayment() {
    if (!user) return;
    setSubmitting(true);
    try {
      // Step 1 — create the order (pending)
      const order = await api.createOrder({
        userId: user.id,
        total: Number(total.toFixed(2)),
        items: items.map((i) => ({
          id: i.productId,
          name: i.name,
          price: i.price,
          quantity: i.quantity,
        })),
        shippingAddress: address,
        paymentMethod: provider,
        // Snapshot the buyer's identity onto the orders row — see api.ts.
        userEmail:     user.email,
        userFirstName: user.firstName,
        userLastName:  user.lastName,
      });

      // Step 2 — open a transaction with the chosen gateway
      const init = await api.initializePayment({
        orderId: order.id,
        amount: Number(total.toFixed(2)),
        email: user.email,
        provider,
      });

      // Step 3 — hand the browser off to the gateway's hosted page
      // Fire-and-forget: persist the typed address for future checkouts
      // if the user opted in. Failure here is non-fatal — the order is
      // already created and payment is about to start.
      if (saveForLater && showForm) {
        api.createAddress({
          fullName: address.fullName,
          line1: address.line1,
          line2: address.line2 || null,
          city: address.city,
          state: address.state,
          postal: address.postal || null,
          country: address.country,
          phone: null,
          isDefault: savedAddresses.length === 0,
        }).catch(() => {
          // Non-fatal — the order has been placed already.
        });
      }
      window.location.href = init.authorizationUrl;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Could not start payment";
      toast.error(msg);
      setSubmitting(false);
    }
    // NB: no `finally { setSubmitting(false) }` — on success we leave the
    // button spinning until the redirect actually happens.
  }

  return (
    <div className="container py-10">
      <h1 className="mb-2 font-display text-4xl font-bold tracking-tight">
        Checkout
      </h1>
      <p className="mb-8 text-muted-foreground">
        Almost there — just a few details.
      </p>

      {/* Stepper */}
      <ol className="mb-10 flex items-center gap-4">
        {STEPS.map((s, i) => {
          const active = i === step;
          const done = i < step;
          return (
            <li key={s.label} className="flex items-center gap-3">
              <div
                className={cn(
                  "grid h-9 w-9 place-items-center rounded-full border-2 text-sm font-semibold transition",
                  done
                    ? "border-primary bg-primary text-primary-foreground"
                    : active
                      ? "border-primary text-primary"
                      : "border-border text-muted-foreground"
                )}
              >
                {done ? <Check className="h-4 w-4" /> : <s.icon className="h-4 w-4" />}
              </div>
              <span
                className={cn(
                  "text-sm font-medium",
                  active ? "text-foreground" : "text-muted-foreground"
                )}
              >
                {s.label}
              </span>
              {i < STEPS.length - 1 && (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
            </li>
          );
        })}
      </ol>

      <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
        <Card className="p-6">
          {step === 0 && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setStep(1);
              }}
              className="space-y-4"
            >
              <h2 className="text-lg font-semibold">Shipping address</h2>

              {savedAddresses.length > 0 && (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Pick a saved address or{" "}
                    <button
                      type="button"
                      className="text-primary underline-offset-2 hover:underline"
                      onClick={() => {
                        setShowForm(true);
                        setPickedAddressId(null);
                      }}
                    >
                      enter a new one
                    </button>
                    .
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {savedAddresses.map((a) => {
                      const picked = pickedAddressId === a.id;
                      return (
                        <button
                          type="button"
                          key={a.id}
                          onClick={() => pickSavedAddress(a)}
                          className={cn(
                            "rounded-lg border p-3 text-left text-sm transition",
                            picked
                              ? "border-primary bg-primary/5 ring-1 ring-primary"
                              : "border-input hover:bg-secondary"
                          )}
                        >
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <span className="font-medium">{a.fullName}</span>
                            {a.isDefault && (
                              <span className="inline-flex items-center gap-0.5 text-xs text-primary">
                                <Star className="h-3 w-3" /> Default
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {a.line1}
                            {a.line2 ? `, ${a.line2}` : ""}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {a.city}, {a.state} {a.postal ?? ""}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {showForm && (
                <>
                  {savedAddresses.length > 0 && (
                    <div className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      New address
                    </div>
                  )}
                  <Field label="Full name" id="fullName" value={address.fullName} onChange={(v) => setAddress({ ...address, fullName: v })} required />
                  <Field label="Address line 1" id="line1" value={address.line1} onChange={(v) => setAddress({ ...address, line1: v })} required />
                  <Field label="Address line 2 (optional)" id="line2" value={address.line2} onChange={(v) => setAddress({ ...address, line2: v })} />
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field label="City" id="city" value={address.city} onChange={(v) => setAddress({ ...address, city: v })} required />
                    <Field label="State" id="state" value={address.state} onChange={(v) => setAddress({ ...address, state: v })} required />
                    <Field label="Postal code" id="postal" value={address.postal} onChange={(v) => setAddress({ ...address, postal: v })} />
                  </div>
                  <Field label="Country" id="country" value={address.country} onChange={(v) => setAddress({ ...address, country: v })} required />
                  <label className="flex items-center gap-2 pt-1 text-sm">
                    <input
                      type="checkbox"
                      checked={saveForLater}
                      onChange={(e) => setSaveForLater(e.target.checked)}
                      className="h-4 w-4 rounded border-input"
                    />
                    Save this address for future orders
                  </label>
                </>
              )}

              <div className="flex justify-end pt-2">
                <Button type="submit" size="lg">Continue to review</Button>
              </div>
            </form>
          )}

          {step === 1 && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold">Review &amp; pay</h2>

              <Section title="Ship to">
                <p>{address.fullName}</p>
                <p className="text-muted-foreground">
                  {address.line1}
                  {address.line2 ? `, ${address.line2}` : ""}
                </p>
                <p className="text-muted-foreground">
                  {address.city}, {address.state} {address.postal}, {address.country}
                </p>
              </Section>

              <Section title="Pay with">
                {providers.length > 1 ? (
                  <div className="space-y-2">
                    <Label htmlFor="provider">Payment gateway</Label>
                    <select
                      id="provider"
                      value={provider}
                      onChange={(e) => setProvider(e.target.value)}
                      disabled={submitting}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      {providers.map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.displayName}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                      <ShieldCheck className="h-3.5 w-3.5" />
                      You&apos;ll be redirected to {providerLabel(provider, providers)} to complete payment.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <CreditCard className="h-5 w-5 text-primary" />
                      <span>{providerLabel(provider, providers)} — secure card or bank transfer</span>
                    </div>
                    <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                      <ShieldCheck className="h-3.5 w-3.5" />
                      You&apos;ll be redirected to {providerLabel(provider, providers)} to complete payment.
                    </p>
                  </>
                )}
              </Section>

              <Section title={`${items.length} item${items.length === 1 ? "" : "s"}`}>
                <ul className="divide-y divide-border">
                  {items.map((i) => (
                    <li
                      key={String(i.productId)}
                      className="flex justify-between py-2 text-sm"
                    >
                      <span>
                        {i.name}{" "}
                        <span className="text-muted-foreground">× {i.quantity}</span>
                      </span>
                      <span className="font-medium">
                        {formatPrice(i.price * i.quantity)}
                      </span>
                    </li>
                  ))}
                </ul>
              </Section>

              <div className="flex justify-between pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setStep(0)}
                  disabled={submitting}
                >
                  Back
                </Button>
                <Button onClick={startPayment} size="lg" disabled={submitting}>
                  {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  Pay {formatPrice(total)} with {providerLabel(provider, providers)}
                </Button>
              </div>
            </div>
          )}
        </Card>

        {/* Summary */}
        <Card className="h-fit p-6">
          <h3 className="text-lg font-semibold">Order Summary</h3>
          <dl className="mt-6 space-y-2 text-sm">
            <Row label="Subtotal" value={formatPrice(subtotal)} />
            <Row
              label="Shipping"
              value={shipping === 0 ? "Free" : formatPrice(shipping)}
            />
            <Row label="VAT (7.5%)" value={formatPrice(tax)} />
            <div className="my-3 h-px bg-border" />
            <Row label="Total" value={formatPrice(total)} strong />
          </dl>
          <Link
            href="/cart"
            className="mt-6 block text-center text-sm text-primary hover:underline"
          >
            Edit cart
          </Link>
        </Card>
      </div>
    </div>
  );
}

// providerLabel turns a provider name like "paystack" into the display string
// the backend told us about, falling back to a title-cased name if the
// /providers call hadn't finished yet.
function providerLabel(
  name: string,
  list: { name: string; displayName: string }[]
): string {
  const hit = list.find((p) => p.name === name);
  if (hit) return hit.displayName;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function Field({
  label,
  id,
  value,
  onChange,
  required,
  placeholder,
}: {
  label: string;
  id: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        placeholder={placeholder}
      />
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-background/50 p-4">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h4>
      <div className="text-sm">{children}</div>
    </div>
  );
}

function Row({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className={cn("flex justify-between", strong && "text-base")}>
      <dt className={strong ? "font-semibold" : "text-muted-foreground"}>{label}</dt>
      <dd className={strong ? "font-bold" : "font-medium"}>{value}</dd>
    </div>
  );
}
