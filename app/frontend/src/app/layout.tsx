import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { Providers } from "@/components/providers";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

// Phase 9 (SEO) — `metadataBase` lets Next resolve relative OG/icon
// URLs against the canonical site origin. Read at runtime from a
// plain (non-NEXT_PUBLIC_) env so we don't have to rebuild the Docker
// image just to change the origin. Falls back to the public API URL
// (NEXT_PUBLIC_API_URL IS inlined at build time so it's always safe).
const SITE_URL =
  process.env.SITE_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "LuxeCart — Premium E-Commerce",
    template: "%s · LuxeCart",
  },
  description:
    "Premium products, thoughtfully curated. Built on a modern microservices platform.",
  applicationName: "LuxeCart",
  keywords: ["ecommerce", "shopping", "premium", "online store", "luxecart"],
  authors: [{ name: "LuxeCart" }],
  // Default: index everything not explicitly disallowed in robots.ts.
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    siteName: "LuxeCart",
    title: "LuxeCart — Premium E-Commerce",
    description:
      "Premium products, thoughtfully curated. Built on a modern microservices platform.",
    url: SITE_URL,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "LuxeCart — Premium E-Commerce",
    description:
      "Premium products, thoughtfully curated. Built on a modern microservices platform.",
  },
  icons: {
    icon: "/favicon.ico",
  },
};

// Phase 9 (a11y/SEO) — `viewport` and `themeColor` moved out of `metadata`
// per the Next 14 convention. `themeColor` is read by mobile browsers
// to tint the address bar; we match the brand on both themes.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning className={inter.variable}>
      <body className="min-h-dvh font-sans">
        <Providers>
          {/*
            Phase 9 (a11y) — Skip-to-content link. Visually hidden until
            keyboard-focused, then it jumps into view as the first
            interactive element. Lets keyboard users bypass the header
            nav entirely. Targets `#main-content` on the <main> below.
          */}
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring/40"
          >
            Skip to content
          </a>
          <div className="flex min-h-dvh flex-col">
            <SiteHeader />
            <main id="main-content" tabIndex={-1} className="flex-1 outline-none">
              {children}
            </main>
            <SiteFooter />
          </div>
        </Providers>
      </body>
    </html>
  );
}
