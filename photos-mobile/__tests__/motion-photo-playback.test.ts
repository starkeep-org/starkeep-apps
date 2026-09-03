/**
 * Playing a Motion Photo, and keeping nothing afterwards.
 *
 * The claim under test is one about *absence*: opening the clip writes exactly
 * one scratch file, releasing it takes that file away, and nothing else on this
 * device changes. A Motion Photo costs what a still costs, because the video was
 * always inside the JPEG — and that property is easy to satisfy on day one and
 * easy to lose later to a well-meaning cache.
 *
 * The second half is the read this avoids. Most photographs are not Motion
 * Photos, so the ordinary case must not open a file at all — which is what the
 * index and its marker are for.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createDataRecord, createHLCClock, type DataRecord } from "@starkeep/protocol-primitives";
import type { ObjectStorageAdapter, RawDatabase } from "@starkeep/storage-adapter";
import {
  MOTION_SCRATCH_SEGMENTS,
  openMotionPhoto,
  sweepMotionScratch,
  type MotionPhotoDeps,
} from "../src/media/motion-photo-playback";
import {
  createSqliteMotionIndexStore,
  type MotionIndexStore,
} from "../src/media/motion-index";
import { createSqliteMediaAliasStore, type MediaAliasStore } from "../src/media/media-alias";
import { fakeExpoFs } from "./helpers/fake-expo-fs";

const encoder = new TextEncoder();
const clock = createHLCClock({ nodeId: "phone" });

function rawDb(): RawDatabase {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => {
      const stmt = db.prepare(sql);
      return {
        run: (...p: unknown[]) => stmt.run(...(p as never[])),
        get: (...p: unknown[]) => stmt.get(...(p as never[])),
        all: (...p: unknown[]) => stmt.all(...(p as never[])),
      };
    },
  };
}

/** The same fixture shape `motion-photo.test.ts` builds: an `ftyp` box. */
function fakeMp4(size: number): Uint8Array {
  const out = new Uint8Array(size);
  out.set([0x00, 0x00, 0x00, 0x18], 0);
  out.set(encoder.encode("ftyp"), 4);
  out.set(encoder.encode("mp42"), 8);
  out[size - 1] = 0xab;
  return out;
}

function buildJpeg(xmpBody: string, trailers: Uint8Array[] = []): Uint8Array {
  const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/">${xmpBody}</x:xmpmeta>`;
  const head = new Uint8Array(2 + xmp.length + 64);
  head.set([0xff, 0xd8], 0);
  head.set(encoder.encode(xmp), 2);
  const total = head.byteLength + trailers.reduce((n, t) => n + t.byteLength, 0);
  const out = new Uint8Array(total);
  out.set(head, 0);
  let at = head.byteLength;
  for (const t of trailers) {
    out.set(t, at);
    at += t.byteLength;
  }
  return out;
}

/** A v1 Motion Photo: the offset is a length back from the end of the file. */
function motionPhoto(clipSize = 256): Uint8Array {
  const clip = fakeMp4(clipSize);
  return buildJpeg(
    `<rdf:RDF GCamera:MicroVideoOffset="${clipSize}" ` +
      `GCamera:MicroVideoPresentationTimestampUs="1500000"/>`,
    [clip],
  );
}

const CACHE = "file:///cache";
const cachePath = (...segments: string[]) => [CACHE, ...segments].join("/");
const SCRATCH_DIR = cachePath(...MOTION_SCRATCH_SEGMENTS);

let harness: ReturnType<typeof fakeExpoFs>;
let index: MotionIndexStore;
let aliases: MediaAliasStore;
/** Which key resolves to which file, standing in for the node's overlay. */
let placed: Map<string, string>;

const objectStorage = {
  localFileUriFor: (key: string) => placed.get(key) ?? null,
} as unknown as ObjectStorageAdapter;

function deps(): MotionPhotoDeps {
  return { fs: harness.fs, index, objectStorage, aliases, cachePath };
}

