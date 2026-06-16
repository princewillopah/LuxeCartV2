"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, Loader2, MailWarning } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default function VerifyEmailPage() {
  return (
    <React.Suspense fallback={<div className="container py-16" />}>
      <VerifyInner />
    </React.Suspense>
  );
}

type Status = "loading" | "success" | "error";

function VerifyInner() {
  const sp = useSearchParams();
  const token = sp.get("token") ?? "";
  const [status, setStatus] = React.useState<Status>("loading");
  const [message, setMessage] = React.useState<string>("");

  // The link from the email already has the token; we POST it once on mount.
  // We deliberately avoid GET-based verification because crawlers/preview bots
  // would consume the single-use token before the user clicked.
  React.useEffect(() => {
    let cancelled = false;
    if (!token) {
      setStatus("error");
      setMessage("This link is missing its verification token.");
      return;
    }
    (async () => {
      try {
        await api.verifyEmail(token);
        if (cancelled) return;
        setStatus("success");
        setMessage("Your email is verified. You can now sign in.");
      } catch (err) {
        if (cancelled) return;
        const msg =
          err instanceof ApiError ? err.message : "Could not verify your email.";
        setStatus("error");
        setMessage(msg);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="container flex min-h-[calc(100dvh-4rem)] items-center justify-center py-12">
      <Card className="w-full max-w-md p-8 text-center">
        {status === "loading" && (
          <>
            <Loader2 className="mx-auto h-10 w-10 animate-spin text-primary" />
            <h1 className="mt-4 font-display text-2xl font-bold">
              Verifying your email…
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Just a moment.
            </p>
          </>
        )}

        {status === "success" && (
          <>
            <CheckCircle2 className="mx-auto h-10 w-10 text-green-600" />
            <h1 className="mt-4 font-display text-2xl font-bold">
              Email verified
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">{message}</p>
            <Button asChild className="mt-6 w-full">
              <Link href="/auth/login">Sign in</Link>
            </Button>
          </>
        )}

        {status === "error" && (
          <>
            <MailWarning className="mx-auto h-10 w-10 text-destructive" />
            <h1 className="mt-4 font-display text-2xl font-bold">
              Verification failed
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">{message}</p>
            <div className="mt-6 space-y-2">
              <Button asChild variant="outline" className="w-full">
                <Link href="/auth/resend-verification">Resend verification email</Link>
              </Button>
              <Button asChild variant="ghost" className="w-full">
                <Link href="/auth/login">Back to sign in</Link>
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
