/**
 * The Settings line about uploads: what is left, whether it is moving, and
 * what this phone can no longer send.
 */
import { describe, expect, it } from "vitest";
import type { UploaderStats } from "@starkeep/sync-engine";
import { describeUploads } from "../src/ui/upload-text";

const MB = 1024 * 1024;

function stats(over: Partial<UploaderStats> = {}): UploaderStats {
  return {
    state: "running",
    queued: { fast: { count: 0, bytes: 0 }, full: { count: 0, bytes: 0 } },
    blocked: { count: 0, bytes: 0 },
    backingOff: 0,
    inFlight: { count: 0, bytes: 0 },
    sent: { count: 0, bytes: 0 },
    ...over,
  };
}

describe("describeUploads", () => {
  it("counts both tiers as one backlog while uploading", () => {
    const line = describeUploads(
      stats({ queued: { fast: { count: 12, bytes: 2 * MB }, full: { count: 300, bytes: 178 * MB } } }),
    );
    expect(line).toBe("Uploading 312 files (180 MB)");
  });

  it("names the camera-roll files this phone can no longer send", () => {
    const line = describeUploads(
      stats({
        queued: { fast: { count: 0, bytes: 0 }, full: { count: 1, bytes: 3 * MB } },
        blocked: { count: 3, bytes: 9 * MB },
      }),
    );
    expect(line).toBe("Uploading 1 file (3.0 MB) · 3 missing from the camera roll");
  });

  it("says why nothing moves when paused or stopped", () => {
    const queued = { fast: { count: 2, bytes: 200_000 }, full: { count: 0, bytes: 0 } };
    expect(describeUploads(stats({ state: "paused", queued }))).toBe(
      "Waiting for the network to upload 2 files (195 kB)",
    );
    expect(describeUploads(stats({ state: "stopped", queued }))).toBe("2 files (195 kB) to upload on Wi-Fi");
  });

  it("says nothing when there is nothing to say", () => {
    expect(describeUploads(stats())).toBeNull();
    expect(describeUploads(null)).toBeNull();
  });
});
