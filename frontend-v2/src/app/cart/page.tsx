"use client";

import * as React from "react";
import Link from "next/link";
import { Minus, Plus, ShoppingBag, Trash2, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { useCart } from "@/store/cart";

export default function CartPage() {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const items = useCart((s) => s.items);
  const setQty = useCart((s) => s.setQty);
  const remove = useCart((s) => s.remove);
  const clear = useCart((s) => s.clear);

  const subtotal = items.reduce((n, i) => n + i.price * i.quantity, 0);
  const shipping = subtotal > 50 || subtotal === 0 ? 0 : 5.99;
  const tax = subtotal * 0.08;
  const total = subtotal + shipping + tax;

  if (!mounted) {
    return <div className="container py-16" />;
  }

  if (items.length === 0) {
    return (
      <div className="container py-16">
        <EmptyState
          icon={ShoppingBag}
          title="Your cart is empty"
          description="Discover thousands of premium products waiting for you."
          actionLabel="Start shopping"
          actionHref="/products"
        />
      </div>
    );
  }

  return (
    <div className="container py-10">
      <h1 className="mb-8 font-display text-4xl font-bold tracking-tight">
        Your Cart
      </h1>

      <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
        <div className="space-y-3">
          {items.map((item) => (
            <Card key={String(item.productId)} className="flex gap-4 p-4">
              <Link
                href={`/products/${item.productId}`}
                className="relative h-24 w-24 shrink-0 overflow-hidden rounded-lg bg-gradient-to-br from-brand-50 to-brand-100 dark:from-brand-950 dark:to-brand-900"
              >
                {item.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.image}
                    alt={item.name}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-3xl font-bold text-brand-300/40 dark:text-brand-700/40">
                    {item.name.charAt(0)}
                  </div>
                )}
              </Link>
              <div className="flex flex-1 flex-col justify-between">
                <div className="flex items-start justify-between gap-2">
                  <Link
                    href={`/products/${item.productId}`}
                    className="font-semibold hover:text-primary"
                  >
                    {item.name}
                  </Link>
                  <button
                    onClick={() => remove(item.productId)}
                    className="text-muted-foreground hover:text-destructive"
                    aria-label="Remove"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                <div className="flex items-center justify-between">
                  <div className="inline-flex h-9 items-center rounded-md border border-input">
                    <button
                      className="grid h-9 w-9 place-items-center hover:bg-secondary"
                      onClick={() => setQty(item.productId, item.quantity - 1)}
                      aria-label="Decrease"
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </button>
                    <span className="w-8 text-center text-sm font-semibold">
                      {item.quantity}
                    </span>
                    <button
                      className="grid h-9 w-9 place-items-center hover:bg-secondary"
                      onClick={() => setQty(item.productId, item.quantity + 1)}
                      aria-label="Increase"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="text-right">
                    <p className="font-bold">
                      ${(item.price * item.quantity).toFixed(2)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      ${item.price.toFixed(2)} ea
                    </p>
                  </div>
                </div>
              </div>
            </Card>
          ))}
          <div className="flex justify-end pt-2">
            <Button variant="ghost" size="sm" onClick={clear}>
              <Trash2 className="h-4 w-4" /> Clear cart
            </Button>
          </div>
        </div>

        {/* Summary */}
        <Card className="h-fit p-6">
          <h3 className="text-lg font-semibold">Order Summary</h3>
          <dl className="mt-6 space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Subtotal</dt>
              <dd className="font-medium">${subtotal.toFixed(2)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Shipping</dt>
              <dd className="font-medium">
                {shipping === 0 ? (
                  <span className="text-emerald-600">Free</span>
                ) : (
                  `$${shipping.toFixed(2)}`
                )}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Estimated tax</dt>
              <dd className="font-medium">${tax.toFixed(2)}</dd>
            </div>
            <div className="my-3 h-px bg-border" />
            <div className="flex justify-between text-base">
              <dt className="font-semibold">Total</dt>
              <dd className="font-bold">${total.toFixed(2)}</dd>
            </div>
          </dl>
          <Button size="lg" className="mt-6 w-full" asChild>
            <Link href="/checkout">
              Checkout <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <p className="mt-3 text-center text-xs text-muted-foreground">
            Free shipping on orders over $50
          </p>
        </Card>
      </div>
    </div>
  );
}
