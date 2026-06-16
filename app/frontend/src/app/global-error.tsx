"use client";

/**
 * Phase 9 — global-error renders when the ROOT layout itself throws.
 * That means none of our Providers / Tailwind classes are guaranteed to
 * apply (the document tree is essentially blank), so this file ships
 * its own minimal inline styles to stay presentable in the worst case.
 *
 * For per-route recoverable errors (cart, checkout, products…) see the
 * sibling `error.tsx` files which DO live inside the styled tree.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily:
            'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
          background: "#fafafa",
          color: "#111",
          padding: "2rem",
        }}
      >
        <div
          style={{
            maxWidth: 520,
            textAlign: "center",
            padding: "2.5rem 2rem",
            background: "#fff",
            border: "1px solid #e5e5e5",
            borderRadius: 16,
            boxShadow: "0 4px 20px rgba(0,0,0,0.04)",
          }}
        >
          <p
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "#dc2626",
              marginBottom: 8,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
            }}
          >
            Application error
          </p>
          <h1 style={{ fontSize: 28, fontWeight: 700, marginTop: 0, marginBottom: 12 }}>
            Something went wrong
          </h1>
          <p style={{ color: "#525252", marginBottom: 24, lineHeight: 1.6 }}>
            {error.message || "An unexpected error occurred. Please try again."}
          </p>
          {error.digest && (
            <p
              style={{
                fontSize: 12,
                color: "#a3a3a3",
                marginBottom: 16,
                fontFamily: "monospace",
              }}
            >
              Ref: {error.digest}
            </p>
          )}
          <div
            style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}
          >
            <button
              onClick={reset}
              style={{
                background: "#7c3aed",
                color: "#fff",
                border: "none",
                padding: "10px 20px",
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            {/*
              Plain anchor on purpose: global-error renders OUTSIDE the
              Next router tree, so a full page navigation is exactly what
              we want — it remounts the root layout from scratch and
              clears whatever broken state caused us to land here.
            */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a
              href="/"
              style={{
                background: "#f5f5f5",
                color: "#111",
                textDecoration: "none",
                padding: "10px 20px",
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              Go home
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
