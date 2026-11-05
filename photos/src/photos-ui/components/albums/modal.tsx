import React, { useEffect } from "react";

/**
 * The dark dialog shell the album and public-link dialogs share: a backdrop
 * that closes on click and on Escape, and a panel that does not.
 */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 300,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        role="dialog"
        aria-modal
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 420,
          maxHeight: "100%",
          overflowY: "auto",
          background: "#181818",
          border: "1px solid #333",
          borderRadius: 8,
          padding: 20,
          color: "#ddd",
          fontSize: 14,
          lineHeight: 1.5,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 17, color: "#fff" }}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export const buttonStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.15)",
  color: "#ddd",
  borderRadius: 4,
  padding: "6px 14px",
  cursor: "pointer",
  fontSize: 13,
};

export const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: "#2f6fd6",
  border: "1px solid #2f6fd6",
  color: "#fff",
};

export const inputStyle: React.CSSProperties = {
  background: "#0e0e0e",
  border: "1px solid #333",
  borderRadius: 4,
  color: "#eee",
  padding: "8px 10px",
  fontSize: 14,
  width: "100%",
  boxSizing: "border-box",
};
