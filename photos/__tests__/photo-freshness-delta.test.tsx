// @vitest-environment jsdom
/**
 * The incremental delta's watermark, and the loop that keeps it honest.
 *
 * `listPhotosSince` asks for everything above a watermark and the hook then
 * moves that watermark to the maximum `updated_at` of what came back. That is
 * only safe when the page is a *prefix* of the changed set, which is why the
 * route cuts the delta in `updated_at` order — see the `updated_after` branch
 * of `app/api/photos/library/route.ts`, pinned by
 * `cloud-data-path.integration.test.ts`.
 *
 * What this file covers is the other half. A page that reports `hasMore` and is
 * not followed leaves the remainder to arrive one page per poll interval, and
 * until the ordering fix it was never offered again at all: the watermark had
 * already moved past it. These cases assert the hook drains instead.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";

const listPhotos = vi.fn();
const listPhotosSince = vi.fn();
const listDeletedPhotosSince = vi.fn();

vi.mock("../src/lib/data-server-client", () => ({
  listPhotos: (...args: unknown[]) => listPhotos(...args),
  listPhotosSince: (...args: unknown[]) => listPhotosSince(...args),
  listDeletedPhotosSince: (...args: unknown[]) => listDeletedPhotosSince(...args),
  getLatestLibraryPolicies: () => null,
}));

// The hook picks SSE over polling from runtime config. Neither is under test
// here — every case drives the delta through the returned `kick`.
vi.mock("../src/lib/runtime-config", () => ({ fetchRuntimeConfig: async () => null }));

import { usePhotoFreshness } from "../src/lib/usePhotoFreshness";

/** One record as the route renders it: an id and the HLC wall clock in ISO. */
function record(id: string, updatedAt: string) {
  return { id, type: "image/jpeg", mime_type: "image/jpeg", updated_at: updatedAt, metadata: null };
}

function page(records: unknown[], hasMore: boolean) {
  return { records, hasMore };
}

