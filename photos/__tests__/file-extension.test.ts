/**
 * Tier-0 tests for the client-side extension helper — apps record the file's
 * true extension as the record type, so this is grant-relevant.
 */
import { describe, it, expect } from "vitest";
import { extensionFromFilename } from "../src/lib/file-extension";

describe("extensionFromFilename", () => {
  it("extracts and lowercases the extension", () => {
    expect(extensionFromFilename("Sunset.JPG")).toBe("jpg");
    expect(extensionFromFilename("a/b/c/photo.png")).toBe("png");
    expect(extensionFromFilename("archive.tar.gz")).toBe("gz");
  });

  it("returns undefined when there is no usable extension", () => {
    expect(extensionFromFilename("README")).toBeUndefined();
    expect(extensionFromFilename(".gitignore")).toBeUndefined();
    expect(extensionFromFilename("trailing-dot.")).toBeUndefined();
    expect(extensionFromFilename("")).toBeUndefined();
    expect(extensionFromFilename(null)).toBeUndefined();
    expect(extensionFromFilename(undefined)).toBeUndefined();
  });

  it("uses only the basename, not dots in directories", () => {
    expect(extensionFromFilename("v1.2/file")).toBeUndefined();
  });
});
