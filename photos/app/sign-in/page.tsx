"use client";

import { SignInForm } from "../../src/lib/SignInForm";

/**
 * Photos' sign-in page. The app owns the route, the markup and the copy; the
 * platform owns everything the form talks to. This is one of the handful of
 * paths the manifest declares public, so it is reachable by someone who has no
 * session yet — which is the only reason it exists.
 */
export default function SignInPage() {
  return (
    <div style={fullScreenStyle}>
      <div style={cardStyle}>
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 20 }}>Sign in to Photos</div>
        <SignInForm />
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
