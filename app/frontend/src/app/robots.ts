import type { MetadataRoute } from "next";

// Phase 9 (SEO) — Force dynamic so the sitemap URL reflects the
// runtime `SITE_URL` env (the file would otherwise be pre-rendered at
// build time when the var isn't available).
export const dynamic = "force-dynamic";

/**
 * Phase 9 (SEO) — robots.txt generator.
 *
 * We open up the storefront (`/`, `/products`, `/about`) but explicitly
 * block account/checkout/admin/auth pages because (a) they require login
 * so crawlers can't index them anyway and (b) they're not useful
 * landing pages.
 */
export default function robots(): MetadataRoute.Robots {
  // Read at runtime — `NEXT_PUBLIC_*` would be inlined at build time and
  // require a rebuild to change. `SITE_URL` lets us configure the
  // canonical origin via plain compose env.
  const baseUrl =
    process.env.SITE_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:3000";

  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/products", "/about"],
        disallow: [
          "/account",
          "/account/",
          "/admin",
          "/admin/",
          "/auth",
          "/auth/",
          "/cart",
          "/checkout",
          "/checkout/",
        ],
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
