// @vitest-environment jsdom
/**
 * The library's one order, asserted on both sides of it.
 *
 * The server cuts each page of `/data/records` in this order and the grid
 * displays what arrives, so the two agreeing is what makes a page a *slice* of
 * the library rather than a sample of it. A test that only checked the
 * comparator would pass while the route asked for something else, so the
 * parameter and the comparator are pinned together here.
 */
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  captureKey,
  compareCaptureOrder,
  LIBRARY_ORDER,
  type AppImage,
} from "../src/photos-lib/client";
import { PhotoGrid } from "../src/photos-ui/components/grid/photo-grid";

// The grid observes a sentinel to ask for the next page. jsdom has no
// IntersectionObserver, and this suite is about section order rather than
// paging, so a stub that observes nothing is the whole requirement.
beforeAll(() => {
  globalThis.IntersectionObserver = class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  } as unknown as typeof IntersectionObserver;
});

afterEach(cleanup);

function image(over: Partial<AppImage> & { id: string }): AppImage {
  return {
    mimeType: "image/jpeg",
    objectStorageKey: `objects/${over.id}`,
    sizeBytes: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    parentId: null,
    derivedKind: null,
    variants: {},
    thumbHash: null,
    width: 100,
    height: 100,
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
      orientation: null,
      present: null,
    },
    originalFilename: `${over.id}.jpg`,
    effectiveDateTaken: over.exif?.capturedAt ?? "2026-01-01T00:00:00.000Z",
    ...over,
  } as AppImage;
}

function captured(id: string, capturedAt: string, createdAt = "2026-01-01T00:00:00.000Z"): AppImage {
  return image({
    id,
    createdAt,
    exif: { ...image({ id }).exif, capturedAt },
    effectiveDateTaken: capturedAt,
  });
}

function uncaptured(id: string, createdAt: string): AppImage {
  return image({ id, createdAt, effectiveDateTaken: createdAt });
}

const sorted = (images: AppImage[]) => [...images].sort(compareCaptureOrder).map((i) => i.id);

describe("the library's order", () => {
  // The comparator exists to mirror this string. Two places state the order and
  // only one of them is sent over the wire, so the pin is the test.
  it("is the order the route asks the data server for", () => {
    expect(LIBRARY_ORDER).toBe("captured_at.desc,created_at.desc");
  });

  it("puts the newest capture first", () => {
    const older = captured("older", "2020-05-05T00:00:00.000Z");
    const newer = captured("newer", "2026-05-05T00:00:00.000Z");
    expect(sorted([older, newer])).toEqual(["newer", "older"]);
  });

  // Nulls last, matching the convention `/data/records` fixes on every ordering
  // key. A record whose capture time is unknown has no place among the ones
  // whose capture time is known, and putting it there by its import date is
  // exactly the divergence that would make a continued page arrive out of
  // order.
  it("puts records with no capture time last, however recently they arrived", () => {
    const old = captured("old", "1999-01-01T00:00:00.000Z");
    const justImported = uncaptured("just-imported", "2026-09-11T00:00:00.000Z");
    expect(sorted([justImported, old])).toEqual(["old", "just-imported"]);
  });

  it("orders the no-capture block by import time, newest first", () => {
    const earlier = uncaptured("earlier", "2026-09-01T00:00:00.000Z");
    const later = uncaptured("later", "2026-09-11T00:00:00.000Z");
    expect(sorted([earlier, later])).toEqual(["later", "earlier"]);
  });

  // The id tiebreaker the query parser appends to every ordering, and it runs
  // ascending — so two frames of one exposure come back in a stable order
  // rather than whichever the engine happened to return.
  it("breaks a tie on id, ascending", () => {
    const b = captured("bbb", "2026-05-05T00:00:00.000Z");
    const a = captured("aaa", "2026-05-05T00:00:00.000Z");
    expect(sorted([b, a])).toEqual(["aaa", "bbb"]);
  });

  // The one key the data server cannot apply: it lives in Photos' own syncable
  // table, which the records query cannot join.
  it("lets a corrected date move a photo", () => {
    const corrected = {
      ...captured("corrected", "2026-05-05T00:00:00.000Z"),
      dateTakenOverride: "1999-01-01T00:00:00.000Z",
    };
    const other = captured("other", "2020-01-01T00:00:00.000Z");
    expect(captureKey(corrected)).toBe("1999-01-01T00:00:00.000Z");
    expect(sorted([corrected, other])).toEqual(["other", "corrected"]);
  });
});

describe("date sections", () => {
  // The failure this replaced: the grid sorted its day keys, so a page ordered
  // by the server was re-ordered on arrival and a later page could open a
  // section belonging above one already on screen.
  it("follows the order the page arrived in rather than sorting the days", () => {
    render(
      <PhotoGrid
        images={[
          captured("a", "2026-09-10T12:00:00.000Z"),
          captured("b", "2026-09-09T12:00:00.000Z"),
          uncaptured("c", "2026-09-11T00:00:00.000Z"),
        ]}
        loading={false}
        hasMore={false}
        onSelect={() => {}}
        onLoadMore={() => {}}
        groupByDate
      />,
    );
    const headings = screen.getAllByText(/2026/).map((el) => el.textContent);
    expect(headings).toEqual([
      "September 10, 2026",
      "September 9, 2026",
      // The no-capture record, last, under the day it arrived — not hoisted to
      // the top by a key sort.
      "September 11, 2026",
    ]);
  });
});
