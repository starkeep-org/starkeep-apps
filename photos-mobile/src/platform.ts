/**
 * The edge where the real React Native modules meet the ports.
 *
 * ## Why this is the only file that imports them
 *
 * Everything else — the driver, the storage adapter, the node assembly, the job
 * graph — takes its dependencies as arguments and declares the shapes it needs
 * structurally. That is what lets all of it run in Node against fakes, which is
 * how a real sync exchange and a real residency budget got tested without a
 * handset.
 *
 * That property only survives if the real imports stay in one place. A single
 * `import { File } from "expo-file-system"` in the storage adapter would make
 * the adapter unloadable outside React Native, and its tests would have to be
 * rewritten around a mock loader — which is the point at which people stop
 * writing them.
 *
 * So: this file is untestable here, and it is the *only* file that is.
 */

import { open as openOpSqlite } from "@op-engineering/op-sqlite";
import { Directory, File, Paths, UploadType } from "expo-file-system";
import * as MediaLibrary from "expo-media-library";
import { generateId, type DataRecord, type HLCClock } from "@starkeep/protocol-primitives";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import {
  createHttpSyncTransport,
  HttpObjectStorageAdapter,
  type UploadFile,
} from "@starkeep/sync-engine";
import { createSessionStore } from "./auth/session-store";
import { loadDeviceKey, type DeviceKey } from "./auth/device-key";
import { loadCloudConfig } from "./config";
import {
  backfillImageExif,
  backfillVideoDurations,
  importDeviceMedia,
  importNullModified,
  noYield,
  type BackfillOutcome,
  type HashBytes,
  type ImportDeps,
  type ImageExifBackfillOutcome,
  type ImportOutcome,
} from "./media/import";
import { createMobileNode, type MobileNode } from "./node";
import {
  openMotionPhoto,
  sweepMotionScratch,
  type MotionPhotoDeps,
  type OpenMotionPhoto,
} from "./media/motion-photo-playback";
import { PHONE_RETENTION, PHOTOS_APP_ID, PHOTOS_SIZE_CLASS_KEY } from "./retention";
import { loadNodeIdentity, type NodeIdentity } from "./node-identity";
import { clearNodeFiles } from "./node-reset";
import { createOpSqliteDriver, type OpSqliteModule } from "./db/op-sqlite-driver";
import { backgroundWindow, nativeTimers } from "./work/native-timers";
import { MEDIA_QUERY_TIMEOUT_MS } from "./work/tick";
import type { DeviceMediaModule, MediaQuery } from "./media/device-library";
import {
  ExpoObjectStorageAdapter,
  type ExpoDirectory,
  type ExpoFile,
  type ExpoFileSystem,
} from "./storage/expo-object-storage";

/**
 * op-sqlite, narrowed to the two calls the driver uses.
 *
 * The cast is the honest shape of this boundary: op-sqlite's own types describe
 * far more than the driver touches, and asserting the narrow contract here is
 * what keeps that surface from leaking inward. If op-sqlite changes either
 * call, this is the line that fails to compile — which is the right place for
 * it to fail.
 */
/**
 * On the two SHA-256s in this app, which are not the same one.
 *
 * `@starkeep/storage-adapter` carries a portable JS digest to verify streamed
 * writes, so the package bundles on React Native at all — it used to import
 * `node:crypto` at module scope, which does not merely fail here but makes the
 * whole package unbundleable, in an error pointing at the importer. That one
 * stays as it is: it runs per streamed write, which on this device is nothing.
 *
 * The *import* hash is a different matter and is wired below with
 * {@link sha256Bytes}. It runs over every byte of every original, and the
 * portable implementation turned out to cost 98% of import time.
 */

export const opSqliteModule: OpSqliteModule = {
  open: (options) => openOpSqlite(options) as unknown as ReturnType<OpSqliteModule["open"]>,
};

export const opSqliteDriver = createOpSqliteDriver(opSqliteModule);

/** expo-file-system's class API, adapted to the interface the storage adapter declares. */
export const expoFileSystem: ExpoFileSystem = {
  file: (path: string) => new File(path) as unknown as ExpoFile,
  directory: (path: string) => new Directory(path) as unknown as ExpoDirectory,
};

