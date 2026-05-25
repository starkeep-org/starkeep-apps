import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { readCloudConfig } from "./cloud-config";
import { fetchRuntimeConfig } from "./runtime-config";
import { SignInForm } from "./SignInForm";
import { FORCE_REMOTE } from "./data-source-context";

type GateStatus = "checking" | "needs-signin" | "authenticated" | "not-required";

export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<GateStatus>("checking");

  useEffect(() => {
    (async () => {
      const rc = await fetchRuntimeConfig();
      const gateRequired = FORCE_REMOTE || !rc?.localDataServerUrl;
      if (!gateRequired) {
        setStatus("not-required");
        return;
      }
      const config = await readCloudConfig();
      setStatus(config?.cognitoRefreshToken ? "authenticated" : "needs-signin");
    })();
  }, []);

  if (status === "checking") {
    return (
      <div style={fullScreenStyle}>
        <span style={{ color: "#888", fontSize: 13 }}>Loading…</span>
      </div>
    );
  }

  if (status === "needs-signin") {
    return (
      <div style={fullScreenStyle}>
        <div style={cardStyle}>
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 20 }}>Sign in to Photos</div>
          <SignInForm />
        </div>
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

const cardStyle: React.CSSProperties = {
  background: "#1c1c1c",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
  padding: 24,
  width: 400,
  maxWidth: "calc(100vw - 40px)",
  color: "#e0e0e0",
};
