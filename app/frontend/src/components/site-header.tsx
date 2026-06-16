"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Search,
  ShoppingBag,
  User,
  Menu,
  Sparkles,
  LogOut,
  Shield,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { useCart } from "@/store/cart";
import { useAuth } from "@/store/auth";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/products", label: "Shop" },
  { href: "/products?sort=new", label: "New Arrivals" },
  { href: "/products?sort=trending", label: "Trending" },
  { href: "/about", label: "About" },
];

/**
 * Phase 9 (a11y) — Compare a NAV entry's href (which may include a
 * querystring like `?sort=new`) against the live pathname + the
 * relevant query param. We only mark a link "current" when both the
 * path AND the discriminating param match — that way `/products` and
 * `/products?sort=new` don't both light up at the same time.
 */
function isNavActive(href: string, pathname: string, params: URLSearchParams | null): boolean {
  const [path, query] = href.split("?");
  if (pathname !== path) return false;
  if (!query) {
    // No querystring on the nav entry → consider it active only when
    // there's no `sort` param either (so /products?sort=new doesn't
    // bleed into the bare "Shop" link).
    return !params?.get("sort");
  }
  const navParams = new URLSearchParams(query);
  for (const [k, v] of navParams.entries()) {
    if (params?.get(k) !== v) return false;
  }
  return true;
}

export function SiteHeader() {
  const router = useRouter();
  const pathname = usePathname();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  // Phase 9 (a11y) — Mobile menu drawer. Was previously a non-functional
  // button; now opens a slide-out with the same NAV + sign-in/admin
  // shortcuts. Closes on link click, escape key, and backdrop click.
  const [menuOpen, setMenuOpen] = React.useState(false);
  React.useEffect(() => {
    if (!menuOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);
  // Close the menu automatically when the route changes (e.g. user
  // taps a nav link and the page navigates).
  React.useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  // `usePathname()` doesn't include the querystring, but our NAV entries
  // do (e.g. `/products?sort=new`). Read the search params live so
  // aria-current stays accurate when the user changes filters.
  // We pull from `window.location` because `useSearchParams()` would
  // wrap us in a Suspense boundary unnecessarily.
  const [searchParams, setSearchParams] = React.useState<URLSearchParams | null>(null);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    setSearchParams(new URLSearchParams(window.location.search));
  }, [pathname]);

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
            aria-label="LuxeCart home"
          >
            <span aria-hidden="true" className="grid h-9 w-9 place-items-center rounded-lg bg-primary text-primary-foreground shadow-glow">
              <Sparkles className="h-5 w-5" />
            </span>
            <span>
              Luxe<span className="text-primary">Cart</span>
            </span>
          </Link>
          <nav aria-label="Primary" className="hidden items-center gap-6 text-sm font-medium text-muted-foreground md:flex">
            {NAV.map((n) => {
              const active = isNavActive(n.href, pathname, searchParams);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "transition-colors hover:text-foreground",
                    active && "text-foreground font-semibold"
                  )}
                >
                  {n.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex items-center gap-1">
          <form onSubmit={onSearch} role="search" className="relative hidden lg:block">
            <label htmlFor="header-search" className="sr-only">
              Search products
            </label>
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              id="header-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              type="search"
              placeholder="Search products…"
              className="h-10 w-72 rounded-md border border-input bg-background pl-9 pr-3 text-sm shadow-soft outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30"
            />
          </form>
          <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Search" title="Search" asChild>
            <Link href="/products">
              <Search className="h-5 w-5" />
            </Link>
          </Button>
          <ThemeToggle />
          {mounted && user ? (
            <>
              {user.role === "admin" && (
                <Button
                  variant="ghost"
                  size="sm"
                  asChild
                  title="Admin dashboard"
                  className="hidden sm:inline-flex"
                >
                  <Link href="/admin">
                    <Shield className="h-4 w-4" /> Admin
                  </Link>
                </Button>
              )}
              <Button variant="ghost" size="icon" asChild aria-label="Account" title="Account">
                <Link href="/account">
                  <User className="h-5 w-5" />
                </Link>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Sign out"
                title="Sign out"
                onClick={() => {
                  logout();
                  router.push("/");
                }}
              >
                <LogOut className="h-5 w-5" />
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" asChild title="Sign in" className="hidden sm:inline-flex">
              <Link href="/auth/login">Sign in</Link>
            </Button>
          )}
          <Button variant="ghost" size="icon" asChild aria-label={mounted && count > 0 ? `Cart, ${count} item${count === 1 ? "" : "s"}` : "Cart"} title="Cart" className="relative">
            <Link href="/cart">
              <ShoppingBag className="h-5 w-5" />
              {mounted && count > 0 && (
                <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                  {count}
                </span>
              )}
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            onClick={() => setMenuOpen((o) => !o)}
          >
            {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
        </div>
      </div>

      {/*
        Mobile drawer. Hidden by default, slides in from the right on
        small screens when the menu button is tapped. Backdrop closes
        on click. Drawer itself has role="dialog" + aria-modal so AT
        users understand it's a transient overlay.
      */}
      {menuOpen && (
        <div className="md:hidden">
          <div
            aria-hidden="true"
            className="fixed inset-0 top-16 z-40 bg-black/40 backdrop-blur-sm"
            onClick={() => setMenuOpen(false)}
          />
          <div
            id="mobile-menu"
            role="dialog"
            aria-modal="true"
            aria-label="Site menu"
            className="fixed inset-x-0 top-16 z-50 max-h-[calc(100dvh-4rem)] overflow-y-auto border-b border-border bg-background shadow-lg animate-in slide-in-from-top-2"
          >
            <nav aria-label="Mobile primary" className="container flex flex-col gap-1 py-4">
              {NAV.map((n) => {
                const active = isNavActive(n.href, pathname, searchParams);
                return (
                  <Link
                    key={n.href}
                    href={n.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "rounded-md px-3 py-2.5 text-base font-medium transition-colors",
                      active
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                    )}
                  >
                    {n.label}
                  </Link>
                );
              })}
              {mounted && !user && (
                <Link
                  href="/auth/login"
                  className="rounded-md px-3 py-2.5 text-base font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  Sign in
                </Link>
              )}
              {mounted && user?.role === "admin" && (
                <Link
                  href="/admin"
                  className="flex items-center gap-2 rounded-md px-3 py-2.5 text-base font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  <Shield className="h-4 w-4" /> Admin
                </Link>
              )}
            </nav>
          </div>
        </div>
      )}
    </header>
  );
}
