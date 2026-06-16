import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="container flex min-h-[60dvh] flex-col items-center justify-center gap-4 text-center">
      <p className="text-6xl font-display font-bold text-primary">404</p>
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="max-w-md text-muted-foreground">
        We can&apos;t find what you&apos;re looking for. Let&apos;s get you back home.
      </p>
      <Button asChild>
        <Link href="/">Take me home</Link>
      </Button>
    </div>
  );
}
