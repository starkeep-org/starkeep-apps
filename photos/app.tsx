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
  SelectionProvider,
  SelectionLayer,
  AlbumsView,
  AlbumHeader,
  PublicLinkDialog,
  type LinkSubject,
} from "@/photos-ui";
import { addPhotoFromPath, deletePhoto, getPhotoFileUrls } from "./src/lib/data-server-client";
import { createUrlBatchLoader, type UrlBatchLoader } from "./src/lib/url-batch-loader";
import { FORCE_REMOTE } from "./src/lib/data-source-context";
import { AuthGate } from "./src/lib/AuthGate";
import { CoverImageBanner, CoverImageProvider } from "./src/lib/CoverImage";
import { SettingsMenu } from "./src/lib/SettingsMenu";
import { signOut } from "./src/lib/sign-out";
import { photoRecordToAppImage } from "./src/lib/photoRecordToAppImage";
import { usePhotoFreshness } from "./src/lib/usePhotoFreshness";
import { usePhotoRoute } from "./src/lib/photo-route";
import { useListLayoutPreferences } from "./src/lib/list-layout-preferences";
import { useNarrowViewport, usePrefersReducedMotion } from "./src/lib/use-narrow-viewport";
import { useHideOnScrollDown } from "./src/lib/use-hide-on-scroll-down";
import { compareCaptureOrder, type Album } from "@/photos-lib/client";
import { useAlbums } from "./src/lib/use-albums";


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


/**
 * Which screen the shell shows. The library and the albums are tabs; an album
 * is the library grid narrowed to its members. Kept in state rather than the
 * URL: the open photo is the one thing a link names.
 */
