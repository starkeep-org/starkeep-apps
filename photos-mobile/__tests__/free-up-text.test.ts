/**
 * The sentence the Storage section shows after "Free up space".
 */
import { describe, it, expect } from "vitest";
import type { FreeUpSpaceReport } from "@starkeep/sync-engine";
import { describeFreed, describeStorageGroup } from "../src/ui/free-up-text";

const MB = 1024 * 1024;

function report(over: Partial<FreeUpSpaceReport>): FreeUpSpaceReport {
  return {
    requestedBytes: Number.MAX_SAFE_INTEGER,
    freedBytes: 0,
    removed: [],
    refused: [],
    eligibleBytes: 0,
    dryRun: false,
    ...over,
  };
}

const item = (recordId: string, sizeBytes: number) => ({
  recordId,
  objectStorageKey: `shared/image/${recordId}`,
  sizeBytes,
  kind: "original" as const,
});

describe("describeFreed", () => {
  it("says why nothing was removed rather than reporting zero", () => {
    expect(describeFreed(report({}))).toMatch(/^Nothing here can be removed/);
  });

  it("reports what was freed", () => {
    const text = describeFreed(report({ freedBytes: 3 * MB, removed: [item("a", 3 * MB)] }));
    expect(text).toMatch(/^Freed 3(\.0)? MB from 1 file\(s\)\.$/);
  });

  it("states the files kept as the cloud not yet holding them", () => {
    const text = describeFreed(
      report({
        freedBytes: MB,
        removed: [item("a", MB)],
        refused: [{ ...item("b", MB), reason: "not-durable", detail: "" }],
      }),
    );
    expect(text).toContain("kept 1 that the cloud could not yet be shown to hold");
  });

  it("speaks conditionally about a dry run", () => {
    expect(describeFreed(report({ dryRun: true, freedBytes: MB, removed: [item("a", MB)] }))).toMatch(
      /^Would free/,
    );
  });
});

describe("describeStorageGroup", () => {
  it("names previews, originals and the files every device keeps", () => {
    expect(describeStorageGroup("stand-in:image")).toBe("Photo previews");
    expect(describeStorageGroup("original:video")).toBe("Video originals");
    expect(describeStorageGroup("kept")).toBe("Other files, kept on every device");
  });
});
