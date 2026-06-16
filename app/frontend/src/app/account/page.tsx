"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Package, User as UserIcon, MapPin, Heart, LogOut, Plus, Pencil, Trash2, Check, Star } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { OrderTimeline } from "@/components/order-timeline";
import { ProductCard } from "@/components/product-card";
import { useAuth } from "@/store/auth";
import { formatPrice } from "@/lib/price";
import { cn } from "@/lib/utils";
import type { Address } from "@/lib/types";

const TABS = [
  { id: "profile", label: "Profile", icon: UserIcon },
  { id: "orders", label: "Orders", icon: Package },
  { id: "addresses", label: "Addresses", icon: MapPin },
  { id: "wishlist", label: "Wishlist", icon: Heart },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function AccountPage() {
  return (
    <React.Suspense fallback={<div className="container py-16" />}>
      <AccountInner />
    </React.Suspense>
  );
}

function AccountInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);

  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  React.useEffect(() => {
    if (mounted && !user) router.push("/auth/login?next=/account");
  }, [mounted, user, router]);

  const tab = (sp.get("tab") as TabId) ?? "profile";

  if (!mounted || !user) return <div className="container py-16" />;

  return (
    <div className="container py-10">
      <h1 className="mb-2 font-display text-4xl font-bold tracking-tight">
        Hi, {user.firstName} 👋
      </h1>
      <p className="mb-8 text-muted-foreground">Manage your account and orders.</p>

      <div className="grid gap-8 lg:grid-cols-[240px_1fr]">
        <aside>
          <nav className="space-y-1">
            {TABS.map((t) => (
              <Link
                key={t.id}
                href={`/account?tab=${t.id}`}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition",
                  tab === t.id
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                )}
              >
                <t.icon className="h-4 w-4" />
                {t.label}
              </Link>
            ))}
            <button
              onClick={() => {
                logout();
                router.push("/");
              }}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition hover:bg-secondary hover:text-destructive"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </nav>
        </aside>

        <div>
          {tab === "profile" && <ProfileTab />}
          {tab === "orders" && <OrdersTab />}
          {tab === "addresses" && <AddressesTab />}
          {tab === "wishlist" && <WishlistTab />}
        </div>
      </div>
    </div>
  );
}

function ProfileTab() {
  const user = useAuth((s) => s.user)!;
  return (
    <Card className="p-6">
      <h2 className="mb-1 text-lg font-semibold">Profile</h2>
      <p className="mb-6 text-sm text-muted-foreground">Account details on file.</p>
      <dl className="grid gap-4 sm:grid-cols-2">
        <Field label="First name" value={user.firstName} />
        <Field label="Last name" value={user.lastName} />
        <Field label="Email" value={user.email} />
        <Field label="Role" value={user.role} />
      </dl>
      <div className="mt-6">
        <Button variant="outline" disabled>
          Edit profile (coming soon)
        </Button>
      </div>
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 font-medium">{value}</dd>
    </div>
  );
}

function OrdersTab() {
  const qc = useQueryClient();
  const [cancellingId, setCancellingId] = React.useState<string | number | null>(null);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["orders"],
    queryFn: () => api.listOrders(),
  });

  async function handleCancel(id: string | number) {
    if (!window.confirm(`Cancel order #${id}? This cannot be undone.`)) return;
    setCancellingId(id);
    try {
      await api.cancelOrder(id);
      toast.success(`Order #${id} cancelled`);
      qc.invalidateQueries({ queryKey: ["orders"] });
    } catch (e) {
      toast.error((e as Error).message || "Failed to cancel order");
    } finally {
      setCancellingId(null);
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24 w-full rounded-2xl" />
        ))}
      </div>
    );
  }
  if (isError) {
    return (
      <EmptyState
        title="Couldn't load orders"
        description="The order service may be unavailable. Please try again."
      />
    );
  }
  if (!data || data.length === 0) {
    return (
      <EmptyState
        icon={Package}
        title="No orders yet"
        description="When you place an order, it will show up here."
        actionLabel="Start shopping"
        actionHref="/products"
      />
    );
  }

  const statusVariant = (s: string) =>
    s === "delivered" || s === "paid"
      ? "success"
      : s === "cancelled"
        ? "destructive"
        : s === "shipped"
          ? "default"
          : "warning";

  return (
    <div className="space-y-3">
      {data.map((o) => (
        <Card key={String(o.id)} className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-semibold">Order #{String(o.id).slice(0, 8)}</h3>
                <Badge variant={statusVariant(o.status)}>{o.status}</Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {new Date(o.createdAt).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}{" "}
                · {o.items?.length ?? 0} item{(o.items?.length ?? 0) === 1 ? "" : "s"}
              </p>
            </div>
            <div className="text-right">
              <p className="text-lg font-bold">{formatPrice(Number(o.total ?? 0))}</p>
              {(o.status === "pending" || o.status === "processing") && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={cancellingId === o.id}
                  onClick={() => handleCancel(o.id)}
                  className="mt-2 h-auto px-2 py-1 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  {cancellingId === o.id ? "Cancelling…" : "Cancel order"}
                </Button>
              )}
            </div>
          </div>
          <div className="mt-5 border-t pt-5">
            <OrderTimeline status={o.status} />
          </div>
        </Card>
      ))}
    </div>
  );
}

