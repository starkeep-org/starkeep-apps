/**
 * Object storage that can also read the device's own camera roll.
 *
 * ## What this is for
 *
 * Import aliases a record's blob to the MediaStore asset that already holds
 * those bytes instead of copying them (`import-loop-design.md` §2). This
 * adapter is what makes that invisible to everything above it: it wraps the
 * node's real object store and consults the alias table first, so a key whose
 * bytes are a `content://` asset answers `has`, `stat` and `getStream` exactly
 * as a stored blob does.
 *
 * ## Why nothing in the sync engine had to change
 *
 * `residencyOf` derives residency from `localStorage.has(key)` — there is no
 * persisted status column, deliberately. So an aliased original is `resident`
 * through the ordinary path: the outbound scan selects its record like any
 * other, `transferFile` reads the bytes straight out of the camera roll through
 * `getStream`/`localFileUriFor`, and the watermark behaves. No new residency
 * state, no `Elided` special case, and — the part worth protecting — the sync
 * engine never learns what a camera roll is. That seam is what keeps the phone a
 * *configuration* of the node rather than a second implementation of it.
 *
 * ## The two rules that matter
 *
 * **Never write through an alias.** An aliased key's bytes belong to the user's
 * media store. `put`/`putStream` against one is a programming error and throws
 * rather than silently writing a second copy into the object store, which would
 * leave two answers to `has()` and no rule about which wins.
 *
 * **Never delete the asset.** `delete()` on an aliased key drops the alias row
 * and stops there. The eviction pass, the budget reducer and any GC can all
 * call it safely — deleting someone's photograph because a cache filled up is
 * the worst thing this app could do, and it must be impossible rather than
 * merely avoided.
 */

import type {
  ByteRange,
  GetResult,
  ListOptions,
  ListResult,
  ObjectFacts,
  ObjectStorageAdapter,
  PutOptions,
  PutStreamOptions,
} from "@starkeep/storage-adapter";
import type { MediaAlias, MediaAliasStore } from "../media/media-alias";
import { streamFromFile, type ExpoFileSystem } from "./expo-object-storage";

/**
 * `ObjectStorageAdapter` plus the file-URI capability the sync engine
 * negotiates.
 *
 * Declared here rather than taken from `@starkeep/storage-adapter` only because
 * this app pins a published version of that package while `@starkeep/sync-engine`
 * is linked to the core workspace, so the port has the member and the app's copy
 * of the types does not yet. Delete this and import it once storage-adapter is
 * published again; the shape must not drift in the meantime.
 */
export interface FileBackedObjectStorage extends ObjectStorageAdapter {
  localFileUriFor?(key: string): string | null;
}

export interface DeviceMediaObjectStorageOptions {
  /** The node's own object store — where renditions and fetched blobs live. */
  readonly inner: FileBackedObjectStorage;
  readonly aliases: MediaAliasStore;
  /**
   * The same filesystem port the inner adapter uses.
   *
   * Not a separate "media" port, because expo-file-system 57 resolves a
   * `content://` URI to a `ContentProviderFile` exposing `exists`, `length()`,
   * `inputStream()` and a seekable handle — the identical shape as a file on
   * disk. An aliased original and a stored blob differ only in the string
   * handed to `fs.file()`, and inventing a second port would hide that.
   */
  readonly fs: ExpoFileSystem;
  /** The clock the probe window is measured on. Injected only by tests. */
  readonly now?: () => number;
}

/**
 * How long a live-asset probe is trusted before the media store is asked again.
 *
 * The probe is two `ContentResolver` round trips, and on a Pixel 5 the pair
 * costs about 85 ms. Nothing cached them, so listing a library page of thirty
 * records — which asks for every record's own URI and for every painted
 * rendition's — spent 2.5 s inside them, and a reload of two pages spent 5 s
 * with the JavaScript thread held the whole time. That reload, and therefore
 * the frozen tap behind it, is what
 * `photos-mobile-grid-and-viewer-2026-09-04.md` measures.
 *
 * Thirty seconds is chosen against what a stale answer costs rather than
 * against what it saves. A stale *positive* hands a caller a URI for an asset
 * the user has since deleted elsewhere: a transfer fails and is retried, or a
 * tile paints a placeholder, and the next probe past the window corrects both.
 * A stale *negative* demotes a record to `staged` for the rest of the window,
 * which is where the record was already heading. Neither answer is durable and
 * neither is written down, so this stays a cache of one question rather than
 * the authority this table must never become.
 */
const ALIAS_PROBE_TTL_MS = 30_000;