/**
 * Let every pending continuation run.
 *
 * The "stops" cases assert a call count *stayed* put, and `waitFor` alone
 * cannot show that: it polls until an assertion passes, so it would happily
 * observe the first request before a loop issued the second. Draining the
 * queues first makes the count final rather than merely current.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

let merged: string[][];

function mount() {
  merged = [];
  return renderHook(() =>
    usePhotoFreshness({
      onInitialLoad: () => {},
      onMerge: (images) => merged.push(images.map((i) => i.id)),
      onLoadingChange: () => {},
      onError: () => {},
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // The first load seeds the cursor; every case starts from one already set.
  listPhotos.mockResolvedValue([record("seed", "2026-09-01T00:00:00.000Z")]);
  listDeletedPhotosSince.mockResolvedValue(page([], false));
  globalThis.EventSource = class {
    close() {}
  } as unknown as typeof EventSource;
});

afterEach(cleanup);

describe("the delta watermark", () => {
  it("keeps asking while the server says there is more", async () => {
    listPhotosSince
      .mockResolvedValueOnce(page([record("a", "2026-09-02T00:00:00.000Z")], true))
      .mockResolvedValueOnce(page([record("b", "2026-09-03T00:00:00.000Z")], true))
      .mockResolvedValueOnce(page([record("c", "2026-09-04T00:00:00.000Z")], false));

    const { result } = mount();
    await waitFor(() => expect(listPhotos).toHaveBeenCalled());
    await result.current.kick();

    await waitFor(() => expect(listPhotosSince).toHaveBeenCalledTimes(3));
    await settle();
    // Each request carries the previous page's maximum, so the walk advances
    // rather than re-reading the same rows.
    expect(listPhotosSince.mock.calls.map((c) => c[0])).toEqual([
      "2026-09-01T00:00:00.000Z",
      "2026-09-02T00:00:00.000Z",
      "2026-09-03T00:00:00.000Z",
    ]);
    expect(merged).toEqual([["a"], ["b"], ["c"]]);
  });

  it("stops after one page when the server says there is no more", async () => {
    listPhotosSince.mockResolvedValue(page([record("a", "2026-09-02T00:00:00.000Z")], false));

    const { result } = mount();
    await waitFor(() => expect(listPhotos).toHaveBeenCalled());
    await result.current.kick();

    await waitFor(() => expect(listPhotosSince).toHaveBeenCalled());
    await settle();
    expect(listPhotosSince).toHaveBeenCalledTimes(1);
    expect(merged).toEqual([["a"]]);
  });

  // The loop's own termination guard. A server that reports `hasMore` while
  // returning rows at or below the bound it was given would otherwise spin:
  // the next request carries the same watermark and returns the same rows.
  it("stops when a page does not move the watermark, however `hasMore` reads", async () => {
    listPhotosSince.mockResolvedValue(page([record("a", "2026-09-01T00:00:00.000Z")], true));

    const { result } = mount();
    await waitFor(() => expect(listPhotos).toHaveBeenCalled());
    await result.current.kick();

    await waitFor(() => expect(listPhotosSince).toHaveBeenCalled());
    await settle();
    expect(listPhotosSince).toHaveBeenCalledTimes(1);
  });

  it("stops on an empty page", async () => {
    listPhotosSince.mockResolvedValue(page([], true));

    const { result } = mount();
    await waitFor(() => expect(listPhotos).toHaveBeenCalled());
    await result.current.kick();

    await waitFor(() => expect(listPhotosSince).toHaveBeenCalled());
    await settle();
    expect(listPhotosSince).toHaveBeenCalledTimes(1);
    expect(merged).toEqual([]);
  });

  // A backlog larger than the cap costs an extra tick rather than an unbounded
  // one. The cursor is left where the last page put it, so the next kick
  // resumes from there.
  it("bounds one tick at MAX_DELTA_PAGES", async () => {
    let day = 1;
    listPhotosSince.mockImplementation(async () => {
      day += 1;
      return page(
        [record(`r${day}`, `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`)],
        true,
      );
    });

    const { result } = mount();
    await waitFor(() => expect(listPhotos).toHaveBeenCalled());
    await result.current.kick();

    await waitFor(() => expect(listPhotosSince).toHaveBeenCalledTimes(20));
    await settle();
    expect(listPhotosSince).toHaveBeenCalledTimes(20);
  });
});

describe("a kick that moves no parent", () => {
  // A poster or a stand-in arrives as a child record. The delta excludes it and
  // the parent's `updated_at` stays put, so the page comes back empty — and the
  // kick is still the only signal the tiles waiting on it will get.
  it("re-asks the waiting tiles anyway", async () => {
    listPhotosSince.mockResolvedValue(page([], false));
    const refreshActiveResolutions = vi.fn();
    const { result } = renderHook(() =>
      usePhotoFreshness({
        onInitialLoad: () => {},
        onMerge: () => {},
        onLoadingChange: () => {},
        onError: () => {},
        refreshActiveResolutions,
      }),
    );
    await waitFor(() => expect(listPhotos).toHaveBeenCalled());
    const before = refreshActiveResolutions.mock.calls.length;
    await result.current.kick();
    await settle();
    expect(refreshActiveResolutions.mock.calls.length).toBeGreaterThan(before);
  });
});

describe("the deletion feed", () => {
  let removed: string[][];

  function mountWithRemove() {
    removed = [];
    return renderHook(() =>
      usePhotoFreshness({
        onInitialLoad: () => {},
        onMerge: () => {},
        onRemove: (ids) => removed.push(ids),
        onLoadingChange: () => {},
        onError: () => {},
      }),
    );
  }

  // A record tombstoned on another node never appears in the live delta, so
  // without this feed an open page shows it beside whatever replaced it.
  it("removes records deleted since the full list, starting from its watermark", async () => {
    listPhotosSince.mockResolvedValue(page([], false));
    listDeletedPhotosSince.mockResolvedValueOnce(
      page([record("old-1", "2026-09-02T00:00:00.000Z"), record("old-2", "2026-09-03T00:00:00.000Z")], false),
    );

    const { result } = mountWithRemove();
    await waitFor(() => expect(listPhotos).toHaveBeenCalled());
    await result.current.kick();

    await waitFor(() => expect(removed).toEqual([["old-1", "old-2"]]));
    expect(listDeletedPhotosSince.mock.calls[0]![0]).toBe("2026-09-01T00:00:00.000Z");
  });

  it("walks on from the newest deletion it has seen, on its own watermark", async () => {
    listPhotosSince.mockResolvedValue(page([record("new", "2026-09-10T00:00:00.000Z")], false));
    listDeletedPhotosSince
      .mockResolvedValueOnce(page([record("old-1", "2026-09-02T00:00:00.000Z")], true))
      .mockResolvedValueOnce(page([record("old-2", "2026-09-03T00:00:00.000Z")], false))
      .mockResolvedValue(page([], false));

    const { result } = mountWithRemove();
    await waitFor(() => expect(listPhotos).toHaveBeenCalled());
    await result.current.kick();
    await settle();
    await result.current.kick();
    await settle();

    // The live delta moved its watermark to 09-10. The deletion feed did not
    // follow it, so a deletion stamped earlier than that live change is not lost.
    expect(listDeletedPhotosSince.mock.calls.map((c) => c[0])).toEqual([
      "2026-09-01T00:00:00.000Z",
      "2026-09-02T00:00:00.000Z",
      "2026-09-03T00:00:00.000Z",
    ]);
    expect(removed).toEqual([["old-1"], ["old-2"]]);
  });

  it("is not read by a caller that cannot remove anything", async () => {
    listPhotosSince.mockResolvedValue(page([], false));

    const { result } = mount();
    await waitFor(() => expect(listPhotos).toHaveBeenCalled());
    await result.current.kick();
    await settle();

    expect(listDeletedPhotosSince).not.toHaveBeenCalled();
  });
});
