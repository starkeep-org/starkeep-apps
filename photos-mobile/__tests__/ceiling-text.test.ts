import { describe, expect, it } from "vitest";
import { ceilingLabel } from "../src/ui/ceiling-text";

describe("ceilingLabel", () => {
  it("names a size in the category's unit", () => {
    expect(ceilingLabel("image", 1280, 4272)).toBe("1280 px");
    expect(ceilingLabel("video", 2000, 4800)).toBe("2000 kbps");
  });

  it("marks the canonical size, and names no ceiling", () => {
    expect(ceilingLabel("video", 4800, 4800)).toBe("4800 kbps (canonical)");
    expect(ceilingLabel("image", null, 4272)).toBe("None");
  });
});
