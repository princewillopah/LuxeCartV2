import Link from "next/link";
import { ArrowRight, ShieldCheck, Truck, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ApiStatus } from "@/components/api-status";
import {
  FeaturedProductsSection,
  CategoriesSection,
} from "@/components/home-sections";

const FEATURES = [
  {
    icon: Truck,
    title: "Free shipping",
    desc: "On every order over ₦50,000, nationwide.",
  },
  {
    icon: ShieldCheck,
    title: "Secure checkout",
    desc: "PCI-compliant payments, end to end.",
  },
  {
    icon: RefreshCw,
    title: "30-day returns",
    desc: "No questions, no fuss, no fees.",
  },
];

export default function HomePage() {
  return (
    <>
      {/* HERO */}
      <section className="relative overflow-hidden bg-hero-gradient">
        <div className="absolute inset-0 bg-grid opacity-30 [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" />
        <div className="container relative grid gap-12 py-20 md:grid-cols-2 md:py-28 lg:py-32">
          <div className="flex flex-col justify-center">
            <ApiStatus />
            <h1 className="mt-6 font-display text-5xl font-bold leading-[1.05] tracking-tight md:text-6xl lg:text-7xl">
              Shop the{" "}
              <span className="bg-gradient-to-r from-brand-600 to-brand-900 bg-clip-text text-transparent dark:from-brand-400 dark:to-brand-200">
                premium
              </span>{" "}
              you deserve.
            </h1>
            <p className="mt-6 max-w-lg text-lg text-muted-foreground">
              Thousands of curated products, blazing-fast delivery, and a
              checkout that just works. Welcome to the new LuxeCart.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button size="lg" asChild>
                <Link href="/products">
                  Shop now <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <Link href="/about">Learn more</Link>
              </Button>
            </div>
            <dl className="mt-10 grid max-w-md grid-cols-3 gap-6 border-t border-border/60 pt-8">
              {[
                { k: "10k+", v: "Products" },
                { k: "50k+", v: "Happy customers" },
                { k: "4.9★", v: "Avg. rating" },
              ].map((s) => (
                <div key={s.v}>
                  <dt className="text-2xl font-bold text-foreground">{s.k}</dt>
                  <dd className="text-xs text-muted-foreground">{s.v}</dd>
                </div>
              ))}
            </dl>
          </div>

          {/* Hero visual */}
          <div className="relative flex items-center justify-center">
            <div className="relative h-[420px] w-full max-w-md">
              <div className="absolute inset-0 rounded-3xl bg-gradient-to-br from-brand-500 via-brand-700 to-brand-950 shadow-glow" />
              <div className="absolute inset-0 rounded-3xl bg-grid opacity-20" />
              <div className="absolute left-6 top-6 grid h-12 w-12 place-items-center rounded-2xl bg-white/10 backdrop-blur">
                <Sparkles className="h-6 w-6 text-white" />
              </div>
              <div className="absolute bottom-6 left-6 right-6 rounded-2xl bg-white/10 p-5 backdrop-blur">
                <p className="text-xs font-semibold uppercase tracking-wider text-brand-100">
                  Featured drop
                </p>
                <p className="mt-1 text-lg font-bold text-white">
                  Summer ’26 Collection
                </p>
                <p className="mt-1 text-sm text-brand-100/80">
                  Now live · up to 30% off
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* FEATURES */}
      <section className="container py-16">
        <div className="grid gap-4 md:grid-cols-3">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="flex items-start gap-4 rounded-2xl border border-border bg-card p-6 shadow-soft transition hover:border-primary/40 hover:shadow-glow"
            >
              <div className="grid h-11 w-11 place-items-center rounded-xl bg-secondary text-primary">
                <f.icon className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-semibold">{f.title}</h3>
                <p className="text-sm text-muted-foreground">{f.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* FEATURED PRODUCTS (live data) */}
      <FeaturedProductsSection />

      {/* CATEGORIES (live counts) */}
      <CategoriesSection />
    </>
  );
}