/**
 * How many probes are remembered at once.
 *
 * A cap rather than a growth curve, because this is keyed by object storage key
 * and a library can hold sixty thousand of them. Eviction is insertion-ordered
 * — a `Map` iterates in insertion order and every write re-inserts — so what
 * falls out is what nothing has asked about recently, which on this app's
 * surfaces is a screen somebody has scrolled away from.
 */
const ALIAS_PROBE_LIMIT = 2048;

/** One remembered answer to "is the asset behind this alias still there". */
interface AliasProbe {
  /**
   * The alias the answer was measured against, as URI and size.
   *
   * Compared rather than assumed, which is what makes a re-import invalidate
   * the cache for free: a record re-aliased to a new asset, or to the same
   * asset at a new size, does not match the stamp and is probed again. The
   * window therefore covers only the case an alias row cannot see — the asset
   * at this exact URI and this exact size disappearing — which is the case the
   * scan job exists to catch.
   */
  readonly stamp: string;
  readonly atMs: number;
  readonly live: boolean;
}

export class DeviceMediaObjectStorage implements FileBackedObjectStorage {
  private readonly inner: FileBackedObjectStorage;
  private readonly aliases: MediaAliasStore;
  private readonly fs: ExpoFileSystem;
  private readonly probes = new Map<string, AliasProbe>();
  private readonly now: () => number;

  constructor(options: DeviceMediaObjectStorageOptions) {
    this.inner = options.inner;
    this.aliases = options.aliases;
    this.fs = options.fs;
    this.now = options.now ?? Date.now;
  }

  /**
   * Resolve an alias to a live file, or null.
   *
   * The size comparison is the whole staleness check on this path, and it is
   * deliberately the cheap one: `ContentProviderFile.lastModified()` is
   * unconditionally `null`, so the recorded mtime cannot be checked here at
   * all — only by the scan job, against a fresh MediaStore query. Size catches
   * the common cases (deleted, replaced, truncated) for the cost of a `stat`,
   * and an edit that preserves the byte count exactly is left for the scan.
   *
   * Returning null rather than throwing is what demotes the record to `staged`
   * instead of tombstoning it: the metadata is still true, the bytes are still
   * wanted, and they are no longer here.
   */
  private resolve(key: string): { alias: MediaAlias; file: ReturnType<ExpoFileSystem["file"]> } | null {
    const alias = this.aliases.get(key);
    if (!alias) return null;
    // Built unconditionally because building it is free: `fs.file()` wraps a
    // string, and every round trip to the media store sits behind one of the
    // handle's accessors. A cached probe touches none of them.
    const file = this.fs.file(alias.contentUri);
    if (!this.live(alias, file)) return null;
    return { alias, file };
  }

  /**
   * Whether the asset behind this alias is still there, remembered briefly.
   *
   * The alias row is read fresh on every call — a primary-key lookup in the
   * SQLite file the caller is already reading — so what is cached here is only
   * the expensive half. {@link ALIAS_PROBE_TTL_MS} carries what the window is
   * worth and what a stale answer costs.
   */
  private live(alias: MediaAlias, file: ReturnType<ExpoFileSystem["file"]>): boolean {
    const stamp = `${alias.contentUri}\u0000${alias.sizeBytes}`;
    const at = this.now();
    const remembered = this.probes.get(alias.objectStorageKey);
    if (remembered && remembered.stamp === stamp && at - remembered.atMs < ALIAS_PROBE_TTL_MS) {
      return remembered.live;
    }
    const live = file.exists && (file.size === null || file.size === alias.sizeBytes);
    this.remember(alias.objectStorageKey, { stamp, atMs: at, live });
    return live;
  }

  private remember(key: string, probe: AliasProbe): void {
    // Deleted first so a re-probe moves the key to the end of the insertion
    // order rather than keeping the position it was first written at.
    this.probes.delete(key);
    this.probes.set(key, probe);
    while (this.probes.size > ALIAS_PROBE_LIMIT) {
      const oldest = this.probes.keys().next();
      if (oldest.done) break;
      this.probes.delete(oldest.value);
    }
  }