/**
 * Send a file's bytes to a URL without them ever becoming a JS value.
 *
 * ## Why this exists at all
 *
 * The sync engine's blob transfer is streamed, and on this platform that was a
 * fiction: `globalThis.fetch` is `expo/fetch` on SDK 57, and its
 * `normalizeBodyInitAsync` drains a `ReadableStream` request body into a chunk
 * array and then copies it into one full-size `Uint8Array`. Add the source-side
 * read — a `content://` asset cannot be streamed, so `bytesSync()` returns the
 * whole thing — and the hash over it, and pushing a 24 MB video allocated
 * something like 3–4× its size in JS heap. On a handset the OS was already
 * pruning, that was a fatal SIGSEGV inside Hermes, not a slow upload.
 *
 * `FileSystemUploadTask` builds an OkHttp request body straight from the file's
 * `inputStream()` and writes it to the socket. `ContentProviderFile` — what a
 * MediaStore URI resolves to — implements `inputStream()` and `length()`, which
 * is precisely the capability that ranged reads over the same URI lack. So the
 * camera roll can be *sent* natively even though it cannot be *read*
 * incrementally, and that asymmetry is the whole fix.
 *
 * ## Two things that look like oversights and are not
 *
 * `BINARY_CONTENT` leaves the request body's content type null, so OkHttp adds
 * no `Content-Type` of its own and the presigned headers are sent exactly as
 * the server signed them. And no `Content-Length` is passed: the upload task
 * takes it from the file's length, and a second one here would be a duplicate
 * header on a signed request.
 *
 * A non-2xx response resolves rather than throws — a 403 from S3 is an answer,
 * and the adapter needs the body to tell `AccessDenied` from
 * `SignatureDoesNotMatch`.
 */
export const uploadFile: UploadFile = async (fileUri, url, init) => {
  // Bounded by the background window when one is open. The upload task carries
  // OkHttp's own sixty-second connect, read and write timeouts, which is a
  // bound on a stalled socket and not a bound on a window: sixty seconds is two
  // thirds of a tick's whole budget. See `work/window-guard.ts`.
  const abort = backgroundWindow.transferAbort();
  try {
    const result = await new File(fileUri).upload(url, {
      httpMethod: init.method,
      uploadType: UploadType.BINARY_CONTENT,
      headers: init.headers,
      ...(abort ? { signal: abort.signal } : {}),
    });
    return { status: result.status, body: result.body };
  } finally {
    abort?.release();
  }
};

/**
 * Where the app's own data lives.
 *
 * `Paths.document` rather than a cache directory: the OS may delete a cache
 * without asking, and a phone that silently lost its local database would
 * re-sync the entire library on next launch — over the network, against a
 * budget, from a node that believed it already had everything.
 */
export function documentPath(...segments: string[]): string {
  return [Paths.document.uri.replace(/\/$/, ""), ...segments].join("/");
}

/**
 * Where bytes this app can always make again go.
 *
 * The reasoning is {@link documentPath}'s, inverted. That one exists because the
 * OS must never delete the database: a phone that silently lost it would re-sync
 * the whole library over a network, against a budget, from a node that believed
 * it already had everything. This one exists because the OS reclaiming these
 * bytes costs one re-extraction and nothing else.
 */
export function cachePath(...segments: string[]): string {
  return [Paths.cache.uri.replace(/\/$/, ""), ...segments].join("/");
}

export const DATABASE_PATH = documentPath("starkeep", "local.sqlite");
export const OBJECTS_PATH = documentPath("starkeep", "objects");
export const SESSION_PATH = documentPath("starkeep", "session.json");
export const NODE_IDENTITY_PATH = documentPath("starkeep", "node.json");

export function createLocalObjectStorage(): ExpoObjectStorageAdapter {
  return new ExpoObjectStorageAdapter({ fs: expoFileSystem, basePath: OBJECTS_PATH });
}

/** The device's session store, over the same filesystem port everything else uses. */
export const sessionStore = createSessionStore(expoFileSystem, SESSION_PATH);

