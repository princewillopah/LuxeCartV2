"use client";

import * as React from "react";
import Link from "next/link";
import { CheckCircle2, Loader2, MailCheck, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Card } from "@/components/ui/card";

export default function RegisterPage() {
  const [form, setForm] = React.useState({
    firstName: "",
    lastName: "",
    email: "",
    password: "",
  });
  const [loading, setLoading] = React.useState(false);
  const [submittedEmail, setSubmittedEmail] = React.useState<string | null>(null);
  const [resending, setResending] = React.useState(false);

  const passwordStrong =
    form.password.length >= 8 && /[A-Z]/.test(form.password) && /\d/.test(form.password);

  function update(k: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!passwordStrong) {
      toast.error("Password must be 8+ chars, include a number and capital letter");
      return;
    }
    setLoading(true);
    try {
      await api.register(form);
      setSubmittedEmail(form.email);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Registration failed";
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  async function onResend() {
    if (!submittedEmail) return;
    setResending(true);
    try {
      await api.resendVerification(submittedEmail);
      toast.success("Verification email re-sent");
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : "Could not resend verification email";
      toast.error(msg);
    } finally {
      setResending(false);
    }
  }

  if (submittedEmail) {
    return (
      <div className="container flex min-h-[calc(100dvh-4rem)] items-center justify-center py-12">
        <Card className="w-full max-w-md p-8">
          <div className="mb-6 flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary text-primary-foreground">
              <MailCheck className="h-5 w-5" />
            </span>
            <div>
              <h1 className="font-display text-2xl font-bold">Check your email</h1>
              <p className="text-sm text-muted-foreground">
                One last step to activate your account.
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              We sent a verification link to{" "}
              <span className="font-medium text-foreground">{submittedEmail}</span>.
              Click the link in that email to activate your account, then sign in.
              The link expires in 1 hour.
            </p>
            <p className="text-xs text-muted-foreground">
              Don&apos;t see it? Check your spam folder, or resend the email below.
            </p>

            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={onResend}
                disabled={resending}
              >
                {resending && <Loader2 className="h-4 w-4 animate-spin" />}
                Resend verification email
              </Button>
              <Button asChild className="w-full">
                <Link href="/auth/login">Back to sign in</Link>
              </Button>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="container flex min-h-[calc(100dvh-4rem)] items-center justify-center py-12">
      <Card className="w-full max-w-md p-8">
        <div className="mb-6 flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary text-primary-foreground shadow-glow">
            <Sparkles className="h-5 w-5" />
          </span>
          <div>
            <h1 className="font-display text-2xl font-bold">Create your account</h1>
            <p className="text-sm text-muted-foreground">
              Join thousands of happy shoppers
            </p>
          </div>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="firstName">First name</Label>
              <Input
                id="firstName"
                required
                value={form.firstName}
                onChange={update("firstName")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lastName">Last name</Label>
              <Input
                id="lastName"
                required
                value={form.lastName}
                onChange={update("lastName")}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={form.email}
              onChange={update("email")}
              placeholder="you@example.com"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              value={form.password}
              onChange={update("password")}
              placeholder="At least 8 characters"
            />
            {form.password && (
              <div
                className={`flex items-center gap-1 text-xs ${passwordStrong ? "text-emerald-600" : "text-amber-600"}`}
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                {passwordStrong
                  ? "Strong password"
                  : "Needs 8+ chars, a number, and a capital letter"}
              </div>
            )}
          </div>

          <Button
            type="submit"
            className="w-full"
            size="lg"
            disabled={loading}
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            Create account
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          Already a member?{" "}
          <Link href="/auth/login" className="font-medium text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </Card>
    </div>
  );
}
