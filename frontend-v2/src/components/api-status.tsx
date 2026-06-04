"use client";

import * as React from "react";
import { API_URL } from "@/lib/utils";

type Status = "loading" | "ok" | "down";

export function ApiStatus() {
  const [status, setStatus] = React.useState<Status>("loading");
  const [detail, setDetail] = React.useState<string>("");

  React.useEffect(() => {
    const ctrl = new AbortController();
    fetch(`${API_URL}/health`, { signal: ctrl.signal, cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json().catch(() => ({}));
        setStatus("ok");
        setDetail(data?.status ?? "OK");
      })
      .catch((e) => {
        if (e.name === "AbortError") return;
        setStatus("down");
        setDetail(e.message);
      });
    return () => ctrl.abort();
  }, []);

  const color =
    status === "ok"
      ? "bg-emerald-500"
      : status === "down"
        ? "bg-red-500"
        : "bg-amber-400";

  const label =
    status === "ok"
      ? "API Gateway online"
      : status === "down"
        ? "API Gateway unreachable"
        : "Checking API…";

  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-soft">
      <span className="relative flex h-2 w-2">
        <span
          className={`absolute inline-flex h-full w-full animate-ping rounded-full ${color} opacity-60`}
        />
        <span className={`relative inline-flex h-2 w-2 rounded-full ${color}`} />
      </span>
      {label}
      {detail && status !== "loading" && (
        <span className="text-muted-foreground/70">· {detail}</span>
      )}
    </div>
  );
}
