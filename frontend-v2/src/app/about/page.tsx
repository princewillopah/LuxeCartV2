import Link from "next/link";
import { ShieldCheck, Truck, Sparkles, Zap, Globe, Heart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const VALUES = [
  { icon: Sparkles, title: "Curated, not cluttered", desc: "Every product earns its place — no infinite junk drawer." },
  { icon: Zap, title: "Microservices speed", desc: "Built on 16 services and an event bus for fast, resilient pages." },
  { icon: ShieldCheck, title: "Secure by default", desc: "Encrypted in transit and at rest, with PCI-compliant payments." },
  { icon: Truck, title: "Free worldwide shipping", desc: "On every order over $50, delivered fast." },
  { icon: Globe, title: "Sustainable sourcing", desc: "We prioritize partners with transparent supply chains." },
  { icon: Heart, title: "Real human support", desc: "Talk to a person, not a bot. Always." },
];

export default function AboutPage() {
  return (
    <div>
      <section className="relative overflow-hidden bg-hero-gradient">
        <div className="absolute inset-0 bg-grid opacity-20 [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" />
        <div className="container relative py-20 text-center md:py-28">
          <h1 className="mx-auto max-w-3xl font-display text-5xl font-bold leading-[1.05] tracking-tight md:text-6xl">
            A modern storefront,{" "}
            <span className="bg-gradient-to-r from-brand-600 to-brand-900 bg-clip-text text-transparent dark:from-brand-400 dark:to-brand-200">
              engineered to delight
            </span>
            .
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
            LuxeCart is built on a modern microservices platform with real-time
            search, event-driven email, and a UI rebuilt from the ground up.
          </p>
          <div className="mt-8 flex justify-center gap-3">
            <Button asChild size="lg">
              <Link href="/products">Shop now</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/contact">Contact us</Link>
            </Button>
          </div>
        </div>
      </section>

      <section className="container py-16">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {VALUES.map((v) => (
            <Card key={v.title} className="p-6">
              <div className="mb-4 grid h-11 w-11 place-items-center rounded-xl bg-secondary text-primary">
                <v.icon className="h-5 w-5" />
              </div>
              <h3 className="font-semibold">{v.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{v.desc}</p>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