type View = { kind: "library" } | { kind: "albums" } | { kind: "album"; id: string };

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
  const { photoId, open, step, close } = usePhotoRoute();

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

  // Sorted client-side by the key the *server* cut the page on, rather than by
  // one of this component's choosing. `/api/photos/library` asks for
  // `order=captured_at.desc,created_at.desc`, so a page is a prefix of the
  // library in that order; sorting here by anything else would show a page
  // ordered one way and continued another once the library outgrows one page.
  //
  // The sort still has to happen, for two reasons the server cannot cover:
  // UPSERT_IMAGES appends merged records to the end of the list, and
  // `dateTakenOverride` lives in Photos' own syncable table where the records
  // query cannot reach it. See `photos-lib/capture-order.ts`.
  const libraryImages = React.useMemo(
    () => state.images.filter((img) => img.parentId === null).sort(compareCaptureOrder),
    [state.images],
  );

  const [view, setView] = useState<View>({ kind: "library" });
  const albums = useAlbums(
    (ids, albumId, member) => dispatch({ type: "SET_ALBUM_MEMBERSHIP", ids, albumId, member }),
    (albumId) => dispatch({ type: "FORGET_ALBUM", albumId }),
  );
  const [linkDialogFor, setLinkDialogFor] = useState<LinkSubject | null>(null);
  const photoSubject = useCallback(
    (photoId: string): LinkSubject => ({
      kind: "photo",
      photoId,
      name: libraryImages.find((img) => img.id === photoId)?.originalFilename ?? "Photo",
    }),
    [libraryImages],
  );
  const openAlbum = view.kind === "album" ? (albums.albums.find((a) => a.id === view.id) ?? null) : null;
  const membersOf = useCallback(
    (albumId: string) => libraryImages.filter((img) => img.albumIds?.includes(albumId)),
    [libraryImages],
  );

  // The grid shows the library, or one album's members in the library's order.
  const displayImages = openAlbum ? membersOf(openAlbum.id) : libraryImages;
  const shownIds = React.useMemo(() => displayImages.map((img) => img.id), [displayImages]);
  const shownIdSet = React.useMemo(() => new Set(shownIds), [shownIds]);

  // An album deleted elsewhere, or by this page, leaves for the albums tab.
  useEffect(() => {
    if (view.kind === "album" && !albums.loading && !openAlbum) setView({ kind: "albums" });
  }, [view, albums.loading, openAlbum]);

  // The grid displays originals, so the clicked tile already *is* the record
  // the viewer wants. There is no thumbnail-to-parent hop to make.
  const selectedIndex = photoId ? displayImages.findIndex((img) => img.id === photoId) : -1;
  // A photo opened by a link, or outside the open album, still opens over
  // the library.
  const linkedIndex = photoId && selectedIndex < 0 ? libraryImages.findIndex((img) => img.id === photoId) : -1;
  const stepList = selectedIndex >= 0 ? displayImages : libraryImages;
  const stepIndex = selectedIndex >= 0 ? selectedIndex : linkedIndex;
  const selectedImage = stepIndex >= 0 ? stepList[stepIndex] : null;
  // The viewer steps through the same list the grid shows, in the same order, so
  // the arrow keys land on the tile beside the one that was opened.
  const previousImage = stepIndex > 0 ? stepList[stepIndex - 1] : null;
  const nextImage = stepIndex >= 0 && stepIndex < stepList.length - 1 ? stepList[stepIndex + 1] : null;

  const freshness = usePhotoFreshness({
    onInitialLoad: (images) => dispatch({ type: "SET_IMAGES", images }),
    onMerge: (images) => dispatch({ type: "UPSERT_IMAGES", images }),
    onRemove: (ids) => dispatch({ type: "REMOVE_IMAGES", ids }),
    onLoadingChange: (loading) => dispatch({ type: "SET_LOADING", loading }),
    onError: setError,
    onPolicies: (policies) => dispatch({ type: "SET_POLICIES", policies }),
    refreshActiveResolutions: () => resolutionCache.refreshPending(),
  });

  // A photo the URL names and the library does not hold: a link to an unknown
  // id, or a photo deleted on another device while it was open. The library
  // loads in full, so once it has loaded, absent means gone. Before then a
  // link waits for its photo to arrive.
  useEffect(() => {
    if (photoId !== null && state.loaded && stepIndex < 0) close();
  }, [photoId, state.loaded, stepIndex, close]);

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
          {/* The two tabs stand in for the title: the app's name is the
              library tab, so the header gains no width at phone size. */}
          <nav aria-label="Views" style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
            <button
              type="button"
              aria-current={view.kind === "library" ? "page" : undefined}
              onClick={() => setView({ kind: "library" })}
              style={tabStyle(view.kind === "library")}
            >
              Photos
            </button>
            <button
              type="button"
              aria-current={view.kind !== "library" ? "page" : undefined}
              onClick={() => setView({ kind: "albums" })}
              style={tabStyle(view.kind !== "library")}
            >
              Albums
            </button>
          </nav>

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
              onSignOut={FORCE_REMOTE ? () => void signOut() : null}
              onOpenFaces={FORCE_REMOTE ? null : () => setShowVision(true)}
            />
          </div>
        </div>

        {error && (
          <div
            // An error is the more urgent of the two banners, and the notice
            // beside it already announces itself. Without a role this one was
            // silent to a screen reader.
            role="alert"
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

        {view.kind === "library" ? <CoverImageBanner /> : null}

        {view.kind === "albums" ? (
          <AlbumsView
            albums={albums.albums}
            membersOf={membersOf}
            linkedAlbumIds={albums.linkedAlbumIds}
            loading={albums.loading}
            error={albums.error}
            onOpen={(album) => setView({ kind: "album", id: album.id })}
            onCreate={async (title) => {
              const album = await albums.create(title);
              setView({ kind: "album", id: album.id });
            }}
          />
        ) : (
          <SelectionProvider key={openAlbum?.id ?? "library"} order={shownIds}>
            {openAlbum ? (
              <AlbumHeader
                key={openAlbum.id}
                album={openAlbum}
                count={displayImages.length}
                linked={albums.linkedAlbumIds.has(openAlbum.id)}
                onBack={() => setView({ kind: "albums" })}
                onRename={(title) => albums.rename(openAlbum, title)}
                onDelete={async () => {
                  await albums.remove(openAlbum);
                  setView({ kind: "albums" });
                }}
                onPublicLink={() => setLinkDialogFor({ kind: "album", album: openAlbum })}
              />
            ) : null}
            {openAlbum && displayImages.length === 0 && state.loaded ? (
              <p style={{ padding: "24px 16px", color: "#888", margin: 0 }}>
                This album is empty. Select photos in the library and choose "Add to album…".
              </p>
            ) : (
              <PhotoGrid
                images={displayImages}
                loading={state.loading}
                loaded={state.loaded}
                hasMore={false}
                onLoadMore={() => {}}
                onSelect={open}
                rowHeight={layout.rowHeight}
                groupByDate={layout.groupByDate}
                edgeToEdge={narrow}
              />
            )}
            <SelectionLayer
              shownIds={shownIdSet}
              album={openAlbum}
              albums={albums}
              onShareAlbum={(album) => {
                setView({ kind: "album", id: album.id });
                setLinkDialogFor({ kind: "album", album });
              }}
              onSharePhoto={(photoId) => setLinkDialogFor(photoSubject(photoId))}
            />
          </SelectionProvider>
        )}

        {linkDialogFor ? (
          <PublicLinkDialog
            key={linkDialogFor.kind === "album" ? linkDialogFor.album.id : linkDialogFor.photoId}
            subject={linkDialogFor}
            state={albums.links}
            link={
              linkDialogFor.kind === "album"
                ? albums.linkOf(linkDialogFor.album.id)
                : albums.photoLinkOf(linkDialogFor.photoId)
            }
            actions={{
              create: (input) =>
                linkDialogFor.kind === "album"
                  ? albums.createLink(linkDialogFor.album, input)
                  : albums.createPhotoLink(linkDialogFor.photoId, input),
              changeLifetime: albums.changeLinkLifetime,
              replace: albums.replaceLink,
              stop: albums.stopLink,
            }}
            onRetry={albums.reloadLinks}
            onClose={() => setLinkDialogFor(null)}
          />
        ) : null}

        {selectedImage && (
          <PhotoViewer
            image={selectedImage}
            onClose={close}
            onShareLink={() => setLinkDialogFor(photoSubject(selectedImage.id))}
            onPrevious={previousImage ? () => step(previousImage.id) : undefined}
            onNext={nextImage ? () => step(nextImage.id) : undefined}
            // The viewer owns the confirmation and the refusal message; the library
            // state is this component's, like every other dispatch here. The grid
            // drops the row without refetching, which is what `OPTIMISTIC_DELETE`
            // means — the server has already agreed by the time this runs.
            onDelete={async () => {
              await deletePhoto(selectedImage.id);
              dispatch({ type: "OPTIMISTIC_DELETE", id: selectedImage.id });
              close();
            }}
          />
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

function tabStyle(active: boolean): React.CSSProperties {
  return {
    background: "none",
    border: "none",
    padding: 0,
    cursor: "pointer",
    fontWeight: 700,
    fontSize: 17,
    letterSpacing: "-0.02em",
    color: active ? "#fff" : "#777",
  };
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