function WishlistTab() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["wishlist"],
    queryFn: () => api.listWishlist(),
  });

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-72 w-full rounded-2xl" />
        ))}
      </div>
    );
  }
  if (isError) {
    return (
      <EmptyState
        title="Couldn't load wishlist"
        description="Please try again in a moment."
      />
    );
  }
  if (!data || data.length === 0) {
    return (
      <EmptyState
        icon={Heart}
        title="Your wishlist is empty"
        description="Tap the heart on any product to save it for later."
        actionLabel="Browse products"
        actionHref="/products"
      />
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {data.map(({ product }) => (
        <ProductCard key={String(product.id)} product={product} />
      ))}
    </div>
  );
}

// ─── Addresses ────────────────────────────────────────────────────────────
// Saved shipping addresses. The checkout page reads these to skip the
// address form on repeat orders. The first address you save becomes
// the default automatically; you can change the default at any time.

type AddressFormState = {
  fullName: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postal: string;
  country: string;
  phone: string;
  isDefault: boolean;
};

const EMPTY_FORM: AddressFormState = {
  fullName: "",
  line1: "",
  line2: "",
  city: "",
  state: "",
  postal: "",
  country: "Nigeria",
  phone: "",
  isDefault: false,
};

function addressToForm(a: Address): AddressFormState {
  return {
    fullName: a.fullName,
    line1: a.line1,
    line2: a.line2 ?? "",
    city: a.city,
    state: a.state,
    postal: a.postal ?? "",
    country: a.country,
    phone: a.phone ?? "",
    isDefault: a.isDefault,
  };
}

