"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search, ShoppingBag, User, Menu, Sparkles, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { useCart } from "@/store/cart";
import { useAuth } from "@/store/auth";

const NAV = [
  { href: "/products", label: "Shop" },
  { href: "/products?sort=new", label: "New Arrivals" },
  { href: "/products?sort=trending", label: "Trending" },
  { href: "/about", label: "About" },
];

export function SiteHeader() {
  const router = useRouter();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const count = useCart((s) => s.items.reduce((n, i) => n + i.quantity, 0));
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);

  const [q, setQ] = React.useState("");
  function onSearch(e: React.FormEvent) {
    e.preventDefault();
    if (q.trim()) router.push(`/products?q=${encodeURIComponent(q.trim())}`);
  }

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/60 bg-background/80 backdrop-blur-xl">
      <div className="container flex h-16 items-center justify-between gap-4">
        <div className="flex items-center gap-8">
          <Link
            href="/"
            className="flex items-center gap-2 font-display text-xl font-bold tracking-tight"
          >
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary text-primary-foreground shadow-glow">
              <Sparkles className="h-5 w-5" />
            </span>
            <span>
              Luxe<span className="text-primary">Cart</span>
            </span>
          </Link>
          <nav className="hidden items-center gap-6 text-sm font-medium text-muted-foreground md:flex">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className="transition-colors hover:text-foreground"
              >
                {n.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-1">
          <form onSubmit={onSearch} className="relative hidden lg:block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              type="search"
              placeholder="Search products…"
              className="h-10 w-72 rounded-md border border-input bg-background pl-9 pr-3 text-sm shadow-soft outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30"
            />
          </form>
          <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Search" asChild>
            <Link href="/products">
              <Search className="h-5 w-5" />
            </Link>
          </Button>
          <ThemeToggle />
          {mounted && user ? (
            <>
              <Button variant="ghost" size="icon" asChild aria-label="Account">
                <Link href="/account">
                  <User className="h-5 w-5" />
                </Link>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Sign out"
                onClick={() => {
                  logout();
                  router.push("/");
                }}
              >
                <LogOut className="h-5 w-5" />
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" asChild className="hidden sm:inline-flex">
              <Link href="/auth/login">Sign in</Link>
            </Button>
          )}
          <Button variant="ghost" size="icon" asChild aria-label="Cart" className="relative">
            <Link href="/cart">
              <ShoppingBag className="h-5 w-5" />
              {mounted && count > 0 && (
                <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                  {count}
                </span>
              )}
            </Link>
          </Button>
          <Button variant="ghost" size="icon" className="md:hidden" aria-label="Menu">
            <Menu className="h-5 w-5" />
          </Button>
        </div>
      </div>
    </header>
  );
}