  async init(): Promise<void> {
    await this.inner.init();
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  async healthCheck(): Promise<boolean> {
    return this.inner.healthCheck();
  }

  async put(key: string, data: Uint8Array, options?: PutOptions): Promise<void> {
    this.refuseAliasedWrite(key, "put");
    return this.inner.put(key, data, options);
  }

  async putStream(
    key: string,
    body: ReadableStream<Uint8Array>,
    options?: PutStreamOptions,
  ): Promise<void> {
    this.refuseAliasedWrite(key, "putStream");
    return this.inner.putStream(key, body, options);
  }

  async has(key: string): Promise<boolean> {
    // A live alias answers immediately; a dead one falls through rather than
    // short-circuiting to false. The fallback is the recovery path: once the
    // camera-roll asset is gone the record is `staged`, a peer sends the bytes
    // back, and they land in the inner store — where an aliased key that
    // refused to look would never find them, leaving a record permanently owed
    // bytes it was already holding.
    if (this.resolve(key) !== null) return true;
    return this.inner.has(key);
  }

  async stat(key: string): Promise<ObjectFacts | null> {
    const resolved = this.resolve(key);
    if (!resolved) {
      // An aliased-but-dead key falls through to the inner store rather than
      // short-circuiting to null: the bytes may since have been fetched back
      // from a peer, which is exactly the recovery path a dead alias leads to.
      return this.inner.stat(key);
    }
    return {
      sizeBytes: resolved.file.size ?? resolved.alias.sizeBytes,
      // The media store verifies nothing at write time and this node did not
      // write these bytes at all, so claiming a checksum here would assert a
      // provenance nothing established. Callers read null as "unknown".
      checksumSha256: null,
      storageClass: null,
      availability: { state: "instant" },
      ...(resolved.alias.contentType ? { contentType: resolved.alias.contentType } : {}),
    };
  }

  async get(key: string): Promise<GetResult | null> {
    const resolved = this.resolve(key);
    if (!resolved) return this.inner.get(key);

    const stream = streamFromFile(resolved.file);
    if (!stream) return null;
    const data = await readAll(stream);
    return {
      data,
      size: data.byteLength,
      ...(resolved.alias.contentType ? { contentType: resolved.alias.contentType } : {}),
    };
  }

  async getStream(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    const resolved = this.resolve(key);
    if (!resolved) return this.inner.getStream(key, range);
    return streamFromFile(resolved.file, range);
  }

  /**
   * The camera-roll asset's own URI, which is the whole payoff of aliasing.
   *
   * A `content://` MediaStore asset cannot be streamed at all (see
   * `streamFromFile`), so every read of an aliased original materializes it —
   * and a 24 MB video materialized three times over is what crashed this app on
   * its first video push. Naming the asset instead lets the platform's uploader
   * read it through `ContentResolver` and send it straight out, which is the
   * one path on this device where the bytes never become a JS value.
   *
   * A read, not a write, so the alias rules are unchanged: this hands out a
   * pointer to the user's photograph for sending, and nothing here can modify
   * or delete it.
   */
  localFileUriFor(key: string): string | null {
    const resolved = this.resolve(key);
    if (resolved) return resolved.alias.contentUri;
    // A dead alias falls through for the same reason `has` and `stat` do: the
    // bytes may since have been fetched back into the inner store.
    return this.inner.localFileUriFor?.(key) ?? null;
  }

  async setTags(key: string, tags: Record<string, string>): Promise<void> {
    // Tags on an aliased key would need a sidecar next to an asset this node
    // does not own. Nothing asks for it, so it is refused rather than written
    // somewhere surprising.
    this.refuseAliasedWrite(key, "setTags");
    return this.inner.setTags(key, tags);
  }

  async restoreObject(
    key: string,
    options: { tier: string; days: number },
  ): Promise<"started" | "already-in-progress"> {
    if (this.aliases.isAliased(key)) return "already-in-progress";
    return this.inner.restoreObject(key, options);
  }

  /**
   * Drop an alias, or delete a stored blob.
   *
   * The asymmetry is the point: for an aliased key this forgets *where to
   * look*, and the user's photograph is untouched. That makes this safe to call
   * from the eviction pass, which is what lets aliased originals participate in
   * the same GC vocabulary as everything else without a caller having to
   * remember which kind of key it holds.
   */
  async delete(key: string): Promise<void> {
    if (this.aliases.isAliased(key)) {
      this.aliases.remove(key);
      // The alias is gone, so the probe describes nothing. Dropped here rather
      // than left to age out, because this is the one mutation the adapter can
      // see and the window should not have to cover it.
      this.probes.delete(key);
      return;
    }
    return this.inner.delete(key);
  }

  async list(prefix: string, options?: ListOptions): Promise<ListResult> {
    return this.inner.list(prefix, options);
  }

  private refuseAliasedWrite(key: string, op: string): void {
    if (this.aliases.isAliased(key)) {
      throw new Error(
        `${op}() on ${key}: these bytes are an alias to the device media store and must not be written. ` +
          `Remove the alias first if the record is genuinely being re-homed into object storage.`,
      );
    }
  }
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
