import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  PhotoProvider,
  PhotoUrlProvider,
  PhotoGrid,
  PhotoViewer,
  usePhotoContext,
  VisionPanel,
  PeopleView,
  SearchBar,
  type SearchMatches,
} from "@/photos-ui";
import {
  addPhotoFromPath,
  getPhotoFileUrls,
  type PhotoRecord,
} from "./src/lib/data-server-client";
import { createUrlBatchLoader, type UrlBatchLoader } from "./src/lib/url-batch-loader";
import { FORCE_REMOTE } from "./src/lib/data-source-context";
import { AuthGate } from "./src/lib/AuthGate";
import { CloudSetupModal } from "./src/lib/CloudSetupModal";
import { CoverImageBanner } from "./src/lib/CoverImage";
import { downsizeImage } from "./src/lib/image-utils";
import { resolveAppApiSource } from "./src/lib/data-client";
import { photoRecordToAppImage } from "./src/lib/photoRecordToAppImage";
import { usePhotoFreshness } from "./src/lib/usePhotoFreshness";

/**
 * How many matches the search filter admits, and how much "Show more" widens it by.
 *
 * A filter width rather than a page size: §5.3 rejects an absolute score cutoff
 * because cosine is uncalibrated, so top-k is what stands in for one.
 */
const SEARCH_PAGE = 120;


function useFullSizeUrlCache() {
  const [urlMap, setUrlMap] = useState<ReadonlyMap<string, string>>(new Map());

  // Coalesce per-photo URL lookups into one batch call per flush window —
  // with lazy thumbnails, a scroll burst becomes a single request instead of
  // a request per visible photo. Created lazily (not at mount) and nulled on
  // unmount so StrictMode's dev mount→unmount→mount cycle can't leave a
  // disposed loader behind.
  const loaderRef = useRef<UrlBatchLoader | null>(null);
  useEffect(
    () => () => {
      loaderRef.current?.dispose();
      loaderRef.current = null;
    },
    [],
  );

  return useCallback(
    (imageId: string): string | null => {
      const cached = urlMap.get(imageId);
      if (cached) return cached;
      loaderRef.current ??= createUrlBatchLoader({
        loadBatch: getPhotoFileUrls,
        onLoaded: (urls) =>
          setUrlMap((prev) => {
            const next = new Map(prev);
            for (const [id, url] of urls) next.set(id, url);
            return next;
          }),
      });
      loaderRef.current.request(imageId);
      return null;
    },
    [urlMap],
  );
}


type ThumbnailStrategy = "browser" | "local-sharp" | "remote-sharp";

// Resolve where /api/resize lives based on the configured data target. For a
// cloud-served build the SPA is mounted under /apps/photos on the API Gateway
// domain and the route is JWT-gated; for a locally-served build the Next.js
// server serves it at the origin.
async function resolveResizeEndpoint(): Promise<{ url: string; headers: Record<string, string> }> {
  const source = await resolveAppApiSource();
  return { url: `${source.baseUrl}/api/resize`, headers: source.headers };
}

async function generateThumbnail(
  record: PhotoRecord,
  file: File,
  thumbnailStrategy: ThumbnailStrategy,
  onCreated: () => void,
): Promise<void> {
  try {
    const { url, headers: authHeaders } = await resolveResizeEndpoint();
    const headers = { "Content-Type": "application/json", ...authHeaders };
    if (thumbnailStrategy === "browser") {
      // Generate thumbnail in-browser using Canvas, then POST it as a new record
      // with content.parentId pointing to the original.
      const result = await downsizeImage(file, 400);
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ targetId: record.id }),
      });
      // Thumbnail is a shared-record write; core's sync supervisor
      // auto-schedules the push. onCreated() just refreshes the local view.
      if (res.ok) onCreated();
      void result; // generation handled server-side via /api/resize

    } else {
      // For local-sharp and remote-sharp, call /api/resize which runs sharp
      // server-side and creates the thumbnail DataRecord.
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ targetId: record.id }),
      });
      if (res.ok) onCreated();
    }
  } catch {
    // Thumbnail generation is best-effort
  }
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  gif: "image/gif", webp: "image/webp", heic: "image/heic",
  heif: "image/heif", avif: "image/avif", tiff: "image/tiff",
};

