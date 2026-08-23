import { useState } from "react";
import { fetchRuntimeConfig } from "./runtime-config";
import { withBasePath } from "./base-path";

interface SignInFormProps {
  onBack?: () => void;
  onSignedIn?: () => void;
}

/**
 * The sign-in form. It posts to Photos' own server and does nothing else — no
 * Cognito client, no pool config to fetch, no token to store. What comes back
 * is a pair of HttpOnly cookies this code cannot read, which is the property
 * that makes an XSS here worth much less than it used to be.
 */
interface SessionResponse {
  signedIn?: boolean;
  challenge?: string;
  session?: string;
  error?: string;
}

async function post(action: string, body: unknown): Promise<SessionResponse> {
  const res = await fetch(withBasePath(`/api/session/${action}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  const parsed = (await res.json().catch(() => ({}))) as SessionResponse;
  if (!res.ok) throw new Error(parsed.error ?? `Sign-in failed (${res.status})`);
  return parsed;
}

export function SignInForm({ onBack, onSignedIn }: SignInFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [session, setSession] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);

  const finishSignIn = async () => {
    // Local surface only: hand the daemon the tokens it needs to sync. This is
    // a different thing from the cloud session that happens to share this
    // form — the daemon is a separate process that has to sign its own
    // outbound calls, and `startOrKickSupervisor` refuses to run without a
    // live ID token. On the cloud surface the server holds the session and
    // there is no daemon to hand anything to.
    const rc = await fetchRuntimeConfig();
    if (!rc?.apiGatewayUrl) {
      await fetch(withBasePath("/api/local-sync-handoff"), {
        method: "POST",
        credentials: "same-origin",
      }).catch(() => {});
    }
    localStorage.setItem("starkeep:dataSource", "remote");
    if (onSignedIn) {
      onSignedIn();
    } else {
      window.location.reload();
    }
  };

  const handleSignIn = async () => {
    if (!email || !password) return;
    setSigningIn(true);
    setSignInError(null);
    try {
      const result = await post("sign-in", { email, password });
      if (result.challenge === "NEW_PASSWORD_REQUIRED") {
        setSession(result.session ?? null);
      } else {
        await finishSignIn();
      }
    } catch (err) {
      setSignInError(err instanceof Error ? err.message : String(err));
    } finally {
      setSigningIn(false);
    }
  };

  const handleNewPassword = async () => {
    if (!session) return;
    setSigningIn(true);
    setSignInError(null);
    try {
      await post("new-password", { session, email, newPassword });
      await finishSignIn();
    } catch (err) {
      setSignInError(err instanceof Error ? err.message : String(err));
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <>
      {session ? (
        <>
          <div style={{ fontSize: 13, color: "#ccc", marginBottom: 16 }}>
            Set a new permanent password to continue.
          </div>
          <label style={labelStyle}>New password</label>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            style={inputStyle}
            autoFocus
          />
          {signInError && <div style={{ fontSize: 12, color: "#f88", marginBottom: 8 }}>{signInError}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setSession(null)} style={btnStyle}>Back</button>
            <button
              onClick={() => void handleNewPassword()}
              disabled={signingIn || !newPassword}
              style={{ ...btnStyle, background: "rgba(80,180,80,0.15)", borderColor: "rgba(80,180,80,0.4)" }}
            >
              {signingIn ? "Setting password…" : "Set password"}
            </button>
          </div>
        </>
      ) : (
        <>
          <label style={labelStyle}>Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={inputStyle}
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") void handleSignIn(); }}
          />
          <label style={labelStyle}>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={inputStyle}
            onKeyDown={(e) => { if (e.key === "Enter") void handleSignIn(); }}
          />
          {signInError && <div style={{ fontSize: 12, color: "#f88", marginBottom: 8 }}>{signInError}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            {onBack && (
              <button onClick={onBack} style={btnStyle}>Back</button>
            )}
            <button
              onClick={() => void handleSignIn()}
              disabled={signingIn || !email || !password}
              style={{ ...btnStyle, background: "rgba(80,140,255,0.15)", borderColor: "rgba(80,140,255,0.4)" }}
            >
              {signingIn ? "Signing in…" : "Sign in"}
            </button>
          </div>
        </>
      )}
    </>
  );
}

const btnStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.07)",
  border: "1px solid rgba(255,255,255,0.15)",
  color: "#ccc",
  borderRadius: 4,
  padding: "7px 14px",
  cursor: "pointer",
  fontSize: 13,
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  color: "#888",
  marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 4,
  color: "#e0e0e0",
  padding: "8px 10px",
  fontSize: 13,
  marginBottom: 12,
  boxSizing: "border-box",
  outline: "none",
};
