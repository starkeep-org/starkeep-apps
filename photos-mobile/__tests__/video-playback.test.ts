import { describe, expect, it } from "vitest";
import {
  createDataRecord,
  createHLCClock,
  DEFAULT_STAND_IN_STANDARDS,
  type DataRecord,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import { chooseVideoPlayback, videoCopies, type VideoCopy } from "../src/photos/video-playback";

const clock = createHLCClock({ nodeId: "phone" });
const EDGES = DEFAULT_STAND_IN_STANDARDS.video.advisoryLongEdges;

function standIn(kbps: number, role: "smaller" | "canonical"): DataRecord {
  return createDataRecord(
    {
      type: "video/webm",
      originAppId: "photos",
      parentId: "Z0RIGINAL0000000000000000" as StarkeepId,
      contentHash: String(kbps).padStart(64, "0"),
      objectStorageKey: `shared/video/${kbps}`,
      sizeBytes: kbps * 1000,
      originalFilename: null,
      standInRole: role,
      fidelity: kbps,
    },
    clock,
  );
}

const copy = (kbps: number, longEdge: number | null, resident: boolean): VideoCopy => ({
  id: `Z${kbps}` as VideoCopy["id"],
  objectStorageKey: `shared/video/${kbps}`,
  kbps,
  longEdge,
  resident,
});

describe("videoCopies", () => {
  it("reads each copy's frame size off the library's advisory long edges", () => {
    const copies = videoCopies([standIn(4800, "canonical"), standIn(2000, "smaller")], {
      edges: EDGES,
      sourceLongEdge: 3840,
      isResident: () => false,
    });
    expect(copies.map((c) => [c.kbps, c.longEdge])).toEqual([
      [2000, 1280],
      [4800, 1920],
    ]);
  });

  // The encoder never upscales, so a 720p source makes a 720p canonical copy.
  it("caps a copy's frame at the original's own long edge", () => {
    const copies = videoCopies([standIn(4800, "canonical")], {
      edges: EDGES,
      sourceLongEdge: 1280,
      isResident: () => false,
    });
    expect(copies[0]!.longEdge).toBe(1280);
  });

  it("knows no frame size for a bitrate the standards do not name", () => {
    const copies = videoCopies([standIn(3000, "smaller")], {
      edges: EDGES,
      sourceLongEdge: 1920,
      isResident: () => false,
    });
    expect(copies[0]!.longEdge).toBeNull();
  });
});

describe("chooseVideoPlayback", () => {
  const p720 = (resident: boolean) => copy(2000, 1280, resident);
  const p1080 = (resident: boolean) => copy(4800, 1920, resident);

  it("plays the original when it is here, and fetches nothing", () => {
    expect(chooseVideoPlayback([p720(false), p1080(false)], 1170, true)).toEqual({ play: null, fetch: null });
  });

  it("fetches the smallest copy that covers the stage, not a larger one", () => {
    expect(chooseVideoPlayback([p720(false), p1080(false)], 1170, false)).toEqual({
      play: null,
      fetch: p720(false),
    });
  });

  it("fetches the larger copy when the smaller one does not cover the stage", () => {
    expect(chooseVideoPlayback([p720(false), p1080(false)], 1638, false).fetch).toEqual(p1080(false));
  });

  it("plays a resident copy that covers the stage without fetching", () => {
    expect(chooseVideoPlayback([p720(false), p1080(true)], 1170, false)).toEqual({
      play: p1080(true),
      fetch: null,
    });
  });

  it("plays a smaller resident copy while the covering one is fetched", () => {
    expect(chooseVideoPlayback([p720(true), p1080(false)], 1638, false)).toEqual({
      play: p720(true),
      fetch: p1080(false),
    });
  });

  it("fetches the largest copy when none covers the stage", () => {
    expect(chooseVideoPlayback([p720(false), p1080(false)], 3000, false).fetch).toEqual(p1080(false));
  });

  it("has nothing to say for a video with no copies", () => {
    expect(chooseVideoPlayback([], 1170, false)).toEqual({ play: null, fetch: null });
  });
});
