import { describe, expect, it } from "vitest";
import type { AppImage } from "../src/photos-lib/client";
import { hasAwaitingRenditions } from "../src/lib/rendition-freshness";

function imageWithIdeal(
  ideal: { longEdge: number; available: boolean; state?: "pending" | "undecodable-here" },
): AppImage {
  return {
    renditions: { "540": { ideal } },
  } as unknown as AppImage;
}

describe("rendition freshness", () => {
  it("requires full refreshes for a provisional pending decision", () => {
    expect(
      hasAwaitingRenditions([
        imageWithIdeal({ longEdge: 540, available: false, state: "pending" }),
      ]),
    ).toBe(true);
  });

  it("stops when the ideal is available or cannot be derived here", () => {
    expect(hasAwaitingRenditions([imageWithIdeal({ longEdge: 540, available: true })])).toBe(false);
    expect(
      hasAwaitingRenditions([
        imageWithIdeal({ longEdge: 540, available: false, state: "undecodable-here" }),
      ]),
    ).toBe(false);
  });
});