/**
 * expo-media-library, adapted to the port `device-library.ts` declares.
 *
 * The builder methods are wrapped rather than passed through because the real
 * `Query` returns itself for chaining and the port says so structurally; the
 * wrapper is what keeps `Query`'s much larger surface from becoming something
 * the logic could accidentally depend on.
 */
function wrapQuery(query: MediaLibrary.Query): MediaQuery {
  return {
    orderBy(sort) {
      query.orderBy({ key: sort.key as MediaLibrary.AssetField, ascending: sort.ascending });
      return wrapQuery(query);
    },
    limit(count) {
      query.limit(count);
      return wrapQuery(query);
    },
    gte(field, value) {
      query.gte(field as MediaLibrary.AssetField, value);
      return wrapQuery(query);
    },
    within(field, values) {
      query.within(field as MediaLibrary.AssetField, values as MediaLibrary.MediaType[]);
      return wrapQuery(query);
    },
    exeForMetadata: () => query.exeForMetadata(),
  };
}

export const deviceMedia: DeviceMediaModule = {
  getPermissions: () => MediaLibrary.getPermissionsAsync(),
  requestPermissions: () => MediaLibrary.requestPermissionsAsync(),
  newQuery: () => wrapQuery(new MediaLibrary.Query()),
  uriFor: (id: string) => new MediaLibrary.Asset(id).getUri(),
};

/**
 * The SHA-256 the import loop hashes originals with — the platform's, not JS's.
 *
 * ## Why this is native
 *
 * It was `js-sha256`, which is correct everywhere and is the right *default*
 * for a library. As an import loop on a handset it was catastrophic, and the
 * device said so precisely: **~1.4 MB/s**, unwavering across ten files of every
 * size and format. A 47 MB video took 34 seconds to hash and half a second to
 * read. Hashing was 98% of import.
 *
 * `expo-crypto` runs the same digest in platform code. The bytes still cross
 * JSI to get here — measured at ~76 MB/s, which is not worth a native module to
 * avoid — so this buys nearly the whole difference for one dependency.
 *
 * ## Why getting this wrong is quiet
 *
 * Content-addressed keys make the digest load-bearing rather than incidental:
 * it *is* the object storage key. A hash that disagrees with every other node's
 * does not fail — it makes a record whose bytes nobody else can match, which
 * surfaces as photos mysteriously failing to deduplicate long after the cause.
 * So the algorithm is named explicitly and the hex encoding is done here rather
 * than trusted to a helper.
 */
export const sha256Bytes: HashBytes = async (bytes) => {
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes as BufferSource);
  const out = new Uint8Array(digest);
  let hex = "";
  for (const byte of out) hex += byte.toString(16).padStart(2, "0");
  return hex;
};

/**
 * What `createMobileNode` needs in order to alias the camera roll.
 *
 * Passing the same filesystem port the object store uses is the whole trick:
 * expo-file-system 57 resolves a `content://` URI to a `ContentProviderFile`
 * with `exists`, `length()`, `inputStream()` and a seekable handle, so reading
 * an aliased original is the same code path as reading a stored blob with a
 * different string in it. There is no second module and no native shim.
 */
export const deviceMediaStorage = { fs: expoFileSystem };

/**
 * Bring up this device's node.
 *
 * No cloud is passed, and that is the current truth rather than a placeholder:
 * every `/apps/{appId}/*` route is HMAC-signed with a per-app secret no handset
 * can hold, so there is nothing to exchange with. The node is complete anyway —
 * it holds records, imports the camera roll and answers every question about
 * what it has. See todo #51 and `import-loop-design.md` §5.2.
 *
 * `generateId` is passed rather than called at module scope because it reaches
 * for a PRNG that Hermes only has after `react-native-get-random-values` has
 * run; see the note at the top of `index.ts`.
 */
