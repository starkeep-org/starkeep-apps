import React, { useCallback, useEffect, useRef, useState } from "react";
import { justifiedRows } from "@starkeep/photos-ladder";
import { useElementWidth } from "@/photos-ui/hooks/use-element-size";
import { useNarrowViewport } from "@/lib/use-narrow-viewport";
import {
  fetchPublicPage,
  sizeFor,
  type PublicItem,
  type PublicPageResult,
} from "./public-share-client";

const GAP = 4;

type Load =
  | { kind: "loading" }
  | {
      kind: "ready";
      title: string;
      source: "label" | "record";
      items: PublicItem[];
      pending: number;
      nextCursor: string | null;
      truncated: boolean;
    }
  | { kind: "failed"; reason: "expired" | "gone" | "failed" };

/**
 * What a visitor of a public link sees: the album's title and its photos,
 * nothing else. A link to one photo opens straight into the large view, with
 * no grid.
 *
 * No sign-in, no menus, no dates, no captions, no download button. A photo
 * opens large on a click and a video plays its stand-in. The platform decides
 * what each item carries; this page only lays it out.
 */
export function PublicAlbumPage({ linkToken }: { linkToken: string }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [open, setOpen] = useState<number | null>(null);
  const loadingMore = useRef(false);
  const narrow = useNarrowViewport();

  const apply = useCallback((result: PublicPageResult, append: boolean) => {
    if (!result.ok) {
      // A later page that fails leaves what is shown in place.
      if (!append) setLoad({ kind: "failed", reason: result.reason });
      return;
    }
    const { page } = result;
    document.title = page.title;
    setLoad((prev) => ({
      kind: "ready",
      title: page.title,
      source: page.source,
      items: append && prev.kind === "ready" ? [...prev.items, ...page.items] : [...page.items],
      pending: page.pending,
      nextCursor: page.nextCursor,
      truncated: page.truncated,
    }));
  }, []);

  useEffect(() => {
    void fetchPublicPage(linkToken, null).then((r) => apply(r, false));
  }, [linkToken, apply]);

  const loadMore = useCallback(() => {
    if (load.kind !== "ready" || !load.nextCursor || loadingMore.current) return;
    loadingMore.current = true;
    void fetchPublicPage(linkToken, load.nextCursor)
      .then((r) => apply(r, true))
      .finally(() => {
        loadingMore.current = false;
      });
  }, [load, linkToken, apply]);

  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) loadMore();
    }, { rootMargin: "400px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

  const [measure, width] = useElementWidth<HTMLDivElement>();

  if (load.kind === "loading") return <Shell>Loading…</Shell>;
  if (load.kind === "failed") {
    return (
      <Shell>
        {load.reason === "expired"
          ? "This link has expired."
          : load.reason === "gone"
            ? "This link does not exist or was turned off."
            : "This album could not be loaded. Try again in a moment."}
      </Shell>
    );
  }

  if (load.source === "record") {
    const item = load.items[0];
    if (!item) {
      return (
        <Shell>
          {load.pending > 0
            ? "This photo is still uploading. Try again in a few minutes."
            : "This link no longer shows anything."}
        </Shell>
      );
    }
    return <Lightbox item={item} title={load.title} />;
  }

  const rows =
    width === null
      ? []
      : justifiedRows(load.items, (item) => (item.height > 0 ? item.width / item.height : 1), {
          containerWidth: width,
          targetRowHeight: narrow ? 160 : 240,
          gap: GAP,
        });
  const count = load.items.length;
  const more = load.nextCursor !== null;
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;

  return (
    <div style={{ minHeight: "100vh", background: "#111", color: "#fff", fontFamily: "sans-serif" }}>
      <header style={{ padding: "16px 20px", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>{load.title}</h1>
        <p style={{ margin: "4px 0 0", color: "#888", fontSize: 13 }}>
          {more ? `${count}+ items` : `${count} ${count === 1 ? "item" : "items"}`}
        </p>
      </header>
      <main style={{ padding: narrow ? 0 : 16 }}>
        <div ref={measure} style={{ display: "flex", flexDirection: "column", gap: GAP }}>
          {rows.map((row) => (
            <div key={row.placements[0]!.item.id} style={{ display: "flex", gap: GAP, height: row.height }}>
              {row.placements.map(({ item, width: w }) => {
                const index = load.items.indexOf(item);
                const size = sizeFor(item.sizes, Math.max(w, row.height) * dpr);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setOpen(index)}
                    aria-label={item.category === "video" ? "Play video" : "Open photo"}
                    style={{
                      all: "unset",
                      cursor: "pointer",
                      width: w,
                      height: row.height,
                      background: "#222",
                      position: "relative",
                      overflow: "hidden",
                      flexShrink: 0,
                    }}
                  >
                    {size ? (
                      <img
                        src={size.url}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                      />
                    ) : null}
                    {item.category === "video" ? <PlayMark /> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div ref={sentinel} style={{ height: 1 }} />
        {load.truncated && !more ? (
          <p style={{ color: "#888", textAlign: "center", fontSize: 13 }}>
            This link shows the album's first {count} items.
          </p>
        ) : null}
      </main>
      {open !== null && load.items[open] ? (
        <Lightbox
          item={load.items[open]!}
          onClose={() => setOpen(null)}
          onPrevious={open > 0 ? () => setOpen(open - 1) : undefined}
          onNext={open < load.items.length - 1 ? () => setOpen(open + 1) : undefined}
        />
      ) : null}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#111",
        color: "#aaa",
        fontFamily: "sans-serif",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        textAlign: "center",
      }}
    >
      {children}
    </div>
  );
}

function PlayMark() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 48 48"
      width={36}
      height={36}
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        opacity: 0.75,
        pointerEvents: "none",
        filter: "drop-shadow(0 0 2px rgba(0,0,0,0.6))",
      }}
    >
      <path d="M13 4 L44 24 L13 44 Z" fill="#fff" />
    </svg>
  );
}

/**
 * One item, as large as the screen allows. Arrow keys step, Escape closes.
 *
 * Without `onClose` it is the whole page of a one-photo link: no close
 * control, and the title in the corner.
 */
function Lightbox({
  item,
  title,
  onClose,
  onPrevious,
  onNext,
}: {
  item: PublicItem;
  title?: string;
  onClose?: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
      if (e.key === "ArrowLeft") onPrevious?.();
      if (e.key === "ArrowRight") onNext?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onPrevious, onNext]);

  const dpr = window.devicePixelRatio || 1;
  const largest = sizeFor(item.sizes, Math.max(window.innerWidth, window.innerHeight) * dpr);
  const nav: React.CSSProperties = {
    position: "absolute",
    top: "50%",
    transform: "translateY(-50%)",
    background: "rgba(0,0,0,0.4)",
    border: "none",
    color: "#fff",
    fontSize: 28,
    width: 44,
    height: 64,
    cursor: "pointer",
  };
  return (
    <div
      {...(onClose ? { role: "dialog", "aria-modal": true } : { role: "main" })}
      aria-label={title ?? "Photo"}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(0,0,0,0.95)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {item.category === "video" && item.playback ? (
        <video
          key={item.id}
          src={item.playback.url}
          poster={largest?.url}
          controls
          autoPlay
          playsInline
          onClick={(e) => e.stopPropagation()}
          style={{ maxWidth: "100%", maxHeight: "100%" }}
        />
      ) : largest ? (
        <img
          key={item.id}
          src={largest.url}
          alt=""
          referrerPolicy="no-referrer"
          onClick={(e) => e.stopPropagation()}
          style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
        />
      ) : null}
      {title ? (
        <h1
          style={{
            position: "absolute",
            top: 16,
            left: 20,
            margin: 0,
            fontSize: 16,
            fontWeight: 500,
            color: "#ddd",
            fontFamily: "sans-serif",
          }}
        >
          {title}
        </h1>
      ) : null}
      {onClose ? (
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          style={{ ...nav, top: 16, right: 16, transform: "none", width: 44, height: 44, fontSize: 22 }}
        >
          ×
        </button>
      ) : null}
      {onPrevious ? (
        <button
          type="button"
          aria-label="Previous"
          onClick={(e) => {
            e.stopPropagation();
            onPrevious();
          }}
          style={{ ...nav, left: 8 }}
        >
          ‹
        </button>
      ) : null}
      {onNext ? (
        <button
          type="button"
          aria-label="Next"
          onClick={(e) => {
            e.stopPropagation();
            onNext();
          }}
          style={{ ...nav, right: 8 }}
        >
          ›
        </button>
      ) : null}
    </div>
  );
}
