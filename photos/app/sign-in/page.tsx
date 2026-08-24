"use client";

import { SignInForm } from "../../src/lib/SignInForm";
import { BASE_PATH } from "../../src/lib/base-path";

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
  return (
    <div style={fullScreenStyle}>
      <div style={cardStyle}>
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 20 }}>Sign in to Photos</div>
        <SignInForm onSignedIn={() => window.location.assign(BASE_PATH || "/")} />
      </div>
    </div>
  );
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