export async function bringUpNode(): Promise<{
  node: MobileNode;
  identity: NodeIdentity;
  deviceKey: DeviceKey;
}> {
  // Before anything else, because the thing it collects belongs to a process
  // that is already gone: a viewer killed mid-playback runs no `release()`. See
  // `sweepMotionScratchFiles`.
  sweepMotionScratchFiles();
  const identity = await loadNodeIdentity(expoFileSystem, NODE_IDENTITY_PATH, generateId);
  const deviceKey = await loadDeviceKey({
    store: SecureStore,
    deviceId: identity.nodeId,
    randomBytes: (length) => Crypto.getRandomValues(new Uint8Array(length)),
  });
  const config = loadCloudConfig();

  const node = await createMobileNode({
    nodeId: identity.nodeId,
    databasePath: DATABASE_PATH,
    sqliteDriver: opSqliteDriver,
    localObjectStorage: createLocalObjectStorage(),
    deviceMedia: deviceMediaStorage,
    // The budget that makes this a phone rather than a laptop with a small
    // disk. Without it `residency` is null and the entire residency half of the
    // node — budgets, classes, pins, eviction — is present and unreachable,
    // which is exactly the state it was in. See `retention.ts` for the numbers
    // and for what this budget deliberately does *not* govern.
    retention: PHONE_RETENTION,
    sizeClassKeys: { [PHOTOS_APP_ID]: PHOTOS_SIZE_CLASS_KEY },
    ...(config?.baseUrl ? { cloud: driveChannel(config.baseUrl, deviceKey) } : {}),
  });
  return { node, identity, deviceKey };
}

/**
 * The Drive channel — how shared records reach the cloud.
 *
 * Drive, not `photos`, and that is the protocol rather than a choice:
 * `data-roles-and-permissions.md` routes *all* shared-record sync through the
 * always-on User-Data-Owner channel, and the photographs are shared records.
 * The `photos` channel carries app-specific rows — captions — and is a second
 * engine against a second base URL, not needed to answer "did my photos sync".
 *
 * **Configured even when this device is not paired yet.** The engine exists and
 * every request 401s until the operator pairs it, which is a far better state
 * than no engine at all: the failure is visible, attributable and fixed by
 * pairing, where a missing engine looks exactly like a device with nothing to
 * send. That was the actual bug — signing in changed nothing because
 * `bringUpNode` passed no cloud, so `exchange()` was a no-op.
 */
function driveChannel(baseUrl: string, deviceKey: DeviceKey) {
  const channelUrl = `${baseUrl.replace(/\/+$/, "")}/apps/${DRIVE_APP_ID}`;
  const signRequest = (method: string, path: string, body?: string | Uint8Array) =>
    deviceKey.signRequest(
      DRIVE_APP_ID,
      method,
      path,
      typeof body === "string" ? new TextEncoder().encode(body) : body,
    );

  // Every request either channel makes, bounded by the window that made it.
  // React Native's `fetch` has no timeouts of its own — `OkHttpClientProvider`
  // sets connect, read and write to zero — so a stalled socket in a background
  // window would otherwise hold the process until WorkManager cancelled it ten
  // minutes later, which is the whole daily allowance in the RARE bucket.
  const boundedFetch = backgroundWindow.boundFetch((input, init) =>
    globalThis.fetch(input, init),
  );

  return {
    transport: createHttpSyncTransport({ baseUrl: channelUrl, signRequest, fetch: boundedFetch }),
    remoteObjectStorage: new HttpObjectStorageAdapter({
      baseUrl: `${channelUrl}/files`,
      signRequest,
      fetch: boundedFetch,
      // Supplying this is what turns on `putFromFileUri`, and with it the path
      // where a video's bytes go from the media store to S3 without passing
      // through Hermes. See {@link uploadFile}.
      uploadFile,
    }),
  };
}

/** The User-Data-Owner app id. Must match `sync-supervisor.ts`'s constant. */
export const DRIVE_APP_ID = "starkeep-drive";

