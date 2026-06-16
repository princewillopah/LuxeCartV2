"use client";

import * as React from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Pagination } from "@/components/pagination";
import { api } from "@/lib/api";
import { useAuth } from "@/store/auth";
import type { User } from "@/lib/types";

const LIMIT = 20;

export default function AdminUsersPage() {
  const me = useAuth((s) => s.user);
  const [users, setUsers] = React.useState<User[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage]   = React.useState(1);
  const [loading, setLoading] = React.useState(true);
  const [q, setQ] = React.useState("");
  const [debouncedQ, setDebouncedQ] = React.useState("");
  const [busyId, setBusyId] = React.useState<string | number | null>(null);

  // Debounce the search input so we don't hit the API on every keystroke.
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Reset to page 1 whenever the search term changes — otherwise the
  // user could be stranded on an empty page 5 of a 2-page result.
  React.useEffect(() => {
    setPage(1);
  }, [debouncedQ]);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.adminListUsers({ page, limit: LIMIT, search: debouncedQ || undefined });
      setUsers(res.items);
      setTotal(res.total);
    } catch (e) {
      toast.error((e as Error).message || "Failed to load users");
    } finally {
      setLoading(false);
    }
  }, [page, debouncedQ]);

  React.useEffect(() => {
    load();
  }, [load]);

  async function onDelete(u: User) {
    if (me?.id === u.id) {
      toast.error("You can't delete your own account.");
      return;
    }
    if (!confirm(`Delete ${u.email}? This cannot be undone.`)) return;
    setBusyId(u.id);
    try {
      await api.adminDeleteUser(u.id);
      toast.success("User deleted");
      // Refetch the current page so totals/positions stay correct after delete.
      load();
    } catch (e) {
      toast.error((e as Error).message || "Delete failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-bold tracking-tight">Users</h1>
        <p className="text-sm text-muted-foreground">
          {total} user{total === 1 ? "" : "s"} total.
        </p>
      </div>

      <Input
        placeholder="Search by email or name…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="max-w-sm"
      />

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-secondary/40 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-b last:border-0">
                    {Array.from({ length: 4 }).map((__, j) => (
                      <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-32" /></td>
                    ))}
                  </tr>
                ))
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center text-muted-foreground">
                    No users match.
                  </td>
                </tr>
              ) : (
                users.map((u) => {
                  const isMe = me?.id === u.id;
                  return (
                    <tr key={u.id} className="border-b last:border-0">
                      <td className="px-4 py-3 font-medium">
                        {u.firstName} {u.lastName}
                        {isMe && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            (you)
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{u.email}</td>
                      <td className="px-4 py-3">
                        <Badge
                          variant={u.role === "admin" ? "default" : "secondary"}
                        >
                          {u.role}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end">
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={busyId === u.id || isMe}
                            onClick={() => onDelete(u)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            {busyId === u.id ? "Deleting…" : "Delete"}
                          </Button>
                        </div>
                      </td>
                    </tr>
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
