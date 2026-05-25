import { useState, useEffect } from "react";
import { initiateAuth, respondNewPasswordChallenge } from "./cognito-auth";
import { storeRefreshToken } from "./cloud-config";
import { fetchRuntimeConfig } from "./runtime-config";
import type { CognitoConfig } from "./cognito-auth";

interface SignInFormProps {
  onBack?: () => void;
  onSignedIn?: () => void;
}

export function SignInForm({ onBack, onSignedIn }: SignInFormProps) {
  const [cognitoConfig, setCognitoConfig] = useState<CognitoConfig | null>(null);
  const [runtimeConfigError, setRuntimeConfigError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [session, setSession] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);

  useEffect(() => {
    fetchRuntimeConfig().then((rc) => {
      if (!rc?.userPoolId || !rc.userPoolClientId) {
        setRuntimeConfigError("Cloud config not found in starkeep-runtime-config.json");
        return;
      }
      setCognitoConfig({
        region: rc.region ?? "us-east-1",
        userPoolId: rc.userPoolId,
        userPoolClientId: rc.userPoolClientId,
        identityPoolId: rc.identityPoolId ?? "",
      });
    });
  }, []);

  const finishSignIn = async (idToken: string, refreshToken: string) => {
    await storeRefreshToken(refreshToken);
    const rc = await fetchRuntimeConfig();
    if (rc?.localDataServerUrl) {
      fetch(`${rc.localDataServerUrl}/auth/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken, refreshToken }),
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
    if (!cognitoConfig || !email || !password) return;
    setSigningIn(true);
    setSignInError(null);
    try {
      const result = await initiateAuth(cognitoConfig, email, password);
      if (result.tokens) {
        await finishSignIn(result.tokens.idToken, result.tokens.refreshToken);
      } else if (result.challengeName === "NEW_PASSWORD_REQUIRED") {
        setSession(result.session ?? null);
      } else {
        setSignInError(`Unexpected challenge: ${result.challengeName}`);
      }
    } catch (err) {
      setSignInError(err instanceof Error ? err.message : String(err));
    } finally {
      setSigningIn(false);
    }
  };

  const handleNewPassword = async () => {
    if (!cognitoConfig || !session) return;
    setSigningIn(true);
    setSignInError(null);
    try {
      const tokens = await respondNewPasswordChallenge(cognitoConfig, session, email, newPassword);
      await finishSignIn(tokens.idToken, tokens.refreshToken);
    } catch (err) {
      setSignInError(err instanceof Error ? err.message : String(err));
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <>
      {!cognitoConfig && (
        <div style={{ fontSize: 13, color: "#f88", marginBottom: 12 }}>
          {runtimeConfigError ?? "Loading cloud config…"}
        </div>
      )}

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
            {onBack && cognitoConfig && (
              <button onClick={onBack} style={btnStyle}>Back</button>
            )}
            <button
              onClick={() => void handleSignIn()}
              disabled={signingIn || !email || !password || !cognitoConfig}
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
