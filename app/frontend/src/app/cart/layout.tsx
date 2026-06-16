import type { Metadata } from "next";

/**
 * Phase 9 (SEO) — Cart is a private, per-user page; tell crawlers not
 * to index it. The title still shows up nicely in browser tabs.
 */
export const metadata: Metadata = {
  title: "Your cart",
  description: "Review the items in your LuxeCart shopping cart.",
  robots: { index: false, follow: true },
};

export default function CartLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
