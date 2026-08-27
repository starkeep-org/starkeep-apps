import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  PhotoProvider,
  PhotoUrlProvider,
  PhotoGrid,
  PhotoViewer,
  usePhotoContext,
  VisionPanel,
  PeopleView,
  RenditionResolutionProvider,
  useRenditionResolutionCache,
} from "@/photos-ui";
import { addPhotoFromPath, getPhotoFileUrls } from "./src/lib/data-server-client";
import { createUrlBatchLoader, type UrlBatchLoader } from "./src/lib/url-batch-loader";
import { FORCE_REMOTE } from "./src/lib/data-source-context";
import { AuthGate } from "./src/lib/AuthGate";
import { CloudSetupModal } from "./src/lib/CloudSetupModal";
import { CoverImageBanner, CoverImageProvider } from "./src/lib/CoverImage";
import { SettingsMenu } from "./src/lib/SettingsMenu";
import { photoRecordToAppImage } from "./src/lib/photoRecordToAppImage";
import { usePhotoFreshness } from "./src/lib/usePhotoFreshness";
import { useListLayoutPreferences } from "./src/lib/list-layout-preferences";
import { useNarrowViewport, usePrefersReducedMotion } from "./src/lib/use-narrow-viewport";
import { useHideOnScrollDown } from "./src/lib/use-hide-on-scroll-down";


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


const IMAGE_EXTENSIONS: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  gif: "image/gif", webp: "image/webp", heic: "image/heic",
  heif: "image/heif", avif: "image/avif", tiff: "image/tiff",
};

function PhotosAppInner() {
  const { state, dispatch } = usePhotoContext();
  const resolutionCache = useRenditionResolutionCache();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showCloudSetup, setShowCloudSetup] = useState(false);
  // Mounted unconditionally: both panels return null when the vision routes
  // answer 501, so the local/remote decision stays server-side rather than
  // being re-derived from the build flag here.
  const [showVision, setShowVision] = useState(false);
  const [showPeople, setShowPeople] = useState(false);
  const [layout, setLayout] = useListLayoutPreferences();
  const narrow = useNarrowViewport();
  // Only on a phone, where the header is a real fraction of the screen. On a
  // desktop there is room for it and a header that moves on its own is a
  // distraction rather than a saving.
  const headerHidden = useHideOnScrollDown(narrow);
  const reducedMotion = usePrefersReducedMotion();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Build the display list. Renditions never appear here in their own right:
  // the library query excludes them server-side by label, so every record in
  // `state.images` is an original and each carries its resolved renditions in
  // `variants`. An original with no variants has nothing derived yet and is
  // shown as a placeholder box.
  //
  // The `parentId` split this used to do could not work for exactly that
  // reason — the set of records with a parent is always empty here, so every
  // original counted as an orphan and every page load re-derived the whole
  // library.
  const originals = state.images.filter((img) => img.parentId === null);

  // Sort client-side so display order is deterministic and identical across the
  // local and cloud backends, independent of each server's query order and of
  // the incremental-merge append drift in UPSERT_IMAGES. Newest first by
  // effectiveDateTaken (the same field the grid groups days by), with id as a
  // stable tiebreak. effectiveDateTaken is an ISO-8601 string, so lexical
  // comparison is chronological.
  const displayImages = [...originals].sort((a, b) => {
    if (a.effectiveDateTaken !== b.effectiveDateTaken) {
      return a.effectiveDateTaken < b.effectiveDateTaken ? 1 : -1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // The grid displays originals, so the clicked tile already *is* the record
  // the viewer wants. There is no thumbnail-to-parent hop to make.
  const selectedImage = state.selectedId
    ? displayImages.find((img) => img.id === state.selectedId) ?? null
    : null;

  const freshness = usePhotoFreshness({
    onInitialLoad: (images) => dispatch({ type: "SET_IMAGES", images }),
    onMerge: (images) => dispatch({ type: "UPSERT_IMAGES", images }),
    onLoadingChange: (loading) => dispatch({ type: "SET_LOADING", loading }),
    onError: setError,
    onPolicies: (policies) => dispatch({ type: "SET_POLICIES", policies }),
    refreshActiveResolutions: () => resolutionCache.refreshPending(),
  });

  useEffect(() => {
    resolutionCache.retainRecords(new Set(originals.map((image) => image.id)));
  }, [originals, resolutionCache]);

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
      // Re-read the record through Photos' library route so it carries an
      // explicit rendition decision. Locally, the supervised sweep owns the
      // work. In the cloud, the pending decision makes the visible tile ask
      // the bounded on-demand scheduler for the rung it needs.
      freshness.kick();
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
            // Slides out of view rather than disappearing, so the direction it
            // went is visible and the way to get it back is obvious.
            transform: headerHidden ? "translateY(-100%)" : "translateY(0)",
            transition: reducedMotion ? undefined : "transform 220ms ease",
          }}
        >
          <span style={{ fontWeight: 700, fontSize: 17, letterSpacing: "-0.02em" }}>Photos</span>

          {/* Three things, at every width. Everything else lives behind the
              gear, because a phone-width header cannot hold more than this and
              a desktop header that only just fits is one addition from not
              fitting either. */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              onClick={handleAddClick}
              disabled={adding}
              style={{ ...toolbarButtonStyle, background: "rgba(255,255,255,0.15)" }}
            >
              {adding
                ? (FORCE_REMOTE ? "Uploading…" : "Adding…")
                : (FORCE_REMOTE ? "Upload Photo" : "Add Photo")}
            </button>

            <SettingsMenu
              layout={layout}
              onLayoutChange={setLayout}
              onOpenCloudSetup={FORCE_REMOTE ? () => setShowCloudSetup(true) : null}
              onOpenFaces={FORCE_REMOTE ? null : () => setShowVision(true)}
            />
          </div>
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

        <CoverImageBanner />

        <PhotoGrid
          images={displayImages}
          loading={state.loading}
          hasMore={false}
          onLoadMore={() => {}}
          onSelect={(id) => dispatch({ type: "SET_SELECTED_ID", id })}
          rowHeight={layout.rowHeight}
          groupByDate={layout.groupByDate}
          edgeToEdge={narrow}
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
        <ResolutionBoundary />
      </PhotoProvider>
    </AuthGate>
  );
}

function ResolutionBoundary() {
  const { state } = usePhotoContext();
  return (
    <RenditionResolutionProvider policies={state.policies}>
      {/* Above PhotosAppInner so the banner over the list and the controls in
          the settings menu read and write one piece of cover state. */}
      <CoverImageProvider>
        <PhotosAppInner />
      </CoverImageProvider>
    </RenditionResolutionProvider>
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
