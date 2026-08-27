// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_DEFAULT_ROW_HEIGHT,
  MOBILE_DEFAULT_ROW_HEIGHT,
  ROW_HEIGHT_MAX,
  useListLayoutPreferences,
} from "../src/lib/list-layout-preferences";

const STORAGE_KEY = "starkeep:photos:listLayout";

/** Pin the viewport to one side of the breakpoint for the whole render. */
function setViewport(narrow: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: narrow,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

beforeEach(() => {
  localStorage.clear();
  setViewport(false);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useListLayoutPreferences", () => {
  it("defaults to the desktop row height on a wide viewport", () => {
    const { result } = renderHook(() => useListLayoutPreferences());
    expect(result.current[0].rowHeight).toBe(DESKTOP_DEFAULT_ROW_HEIGHT);
  });

  it("defaults to the mobile row height on a phone-width viewport", () => {
    setViewport(true);
    const { result } = renderHook(() => useListLayoutPreferences());
    expect(result.current[0].rowHeight).toBe(MOBILE_DEFAULT_ROW_HEIGHT);
  });

  it("lets a chosen row height outrank the viewport at both widths", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ rowHeight: 240, groupByDate: false }));

    const wide = renderHook(() => useListLayoutPreferences());
    expect(wide.result.current[0].rowHeight).toBe(240);
    cleanup();

    setViewport(true);
    const narrow = renderHook(() => useListLayoutPreferences());
    expect(narrow.result.current[0].rowHeight).toBe(240);
  });

  it("remembers a change, and remembers it as a choice rather than a default", () => {
    const { result } = renderHook(() => useListLayoutPreferences());
    act(() => result.current[1]({ rowHeight: 260, groupByDate: true }));

    expect(result.current[0]).toEqual({ rowHeight: 260, groupByDate: true });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({
      rowHeight: 260,
      groupByDate: true,
    });
  });

  it("flat, undated view is the default", () => {
    const { result } = renderHook(() => useListLayoutPreferences());
    expect(result.current[0].groupByDate).toBe(false);
  });

  it("clamps a stored row height that is out of range, and ignores a corrupt one", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ rowHeight: 9000, groupByDate: false }));
    const clamped = renderHook(() => useListLayoutPreferences());
    expect(clamped.result.current[0].rowHeight).toBe(ROW_HEIGHT_MAX);
    cleanup();

    localStorage.setItem(STORAGE_KEY, "not json");
    const corrupt = renderHook(() => useListLayoutPreferences());
    expect(corrupt.result.current[0].rowHeight).toBe(DESKTOP_DEFAULT_ROW_HEIGHT);
  });
});