function PhotosAppInner() {
  const { state, dispatch } = usePhotoContext();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showCloudSetup, setShowCloudSetup] = useState(false);
  // Mounted unconditionally: both panels return null when the vision routes
  // answer 501, so the local/remote decision stays server-side rather than
  // being re-derived from the build flag here.
  const [showVision, setShowVision] = useState(false);
  const [showPeople, setShowPeople] = useState(false);
  // Search filters the main grid rather than opening its own. `limit` is the filter's
  // width, not a page size — §5.3 rules out an absolute cutoff, so top-k *is* the
  // filter and "Show more" widens it.
  const [searchMatches, setSearchMatches] = useState<SearchMatches>({
    recordIds: null,
    total: 0,
  });
  const [searchLimit, setSearchLimit] = useState(SEARCH_PAGE);

  /**
   * Stable by necessity, not by habit: `SearchBar` has this in its debounce effect's
   * dependency chain, so a new identity each render would re-fire the search forever.
   */
  const onMatchesChange = useCallback((matches: SearchMatches) => {
    setSearchMatches(matches);
    // Clearing the box also forgets a widened filter, so the next query starts at the
    // default width. Guarded so an unchanged value does not cost a render.
    if (matches.recordIds === null) {
      setSearchLimit((prev) => (prev === SEARCH_PAGE ? prev : SEARCH_PAGE));
    }
  }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [thumbnailStrategy, setThumbnailStrategy] = useState<ThumbnailStrategy>(
    () => (localStorage.getItem("thumbnail-strategy") as ThumbnailStrategy) ?? "browser",
  );

  const handleStrategyChange = (s: ThumbnailStrategy) => {
    setThumbnailStrategy(s);
    localStorage.setItem("thumbnail-strategy", s);
  };

  // Build the display list. Deduplicate thumbnails per original (keep newest),
  // then show orphan originals (no thumbnail yet) as empty placeholder boxes.
  const allThumbnails = state.images.filter((img) => img.parentId !== null);
  const originals = state.images.filter((img) => img.parentId === null);
  const newestThumbnailByParent = new Map<string, typeof allThumbnails[0]>();
  for (const t of allThumbnails) {
    const parentId = t.parentId!;
    const existing = newestThumbnailByParent.get(parentId);
    if (!existing || t.createdAt > existing.createdAt) newestThumbnailByParent.set(parentId, t);
  }
  const thumbnails = Array.from(newestThumbnailByParent.values());
  const thumbnailedIds = new Set(thumbnails.map((t) => t.parentId!));
  const fallbackOriginals = originals.filter((img) => !thumbnailedIds.has(img.id));
  // Sort client-side so display order is deterministic and identical across the
  // local and cloud backends, independent of each server's query order and of
  // the incremental-merge append drift in UPSERT_IMAGES. Newest first by
  // effectiveDateTaken (the same field the grid groups days by), with id as a
  // stable tiebreak. effectiveDateTaken is an ISO-8601 string, so lexical
  // comparison is chronological.
  const displayImages = [...thumbnails, ...fallbackOriginals].sort((a, b) => {
    if (a.effectiveDateTaken !== b.effectiveDateTaken) {
      return a.effectiveDateTaken < b.effectiveDateTaken ? 1 : -1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  /**
   * The search filter, applied to the list the grid already renders.
   *
   * Matched ids are **originals** (the scan set is originals-only), while the grid
   * shows thumbnails whose `parentId` is the original — so a display image is matched
   * by its original id, which is `parentId` for a thumbnail and `id` for a
   * fallback original.
   *
   * Date order and grouping survive; the ranking decides *membership* rather than
   * position. That is the tradeoff of filtering instead of showing a second list:
   * within the matches you keep the chronological layout you already know how to
   * read, and lose the relevance order between them.
   */
  const visibleImages = useMemo(() => {
    const matched = searchMatches.recordIds;
    if (matched === null) return displayImages;
    const wanted = new Set(matched);
    return displayImages.filter((img) => wanted.has(img.parentId ?? img.id));
  }, [displayImages, searchMatches]);

  // Backfill thumbnails for orphan originals. A ref prevents the same ID from
  // being submitted more than once per session, even if the effect re-fires.
  const backfilledRef = useRef(new Set<string>());
  const orphanIds = fallbackOriginals.map((img) => img.id).sort().join(",");
  useEffect(() => {
    if (!orphanIds) return;
    const newIds = orphanIds.split(",").filter((id) => !backfilledRef.current.has(id));
    if (newIds.length === 0) return;
    newIds.forEach((id) => backfilledRef.current.add(id));
    void (async () => {
      const { url, headers: authHeaders } = await resolveResizeEndpoint();
      const headers = { "Content-Type": "application/json", ...authHeaders };
      newIds.forEach((id) => {
        fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ targetId: id }),
        }).then((res) => { if (res.ok) freshness.kick(); }).catch(() => {});
      });
    })();
  }, [orphanIds]);

  // For the viewer: if a thumbnail was clicked, show its original.
  // If a fallback-original was clicked (no thumbnail exists), show it directly.
  const selectedDisplayImage = state.selectedId
    ? displayImages.find((img) => img.id === state.selectedId) ?? null
    : null;
  const selectedImage = selectedDisplayImage
    ? (selectedDisplayImage.parentId !== null
        ? (state.images.find((img) => img.id === selectedDisplayImage.parentId) ?? selectedDisplayImage)
        : selectedDisplayImage)
    : null;

  const freshness = usePhotoFreshness({
    onInitialLoad: (images) => dispatch({ type: "SET_IMAGES", images }),
    onMerge: (images) => dispatch({ type: "UPSERT_IMAGES", images }),
    onLoadingChange: (loading) => dispatch({ type: "SET_LOADING", loading }),
    onError: setError,
  });

  const handleFileSelected = async (file: File) => {
    setAdding(true);
    setError(null);
    setNotice(null);
    try {
      const fileName = file.name;
      const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
      const mimeType = IMAGE_EXTENSIONS[ext] ?? file.type ?? "application/octet-stream";

      const buf = await file.arrayBuffer();
      const fileBytes = new Uint8Array(buf);
      const { record, deduped } = await addPhotoFromPath(fileName, fileBytes, mimeType, fileName);
      // UPSERT (not APPEND) so a dedup hit — which returns the already-listed
      // record — doesn't add a duplicate row to the grid.
      dispatch({ type: "UPSERT_IMAGES", images: [photoRecordToAppImage(record, null)] });

      if (deduped) {
        setNotice(`"${fileName}" is already in your photos — nothing was added.`);
      }

      // Mark as submitted before generateThumbnail fires so the backfill effect
      // never picks up this original and creates a second thumbnail.
      backfilledRef.current.add(record.id);
      generateThumbnail(record, file, thumbnailStrategy, freshness.kick).catch(() => {});
    } catch (err) {
      console.error("[photos] Upload failed:", err);
      setError(err instanceof Error ? err.message : "Failed to add photo");
    } finally {
      setAdding(false);
    }
  };

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const handleAddClick = () => {
    fileInputRef.current?.click();
  };

  const getFullSizeSrc = useFullSizeUrlCache();

  return (
    <PhotoUrlProvider getThumbnailSrc={getFullSizeSrc} getFullSizeSrc={getFullSizeSrc}>
      <div
        style={{
          minHeight: "100vh",
          background: "#111",
          color: "#fff",
          fontFamily: "sans-serif",
        }}
      >
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept={Object.keys(IMAGE_EXTENSIONS).map((e) => `.${e}`).join(",")}
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFileSelected(file);
            e.target.value = "";
          }}
        />

        {/* Toolbar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 20px",
            borderBottom: "1px solid rgba(255,255,255,0.1)",
            position: "sticky",
            top: 0,
            background: "#111",
            zIndex: 100,
          }}
        >
          <span style={{ fontWeight: 700, fontSize: 17, letterSpacing: "-0.02em" }}>Photos</span>

          {/* Thumbnail generation strategy */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "#aaa" }}>
            <span style={{ whiteSpace: "nowrap" }}>Thumbnail generation:</span>
            {(
              [
                { value: "browser", label: "Browser" },
                ...(FORCE_REMOTE
                  ? [{ value: "remote-sharp" as const, label: "Remote Sharp" }]
                  : [{ value: "local-sharp" as const, label: "Local Sharp" }]),
              ] as { value: ThumbnailStrategy; label: string }[]
            ).map(({ value, label }) => (
              <label
                key={value}
                style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", whiteSpace: "nowrap" }}
              >
                <input
                  type="radio"
                  name="thumbnail-strategy"
                  value={value}
                  checked={thumbnailStrategy === value}
                  onChange={() => handleStrategyChange(value)}
                  style={{ accentColor: "#888" }}
                />
                {label}
              </label>
            ))}
          </div>

          {FORCE_REMOTE && (
            <button
              onClick={() => setShowCloudSetup(true)}
              title="Cloud setup"
              style={toolbarButtonStyle}
            >
              ⚙
            </button>
          )}

          {!FORCE_REMOTE && (
            <button
              onClick={() => setShowVision(true)}
              title="On-device face recognition"
              style={toolbarButtonStyle}
            >
              Faces
            </button>
          )}

          <button
            onClick={handleAddClick}
            disabled={adding}
            style={{ ...toolbarButtonStyle, background: "rgba(255,255,255,0.15)" }}
          >
            {adding
              ? (FORCE_REMOTE ? "Uploading…" : "Adding…")
              : (FORCE_REMOTE ? "Upload Photo" : "Add Photo")}
          </button>
        </div>

        {error && (
          <div
            style={{
              padding: "8px 20px",
              background: "rgba(220,50,50,0.15)",
              color: "#f88",
              fontSize: 13,
              borderBottom: "1px solid rgba(220,50,50,0.3)",
            }}
          >
            {error}
          </div>
        )}

        {notice && (
          <div
            role="status"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              padding: "8px 20px",
              background: "rgba(255,200,60,0.12)",
              color: "#ffd86b",
              fontSize: 13,
              borderBottom: "1px solid rgba(255,200,60,0.3)",
            }}
          >
            <span>{notice}</span>
            <button
              onClick={() => setNotice(null)}
              aria-label="Dismiss"
              style={{
                background: "transparent",
                border: "none",
                color: "inherit",
                cursor: "pointer",
                fontSize: 16,
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>
        )}

        {!FORCE_REMOTE && (
          <SearchBar
            limit={searchLimit}
            onWiden={() => setSearchLimit((n) => n + SEARCH_PAGE)}
            onMatchesChange={onMatchesChange}
          />
        )}

        <CoverImageBanner />

        <PhotoGrid
          images={visibleImages}
          loading={state.loading}
          hasMore={false}
          onLoadMore={() => {}}
          onSelect={(id) => dispatch({ type: "SET_SELECTED_ID", id })}
        />

        {selectedImage && (
          <PhotoViewer
            image={selectedImage}
            onClose={() => dispatch({ type: "SET_SELECTED_ID", id: null })}
          />
        )}

        {showCloudSetup && (
          <CloudSetupModal onClose={() => setShowCloudSetup(false)} />
        )}

        {showVision && (
          <VisionPanel
            onClose={() => setShowVision(false)}
            onOpenPeople={() => {
              setShowVision(false);
              setShowPeople(true);
            }}
          />
        )}

        {showPeople && <PeopleView onClose={() => setShowPeople(false)} />}

      </div>
    </PhotoUrlProvider>
  );
}

export function App() {
  return (
    <AuthGate>
      <PhotoProvider>
        <PhotosAppInner />
      </PhotoProvider>
    </AuthGate>
  );
}

const toolbarButtonStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.15)",
  color: "#ddd",
  borderRadius: 4,
  padding: "6px 14px",
  cursor: "pointer",
  fontSize: 13,
};