let seq = 0;
function recordFor(bytes: Uint8Array, uri: string): DataRecord {
  seq += 1;
  const record = createDataRecord(
    {
      type: "image/jpeg",
      originAppId: "photos",
      contentHash: String(seq).padStart(64, "0"),
      objectStorageKey: `shared/image/${String(seq).padStart(64, "0")}`,
      sizeBytes: bytes.byteLength,
      originalFilename: `IMG_000${seq}.jpg`,
    },
    clock,
  );
  const file = harness.fs.file(uri);
  file.create({ intermediates: true, overwrite: true });
  file.write(bytes);
  placed.set(record.objectStorageKey!, uri);
  return record;
}

beforeEach(() => {
  harness = fakeExpoFs();
  index = createSqliteMotionIndexStore({ db: rawDb() });
  aliases = createSqliteMediaAliasStore({ db: rawDb() });
  placed = new Map();
  seq = 0;
});

describe("opening the clip", () => {
  it("materialises the embedded video as a file a player can open", async () => {
    const bytes = motionPhoto();
    const record = recordFor(bytes, "file:///objects/photo.jpg");

    const opened = await openMotionPhoto(deps(), record);

    expect(opened).not.toBeNull();
    const written = harness.files.get(opened!.uri);
    // The clip's own bytes, not the photograph's. The distinctive tail byte is
    // what makes "did we get *this* buffer" answerable.
    expect(written?.byteLength).toBe(256);
    expect(written?.[written.byteLength - 1]).toBe(0xab);
  });

  it("carries the frame the camera chose as the photograph", async () => {
    const record = recordFor(motionPhoto(), "file:///objects/photo.jpg");
    const opened = await openMotionPhoto(deps(), record);
    expect(opened?.presentationTimestampUs).toBe(1_500_000);
  });

  it("reports no timestamp when the XMP stated none", async () => {
    const clip = fakeMp4(128);
    const bytes = buildJpeg(`<rdf:RDF GCamera:MicroVideoOffset="128"/>`, [clip]);
    const record = recordFor(bytes, "file:///objects/plain.jpg");

    const opened = await openMotionPhoto(deps(), record);

    expect(opened?.presentationTimestampUs).toBeNull();
  });

  it("writes exactly one file and leaves the photograph untouched", async () => {
    const record = recordFor(motionPhoto(), "file:///objects/photo.jpg");
    const before = [...harness.files.keys()];

    const opened = await openMotionPhoto(deps(), record);

    const after = [...harness.files.keys()];
    expect(after).toHaveLength(before.length + 1);
    expect(after).toContain(opened!.uri);
  });
});

describe("releasing it", () => {
  it("deletes the scratch file, so a Motion Photo costs what a still costs", async () => {
    const record = recordFor(motionPhoto(), "file:///objects/photo.jpg");
    const opened = await openMotionPhoto(deps(), record);

    opened!.release();

    expect(harness.files.has(opened!.uri)).toBe(false);
  });

  it("is safe to call twice", async () => {
    // A viewer can close while a background transition is releasing the same
    // handle, and a throw there would take the screen down with it.
    const record = recordFor(motionPhoto(), "file:///objects/photo.jpg");
    const opened = await openMotionPhoto(deps(), record);

    opened!.release();
    expect(() => opened!.release()).not.toThrow();
  });
});

describe("the ordinary photograph", () => {
  it("answers null for a JPEG with no motion", async () => {
    const record = recordFor(buildJpeg(`<rdf:RDF/>`), "file:///objects/still.jpg");
    expect(await openMotionPhoto(deps(), record)).toBeNull();
  });

  it("remembers that it looked, so the read is not paid for twice", async () => {
    const record = recordFor(buildJpeg(`<rdf:RDF/>`), "file:///objects/still.jpg");

    await openMotionPhoto(deps(), record);

    expect(index.scanned(record.objectStorageKey!)).toBe(true);
    expect(index.get(record.objectStorageKey!)).toBeNull();
  });

  it("does not open the file at all once import has covered the record", async () => {
    // The point of the marker: import scanned every JPEG it read, so for a
    // record imported after it the absence of a row *is* the answer, and the
    // viewer opens no file to rediscover it.
    const record = recordFor(motionPhoto(), "file:///objects/photo.jpg");
    index.markScannedFrom(1_000);
    aliases.add({
      objectStorageKey: record.objectStorageKey!,
      recordId: record.id,
      contentUri: "content://media/external/images/media/1",
      assetId: "content://media/external/images/media/1",
      sizeBytes: 10,
      contentType: null,
      modificationTimeMs: 1_000,
      addedAtMs: 2_000,
    });

    expect(await openMotionPhoto(deps(), record)).toBeNull();
    expect(index.scanned(record.objectStorageKey!)).toBe(false);
  });

  it("still looks at a record this node imported before the marker", async () => {
    const record = recordFor(motionPhoto(), "file:///objects/photo.jpg");
    index.markScannedFrom(5_000);
    aliases.add({
      objectStorageKey: record.objectStorageKey!,
      recordId: record.id,
      contentUri: "content://media/external/images/media/1",
      assetId: "content://media/external/images/media/1",
      sizeBytes: 10,
      contentType: null,
      modificationTimeMs: 1_000,
      addedAtMs: 2_000,
    });

    expect(await openMotionPhoto(deps(), record)).not.toBeNull();
  });
});

