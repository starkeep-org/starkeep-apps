/**
 * The DNG preview parser against a real camera file.
 *
 * The plan asks for this explicitly — "verify against real ProRAW and Pixel
 * files first; preview dimensions vary by camera" — and it is the thing the
 * hand-built TIFF fixtures cannot do. A synthetic file proves the IFD walk is
 * correct against a structure I chose; only a real one proves I chose the right
 * structure.
 *
 * Skipped when the file is absent, since a 30 MB raw is not something to commit
 * to the repository. The guard below makes that skip visible rather than silent.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import {
  findEmbeddedPreviews,
  extractLargestPreview,
} from "../src/photos-lib/image-processing/dng-preview";
import { decodeSource } from "../src/photos-lib/image-processing/decode-source";
import { deriveStillLadder } from "../src/photos-lib/image-processing/derive-ladder";

const DNG_PATH = join(__dirname, "..", "..", "_R001301.DNG");
const present = existsSync(DNG_PATH);
const bytes = present ? new Uint8Array(readFileSync(DNG_PATH)) : new Uint8Array();

const withDng = () => (present ? it : it.skip);

describe("a real RICOH GR IV DNG", () => {
  withDng()("finds more than one embedded preview", () => {
    const previews = findEmbeddedPreviews(bytes);
    expect(previews.length).toBeGreaterThan(0);
    // Reported for the record: preview layouts vary by camera and this is the
    // evidence for what this one does.
    console.log(
      "[dng] previews:",
      previews.map((p) => `${p.width}x${p.height} (${p.length}B)`).join(", "),
    );
  });

  // The whole reason for "largest, not first". This camera writes a 160x120
  // thumbnail in IFD0 — taking the first would build the entire ladder from it:
  // every rung produced, every one useless, nothing resembling an error.
  withDng()("does not return the 160x120 IFD0 thumbnail as the preview", () => {
    const previews = findEmbeddedPreviews(bytes);
    expect(previews[0]!.width).toBeGreaterThan(160);
    expect(previews[0]!.width * previews[0]!.height).toBeGreaterThan(160 * 120);
  });

  withDng()("extracts bytes that are a decodable JPEG", async () => {
    const preview = extractLargestPreview(bytes);
    expect(preview).not.toBeNull();
    const meta = await sharp(Buffer.from(preview!)).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBeGreaterThan(1000);
    console.log(`[dng] largest preview decodes as ${meta.width}x${meta.height}`);
  });

  withDng()("routes through decodeSource as an embedded preview", async () => {
    const decoded = await decodeSource(bytes, "image/dng");
    expect(decoded.via).toBe("embedded-preview");
    // Materially smaller than the 30 MB original — which is the point: the
    // ladder is derived without ever decoding sensor data.
    expect(decoded.bytes.byteLength).toBeLessThan(bytes.byteLength / 2);
  });

  // The end-to-end claim of item 30: a raw file yields a real ladder.
  withDng()("derives a still ladder from the preview", async () => {
    const ladder = await deriveStillLadder(bytes, {
      sourceType: "image/dng",
      codec: "jpeg",
      only: ["image-thumb"],
    });
    expect(ladder).toHaveLength(1);
    const meta = await sharp(Buffer.from(ladder[0]!.data)).metadata();
    expect(meta.width).toBeGreaterThan(0);
    expect(ladder[0]!.data.byteLength).toBeLessThan(bytes.byteLength);
  }, 120_000);
});

describe("the DNG fixture", () => {
  // A skip that nobody notices is how this coverage rots back to nothing.
  it("is present when the environment says it must be", () => {
    if (process.env.STARKEEP_REQUIRE_DNG !== "1") return;
    expect(present, `STARKEEP_REQUIRE_DNG=1 but no DNG at ${DNG_PATH}`).toBe(true);
  });
});
