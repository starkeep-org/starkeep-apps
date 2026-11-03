import { useEffect } from "react";
import { SignInForm } from "./lib/SignInForm";
import { BASE_PATH, withBasePath } from "./lib/base-path";
import { FORCE_REMOTE } from "./lib/data-source-context";

/**
 * Photos' sign-in page, mounted by `src/main.tsx` for the `/sign-in` client
 * route. The app owns the route, the markup and the copy; the platform owns
 * the sign-in itself, on the managed login page. This is one of the handful of
 * paths the manifest declares public, so it is reachable by someone who has no
 * session yet — which is the only reason it exists.
 *
 * The sign-in returns to the app root, not to this page: landing back here
 * would show the button again to a person who has just signed in.
 */
export function SignInPage() {
  useRestoredSession();
  return (
    <div style={fullScreenStyle}>
      <div style={cardStyle}>
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 20 }}>Sign in to Photos</div>
        <SignInForm returnPath={RETURN_PATH} />
      </div>
    </div>
  );
}

const APP_HOME = BASE_PATH || "/";
/** The app root, with the trailing slash the platform's return check expects. */
const RETURN_PATH = `${BASE_PATH}/`;

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
 * The button renders at once, with no spinner and no status line: a person with
 * no session at all is the other case, and making them wait on a network round
 * trip to see it would trade their whole first visit for this one's. A line
 * saying the check is running told nobody anything. A signed-out visitor saw it
 * flash, and a signed-in one left before reading it.
 *
 * Only the cloud build does any of this. A local build has no user pool, so
 * the route can only answer 503, and there is no gateway sending anyone here
 * with an expired token in the first place.
 */
function useRestoredSession(): void {
  useEffect(() => {
    if (!FORCE_REMOTE) return;
    if (bouncedRecently()) return;
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
        // button and let a real sign-in report the truth.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
}

// One bounce, not a loop. If the app root sends the browser straight back here
// after a refresh reported success, refreshing again would produce the same
// success and the same bounce forever. The second visit shows the button.
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
