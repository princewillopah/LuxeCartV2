import type { MetadataRoute } from "next";
import type { Product } from "@/lib/types";

// Phase 9 (SEO) — Force the sitemap to be generated per-request so it
// can (1) reflect newly-added products and (2) pick up the runtime
// `SITE_URL` env var. Without this, Next 15 statically pre-renders
// sitemap.xml at build time using whatever env was available then.
export const dynamic = "force-dynamic";
export const revalidate = 600; // re-fetch products at most every 10 min

/**
 * Phase 9 (SEO) — sitemap.xml generator.
 *
 * Includes the static marketing pages plus one entry per product so
 * search engines can discover the full catalog. Falls back gracefully
 * if the product-service is unreachable during build/SSR — we still
 * emit the static pages so the sitemap is never empty.
 *
 * `INTERNAL_API_URL` (docker DNS, e.g. http://api-gateway:3000) is
 * preferred for the server-side fetch since the container can hit the
 * gateway without leaving the docker network. Falls back to the public
 * URL which also works (the gateway is reachable both ways).
 */
const SSR_API_URL =
  process.env.INTERNAL_API_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:3000";

const SITE_URL =
  process.env.SITE_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:3000";

async function fetchProductsForSitemap(): Promise<Product[]> {
  try {
    const res = await fetch(`${SSR_API_URL}/api/products/public`, {
      // Re-generate at most every 10 minutes — fresh enough for SEO,
      // cheap enough not to hammer the gateway on each crawl.
      next: { revalidate: 600 },
    });
    if (!res.ok) return [];
    const data: unknown = await res.json();
    if (Array.isArray(data)) return data as Product[];
    // Paginated shape { items, total, ... }
    if (data && typeof data === "object" && Array.isArray((data as { items?: unknown }).items)) {
      return (data as { items: Product[] }).items;
    }
    return [];
  } catch {
    return [];
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const staticRoutes: MetadataRoute.Sitemap = [
    {
      url: `${SITE_URL}/`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 1,
    },
    {
      url: `${SITE_URL}/products`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.9,
    },
    {
      url: `${SITE_URL}/about`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.4,
    },
  ];

  const products = await fetchProductsForSitemap();
  const productRoutes: MetadataRoute.Sitemap = products.map((p) => ({
    url: `${SITE_URL}/products/${p.id}`,
    lastModified: p.createdAt ? new Date(p.createdAt) : now,
    changeFrequency: "weekly",
    priority: 0.7,
  }));

  return [...staticRoutes, ...productRoutes];
}
