import { useState, useEffect } from "react";
import { readCloudConfig } from "./cloud-config";
import { fetchRuntimeConfig } from "./runtime-config";
import { SignInForm } from "./SignInForm";

export function CloudSetupModal({ onClose }: { onClose: () => void }) {
  const [hasCognitoConfig, setHasCognitoConfig] = useState(false);
  const [runtimeConfigError, setRuntimeConfigError] = useState<string | null>(null);
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [apiUrl, setApiUrl] = useState<string | null>(null);
  const [showSignIn, setShowSignIn] = useState(false);

  useEffect(() => {
    fetchRuntimeConfig().then((rc) => {
      if (!rc?.userPoolId || !rc.userPoolClientId) {
        setRuntimeConfigError("Cloud config not found in starkeep-runtime-config.json");
        return;
      }
      setHasCognitoConfig(true);
      setApiUrl(rc.apiGatewayUrl ?? null);
    });
    readCloudConfig().then((c) => {
      setIsSignedIn(!!c?.cognitoRefreshToken);
      if (!c) setShowSignIn(true);
    });
  }, []);

  const handleDisconnect = () => {
    localStorage.removeItem("starkeep:cloud-tokens");
    localStorage.removeItem("starkeep:cloud-config"); // legacy key
    localStorage.removeItem("starkeep:cloud-credentials");
    localStorage.setItem("starkeep:dataSource", "local");
    window.location.reload();
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: "#1c1c1c",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 8,
          padding: 24,
          width: 400,
          maxWidth: "calc(100vw - 40px)",
          color: "#e0e0e0",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <span style={{ fontWeight: 700, fontSize: 16 }}>Cloud Setup</span>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", color: "#888", fontSize: 20, cursor: "pointer", lineHeight: 1 }}
          >
            ×
          </button>
        </div>

        {!showSignIn && (
          <>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: "#888", marginBottom: 4 }}>Status</div>
              {isSignedIn ? (
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ color: "#6c6", fontSize: 12 }}>●</span>
                  <span style={{ fontSize: 13, color: "#bbb", wordBreak: "break-all" }}>
                    {apiUrl ?? "Connected"}
                  </span>
                </div>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ color: "#c66", fontSize: 12 }}>●</span>
                  <span style={{ fontSize: 13, color: "#bbb" }}>
                    {hasCognitoConfig ? "Config loaded, not signed in" : "Not configured"}
                  </span>
                </div>
              )}
            </div>

            {runtimeConfigError && (
              <div style={{ fontSize: 12, color: "#f88", marginBottom: 12 }}>
                {runtimeConfigError}
              </div>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => { setShowSignIn(true); }}
                style={btnStyle}
              >
                {isSignedIn ? "Sign in again" : "Sign in"}
              </button>
              {isSignedIn && (
                <button onClick={handleDisconnect} style={{ ...btnStyle, color: "#f88", borderColor: "rgba(255,100,100,0.3)" }}>
                  Disconnect
                </button>
              )}
            </div>
          </>
        )}

        {showSignIn && (
          <SignInForm onBack={() => setShowSignIn(false)} />
        )}
      </div>
    </div>
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
