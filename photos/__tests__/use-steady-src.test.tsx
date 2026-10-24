// @vitest-environment jsdom
/**
 * One `<img>` moving between URLs without a blank frame. Before a picture has
 * drawn, the `src` follows the wanted URL at once. After, a new URL takes over
 * only once it has decoded off screen, and one that fails leaves the picture
 * where it is. See `useSteadySrc`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSteadySrc } from "../src/photos-ui/hooks/use-steady-src";

/** Each off-screen decode, by URL, settled by hand. */
let decodes: Map<string, { resolve: () => void; reject: (error: Error) => void }>;

// jsdom has no `decode`, so the tests give it one they can settle.
beforeEach(() => {
  decodes = new Map();
  Object.defineProperty(HTMLImageElement.prototype, "decode", {
    configurable: true,
    writable: true,
    value: function (this: HTMLImageElement) {
      return new Promise<void>((resolve, reject) => {
        decodes.set(this.src, { resolve, reject });
      });
    },
  });
});
afterEach(() => {
  delete (HTMLImageElement.prototype as { decode?: unknown }).decode;
});

function steady(initial: string | null) {
  const onFailure = vi.fn();
  const hook = renderHook(({ desired }) => useSteadySrc(desired, onFailure), {
    initialProps: { desired: initial },
  });
  return { ...hook, onFailure };
}

describe("useSteadySrc", () => {
  it("follows the wanted URL at once while nothing has drawn", () => {
    const { result, rerender } = steady("https://x.test/small");
    expect(result.current.src).toBe("https://x.test/small");
    rerender({ desired: "https://x.test/large" });
    expect(result.current.src).toBe("https://x.test/large");
    expect(decodes.size).toBe(0);
  });

  it("keeps the drawn picture until the new URL has decoded", async () => {
    const { result, rerender } = steady("https://x.test/small");
    act(() => result.current.onLoad());
    rerender({ desired: "https://x.test/large" });
    expect(result.current.src).toBe("https://x.test/small");

    await act(async () => decodes.get("https://x.test/large")!.resolve());
    expect(result.current.src).toBe("https://x.test/large");
    expect(result.current.shown).toBe(true);
  });

  it("leaves the drawn picture alone when the new URL fails", async () => {
    const { result, rerender, onFailure } = steady("https://x.test/small");
    act(() => result.current.onLoad());
    rerender({ desired: "https://x.test/broken" });

    await act(async () => decodes.get("https://x.test/broken")!.reject(new Error("404")));
    expect(result.current.src).toBe("https://x.test/small");
    expect(onFailure).toHaveBeenCalledWith("https://x.test/broken");
  });

  it("keeps the drawn picture when the wanted URL is withdrawn", () => {
    const { result, rerender } = steady("https://x.test/small");
    act(() => result.current.onLoad());
    rerender({ desired: null });
    expect(result.current.src).toBe("https://x.test/small");
  });

  it("drops a URL that failed before anything drew", () => {
    const { result, rerender, onFailure } = steady("https://x.test/broken");
    act(() => result.current.onError());
    expect(onFailure).toHaveBeenCalledWith("https://x.test/broken");
    rerender({ desired: null });
    expect(result.current.src).toBeNull();
  });
});
