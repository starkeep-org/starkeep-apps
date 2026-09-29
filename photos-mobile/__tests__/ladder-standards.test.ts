/**
 * Photos' ladder against the platform's stand-in standards.
 *
 * `@starkeep/photos-ladder` restates the standards rather than importing them:
 * the web app builds against the *published* protocol package, which can lag
 * core. A restated number that drifts produces stand-ins the platform refuses
 * at write — every rung, on every node. So the restatement is pinned here, in
 * the one package that links core's working tree.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_STAND_IN_STANDARDS } from "@starkeep/protocol-primitives";
import {
  ARCHIVE_SIZE_FLOOR_BYTES,
  IMAGE_CANONICAL_THRESHOLD,
  STAND_IN_MIN_QUALITY,
  STILL_LADDER,
  VIDEO_CANONICAL_THRESHOLD,
  VIDEO_LADDER,
  VIDEO_STAND_IN_CRF,
} from "@starkeep/photos-ladder";

const image = DEFAULT_STAND_IN_STANDARDS.image;
const video = DEFAULT_STAND_IN_STANDARDS.video;

describe("Photos' ladder restates the platform's standards", () => {
  it("uses the image canonical threshold and size floor", () => {
    expect(IMAGE_CANONICAL_THRESHOLD).toBe(image.canonicalThreshold);
    expect(ARCHIVE_SIZE_FLOOR_BYTES).toBe(image.sizeFloorBytes);
  });

  it("puts every smaller still rung at a standard size, and the canonical rung at the threshold", () => {
    const smaller = STILL_LADDER.filter((s) => s.role === "smaller").map((s) => s.maxLongEdge);
    expect(smaller).toEqual([...image.standardSizes]);
    const canonical = STILL_LADDER.filter((s) => s.role === "canonical").map((s) => s.maxLongEdge);
    expect(canonical).toEqual([image.canonicalThreshold]);
  });

  it("encodes at the minimum image quality", () => {
    expect(STAND_IN_MIN_QUALITY).toBe(image.minimumQuality!.value);
  });

  it("uses the video canonical threshold, standard sizes and CRF", () => {
    expect(VIDEO_CANONICAL_THRESHOLD).toBe(video.canonicalThreshold);
    const transcodes = VIDEO_LADDER.filter((v) => v.kind === "transcode");
    expect(transcodes.filter((v) => v.role === "smaller").map((v) => v.maxLongEdge)).toEqual([
      ...video.standardSizes,
    ]);
    expect(transcodes.filter((v) => v.role === "canonical").map((v) => v.maxLongEdge)).toEqual([
      video.canonicalThreshold,
    ]);
    expect(VIDEO_STAND_IN_CRF).toBe(video.minimumQuality!.value);
  });
});
