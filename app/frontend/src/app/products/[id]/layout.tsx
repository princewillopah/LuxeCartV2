import type { Metadata } from "next";
import type { Product } from "@/lib/types";

/**
 * Phase 9 (SEO) — Per-product server-side metadata. Uses the existing
 * REST API (no DB coupling) so this layout works with whatever the
 * page client sees. Fetched at request time, cached for 5 min via
 * `next.revalidate` so repeated crawler hits don't hammer the gateway.
 *
 * The page itself stays a client component (interactive gallery,
 * add-to-cart, reviews form). This sibling layout just feeds the
 * `<head>` so social sharing + Google search work properly.
 */

const SSR_API_URL =
  process.env.INTERNAL_API_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:3000";

async function fetchProduct(id: string): Promise<Product | null> {
  try {
    const res = await fetch(`${SSR_API_URL}/api/products/public/${id}`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    return (await res.json()) as Product;
  } catch {
    return null;
  }
}

/**
 * Per-product metadata. Falls back to a generic title when the fetch
 * fails so the page is never headless — the page-level error boundary
 * handles the user-facing "not found" experience.
 *
 * Next 15 routing API: `params` is a Promise that must be awaited.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const product = await fetchProduct(id);

  if (!product) {
    return {
      title: "Product",
      description: "View product details on LuxeCart.",
    };
  }

  // Trim description so OG previews don't get truncated by Twitter / FB.
  const description = (product.description || "Premium product on LuxeCart.")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

  const firstImage = product.images?.[0];

  return {
    title: product.name,
    description,
    openGraph: {
      type: "website",
      title: `${product.name} · LuxeCart`,
      description,
      ...(firstImage ? { images: [{ url: firstImage, alt: product.name }] } : {}),
    },
    twitter: {
      card: firstImage ? "summary_large_image" : "summary",
      title: `${product.name} · LuxeCart`,
      description,
      ...(firstImage ? { images: [firstImage] } : {}),
    },
  };
}

export default function ProductDetailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
