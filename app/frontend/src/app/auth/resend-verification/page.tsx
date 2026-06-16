"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2, MailPlus } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Card } from "@/components/ui/card";

export default function ResendVerificationPage() {
  const [email, setEmail] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [sent, setSent] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await api.resendVerification(email);
      setSent(true);
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : "Could not send verification email";
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="container flex min-h-[calc(100dvh-4rem)] items-center justify-center py-12">
      <Card className="w-full max-w-md p-8">
        <div className="mb-6 flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary text-primary-foreground">
            <MailPlus className="h-5 w-5" />
          </span>
          <div>
            <h1 className="font-display text-2xl font-bold">
              Resend verification email
            </h1>
            <p className="text-sm text-muted-foreground">
              We&apos;ll send a fresh link if your account needs verifying.
            </p>
          </div>
        </div>

        {sent ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              If your email is registered and unverified, a new link is on its way.
              Check your inbox (and spam folder).
            </p>
            <Button asChild className="w-full">
              <Link href="/auth/login">Back to sign in</Link>
            </Button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </div>
            <Button type="submit" className="w-full" size="lg" disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              Send verification email
            </Button>
          </form>
        )}

        <p className="mt-6 text-center text-sm text-muted-foreground">
          Already verified?{" "}
          <Link href="/auth/login" className="font-medium text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </Card>
    </div>
  );
}