describe("bytes that lie or are not here", () => {
  it("answers null for XMP pointing at something that is not a video", async () => {
    // Cameras write wrong offsets, and an offset that is plausible but wrong
    // yields bytes that fail much later, inside a decoder, about the wrong
    // thing. The `ftyp` check is what keeps the failure here.
    const notAClip = new Uint8Array(64).fill(0x11);
    const bytes = buildJpeg(`<rdf:RDF GCamera:MicroVideoOffset="64"/>`, [notAClip]);
    const record = recordFor(bytes, "file:///objects/lying.jpg");

    expect(await openMotionPhoto(deps(), record)).toBeNull();
  });

  it("opens no file at all for a record that could not carry motion", async () => {
    // The viewer asks this of everything it opens. Without the type guard,
    // opening a 47 MB clip would pull it whole into the JS heap to look for XMP
    // that only ever appears in a JPEG.
    const bytes = motionPhoto();
    seq += 1;
    const record = createDataRecord(
      {
        type: "video/mp4",
        originAppId: "photos",
        contentHash: "a".repeat(64),
        objectStorageKey: "shared/video/aaa",
        sizeBytes: bytes.byteLength,
        originalFilename: "VID_0001.mp4",
      },
      clock,
    );
    const file = harness.fs.file("file:///objects/clip.mp4");
    file.create({ intermediates: true, overwrite: true });
    file.write(bytes);
    placed.set(record.objectStorageKey!, "file:///objects/clip.mp4");

    expect(await openMotionPhoto(deps(), record)).toBeNull();
    expect(index.scanned(record.objectStorageKey!)).toBe(false);
  });

  it("answers null for a record whose bytes are not on this device", async () => {
    const record = createDataRecord(
      {
        type: "image/jpeg",
        originAppId: "photos",
        contentHash: "f".repeat(64),
        objectStorageKey: "shared/image/elided",
        sizeBytes: 100,
        originalFilename: "gone.jpg",
      },
      clock,
    );

    expect(await openMotionPhoto(deps(), record)).toBeNull();
  });
});

describe("the start-up sweep", () => {
  it("clears a scratch file a killed process left behind", async () => {
    // A viewer killed mid-playback runs no `release()`, and this sweep is the
    // only thing that will ever collect that file.
    const record = recordFor(motionPhoto(), "file:///objects/photo.jpg");
    const opened = await openMotionPhoto(deps(), record);
    expect(harness.files.has(opened!.uri)).toBe(true);

    sweepMotionScratch({ fs: harness.fs, cachePath });

    expect(harness.files.has(opened!.uri)).toBe(false);
  });

  it("touches nothing outside its own directory", async () => {
    const record = recordFor(motionPhoto(), "file:///objects/photo.jpg");

    sweepMotionScratch({ fs: harness.fs, cachePath });

    expect(harness.files.has("file:///objects/photo.jpg")).toBe(true);
    expect(harness.fs.directory(SCRATCH_DIR).exists).toBe(false);
    expect(record.objectStorageKey).toBeTruthy();
  });

  it("does nothing on a device that has never viewed one", () => {
    expect(() => sweepMotionScratch({ fs: harness.fs, cachePath })).not.toThrow();
  });
});
