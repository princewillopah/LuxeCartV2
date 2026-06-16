import type { Metadata } from "next";

/**
 * Phase 9 (SEO) — Section-level metadata for the products listing.
 * Server-only layout so it can export `metadata` (the page itself
 * is a client component and can't).
 */
export const metadata: Metadata = {
  title: "Shop all products",
  description:
    "Browse the full LuxeCart catalog — premium products across electronics, fashion, home, beauty, sports and books.",
  openGraph: {
    title: "Shop all products · LuxeCart",
    description:
      "Browse the full LuxeCart catalog — premium products across electronics, fashion, home, beauty, sports and books.",
    type: "website",
  },
};

export default function ProductsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
