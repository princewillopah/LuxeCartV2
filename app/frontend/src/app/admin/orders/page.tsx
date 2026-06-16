"use client";

import * as React from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Pagination } from "@/components/pagination";
import { api } from "@/lib/api";
import { formatPrice } from "@/lib/price";
import {
  ADMIN_NEXT_STATUSES,
  ORDER_STATUSES,
  type Order,
  type OrderHistoryEntry,
  type OrderStatus,
} from "@/lib/types";

const STATUS_VARIANT: Record<
  string,
  "default" | "secondary" | "outline" | "success" | "warning" | "destructive"
> = {
  pending: "warning",
  processing: "secondary",
  shipped: "default",
  delivered: "success",
  cancelled: "destructive",
  refunded: "outline",
};

// Capitalised verb shown on the action button. Defaults to status name.
const ACTION_LABEL: Partial<Record<OrderStatus, string>> = {
  processing: "Mark processing",
  shipped: "Ship",
  delivered: "Mark delivered",
  cancelled: "Cancel",
  refunded: "Refund",
};

// Destructive transitions get a red button + confirm-prompt.
const DESTRUCTIVE = new Set<OrderStatus>(["cancelled", "refunded"]);

function fmtAddr(addr: Order["shippingAddress"]): string {
  if (!addr) return "—";
  if (typeof addr === "string") return addr;
  const a = addr as Record<string, unknown>;
  const parts = [a.street, a.city, a.state, a.zip, a.country].filter(Boolean);
  return parts.length ? parts.join(", ") : JSON.stringify(addr);
}

