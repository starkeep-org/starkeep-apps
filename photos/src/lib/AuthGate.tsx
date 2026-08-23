import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { withBasePath } from "./base-path";
import { FORCE_REMOTE } from "./data-source-context";

type GateStatus = "checking" | "not-required" | "authenticated";

/**
 * Decides what to render. Enforces nothing.
 *
 * That distinction used to be the exposure: this component was the only thing
 * standing between an anonymous caller and Photos' data, and it runs in the
 * browser, so it stood between nothing and nothing. Worse here than elsewhere,
 * because list responses embed CloudFront-signed rendition URLs inline — one
 * anonymous call handed out working links to the image bytes too. Enforcement
 * now lives at the API Gateway (the platform session authorizer), in the
 * origin middleware, and in the data proxy — three places, all server-side,
 * none of them here.
 *
 * What is left for this component is the user-visible half: in cloud mode a
 * signed-out visitor has already been redirected to /sign-in before any of
 * this runs, so the only case it still handles is a session that expired while
 * the page was open. In local mode there is nothing to check.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<GateStatus>(FORCE_REMOTE ? "checking" : "not-required");

  useEffect(() => {
    if (!FORCE_REMOTE) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(withBasePath("/api/session"), { credentials: "same-origin" });
        const body = (await res.json()) as { signedIn?: boolean };
        if (cancelled) return;
        if (!body.signedIn) {
          window.location.replace(withBasePath("/sign-in"));
          return;
        }
      } catch {
        // A probe that cannot complete is not evidence of being signed out,
        // and bouncing to sign-in on a network blip would be worse than
        // rendering and letting the next data call report the truth.
      }
      if (!cancelled) setStatus("authenticated");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === "checking") {
    return (
      <div style={fullScreenStyle}>
        <span style={{ color: "#888", fontSize: 13 }}>Loading…</span>
      </div>
    );
  }

  return <>{children}</>;
}

const fullScreenStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "#111",
  color: "#fff",
  fontFamily: "sans-serif",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 20,
};
