import Link from "next/link";
import { Sparkles } from "lucide-react";

const COLS = [
  {
    title: "Shop",
    links: [
      { href: "/products", label: "All Products" },
      { href: "/products?sort=new", label: "New Arrivals" },
      { href: "/products?sort=trending", label: "Trending" },
      { href: "/products?sort=sale", label: "Sale" },
    ],
  },
  {
    title: "Support",
    links: [
      { href: "/help", label: "Help Center" },
      { href: "/shipping", label: "Shipping" },
      { href: "/returns", label: "Returns" },
      { href: "/contact", label: "Contact" },
    ],
  },
  {
    title: "Company",
    links: [
      { href: "/about", label: "About" },
      { href: "/careers", label: "Careers" },
      { href: "/press", label: "Press" },
      { href: "/blog", label: "Blog" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="mt-20 border-t border-border/60 bg-muted/30">
      <div className="container grid gap-10 py-14 md:grid-cols-5">
        <div className="md:col-span-2">
          <Link href="/" className="flex items-center gap-2 font-display text-xl font-bold">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary text-primary-foreground shadow-glow">
              <Sparkles className="h-5 w-5" />
            </span>
            Luxe<span className="text-primary">Cart</span>
          </Link>
          <p className="mt-4 max-w-sm text-sm text-muted-foreground">
            Premium products, thoughtfully curated. Built on a modern microservices
            platform for speed, scale, and reliability.
          </p>
        </div>
        {COLS.map((col) => (
          <div key={col.title}>
            <h4 className="mb-4 text-sm font-semibold">{col.title}</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              {col.links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="hover:text-foreground">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-border/60">
        <div className="container flex flex-col items-center justify-between gap-2 py-6 text-xs text-muted-foreground md:flex-row">
          <p>© {new Date().getFullYear()} LuxeCart. All rights reserved.</p>
          <div className="flex gap-4">
            <Link href="/privacy" className="hover:text-foreground">Privacy</Link>
            <Link href="/terms" className="hover:text-foreground">Terms</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
