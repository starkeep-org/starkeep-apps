// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useHideOnScrollDown } from "../src/lib/use-hide-on-scroll-down";

function scrollTo(y: number) {
  act(() => {
    Object.defineProperty(window, "scrollY", { configurable: true, value: y });
    window.dispatchEvent(new Event("scroll"));
  });
}

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
});

describe("useHideOnScrollDown", () => {
  it("hides on the way down and comes back on the way up", () => {
    const { result } = renderHook(() => useHideOnScrollDown(true));
    expect(result.current).toBe(false);

    scrollTo(600);
    expect(result.current).toBe(true);

    scrollTo(500);
    expect(result.current).toBe(false);
  });

  it("stays shown near the top of the page", () => {
    const { result } = renderHook(() => useHideOnScrollDown(true));
    // Downward, but not yet far enough down for a hidden header to be worth
    // the screen it saves.
    scrollTo(40);
    expect(result.current).toBe(false);
  });

  it("ignores movement small enough to be jitter", () => {
    const { result } = renderHook(() => useHideOnScrollDown(true));
    scrollTo(600);
    expect(result.current).toBe(true);

    // A few pixels of trackpad rubber-banding upward must not flick the header
    // back into view.
    scrollTo(597);
    expect(result.current).toBe(true);
  });

  it("never hides when disabled, and unhides if it is disabled mid-scroll", () => {
    const { result, rerender } = renderHook(({ on }) => useHideOnScrollDown(on), {
      initialProps: { on: true },
    });
    scrollTo(600);
    expect(result.current).toBe(true);

    // A rotation or a window resize past the breakpoint must not leave the
    // header parked off-screen.
    rerender({ on: false });
    expect(result.current).toBe(false);

    scrollTo(1200);
    expect(result.current).toBe(false);
  });
});
