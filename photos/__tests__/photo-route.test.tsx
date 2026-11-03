// @vitest-environment jsdom
/**
 * The open photo, kept in the URL.
 *
 * The viewer used to be React state alone, so Back left the app instead of
 * closing it. These pin the three moves and what each writes to history:
 * opening pushes, stepping replaces, and closing goes back only over an entry
 * this page pushed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

async function load(basePath = "") {
  vi.resetModules();
  vi.stubEnv("STARKEEP_APP_BASE_PATH", basePath);
  return import("../src/lib/photo-route");
}

/** Resolves on the `popstate` that `history.back()` fires asynchronously. */
function nextPopState(): Promise<void> {
  return new Promise((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  window.history.replaceState(null, "", "/");
});

describe("photoIdFromPath", () => {
  it("reads the id from a photo path and nothing from any other", async () => {
    const { photoIdFromPath, photoPath } = await load();
    expect(photoIdFromPath("/photo/abc")).toBe("abc");
    expect(photoIdFromPath(photoPath("a b/c"))).toBe("a b/c");
    for (const path of ["/", "/sign-in", "/photo/", "/photo/abc/extra", "/photo/%E0%A4%A"]) {
      expect(photoIdFromPath(path), path).toBeNull();
    }
  });

  it("strips the cloud mount before reading, and writes it back", async () => {
    const { photoIdFromPath, photoPath } = await load("/apps/photos");
    expect(photoPath("abc")).toBe("/apps/photos/photo/abc");
    expect(photoIdFromPath("/apps/photos/photo/abc")).toBe("abc");
  });
});

describe("usePhotoRoute", () => {
  it("opens the photo a link names", async () => {
    window.history.replaceState(null, "", "/photo/linked");
    const { usePhotoRoute } = await load();
    const { result } = renderHook(() => usePhotoRoute());
    expect(result.current.photoId).toBe("linked");
  });

  it("pushes on open, so Back closes the viewer", async () => {
    const { usePhotoRoute } = await load();
    const { result } = renderHook(() => usePhotoRoute());
    const before = window.history.length;

    act(() => result.current.open("a"));
    expect(window.location.pathname).toBe("/photo/a");
    expect(window.history.length).toBe(before + 1);

    const popped = nextPopState();
    window.history.back();
    await act(() => popped);
    expect(window.location.pathname).toBe("/");
    expect(result.current.photoId).toBeNull();
  });

  it("replaces on a step, so Back skips the photos stepped through", async () => {
    const { usePhotoRoute } = await load();
    const { result } = renderHook(() => usePhotoRoute());
    act(() => result.current.open("a"));
    const before = window.history.length;

    act(() => result.current.step("b"));
    act(() => result.current.step("c"));
    expect(window.location.pathname).toBe("/photo/c");
    expect(result.current.photoId).toBe("c");
    expect(window.history.length).toBe(before);
  });

  it("closes by going back over an entry it pushed, through steps", async () => {
    const { usePhotoRoute } = await load();
    const { result } = renderHook(() => usePhotoRoute());
    act(() => result.current.open("a"));
    act(() => result.current.step("b"));

    const popped = nextPopState();
    act(() => result.current.close());
    // Closed at once, not on the later `popstate`.
    expect(result.current.photoId).toBeNull();
    await act(() => popped);
    expect(window.location.pathname).toBe("/");
    expect(result.current.photoId).toBeNull();
  });

  it("closes a linked photo by replacing it with the grid, not by leaving the app", async () => {
    window.history.replaceState(null, "", "/photo/linked");
    const { usePhotoRoute } = await load();
    const { result } = renderHook(() => usePhotoRoute());
    const before = window.history.length;
    const back = vi.spyOn(window.history, "back");

    act(() => result.current.close());
    expect(back).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/");
    expect(window.history.length).toBe(before);
    expect(result.current.photoId).toBeNull();
  });

  it("closes to the app's mount in the cloud", async () => {
    window.history.replaceState(null, "", "/apps/photos/photo/linked");
    const { usePhotoRoute } = await load("/apps/photos");
    const { result } = renderHook(() => usePhotoRoute());
    expect(result.current.photoId).toBe("linked");

    act(() => result.current.close());
    expect(window.location.pathname).toBe("/apps/photos");
  });
});
