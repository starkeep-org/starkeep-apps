// @vitest-environment jsdom
/**
 * Where a public link starts, and what each entry point leaves on screen.
 *
 * - "Share link…" on a selection of one photo shares that photo. On more than
 *   one, it makes an album from them first.
 * - Escape in the link dialog over the viewer closes the dialog and keeps the
 *   viewer open.
 * - The link dialog beside an open album never leaves the album on screen
 *   twice.
 */
import React, { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SelectionLayer } from "../src/photos-ui/components/albums/selection-layer";
import {
  linkDialogKey,
  PublicLinkDialog,
  type LinkSubject,
} from "../src/photos-ui/components/albums/public-link-dialog";
import { PhotoViewer } from "../src/photos-ui/components/viewer/photo-viewer";
import { PhotoUrlProvider } from "../src/photos-ui/context/photo-url-context";
import { RenditionResolutionProvider } from "../src/photos-ui/context/rendition-resolution-context";
import { SelectionProvider, useSelection } from "../src/photos-ui/context/selection-context";
import { resetDerivationRequests } from "../src/lib/on-demand-derivation";
import type { AlbumsState } from "../src/lib/use-albums";
import type { Album } from "../src/photos-lib/client";
import type { AppImage } from "../src/photos-lib";

const ALBUM: Album = { id: "a".repeat(32), title: "Summer", coverRecordId: null, createdAtMs: 1 };

const noLinks = {
  available: true as const,
  mayPublish: true,
  viewerBaseUrl: null,
  links: [],
};

const actions = { create: vi.fn(), changeLifetime: vi.fn(), replace: vi.fn(), stop: vi.fn() };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Selects `ids` once mounted, as clicks on their checkboxes would. */
function Select({ ids }: { ids: readonly string[] }) {
  const selection = useSelection()!;
  useEffect(() => {
    for (const id of ids) selection.choose(id, false);
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function selectionOf(ids: readonly string[], onSharePhoto: (id: string) => void) {
  const shown = ["p1", "p2", "p3"];
  render(
    <SelectionProvider order={shown}>
      <Select ids={ids} />
      <SelectionLayer
        shownIds={new Set(shown)}
        album={null}
        albums={{ albums: [] } as unknown as AlbumsState}
        onShareAlbum={() => {}}
        onSharePhoto={onSharePhoto}
      />
    </SelectionProvider>,
  );
}

describe("Share link… on a selection", () => {
  it("shares one selected photo as itself, and ends the selection", async () => {
    const onSharePhoto = vi.fn();
    selectionOf(["p2"], onSharePhoto);
    fireEvent.click(await screen.findByRole("button", { name: "Share link…" }));
    expect(onSharePhoto).toHaveBeenCalledWith("p2");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Share link…" })).toBeNull();
  });

  it("asks for a new album when more than one photo is selected", async () => {
    const onSharePhoto = vi.fn();
    selectionOf(["p1", "p3"], onSharePhoto);
    fireEvent.click(await screen.findByRole("button", { name: "Share link…" }));
    expect(onSharePhoto).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Share 2 photos" })).toBeDefined();
  });
});

function appImage(): AppImage {
  return {
    id: "orig-1",
    mimeType: "image/jpeg",
    objectStorageKey: "shared/image/aa/hash",
    sizeBytes: 100,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    parentId: null,
    derivedKind: null,
    variants: {},
    thumbHash: null,
    width: 4000,
    height: 3000,
    exif: {
      capturedAt: null,
      cameraMake: null,
      cameraModel: null,
      fNumber: null,
      exposureTime: null,
      iso: null,
      lensModel: null,
      gpsLat: null,
      gpsLon: null,
      present: null,
      orientation: null,
    },
    originalFilename: "photo.jpg",
    effectiveDateTaken: "2026-01-01T00:00:00.000Z",
  };
}

const policies = {
  still: { kind: "still" as const, version: "still-test", targetLongEdges: [320, 1280] },
  video: { kind: "video" as const, version: "video-test", targetLongEdges: [640] },
};

describe("Escape in the link dialog over the viewer", () => {
  beforeEach(() => {
    resetDerivationRequests();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ records: [] })),
    );
  });

  it("closes the dialog and keeps the viewer open", async () => {
    const closeViewer = vi.fn();
    const closeDialog = vi.fn();
    render(
      <RenditionResolutionProvider policies={policies}>
        <PhotoUrlProvider getThumbnailSrc={() => null} getFullSizeSrc={() => null}>
          <PhotoViewer image={appImage()} onClose={closeViewer} />
          <PublicLinkDialog
            subject={{ kind: "photo", photoId: "orig-1", name: "photo.jpg" }}
            state={noLinks}
            link={null}
            actions={actions}
            onRetry={async () => {}}
            onClose={closeDialog}
          />
        </PhotoUrlProvider>
      </RenditionResolutionProvider>,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    // A key press starts at the focused element, so the dialog's capture
    // listener on the window runs before the viewer's bubble listener.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(closeDialog).toHaveBeenCalledTimes(1);
    expect(closeViewer).not.toHaveBeenCalled();
  });
});

/** The album view and the link dialog as siblings, as the app lays them out. */
function AlbumWithDialog() {
  const [subject, setSubject] = useState<LinkSubject | null>(null);
  return (
    <>
      <section key={ALBUM.id} aria-label="Album">
        <h1>{ALBUM.title}</h1>
        <button type="button" onClick={() => setSubject({ kind: "album", album: ALBUM })}>
          Open link
        </button>
      </section>
      {subject ? (
        <PublicLinkDialog
          key={linkDialogKey(subject)}
          subject={subject}
          state={noLinks}
          link={null}
          actions={actions}
          onRetry={async () => {}}
          onClose={() => setSubject(null)}
        />
      ) : null}
    </>
  );
}

describe("the link dialog beside an open album", () => {
  it("never shares a key with the album view", () => {
    expect(linkDialogKey({ kind: "album", album: ALBUM })).not.toBe(ALBUM.id);
    expect(linkDialogKey({ kind: "photo", photoId: ALBUM.id, name: "x" })).not.toBe(ALBUM.id);
  });

  it("leaves the album on screen once after the dialog opens and closes", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<AlbumWithDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Open link" }));
    expect(screen.getByRole("dialog")).toBeDefined();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getAllByRole("region", { name: "Album" })).toHaveLength(1);
    expect(screen.getAllByRole("heading", { name: "Summer" })).toHaveLength(1);
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(/same key/);
  });
});
