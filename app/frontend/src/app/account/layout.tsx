import type { Metadata } from "next";

/** Phase 9 (SEO) — Account pages are private; do not index. */
export const metadata: Metadata = {
  title: "Your account",
  description: "Manage your LuxeCart account, orders, and saved addresses.",
  robots: { index: false, follow: false },
};

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