function AddressesTab() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["addresses"],
    queryFn: () => api.listMyAddresses(),
  });

  // editingId: null = closed, "new" = creating, number = editing that id
  const [editingId, setEditingId] = React.useState<null | "new" | number>(null);
  const [form, setForm] = React.useState<AddressFormState>(EMPTY_FORM);
  const [busyId, setBusyId] = React.useState<number | null>(null);

  const createMut = useMutation({
    mutationFn: (input: AddressFormState) => api.createAddress(input),
    onSuccess: () => {
      toast.success("Address saved");
      setEditingId(null);
      qc.invalidateQueries({ queryKey: ["addresses"] });
    },
    onError: (e: Error) => toast.error(e.message || "Failed to save address"),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, input }: { id: number; input: AddressFormState }) =>
      api.updateAddress(id, input),
    onSuccess: () => {
      toast.success("Address updated");
      setEditingId(null);
      qc.invalidateQueries({ queryKey: ["addresses"] });
    },
    onError: (e: Error) => toast.error(e.message || "Failed to update address"),
  });

  async function handleDelete(id: number) {
    if (!confirm("Delete this address?")) return;
    setBusyId(id);
    try {
      await api.deleteAddress(id);
      toast.success("Address removed");
      qc.invalidateQueries({ queryKey: ["addresses"] });
    } catch (e) {
      toast.error((e as Error).message || "Failed to delete address");
    } finally {
      setBusyId(null);
    }
  }

  async function handleSetDefault(id: number) {
    setBusyId(id);
    try {
      await api.setDefaultAddress(id);
      toast.success("Default address updated");
      qc.invalidateQueries({ queryKey: ["addresses"] });
    } catch (e) {
      toast.error((e as Error).message || "Failed to set default");
    } finally {
      setBusyId(null);
    }
  }

  function startNew() {
    setForm(EMPTY_FORM);
    setEditingId("new");
  }

  function startEdit(a: Address) {
    setForm(addressToForm(a));
    setEditingId(a.id as number);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (editingId === "new") createMut.mutate(form);
    else if (typeof editingId === "number") updateMut.mutate({ id: editingId, input: form });
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2].map((i) => (
          <Skeleton key={i} className="h-32 w-full rounded-2xl" />
        ))}
      </div>
    );
  }
  if (isError) {
    return (
      <EmptyState
        title="Couldn't load addresses"
        description="Please try again in a moment."
      />
    );
  }

  const addresses = data ?? [];
  const saving = createMut.isPending || updateMut.isPending;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Shipping addresses</h2>
          <p className="text-sm text-muted-foreground">
            Save addresses to skip the form at checkout.
          </p>
        </div>
        {editingId === null && (
          <Button onClick={startNew}>
            <Plus className="h-4 w-4" /> Add address
          </Button>
        )}
      </div>

      {editingId !== null && (
        <Card className="p-6">
          <h3 className="mb-4 font-semibold">
            {editingId === "new" ? "New address" : "Edit address"}
          </h3>
          <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label htmlFor="fullName">Full name *</Label>
              <Input
                id="fullName"
                value={form.fullName}
                onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                required
              />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="line1">Address line 1 *</Label>
              <Input
                id="line1"
                value={form.line1}
                onChange={(e) => setForm({ ...form, line1: e.target.value })}
                required
              />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="line2">Address line 2</Label>
              <Input
                id="line2"
                value={form.line2}
                onChange={(e) => setForm({ ...form, line2: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="city">City *</Label>
              <Input
                id="city"
                value={form.city}
                onChange={(e) => setForm({ ...form, city: e.target.value })}
                required
              />
            </div>
            <div>
              <Label htmlFor="state">State *</Label>
              <Input
                id="state"
                value={form.state}
                onChange={(e) => setForm({ ...form, state: e.target.value })}
                required
              />
            </div>
            <div>
              <Label htmlFor="postal">Postal code</Label>
              <Input
                id="postal"
                value={form.postal}
                onChange={(e) => setForm({ ...form, postal: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="country">Country *</Label>
              <Input
                id="country"
                value={form.country}
                onChange={(e) => setForm({ ...form, country: e.target.value })}
                required
              />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="phone">Phone</Label>
              <Input
                id="phone"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
              />
            </div>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input
                type="checkbox"
                checked={form.isDefault}
                onChange={(e) => setForm({ ...form, isDefault: e.target.checked })}
                className="h-4 w-4 rounded border-input"
              />
              Set as default shipping address
            </label>
            <div className="flex gap-2 sm:col-span-2">
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save address"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditingId(null)}
                disabled={saving}
              >
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      {addresses.length === 0 && editingId === null ? (
        <EmptyState
          icon={MapPin}
          title="No saved addresses"
          description="Add an address to make checkout faster."
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {addresses.map((a) => (
            <Card key={a.id} className="p-5">
              <div className="mb-3 flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold">{a.fullName}</p>
                  {a.isDefault && (
                    <Badge variant="success" className="mt-1">
                      <Star className="h-3 w-3" /> Default
                    </Badge>
                  )}
                </div>
              </div>
              <address className="space-y-0.5 not-italic text-sm text-muted-foreground">
                <p>{a.line1}</p>
                {a.line2 && <p>{a.line2}</p>}
                <p>
                  {a.city}, {a.state} {a.postal ?? ""}
                </p>
                <p>{a.country}</p>
                {a.phone && <p className="pt-1">📞 {a.phone}</p>}
              </address>
              <div className="mt-4 flex flex-wrap gap-2">
                {!a.isDefault && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyId === a.id}
                    onClick={() => handleSetDefault(a.id as number)}
                  >
                    <Check className="h-3.5 w-3.5" /> Make default
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => startEdit(a)}
                >
                  <Pencil className="h-3.5 w-3.5" /> Edit
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busyId === a.id}
                  onClick={() => handleDelete(a.id as number)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {busyId === a.id ? "…" : "Delete"}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
