"use client";

import { useEffect, useState } from "react";
import { SignInForm } from "../../src/lib/SignInForm";
import { BASE_PATH, withBasePath } from "../../src/lib/base-path";
import { FORCE_REMOTE } from "../../src/lib/data-source-context";

/**
 * Photos' sign-in page. The app owns the route, the markup and the copy; the
 * platform owns everything the form talks to. This is one of the handful of
 * paths the manifest declares public, so it is reachable by someone who has no
 * session yet — which is the only reason it exists.
 *
 * `onSignedIn` is not optional here in practice. Without it the form falls back
 * to `window.location.reload()`, which was right when it rendered *inside* the
 * app shell — reloading re-rendered the app, now authenticated. On a page of its
 * own, reloading re-renders the sign-in page, so a person signs in successfully,
 * gets both cookies, and lands back on the form with nothing to say why. Sending
 * them to the app root is the whole difference between a working sign-in and one
 * that silently loops.
 */
export default function SignInPage() {
  const restoring = useRestoredSession();
  return (
    <div style={fullScreenStyle}>
      <div style={cardStyle}>
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 20 }}>Sign in to Photos</div>
        {restoring && (
          <div style={{ fontSize: 12, color: "#888", marginBottom: 16 }}>
            Checking for an existing session…
          </div>
        )}
        <SignInForm onSignedIn={() => window.location.assign(APP_HOME)} />
      </div>
    </div>
  );
}

const APP_HOME = BASE_PATH || "/";

/**
 * A browser holding a live session but no live token lands here without ever
 * being signed out. `sk_session` carries the Cognito refresh token and lasts
 * weeks; `sk_token` carries a minted ID token and lasts about an hour, and the
 * gateway authorizer — and the CloudFront redirect in front of it — read the
 * short-lived one. About an hour after the last page load, every signed-in
 * person is sent here with a perfectly good session in a cookie nobody
 * consulted.
 *
 * `/api/session/refresh` mints a fresh `sk_token` from that cookie, and the
 * platform leaves the route public at the gateway precisely so it can be
 * reached from a page like this one. Asking for a password instead would be
 * asking for something the browser already has.
 *
 * The form renders underneath while this runs rather than behind a spinner: a
 * person with no session at all is the other case, and making them wait on a
 * network round trip to see the fields would trade their whole first visit for
 * this one's.
 *
 * Only the cloud build does any of this. A local build has no user pool, so
 * the route can only answer 503, and there is no gateway sending anyone here
 * with an expired token in the first place.
 */
function useRestoredSession(): boolean {
  const [restoring, setRestoring] = useState(FORCE_REMOTE);

  useEffect(() => {
    if (!FORCE_REMOTE) return;
    if (bouncedRecently()) {
      setRestoring(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(withBasePath("/api/session/refresh"), {
          method: "POST",
          credentials: "same-origin",
        });
        const body = (await res.json().catch(() => ({}))) as { signedIn?: boolean };
        if (cancelled) return;
        if (res.ok && body.signedIn) {
          markBounce();
          window.location.replace(APP_HOME);
          return;
        }
      } catch {
        // A refresh that cannot complete is not evidence of anything. Show the
        // form and let a real sign-in report the truth.
      }
      if (!cancelled) setRestoring(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return restoring;
}

// One bounce, not a loop. If the app root sends the browser straight back here
// after a refresh reported success, refreshing again would produce the same
// success and the same bounce forever. The second visit shows the form.
const BOUNCE_KEY = "starkeep:signInBounce";
const BOUNCE_WINDOW_MS = 15_000;

function markBounce(): void {
  try {
    sessionStorage.setItem(BOUNCE_KEY, String(Date.now()));
  } catch {
    // Storage can be unavailable (private mode, blocked site data). Losing the
    // guard costs a loop only in a case that is already failing.
  }
}

function bouncedRecently(): boolean {
  try {
    const at = Number(sessionStorage.getItem(BOUNCE_KEY));
    return Number.isFinite(at) && at > 0 && Date.now() - at < BOUNCE_WINDOW_MS;
  } catch {
    return false;
  }
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

const cardStyle: React.CSSProperties = {
  background: "#1c1c1c",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
  padding: 24,
  width: 400,
  maxWidth: "calc(100vw - 40px)",
  color: "#e0e0e0",
};
