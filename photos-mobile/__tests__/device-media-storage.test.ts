/**
 * Object storage that reads the device's camera roll (`import-loop-design.md` §2).
 *
 * The two assertions this file exists for are the destructive ones — that
 * `delete()` on an aliased key does not delete the user's photograph, and that
 * `put()` on one refuses rather than quietly making the second copy the whole
 * design is built to avoid. Both are sabotage-checked: remove the alias branch
 * from either method and a test here fails.
 *
 * The rest establishes that an aliased blob is indistinguishable from a stored
 * one to a caller, which is what lets the sync engine stay ignorant of camera
 * rolls entirely.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { StarkeepId } from "@starkeep/protocol-primitives";
import type { RawDatabase } from "@starkeep/storage-adapter";
import { createSqliteMediaAliasStore, type MediaAliasStore } from "../src/media/media-alias";
import { DeviceMediaObjectStorage } from "../src/storage/device-media-storage";
import { ExpoObjectStorageAdapter } from "../src/storage/expo-object-storage";
import { fakeExpoFs } from "./helpers/fake-expo-fs";

const KEY = "shared/image/ab/abcd";
const URI = "content://media/external/images/media/1";
const PHOTO = new Uint8Array(Array.from({ length: 64 }, (_, i) => i));

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

let fs: ReturnType<typeof fakeExpoFs>;
let aliases: MediaAliasStore;
let inner: ExpoObjectStorageAdapter;
let storage: DeviceMediaObjectStorage;

async function drain(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (!stream) throw new Error("expected a stream");
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Put a photo in the "media store" and alias a key to it. */
function aliasAPhoto(bytes: Uint8Array = PHOTO): void {
  const file = fs.fs.file(URI);
  file.create({ intermediates: true, overwrite: true });
  file.write(bytes);
  aliases.add({
    objectStorageKey: KEY,
    recordId: "rec-1" as unknown as StarkeepId,
    contentUri: URI,
    assetId: "1",
    sizeBytes: bytes.byteLength,
    contentType: "image/jpeg",
    modificationTimeMs: 1_700_000_000_000,
    addedAtMs: 1_700_000_100_000,
  });
}

beforeEach(async () => {
  fs = fakeExpoFs();
  aliases = createSqliteMediaAliasStore({ db: rawDb() });
  inner = new ExpoObjectStorageAdapter({ fs: fs.fs, basePath: "/objects" });
  storage = new DeviceMediaObjectStorage({ inner, aliases, fs: fs.fs });
  await storage.init();
});

describe("an aliased blob behaves like a stored one", () => {
  it("reports has() true without any bytes in the object store", async () => {
    aliasAPhoto();
    expect(await storage.has(KEY)).toBe(true);
    // The point of the whole design: nothing was copied.
    expect(await inner.has(KEY)).toBe(false);
  });

  it("streams the asset's bytes", async () => {
    aliasAPhoto();
    expect(await drain(await storage.getStream(KEY))).toEqual(PHOTO);
  });

  it("serves a byte range from the asset without reading it whole", async () => {
    aliasAPhoto();
    const got = await drain(await storage.getStream(KEY, { start: 8, end: 11 }));
    expect(Array.from(got)).toEqual([8, 9, 10, 11]);
    // A range served by reading from zero and discarding the prefix would pass
    // the assertion above while turning a seek into a full read.
    expect(fs.state.rangedReads.length).toBeGreaterThan(0);
  });

  it("stats the asset, reporting no checksum because nothing verified one", async () => {
    aliasAPhoto();
    const facts = await storage.stat(KEY);
    expect(facts?.sizeBytes).toBe(PHOTO.byteLength);
    expect(facts?.contentType).toBe("image/jpeg");
    expect(facts?.checksumSha256).toBeNull();
  });

  it("gets the asset whole", async () => {
    aliasAPhoto();
    expect((await storage.get(KEY))?.data).toEqual(PHOTO);
  });
});

describe("staleness", () => {
  it("reports has() false once the asset is gone", async () => {
    aliasAPhoto();
    fs.fs.file(URI).delete();

    // Not an error and not a tombstone — the record is still true, its bytes
    // are merely not here, which is exactly `staged`.
    expect(await storage.has(KEY)).toBe(false);
    expect(await storage.stat(KEY)).toBeNull();
    expect(await storage.getStream(KEY)).toBeNull();
  });

  it("reports has() false when the asset's size no longer matches", async () => {
    aliasAPhoto();
    const file = fs.fs.file(URI);
    file.create({ overwrite: true });
    file.write(new Uint8Array(8));

    expect(await storage.has(KEY)).toBe(false);
  });

  it("falls back to the object store when a dead alias's bytes were re-fetched", async () => {
    // The recovery path: the camera-roll asset is gone, but a peer sent the
    // bytes back. Short-circuiting a dead alias to null would hide them.
    aliasAPhoto();
    fs.fs.file(URI).delete();
    await inner.put(KEY, PHOTO);

    expect(await storage.has(KEY)).toBe(true);
    expect(await drain(await storage.getStream(KEY))).toEqual(PHOTO);
  });
});

describe("the two destructive rules", () => {
  it("delete() drops the alias and never the user's photograph", async () => {
    aliasAPhoto();

    await storage.delete(KEY);

    expect(fs.fs.file(URI).exists).toBe(true);
    expect(aliases.isAliased(KEY)).toBe(false);
    expect(await storage.has(KEY)).toBe(false);
  });

  it("delete() still deletes a genuinely stored blob", async () => {
    await inner.put(KEY, PHOTO);
    await storage.delete(KEY);
    expect(await inner.has(KEY)).toBe(false);
  });

  it("put() on an aliased key refuses rather than making a second copy", async () => {
    aliasAPhoto();
    await expect(storage.put(KEY, PHOTO)).rejects.toThrow(/alias to the device media store/);
    expect(await inner.has(KEY)).toBe(false);
  });

  it("putStream() on an aliased key refuses too", async () => {
    aliasAPhoto();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(PHOTO);
        c.close();
      },
    });
    await expect(storage.putStream(KEY, body)).rejects.toThrow(/alias to the device media store/);
  });
});

describe("unaliased keys are untouched", () => {
  it("passes reads and writes straight through", async () => {
    await storage.put("shared/image/cd/cdef", PHOTO);
    expect(await storage.has("shared/image/cd/cdef")).toBe(true);
    expect((await storage.get("shared/image/cd/cdef"))?.data).toEqual(PHOTO);
  });

  it("reports a key that is neither aliased nor stored as absent", async () => {
    expect(await storage.has("shared/image/zz/nope")).toBe(false);
    expect(await storage.stat("shared/image/zz/nope")).toBeNull();
  });
});