export default function AdminOrdersPage() {
  const LIMIT = 20;
  const [orders, setOrders] = React.useState<Order[]>([]);
  const [total, setTotal]   = React.useState(0);
  const [page, setPage]     = React.useState(1);
  const [loading, setLoading] = React.useState(true);
  const [filter, setFilter] = React.useState<OrderStatus | "all">("all");
  const [busyId, setBusyId] = React.useState<string | number | null>(null);
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const [history, setHistory] = React.useState<Record<string, OrderHistoryEntry[]>>({});

  // Reset to page 1 whenever the status filter changes — otherwise the
  // user could be stranded on an empty page after narrowing the filter.
  React.useEffect(() => { setPage(1); }, [filter]);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.adminListOrders({
        page, limit: LIMIT,
        status: filter === "all" ? undefined : filter,
      });
      setOrders(res.items);
      setTotal(res.total);
    } catch (e) {
      toast.error((e as Error).message || "Failed to load orders");
    } finally {
      setLoading(false);
    }
  }, [page, filter]);

  React.useEffect(() => {
    load();
  }, [load]);

  // Lazy-load the timeline only when the row is expanded for the first time.
  // Keeps the list view cheap when there are hundreds of orders.
  async function ensureHistory(orderId: string | number) {
    const key = String(orderId);
    if (history[key]) return;
    try {
      const r = await api.orderHistory(orderId);
      setHistory((h) => ({ ...h, [key]: r.history }));
    } catch {
      // Non-fatal — timeline is informational
    }
  }

  async function changeStatus(o: Order, status: OrderStatus) {
    if (DESTRUCTIVE.has(status)) {
      const verb = status === "refunded" ? "issue a refund for" : "cancel";
      const confirmed = window.confirm(`Are you sure you want to ${verb} order #${o.id}?`);
      if (!confirmed) return;
    }
    setBusyId(o.id);
    try {
      const updated = await api.updateOrderStatus(o.id, status);
      setOrders((cur) =>
        cur.map((x) => (x.id === o.id ? { ...x, ...updated, status } : x))
      );
      toast.success(`Order #${o.id} → ${status}`);
      // Refresh the timeline if it was already loaded
      if (history[String(o.id)]) {
        const r = await api.orderHistory(o.id);
        setHistory((h) => ({ ...h, [String(o.id)]: r.history }));
      }
    } catch (e) {
      toast.error((e as Error).message || "Failed to update status");
    } finally {
      setBusyId(null);
    }
  }

  const filtered = orders; // server-side filtering now

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-bold tracking-tight">Orders</h1>
        <p className="text-sm text-muted-foreground">
          {total} order{total === 1 ? "" : "s"} matching current filter.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {(["all", ...ORDER_STATUSES] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setFilter(s)}
            className={`rounded-full border px-3 py-1 text-xs font-medium capitalize transition-colors ${
              filter === s
                ? "border-primary bg-primary text-primary-foreground"
                : "border-input bg-background text-muted-foreground hover:bg-secondary"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-secondary/40 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Order</th>
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3 text-right">Total</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-b last:border-0">
                    {Array.from({ length: 6 }).map((__, j) => (
                      <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-20" /></td>
                    ))}
                  </tr>
                ))
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">
                    No orders.
                  </td>
                </tr>
              ) : (
                filtered.map((o) => {
                  const open = !!expanded[String(o.id)];
                  const nextStates =
                    ADMIN_NEXT_STATUSES[o.status as OrderStatus] || [];
                  return (
                    <React.Fragment key={o.id}>
                      <tr className="border-b last:border-0">
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            className="font-medium text-primary hover:underline"
                            onClick={() => {
                              const next = !open;
                              setExpanded((e) => ({ ...e, [String(o.id)]: next }));
                              if (next) ensureHistory(o.id);
                            }}
                          >
                            #{o.id}
                          </button>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{o.userId}</td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {new Date(o.createdAt).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {formatPrice(Number(o.total))}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={STATUS_VARIANT[o.status] ?? "outline"}>
                            {o.status}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          {nextStates.length === 0 ? (
                            <span className="text-xs text-muted-foreground">
                              Final state
                            </span>
                          ) : (
                            <div className="flex flex-wrap gap-1">
                              {nextStates.map((s) => (
                                <button
                                  key={s}
                                  type="button"
                                  disabled={busyId === o.id}
                                  onClick={() => changeStatus(o, s)}
                                  className={`rounded-md border px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                                    DESTRUCTIVE.has(s)
                                      ? "border-destructive/40 text-destructive hover:bg-destructive/10"
                                      : "border-input hover:bg-secondary"
                                  }`}
                                >
                                  {ACTION_LABEL[s] || s}
                                </button>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                      {open && (
                        <tr className="border-b bg-secondary/30 last:border-0">
                          <td colSpan={6} className="px-4 py-4">
                            <div className="grid gap-4 md:grid-cols-3">
                              <div>
                                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                  Items
                                </div>
                                <ul className="space-y-1 text-sm">
                                  {(o.items ?? []).filter(Boolean).map((it, idx) => (
                                    <li key={idx} className="flex justify-between gap-4">
                                      <span className="truncate">
                                        {it.productName ?? it.name} × {it.quantity}
                                      </span>
                                      <span className="tabular-nums text-muted-foreground">
                                        {formatPrice(Number(it.price))}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                              <div className="space-y-2 text-sm">
                                <div>
                                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                    Ship to
                                  </div>
                                  <div>{fmtAddr(o.shippingAddress)}</div>
                                </div>
                                <div>
                                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                    Payment
                                  </div>
                                  <div>{o.paymentMethod ?? "—"}</div>
                                </div>
                                {o.trackingNumber && (
                                  <div>
                                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                      Tracking
                                    </div>
                                    <div className="font-mono text-xs">{o.trackingNumber}</div>
                                  </div>
                                )}
                              </div>
                              <div>
                                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                  Timeline
                                </div>
                                {history[String(o.id)] === undefined ? (
                                  <Skeleton className="h-12 w-full" />
                                ) : history[String(o.id)].length === 0 ? (
                                  <p className="text-xs text-muted-foreground">
                                    No transitions recorded yet.
                                  </p>
                                ) : (
                                  <ol className="space-y-2 text-xs">
                                    {history[String(o.id)].map((h) => (
                                      <li key={h.id} className="border-l-2 border-primary/40 pl-2">
                                        <div>
                                          <span className="text-muted-foreground">
                                            {h.from_status ? `${h.from_status} → ` : ""}
                                          </span>
                                          <span className="font-medium">{h.to_status}</span>
                                          <span className="ml-2 text-muted-foreground">
                                            ({h.actor_role || "system"})
                                          </span>
                                        </div>
                                        {h.note && (
                                          <div className="text-muted-foreground">{h.note}</div>
                                        )}
                                        <div className="text-muted-foreground/70">
                                          {new Date(h.created_at).toLocaleString()}
                                        </div>
                                      </li>
                                    ))}
                                  </ol>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="border-t px-4">
          <Pagination
            page={page}
            total={total}
            limit={LIMIT}
            onPageChange={setPage}
          />
        </div>
      </Card>
    </div>
  );
}

