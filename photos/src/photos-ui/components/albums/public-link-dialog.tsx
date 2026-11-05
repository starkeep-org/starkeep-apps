import React, { useState } from "react";
import { ALBUM_TITLE_MAX, normalizeAlbumTitle, type Album } from "@/photos-lib/client";
import {
  DEFAULT_LINK_LIFETIME,
  LINK_LIFETIMES,
  publicLinkUrl,
  type LinkLifetime,
  type PublicLink,
  type PublicLinksState,
} from "@/lib/albums-client";
import { Modal, buttonStyle, inputStyle, primaryButtonStyle } from "./modal";

/** "Expires 12 Nov 2026", "Expired", or "Never expires". */
export function expiryText(expiresAtMs: number | null, nowMs: number = Date.now()): string {
  if (expiresAtMs === null) return "Never expires";
  if (expiresAtMs <= nowMs) return "Expired";
  return `Expires ${new Date(expiresAtMs).toLocaleDateString(undefined, { dateStyle: "medium" })}`;
}

/** Whether a link still opens. */
export function isLive(link: PublicLink, nowMs: number = Date.now()): boolean {
  return link.expiresAtMs === null || link.expiresAtMs > nowMs;
}

export interface PublicLinkActions {
  create: (input: { title: string; lifetime: LinkLifetime }) => Promise<void>;
  changeLifetime: (link: PublicLink, lifetime: LinkLifetime) => Promise<void>;
  replace: (link: PublicLink) => Promise<void>;
  stop: (link: PublicLink) => Promise<void>;
}

/**
 * One album's public link: create it, or copy, change, replace or stop it.
 *
 * Local Photos cannot create a link — a link is served by the cloud and made
 * from a person's session there, never by this device — so the dialog sends
 * the person to cloud Photos instead.
 */
export function PublicLinkDialog({
  album,
  state,
  link,
  actions,
  onClose,
}: {
  album: Album;
  state: PublicLinksState | null;
  link: PublicLink | null;
  actions: PublicLinkActions;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(album.title);
  const [lifetime, setLifetime] = useState<LinkLifetime>(DEFAULT_LINK_LIFETIME);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const run = async (act: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await act();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const disclosure = (
    <p style={{ margin: 0, color: "#aaa" }}>
      Anyone with the link can see this album, including photos you add later. They see the photos
      at screen size, without their details or location, and can save what they see.
    </p>
  );

  let body: React.ReactNode;
  if (state === null) {
    body = <p style={{ margin: 0, color: "#888" }}>Loading…</p>;
  } else if (state.local) {
    body = (
      <>
        <p style={{ margin: 0 }}>
          Public links are made in cloud Photos, while you are signed in there. This computer
          cannot make one, so that a lost device can never publish your photos.
        </p>
        {state.cloudPhotosUrl ? (
          <a
            href={state.cloudPhotosUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ ...primaryButtonStyle, textDecoration: "none", alignSelf: "flex-start" }}
          >
            Open cloud Photos ↗
          </a>
        ) : (
          <p style={{ margin: 0, color: "#888" }}>This computer is not connected to a cloud yet.</p>
        )}
        <p style={{ margin: 0, color: "#888", fontSize: 13 }}>
          The album reaches the cloud when this computer next syncs.
        </p>
      </>
    );
  } else if (!state.mayPublish && !link) {
    body = (
      <p style={{ margin: 0 }}>
        Photos was not approved to publish public links when it was installed. Reinstall it from
        admin-web and approve public links to turn this on.
      </p>
    );
  } else if (link) {
    const url = publicLinkUrl(link.linkToken);
    body = (
      <>
        {disclosure}
        <div style={{ display: "flex", gap: 8 }}>
          <input readOnly value={url} aria-label="Public link" style={inputStyle} onFocus={(e) => e.target.select()} />
          <button
            type="button"
            style={primaryButtonStyle}
            onClick={() =>
              void navigator.clipboard?.writeText(url).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              })
            }
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p style={{ margin: 0, color: isLive(link) ? "#aaa" : "#f88", fontSize: 13 }}>
          {expiryText(link.expiresAtMs)}
        </p>
        <label style={{ display: "flex", alignItems: "center", gap: 8, color: "#aaa", fontSize: 13 }}>
          Lifetime from now
          <select
            value=""
            disabled={busy}
            onChange={(e) => {
              const value = e.target.value as LinkLifetime;
              if (value) void run(() => actions.changeLifetime(link, value));
            }}
            style={{ ...inputStyle, width: "auto" }}
          >
            <option value="" disabled>
              Change…
            </option>
            {LINK_LIFETIMES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            style={buttonStyle}
            disabled={busy}
            onClick={() => {
              if (confirm("Replace the link? The current link stops working, and the album is shared at a new one.")) {
                void run(() => actions.replace(link));
              }
            }}
          >
            Replace link
          </button>
          <button
            type="button"
            style={{ ...buttonStyle, color: "#f88" }}
            disabled={busy}
            onClick={() => {
              if (confirm("Stop sharing? Anyone holding the link loses access.")) {
                void run(() => actions.stop(link));
              }
            }}
          >
            Stop sharing
          </button>
        </div>
      </>
    );
  } else {
    const valid = normalizeAlbumTitle(title) !== null;
    body = (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void run(() => actions.create({ title: title.trim(), lifetime }));
        }}
        style={{ display: "flex", flexDirection: "column", gap: 12 }}
      >
        {disclosure}
        <label style={{ display: "flex", flexDirection: "column", gap: 6, color: "#aaa", fontSize: 13 }}>
          Title visitors see
          <input
            value={title}
            maxLength={ALBUM_TITLE_MAX}
            onChange={(e) => setTitle(e.target.value)}
            style={inputStyle}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, color: "#aaa", fontSize: 13 }}>
          Link expires after
          <select
            value={lifetime}
            onChange={(e) => setLifetime(e.target.value as LinkLifetime)}
            style={inputStyle}
          >
            {LINK_LIFETIMES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" style={buttonStyle} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" style={primaryButtonStyle} disabled={!valid || busy}>
            Create link
          </button>
        </div>
      </form>
    );
  }

  return (
    <Modal title={`Public link: ${album.title}`} onClose={onClose}>
      {body}
      {error ? (
        <p role="alert" style={{ margin: 0, color: "#f88", fontSize: 13 }}>
          {error}
        </p>
      ) : null}
      {link || state?.local || (state && !state.mayPublish) ? (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" style={buttonStyle} onClick={onClose}>
            Done
          </button>
        </div>
      ) : null}
    </Modal>
  );
}
