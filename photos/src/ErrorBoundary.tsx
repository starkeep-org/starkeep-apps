import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * The last-resort screen, replacing `app/global-error.tsx`.
 *
 * The framework's version was a whole document — its own `<html>` and `<body>`
 * — because the framework rendered the shell per request and an error could
 * take the shell with it. Here the shell is a file on disk that has already
 * been served by the time React runs, so what is left to replace is the mounted
 * tree, which is what an error boundary replaces.
 *
 * "Try again" re-renders the children rather than reloading. A reload would
 * refetch a document the browser already has and would discard whatever the
 * page had loaded; clearing the error is enough for the transient failures this
 * catches, and a failure that is not transient throws again immediately.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console is the only place this can go. There is no server render to
    // report to, and Photos ships no telemetry.
    console.error("[photos] unhandled render error:", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div style={fullScreenStyle}>
        <div style={{ textAlign: "center" }}>
          <h2 style={{ marginBottom: 16 }}>Something went wrong</h2>
          <button onClick={() => this.setState({ error: null })} style={buttonStyle}>
            Try again
          </button>
        </div>
      </div>
    );
  }
}

const fullScreenStyle: React.CSSProperties = {
  margin: 0,
  background: "#111",
  color: "#fff",
  fontFamily: "sans-serif",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: "100vh",
};

const buttonStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.15)",
  border: "1px solid rgba(255,255,255,0.2)",
  color: "#fff",
  borderRadius: 4,
  padding: "8px 20px",
  cursor: "pointer",
  fontSize: 14,
};