/**
 * Throw away everything this node has indexed.
 *
 * ## What this deletes, and what it emphatically does not
 *
 * It deletes the node's **database** — records, labels, sync watermarks and the
 * alias table — and the node's **object store**, which holds renditions and any
 * blobs fetched from a peer.
 *
 * It does not touch a single photograph. The originals were never copied here:
 * import aliases them to the MediaStore assets that already hold them
 * (`import-loop-design.md` §2), so what is being deleted is Starkeep's *index
 * of* the camera roll, not the camera roll. Deleting a pointer is the only
 * destructive operation available, and that is a property of the design worth
 * relying on rather than a coincidence — the same reason
 * `DeviceMediaObjectStorage.delete()` drops an alias row and never an asset.
 *
 * The **node identity survives**. It is not data, it is who this device is: it
 * is stamped into every HLC timestamp, and regenerating it would make the phone
 * look like a brand new peer to everyone it has ever synced with. The session
 * survives too — signing out is a different action, offered separately.
 *
 * The node must be closed first and rebuilt after, which is why this takes one
 * and the caller replaces it: SQLite holds the file open, and deleting it from
 * underneath a live connection is how a database ends up half-there.
 */
export async function clearNodeData(node: MobileNode): Promise<void> {
  await node.close();
  discardNodeFiles();
}

/**
 * Delete the node's files, assuming it is already closed.
 *
 * Split from {@link clearNodeData} because the node is no longer the caller's
 * to close: it is shared through `work/node-handle.ts`, and closing the handle
 * is a separate step that invalidates every outstanding claim on it. Deleting
 * a database SQLite still has open is how one ends up half-there, so the two
 * halves stay in this order and the caller performs both.
 */
export function discardNodeFiles(): void {
  clearNodeFiles(expoFileSystem, {
    databasePath: DATABASE_PATH,
    objectsPath: OBJECTS_PATH,
  });
  // The scratch clips go too. They are derived from bytes this node is about to
  // forget, and a clip left behind would be the one thing a cleared node still
  // held of the photographs it no longer knows about.
  sweepMotionScratchFiles();
}

/** Import dependencies, assembled from the real modules for a live node. */
export function importDepsFor(node: MobileNode, clock: HLCClock): ImportDeps {
  if (!node.mediaAliases) {
    throw new Error("this node was built without deviceMedia, so it cannot import a camera roll");
  }
  return {
    media: deviceMedia,
    aliases: node.mediaAliases,
    database: node.databaseAdapter,
    clock,
    fs: expoFileSystem,
    hash: sha256Bytes,
    ...(node.motionIndex ? { motionIndex: node.motionIndex } : {}),
  };
}

/**
 * Bring in whatever the camera has taken since this node last looked.
 *
 * ## Why the two callers share one call
 *
 * The background tick and the foreground catch-up want the same import with two
 * differences, and both differences are consequences of one fact: **React
 * Native runs no JS timers in a headless context.** A `setTimeout` in a process
 * started for `SystemJobService` never fires, so the default yield between
 * assets becomes a permanent hang and a deadline armed on the platform's timers
 * never expires. `background: true` is the name of that fact, and it supplies
 * all three of the answers to it at once — see `ImportDeps.yieldToUi` and
 * `work/native-timers.ts`.
 *
 * The tick used to build this inline. A second caller building it inline again
 * is how one of the two comes to run without the headless yield, which fails
 * only on a handset, only in the background, and only as a window that reports
 * nothing.
 *
 * ## Both callers pass the cursor, and "Add photos" still does not
 *
 * The watermark is what makes a repeated scan cheap, which is right for a pass
 * that runs on every app open and on every background window. It is wrong for a
 * person tapping "Add photos from this device" to backfill a library that
 * predates this node, and that control keeps running without one. See
 * `ImportDeps.importCursor`.
 */
