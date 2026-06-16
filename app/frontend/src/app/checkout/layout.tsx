import type { Metadata } from "next";

/** Phase 9 (SEO) — Checkout is private; do not index. */
export const metadata: Metadata = {
  title: "Checkout",
  description: "Complete your LuxeCart order.",
  robots: { index: false, follow: false },
};

export default function CheckoutLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
