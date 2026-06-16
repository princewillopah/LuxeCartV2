import type { Metadata } from "next";

/**
 * Phase 9 (SEO) — Auth pages (login/register/forgot/reset/verify) are
 * functional pages for our users, not landing pages for crawlers.
 * `robots.ts` already disallows /auth, this layout adds the in-page
 * meta as a belt-and-braces signal.
 */
export const metadata: Metadata = {
  title: { default: "Sign in", template: "%s · LuxeCart" },
  description: "Sign in or create your LuxeCart account.",
  robots: { index: false, follow: false },
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