export function importRecentFor(
  node: MobileNode,
  clock: HLCClock,
  options: {
    readonly limit: number;
    /** True in a headless window, false on a screen someone is looking at. */
    readonly background: boolean;
    readonly signal?: { readonly aborted: boolean };
    readonly onProgress?: ImportDeps["onProgress"];
  },
): Promise<ImportOutcome> {
  return importDeviceMedia(
    {
      ...importDepsFor(node, clock),
      importCursor: node.importCursor ?? undefined,
      ...(options.background ? { yieldToUi: noYield } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    },
    {
      limit: options.limit,
      ...(options.signal ? { signal: options.signal } : {}),
      // Omitted in the foreground, deliberately. A person watching a spinner can
      // decide for themselves how long to wait, and the platform's own timers
      // work on a screen that is drawing frames — so the deadline and the timer
      // it runs on are both the background window's business and nobody else's.
      ...(options.background
        ? { queryTimeoutMs: MEDIA_QUERY_TIMEOUT_MS, timers: nativeTimers }
        : {}),
    },
  );
}

/**
 * Import the assets the import watermark can never reach.
 *
 * Foreground only, and the reason is the same one the duration backfill gives:
 * the pass costs ten media-store probes for a payoff that is rare, and a
 * background window's budget is better spent on assets that do have a position
 * on the field the watermark measures.
 *
 * Deliberately passes **no** `importCursor`. The pass must not move the
 * watermark, and the cleanest way to guarantee that is for it never to hold
 * one — see `importNullModified`.
 */
export function sweepNullModifiedFor(
  node: MobileNode,
  clock: HLCClock,
  options: { readonly limit: number },
): Promise<ImportOutcome> {
  return importNullModified(importDepsFor(node, clock), { limit: options.limit });
}

/**
 * Fill in the length of clips imported before a record carried one.
 *
 * Answers `complete: true` on a node that reads no camera roll, because such a
 * node has nothing to repair and the caller's job is to stop asking.
 *
 * Foreground only, and not because it would be unsafe in a window: the pass
 * costs one media-store query per call and the background window's whole
 * remaining budget is better spent on the sync that gets photographs off the
 * device. A duration is a nicety on a tile; a backup is not.
 */
export function backfillVideoDurationsFor(
  node: MobileNode,
  options: { readonly limit: number },
): Promise<BackfillOutcome> {
  if (!node.mediaAliases || !node.videoDurationCursor) {
    return Promise.resolve({ scanned: 0, written: 0, complete: true });
  }
  return backfillVideoDurations(
    {
      media: deviceMedia,
      aliases: node.mediaAliases,
      database: node.databaseAdapter,
      cursor: node.videoDurationCursor,
    },
    { limit: options.limit },
  );
}

/**
 * Repair the capture time and orientation of stills imported before a record
 * carried them.
 *
 * Answers `complete: true` on a node that reads no camera roll, because such a
 * node has nothing to repair and the caller's job is to stop asking.
 *
 * Foreground only, on the same argument the duration backfill makes and more
 * strongly: this pass reads whole photographs across JSI, and a background
 * window's budget belongs to the sync that gets them off the device.
 */
export function backfillImageExifFor(
  node: MobileNode,
  options: { readonly limit: number; readonly after?: string | null },
): Promise<ImageExifBackfillOutcome> {
  if (!node.mediaAliases) {
    return Promise.resolve({ scanned: 0, written: 0, complete: true, resumeAfter: null });
  }
  return backfillImageExif(
    {
      aliases: node.mediaAliases,
      database: node.databaseAdapter,
      fs: expoFileSystem,
    },
    { limit: options.limit, ...(options.after !== undefined ? { after: options.after } : {}) },
  );
}

/**
 * The clip inside a Motion Photo, as a file a player can open.
 *
 * Answers null on a node that reads no camera roll, and on the ordinary
 * photograph that carries no motion at all. The caller must call `release()` —
 * on closing the viewer and on leaving the foreground — because the scratch file
 * is the only thing this leaves behind and it is meant to last exactly one
 * viewing. See `media/motion-photo-playback.ts`.
 */
export function openMotionPhotoFor(
  node: MobileNode,
  record: DataRecord,
): Promise<OpenMotionPhoto | null> {
  if (!node.motionIndex) return Promise.resolve(null);
  const deps: MotionPhotoDeps = {
    fs: expoFileSystem,
    index: node.motionIndex,
    objectStorage: node.objectStorage,
    aliases: node.mediaAliases,
    cachePath,
  };
  return openMotionPhoto(deps, record);
}

/**
 * Collect scratch clips a previous run left behind.
 *
 * Called on the way up rather than on the way down, because the case it exists
 * for is a process that had no way down: a viewer killed mid-playback runs no
 * `release()`, and this sweep is the only thing that will ever collect that file.
 */
export function sweepMotionScratchFiles(): void {
  sweepMotionScratch({ fs: expoFileSystem, cachePath });
}
