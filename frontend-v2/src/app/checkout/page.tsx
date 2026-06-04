"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronRight,
  CreditCard,
  Loader2,
  MapPin,
  Package,
} from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { EmptyState } from "@/components/empty-state";
import { useCart } from "@/store/cart";
import { useAuth } from "@/store/auth";
import { cn } from "@/lib/utils";

type Step = 0 | 1 | 2;

const STEPS: { label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { label: "Shipping", icon: MapPin },
  { label: "Payment", icon: CreditCard },
  { label: "Review", icon: Package },
];

export default function CheckoutPage() {
  const router = useRouter();
  const items = useCart((s) => s.items);
  const clear = useCart((s) => s.clear);
  const user = useAuth((s) => s.user);

  const [step, setStep] = React.useState<Step>(0);
  const [submitting, setSubmitting] = React.useState(false);
  const [address, setAddress] = React.useState({
    fullName: user ? `${user.firstName} ${user.lastName}` : "",
    line1: "",
    line2: "",
    city: "",
    state: "",
    postal: "",
    country: "United States",
  });
  const [payment, setPayment] = React.useState({
    cardName: "",
    cardNumber: "",
    expiry: "",
    cvc: "",
  });

  const subtotal = items.reduce((n, i) => n + i.price * i.quantity, 0);
  const shipping = subtotal > 50 || subtotal === 0 ? 0 : 5.99;
  const tax = subtotal * 0.08;
  const total = subtotal + shipping + tax;

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

  async function placeOrder() {
    if (!user) return;
    setSubmitting(true);
    try {
      await api.createOrder({
        userId: user.id,
        total: Number(total.toFixed(2)),
        items: items.map((i) => ({
          id: i.productId,
          name: i.name,
          price: i.price,
          quantity: i.quantity,
        })),
        shippingAddress: address,
        paymentMethod: "card",
      });
      toast.success("Order placed! 🎉");
      clear();
      router.push("/account?tab=orders");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Order failed";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="container py-10">
      <h1 className="mb-2 font-display text-4xl font-bold tracking-tight">Checkout</h1>
      <p className="mb-8 text-muted-foreground">Almost there — just a few details.</p>

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
              <Field label="Full name" id="fullName" value={address.fullName} onChange={(v) => setAddress({ ...address, fullName: v })} required />
              <Field label="Address line 1" id="line1" value={address.line1} onChange={(v) => setAddress({ ...address, line1: v })} required />
              <Field label="Address line 2 (optional)" id="line2" value={address.line2} onChange={(v) => setAddress({ ...address, line2: v })} />
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="City" id="city" value={address.city} onChange={(v) => setAddress({ ...address, city: v })} required />
                <Field label="State" id="state" value={address.state} onChange={(v) => setAddress({ ...address, state: v })} required />
                <Field label="Postal code" id="postal" value={address.postal} onChange={(v) => setAddress({ ...address, postal: v })} required />
              </div>
              <Field label="Country" id="country" value={address.country} onChange={(v) => setAddress({ ...address, country: v })} required />
              <div className="flex justify-end pt-2">
                <Button type="submit" size="lg">Continue to payment</Button>
              </div>
            </form>
          )}

          {step === 1 && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setStep(2);
              }}
              className="space-y-4"
            >
              <h2 className="text-lg font-semibold">Payment details</h2>
              <p className="text-xs text-muted-foreground">
                💳 Demo only — no real card data is processed.
              </p>
              <Field label="Name on card" id="cardName" value={payment.cardName} onChange={(v) => setPayment({ ...payment, cardName: v })} required />
              <Field label="Card number" id="cardNumber" value={payment.cardNumber} onChange={(v) => setPayment({ ...payment, cardNumber: v })} placeholder="4242 4242 4242 4242" required />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Expiry (MM/YY)" id="expiry" value={payment.expiry} onChange={(v) => setPayment({ ...payment, expiry: v })} placeholder="12/28" required />
                <Field label="CVC" id="cvc" value={payment.cvc} onChange={(v) => setPayment({ ...payment, cvc: v })} placeholder="123" required />
              </div>
              <div className="flex justify-between pt-2">
                <Button type="button" variant="ghost" onClick={() => setStep(0)}>Back</Button>
                <Button type="submit" size="lg">Review order</Button>
              </div>
            </form>
          )}

          {step === 2 && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold">Review &amp; place order</h2>

              <Section title="Ship to">
                <p>{address.fullName}</p>
                <p className="text-muted-foreground">
                  {address.line1}{address.line2 ? `, ${address.line2}` : ""}
                </p>
                <p className="text-muted-foreground">
                  {address.city}, {address.state} {address.postal}, {address.country}
                </p>
              </Section>

              <Section title="Pay with">
                <p>
                  Card ending in {payment.cardNumber.slice(-4) || "••••"}
                </p>
                <p className="text-muted-foreground">{payment.cardName}</p>
              </Section>

              <Section title={`${items.length} item${items.length === 1 ? "" : "s"}`}>
                <ul className="divide-y divide-border">
                  {items.map((i) => (
                    <li key={String(i.productId)} className="flex justify-between py-2 text-sm">
                      <span>
                        {i.name} <span className="text-muted-foreground">× {i.quantity}</span>
                      </span>
                      <span className="font-medium">
                        ${(i.price * i.quantity).toFixed(2)}
                      </span>
                    </li>
                  ))}
                </ul>
              </Section>

              <div className="flex justify-between pt-2">
                <Button type="button" variant="ghost" onClick={() => setStep(1)}>Back</Button>
                <Button onClick={placeOrder} size="lg" disabled={submitting}>
                  {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  Place order — ${total.toFixed(2)}
                </Button>
              </div>
            </div>
          )}
        </Card>

        {/* Summary */}
        <Card className="h-fit p-6">
          <h3 className="text-lg font-semibold">Order Summary</h3>
          <dl className="mt-6 space-y-2 text-sm">
            <Row label="Subtotal" value={`$${subtotal.toFixed(2)}`} />
            <Row label="Shipping" value={shipping === 0 ? "Free" : `$${shipping.toFixed(2)}`} />
            <Row label="Tax" value={`$${tax.toFixed(2)}`} />
            <div className="my-3 h-px bg-border" />
            <Row label="Total" value={`$${total.toFixed(2)}`} strong />
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

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cn("flex justify-between", strong && "text-base")}>
      <dt className={strong ? "font-semibold" : "text-muted-foreground"}>{label}</dt>
      <dd className={strong ? "font-bold" : "font-medium"}>{value}</dd>
    </div>
  );
}
