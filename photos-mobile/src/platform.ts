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
// The app's only image decoder, and the one that already paints every tile. See
// `thumbHashFor` below for why the ThumbHash is taken from it rather than
// computed in JavaScript.
import { Image } from "expo-image";
import {
  createCloudTokenSource,
  DEPLOYMENT_SETTINGS_ROUTE,
  generateId,
  idTokenClaims,
  SignedOutError,
  withUserToken,
  type DataRecord,
  type HLCClock,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import {
  createHttpSyncTransport,
  HttpObjectStorageAdapter,
  type HashFileParts,
  type UploadFile,
  type UploadFileRange,
} from "@starkeep/sync-engine";
import {
  cognitoFor,
  createSessionStore,
  finishPendingSignOut,
  loadSignedIn,
  notifySessionRejected,
  signInPhone,
  signOutPhone,
  type SessionCloud,
  type SignInOutcome,
} from "./auth/session";
import type { CloudConnection } from "./auth/connection";
import {
  backfillImageExif,
  backfillThumbHashes,
  backfillVideoDurations,
  importDeviceMedia,
  importNullModified,
  noYield,
  type BackfillOutcome,
  type HashBytes,
  type HashUri,
  type ImportDeps,
  type ImageExifBackfillOutcome,
  type ImportOutcome,
  type ThumbHashBackfillOutcome,
} from "./media/import";
import type { ThumbHashEncoder } from "./media/thumb-hash";
import StarkeepAvif from "../modules/starkeep-avif";
import StarkeepMediaHash from "../modules/starkeep-media-hash";
import {
  deriveForRecord,
  deriveRenditions,
  type DeriveLadderDeps,
  type DeriveLadderOutcome,
  type ImageEncoder,
} from "./photos/derive-ladder";
import { createMobileNode, type MobileNode } from "./node";
import { backgroundDerivePlan, type BackgroundDerivePass } from "./photos/background-derive";
import {
  openMotionPhoto,
  sweepMotionScratch,
  type MotionPhotoDeps,
  type OpenMotionPhoto,
} from "./media/motion-photo-playback";
import { loadNodeIdentity, type NodeIdentity } from "./node-identity";
import { createOpSqliteDriver, type OpSqliteModule } from "./db/op-sqlite-driver";
import { backgroundWindow, nativeTimers } from "./work/native-timers";
import { createFileMultipartSessions } from "./storage/multipart-sessions";
import { requireOriginalUri } from "./media/original-uri";
import { deleteLibraryRecord, type DeleteRecordOutcome } from "./photos/delete-record";
import {
  backfillVideoPosters,
  type VideoPosterBackfillOutcome,
  type VideoPosterDeps,
} from "./photos/video-posters";
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
export const NODE_IDENTITY_PATH = documentPath("starkeep", "node.json");

export function createLocalObjectStorage(): ExpoObjectStorageAdapter {
  return new ExpoObjectStorageAdapter({ fs: expoFileSystem, basePath: OBJECTS_PATH });
}

/**
 * Sign this phone in to the cloud at `baseUrl`. The node picks the session up
 * when it next opens. See `auth/session.ts`.
 */
export async function signIn(args: {
  baseUrl: string;
  email: string;
  password: string;
  newPassword?: string;
}): Promise<SignInOutcome> {
  // Whose library this phone holds, so a sign-in as anyone else is refused
  // before it is kept. Imported here rather than at module scope, because the
  // node handle imports this module lazily.
  const { acquireNode } = await import("./work/node-handle");
  const lease = await acquireNode();
  try {
    return await signInPhone(SecureStore, { ...args, libraryOwner: lease.node.libraryOwner() });
  } finally {
    await lease.release();
  }
}

/** Sign this phone out, here and at the pool. The node drops its cloud when it next opens. */
export function signOutThisPhone(): Promise<unknown> {
  return signOutPhone(SecureStore);
}

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
  onChange: (listener) => MediaLibrary.addListener(() => listener()),
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
 * The streaming digest import uses for every asset that is not a still.
 *
 * Null when the binary predates `modules/starkeep-media-hash`, and import then
 * falls back to {@link sha256Bytes} and its 64 MB ceiling. See
 * `ImportDeps.hashUri`.
 */
const mediaHash = StarkeepMediaHash;
export const sha256OfUri: HashUri | null = mediaHash
  ? (uri) => mediaHash.sha256OfUri(uri)
  : null;

/**
 * The two ports a resumable multipart upload needs, from the same native
 * module. Null when the binary predates them, and every file then keeps the
 * single PUT.
 *
 * Checked per function rather than per module, because a development client
 * built when the module held only `sha256OfUri` loads it without the rest.
 */
const multipartNative =
  mediaHash &&
  typeof mediaHash.sha256PartsOfUri === "function" &&
  typeof mediaHash.uploadRangeOfUri === "function"
    ? mediaHash
    : null;

/** The whole-file and part digests of a file, from one native read. */
export const hashFileParts: HashFileParts | null = multipartNative
  ? async (uri, partBytes) => {
      const digest = await multipartNative.sha256PartsOfUri(uri, partBytes);
      return { sha256Hex: digest.hex, partSha256Hex: digest.partHexes, sizeBytes: digest.sizeBytes };
    }
  : null;

let rangeUploads = 0;

/**
 * One multipart part's PUT, sent natively from the file.
 *
 * Bounded by the background window the same way {@link uploadFile} is. The
 * native side cannot take an `AbortSignal`, so the abort reaches it as a cancel
 * by request id, which disconnects the socket mid-write. A part cut off this
 * way is simply missing next time; the parts before it are already saved.
 */
export const uploadFileRange: UploadFileRange | null = multipartNative
  ? async (fileUri, range, url, init) => {
      const requestId = `range-${++rangeUploads}`;
      const abort = backgroundWindow.transferAbort();
      const cancel = () => {
        console.warn(`[multipart] cancelling ${requestId} (${range.length} bytes at ${range.offset}): the background window closed`);
        multipartNative.cancelUpload(requestId);
      };
      abort?.signal.addEventListener("abort", cancel);
      try {
        if (abort?.signal.aborted) throw new Error("the background window closed before the part began");
        return await multipartNative.uploadRangeOfUri(
          requestId,
          fileUri,
          range.offset,
          range.length,
          url,
          init.headers,
        );
      } finally {
        abort?.signal.removeEventListener("abort", cancel);
        abort?.release();
      }
    }
  : null;

// Once per process, so a device log shows which upload path this binary has
// before any transfer starts.
console.log(
  multipartNative
    ? "[multipart] native part hashing and range upload present; files above 64 MiB go up in parts"
    : "[multipart] native multipart functions absent from this binary; every file uses a single PUT",
);

/** In the documents directory, beside the database, so the OS never clears it. */
const MULTIPART_SESSIONS_PATH = documentPath("multipart-uploads.json");

/** See `storage/multipart-sessions.ts`. */
const multipartSessions = createFileMultipartSessions({
  read: () => {
    const file = new File(MULTIPART_SESSIONS_PATH);
    return file.exists ? file.textSync() : null;
  },
  write: (contents) => {
    const file = new File(MULTIPART_SESSIONS_PATH);
    if (!file.exists) file.create();
    file.write(contents);
  },
});

/**
 * What `createMobileNode` needs in order to alias the camera roll.
 *
 * Passing the same filesystem port the object store uses is the whole trick:
 * expo-file-system 57 resolves a `content://` URI to a `ContentProviderFile`
 * with `exists`, `length()`, `inputStream()` and a seekable handle, so reading
 * an aliased original is the same code path as reading a stored blob with a
 * different string in it. There is no second module and no native shim.
 */
export const deviceMediaStorage = {
  fs: expoFileSystem,
};

/**
 * Bring up this device's node.
 *
 * The node syncs only once the phone is signed in. The sign-in carries both the
 * cloud's address and the session the phone syncs with. Signed out there is no
 * cloud to exchange with, and the node is complete anyway: it holds records,
 * imports the camera roll and answers every question about what it has.
 *
 * `generateId` is passed rather than called at module scope because it reaches
 * for a PRNG that Hermes only has after `react-native-get-random-values` has
 * run; see the note at the top of `index.ts`.
 */
export async function bringUpNode(): Promise<{
  node: MobileNode;
  identity: NodeIdentity;
  connection: CloudConnection | null;
}> {
  // Before anything else, because the thing it collects belongs to a process
  // that is already gone: a viewer killed mid-playback runs no `release()`. See
  // `sweepMotionScratchFiles`.
  sweepMotionScratchFiles();
  const identity = await loadNodeIdentity(expoFileSystem, NODE_IDENTITY_PATH, generateId);
  // A sign-out that could not reach the pool finishes now, in the background.
  void finishPendingSignOut(SecureStore).catch(() => undefined);

  const signedIn = await loadSignedIn(SecureStore);
  const connection: CloudConnection | null = signedIn
    ? { kind: "session", baseUrl: signedIn.cloud.baseUrl, email: signedIn.email }
    : null;
  const cloud = signedIn ? sessionChannel(signedIn.cloud) : null;

  const node = await createMobileNode({
    nodeId: identity.nodeId,
    databasePath: DATABASE_PATH,
    sqliteDriver: opSqliteDriver,
    localObjectStorage: createLocalObjectStorage(),
    deviceMedia: deviceMediaStorage,
    ...(hashFileParts ? { hashFileParts } : {}),
    ...(cloud ? { cloud } : {}),
  });
  return { node, identity, connection };
}

/**
 * Every request the channel makes, bounded by the window that made it.
 * React Native's `fetch` has no timeouts of its own — `OkHttpClientProvider`
 * sets connect, read and write to zero — so a stalled socket in a background
 * window would otherwise hold the process until WorkManager cancelled it ten
 * minutes later, which is the whole daily allowance in the RARE bucket.
 */
function boundedFetch(): typeof fetch {
  return backgroundWindow.boundFetch((input, init) => globalThis.fetch(input, init));
}

/**
 * The Drive channel for a signed-in phone: every data-plane request carries the
 * device client's ID token and nothing else, which is what the cloud's
 * device-token branch accepts. The token goes only to the channel's own URL;
 * presigned S3 and CloudFront URLs never see it.
 */
function sessionChannel(cloud: SessionCloud) {
  const channelUrl = `${cloud.baseUrl.replace(/\/+$/, "")}/apps/${DRIVE_APP_ID}`;
  const tokens = createCloudTokenSource({
    client: cognitoFor(cloud),
    store: createSessionStore(SecureStore),
    // The pool ended the sign-in. The session is already cleared; the screen
    // hears of it and reopens the node without a cloud.
    onRejected: notifySessionRejected,
  });
  const fetchImpl = withUserToken(boundedFetch(), channelUrl, tokens);
  return driveChannel(channelUrl, fetchImpl, () => ({}), async () => {
    // The user the library binds to is the signed-in token's own.
    const token = await tokens.current();
    if (!token) throw new SignedOutError();
    return { userId: idTokenClaims(token).sub };
  });
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
 * **Configured only once the phone is signed in.** The sign-in names the
 * cloud's address, so a signed-out phone has no cloud to name, and the screen
 * says "not connected" rather than showing a sync that fails.
 */
function driveChannel(
  channelUrl: string,
  fetchImpl: typeof fetch,
  signRequest: (method: string, path: string, body?: string | Uint8Array) => Record<string, string>,
  readSyncUser: () => Promise<{ userId: string | null }>,
) {
  return {
    // Signed over the path below the app, as the sync transport signs.
    async readDeploymentSettings(): Promise<unknown> {
      const res = await fetchImpl(`${channelUrl}${DEPLOYMENT_SETTINGS_ROUTE}`, {
        method: "GET",
        headers: signRequest("GET", DEPLOYMENT_SETTINGS_ROUTE),
      });
      if (!res.ok) throw new Error(`the cloud answered ${res.status} for the deployment's settings`);
      const body = (await res.json()) as { settings?: unknown };
      return body.settings ?? null;
    },
    readSyncUser,
    transport: createHttpSyncTransport({ baseUrl: channelUrl, signRequest, fetch: fetchImpl }),
    remoteObjectStorage: new HttpObjectStorageAdapter({
      baseUrl: `${channelUrl}/files`,
      signRequest,
      fetch: fetchImpl,
      // Supplying this is what turns on `putFromFileUri`, and with it the path
      // where a video's bytes go from the media store to S3 without passing
      // through Hermes. See {@link uploadFile}.
      uploadFile,
      // A video above the multipart threshold goes up in parts that survive a
      // closed background window. See `storage/multipart-sessions.ts`.
      ...(hashFileParts && uploadFileRange
        ? { hashFileParts, uploadFileRange, multipartSessions }
        : {}),
    }),
  };
}

/** The User-Data-Owner app id. Must match `sync-supervisor.ts`'s constant. */
export const DRIVE_APP_ID = "starkeep-drive";

/**
 * The native video functions, checked per function rather than per module:
 * an older development client loads the module without them.
 */
const videoNative =
  mediaHash &&
  typeof mediaHash.videoFactsOfUri === "function" &&
  typeof mediaHash.extractPostersOfUri === "function"
    ? mediaHash
    : null;

/** Whether reads may ask for unredacted bytes. False on a binary without the check. */
export function mediaLocationGranted(): boolean {
  try {
    return typeof mediaHash?.mediaLocationGranted === "function" && mediaHash.mediaLocationGranted();
  } catch {
    return false;
  }
}

let warnedNoLocation = false;

/**
 * The URI import reads an asset through. Checked per asset, because the grant
 * can arrive while the app runs. See `media/original-uri.ts`.
 */
function readUriFor(uri: string): string {
  if (mediaLocationGranted()) return requireOriginalUri(uri);
  if (!warnedNoLocation) {
    warnedNoLocation = true;
    console.warn("[import] no media-location permission; imported photos and videos lose their GPS location");
  }
  return uri;
}

/** Where a poster's JPEG sits between the native encode and the object store. */
function posterScratchPath(name: string): string {
  return `${Paths.cache.uri.replace(/\/$/, "")}/posters/${name}`;
}

/** What makes a video's posters on this device, or null on a binary that cannot. */
function videoPosterDepsFor(node: MobileNode, clock: HLCClock): VideoPosterDeps | null {
  if (!videoNative) return null;
  return {
    database: node.databaseAdapter,
    objectStorage: node.objectStorage,
    clock,
    hash: sha256Bytes,
    userId: () => node.userId(),
    readFacts: (uri) => videoNative.videoFactsOfUri(uri),
    extractPosters: (uri, timeUs, outputs, quality) =>
      videoNative.extractPostersOfUri(uri, timeUs, [...outputs], quality),
    scratchPath: posterScratchPath,
    readScratch: (path) => new File(path).bytesSync(),
    removeScratch: (path) => new File(path).delete(),
    noteDerived: (record) => node.noteDerived(record),
  };
}

/** Import dependencies, assembled from the real modules for a live node. */
export function importDepsFor(node: MobileNode, clock: HLCClock): ImportDeps {
  if (!node.mediaAliases) {
    throw new Error("this node was built without deviceMedia, so it cannot import a camera roll");
  }
  const videoPosters = videoPosterDepsFor(node, clock);
  return {
    media: deviceMedia,
    aliases: node.mediaAliases,
    database: node.databaseAdapter,
    clock,
    fs: expoFileSystem,
    hash: sha256Bytes,
    ...(sha256OfUri ? { hashUri: sha256OfUri } : {}),
    readUriFor,
    ...(videoPosters ? { videoPosters } : {}),
    userId: () => node.userId(),
    thumbHash: thumbHashFor,
    ...(node.motionIndex ? { motionIndex: node.motionIndex } : {}),
  };
}

/**
 * Give posters and a capture time to videos imported before this device made
 * them. Answers `complete: true` on a node that cannot, so the caller stops
 * asking. Foreground only, like the other repairs: it decodes a frame per clip.
 */
export function backfillVideoPostersFor(
  node: MobileNode,
  clock: HLCClock,
  options: { readonly limit: number; readonly after?: string | null },
): Promise<VideoPosterBackfillOutcome> {
  const deps = videoPosterDepsFor(node, clock);
  if (!node.mediaAliases || deps === null) {
    return Promise.resolve({ scanned: 0, written: 0, complete: true, resumeAfter: null });
  }
  return backfillVideoPosters(
    { ...deps, aliases: node.mediaAliases },
    { limit: options.limit, ...(options.after !== undefined ? { after: options.after } : {}) },
  );
}

/**
 * The ~25-byte placeholder for whatever is at this URI.
 *
 * ## Why the decode is `expo-image`'s
 *
 * It is the decoder this app already trusts to paint every tile. On Android
 * that is Glide, which reads a `content://` asset, a `file://` blob and an
 * extensionless synced original alike, sniffing the source rather than trusting
 * a file extension — the same property that makes a video's first frame
 * paintable. Adding a second decoder to answer the same question in JavaScript
 * would be a second thing that can disagree about what a file contains.
 *
 * The returned string is base64 of the ThumbHash bytes, which is exactly what
 * `derive-ladder.ts` writes on a node running `sharp`. `media/thumb-hash.ts`
 * records why the two agree.
 *
 * ## Why every failure is null
 *
 * A missing placeholder is an ordinary state — most records had none until this
 * pass existed — so nothing here is worth failing an import or a backfill for.
 * The one case worth naming is a video the decoder cannot open: it answers
 * null, the tile paints its own first frame as it already does, and no
 * placeholder is lost that anything was relying on.
 */
export const thumbHashFor: ThumbHashEncoder = async (uri) => {
  try {
    const hash = await Image.generateThumbhashAsync(uri);
    // An empty string is not a placeholder. Normalising it here means every
    // reader downstream can treat "a string" as "a hash".
    return hash ? hash : null;
  } catch {
    return null;
  }
};

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
 * ## Both callers pass the cursor
 *
 * The watermark is what makes a repeated scan cheap, which is right for a pass
 * that runs on every app open and on every background window. See
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
      importFloor: node.importFloor ?? undefined,
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
 * Give a placeholder to records imported before this device made them.
 *
 * Answers `complete: true` on a node that reads no camera roll, because such a
 * node has nothing to repair and the caller's job is to stop asking.
 *
 * Foreground only, and the argument is the EXIF backfill's carried one step
 * further: this pass decodes whole photographs rather than reading their
 * headers, and a background window's budget belongs to the sync that gets them
 * off the device.
 */
export function backfillThumbHashesFor(
  node: MobileNode,
  options: { readonly limit: number; readonly after?: string | null },
): Promise<ThumbHashBackfillOutcome> {
  if (!node.mediaAliases) {
    return Promise.resolve({ scanned: 0, written: 0, complete: true, resumeAfter: null });
  }
  return backfillThumbHashes(
    {
      aliases: node.mediaAliases,
      database: node.databaseAdapter,
      encode: thumbHashFor,
    },
    { limit: options.limit, ...(options.after !== undefined ? { after: options.after } : {}) },
  );
}

/**
 * Decode a photograph once and encode AVIF rungs from it, or null on a build
 * with no encoder.
 *
 * ## The decode is expo-image's, and only the encode is ours
 *
 * `Image.loadAsync` hands back an `ImageRef` — on Android a `SharedRef<Drawable>`
 * over a Glide-decoded bitmap — and bounding it to `maxLongEdge` here is what
 * makes the ceiling cost nothing: a 12-megapixel original is never held whole,
 * and every rung below reads the one bitmap. It is also the decoder this app
 * already trusts to paint every tile, which is the argument `thumbHashFor`
 * makes: a second decoder is a second thing that can disagree about what a file
 * contains.
 *
 * ## Why the bytes go through the cache directory
 *
 * The encoder writes to a path rather than returning bytes across the bridge —
 * see the module's own header — and the caller needs them in hand to hash them
 * into a content-addressed key. The cache is the right place for a file whose
 * whole life is those two steps: it is deleted immediately, and an encode killed
 * between the write and the delete leaves behind exactly the kind of bytes
 * {@link cachePath} exists for, which the OS may reclaim whenever it likes.
 *
 * ## Every failure is null, and only at the decode
 *
 * A camera roll contains files this device cannot read — a RAW original, a
 * truncated JPEG, an asset the media store has lost since the alias was written
 * — and none of them is a reason to fail a pass. An encode that fails after a
 * successful decode is a different matter and is left to throw: it means the
 * encoder rejected a bitmap it should have taken, which is worth surfacing as
 * the record's failure rather than silently producing nothing.
 */
export const avifEncoder: ImageEncoder | null = ((avif) =>
  avif === null
    ? null
    : (async (uri, maxLongEdge) => {
        const ref = await Image.loadAsync(uri, {
          // Both axes, because the cap is on the long edge and the loader does
          // not know which one that is. It preserves the aspect ratio, so the
          // pair bounds the larger and leaves the smaller wherever it lands.
          maxWidth: maxLongEdge,
          maxHeight: maxLongEdge,
        }).catch(() => null);
        if (ref === null) return null;
        return {
          async encode(longEdge, quality) {
            const path = cachePath("starkeep-derive", `${generateId()}.avif`);
            const file = expoFileSystem.file(path);
            try {
              const result = await avif.encodeAsync(ref, path, longEdge, quality);
              // Read back rather than trusted from the result, which reports a
              // length and not the bytes. The dimensions do come from the
              // encoder, because it is what applied the cap.
              return { bytes: file.bytesSync(), width: result.width, height: result.height };
            } finally {
              try {
                file.delete();
              } catch {
                // The bytes are already in hand or already lost, and either way
                // this is a cache file. Failing a rendition over it would be the
                // wrong trade.
              }
            }
          },
          release() {
            ref.release();
          },
        };
        // Bound once rather than read per call, because TypeScript cannot see
        // that a module-level null check still holds inside a closure — and the
        // alternative, a non-null assertion at the call site, would be the same
        // claim with nothing checking it.
      }) satisfies ImageEncoder)(StarkeepAvif);

/**
 * Make the rungs this device's own photographs are missing.
 *
 * Resolves null when this node cannot derive at all — no camera roll to walk, or
 * a build with no encoder in it. Null rather than an empty outcome because the
 * two mean different things to the tick: an outcome of zero is a pass that found
 * nothing to do, and null is a device that will never find anything.
 *
 * Runs in the background window, where the job graph places it. The pass is
 * bounded by its page and stops between records on the signal, so a window that
 * closes mid-page costs the record in flight and nothing else.
 */
export function deriveRenditionsFor(
  node: MobileNode,
  clock: HLCClock,
  options: {
    readonly maxRecords?: number;
    readonly signal?: { readonly aborted: boolean };
  } = {},
): Promise<DeriveLadderOutcome | null> {
  return runBackgroundPass(node, clock, "cheap", options);
}

/**
 * Make the larger rungs — 2560 and the canonical — for this device's own
 * photographs, one record at a time.
 *
 * The full-ladder counterpart to {@link deriveRenditionsFor}, with its own
 * cursor and the same null contract. It is what lets a phone derive its own
 * photographs in full, so no desktop has to fetch their originals to do it.
 * The caller runs it only when power allows; see `fullDeriveMayRun`.
 */
export function deriveFullRenditionsFor(
  node: MobileNode,
  clock: HLCClock,
  options: {
    readonly maxRecords?: number;
    readonly signal?: { readonly aborted: boolean };
  } = {},
): Promise<DeriveLadderOutcome | null> {
  return runBackgroundPass(node, clock, "full", options);
}

/** One background pass, as `backgroundDerivePlan` allows it. */
function runBackgroundPass(
  node: MobileNode,
  clock: HLCClock,
  pass: BackgroundDerivePass,
  options: { readonly maxRecords?: number; readonly signal?: { readonly aborted: boolean } },
): Promise<DeriveLadderOutcome | null> {
  const plan = backgroundDerivePlan(
    node,
    pass,
    options.maxRecords !== undefined ? { maxRecords: options.maxRecords } : {},
  );
  if (plan === null) return Promise.resolve(null);
  const deps = deriveDepsFor(node, clock);
  if (deps === null) return Promise.resolve(null);
  return deriveRenditions(
    { ...deps, cursor: plan.cursor },
    {
      ...(plan.ceilingLongEdge !== undefined ? { ceilingLongEdge: plan.ceilingLongEdge } : {}),
      ...(plan.maxRecords !== undefined ? { maxRecords: plan.maxRecords } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
}

/**
 * Make the rungs one record is missing, because a surface is showing it.
 *
 * The targeted counterpart to {@link deriveRenditionsFor}, and the same null
 * contract: a device with no camera roll or no encoder in the binary answers
 * null and the caller stops asking. See `deriveForRecord` for the three things
 * it refuses and why re-encoding an existing rung is the one that would do
 * damage.
 *
 * Deliberately takes no signal. One record is one decode and at most three
 * encodes, on a foreground surface, with somebody waiting for exactly this
 * picture — there is no window to give back.
 *
 * `ceilingLongEdge` is the largest rung to make, and omitting it keeps the
 * sweep's default. The viewer passes the rung its stage actually needs, which is
 * how a phone comes to make `image-screen` for the one photograph on screen
 * without volunteering to make it for sixty thousand others.
 */
export function deriveRecordFor(
  node: MobileNode,
  clock: HLCClock,
  record: DataRecord,
  ceilingLongEdge?: number,
): Promise<number | null> {
  const deps = deriveDepsFor(node, clock);
  if (deps === null) return Promise.resolve(null);
  return ceilingLongEdge === undefined
    ? deriveForRecord(deps, record)
    : deriveForRecord(deps, record, ceilingLongEdge);
}

/**
 * What both derivation entry points need, or null on a device that cannot.
 *
 * One place rather than two, because the pair differ only in which records they
 * walk: everything below — the encoder, the hash, where the bytes land, which
 * budget they are charged to — is the same wiring, and two copies of it is how
 * a rung derived by one path ends up uncharged or unlabelled relative to the
 * other.
 */
function deriveDepsFor(node: MobileNode, clock: HLCClock): DeriveLadderDeps | null {
  if (!node.mediaAliases || avifEncoder === null) return null;
  return {
    aliases: node.mediaAliases,
    database: node.databaseAdapter,
    objectStorage: node.objectStorage,
    clock,
    hash: sha256Bytes,
    userId: () => node.userId(),
    encode: avifEncoder,
    noteDerived: (record) => node.noteDerived(record),
    librarySettings: node.librarySettings,
  };
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
 * Delete a library item in Starkeep, and answer the camera-roll files that held
 * its bytes. See `photos/delete-record.ts`.
 */
export function deleteRecordFor(
  node: MobileNode,
  clock: HLCClock,
  recordId: StarkeepId,
): Promise<DeleteRecordOutcome> {
  return deleteLibraryRecord(
    {
      database: node.databaseAdapter,
      clock,
      aliases: node.mediaAliases,
      assetExists: (uri) => expoFileSystem.file(uri).exists,
    },
    recordId,
  );
}

/**
 * Ask Android to move camera-roll files to its trash. Resolves whether the
 * person confirmed in the system's dialog.
 *
 * Never rejects: a binary without the native function, a declined dialog and a
 * failed request all leave the files where they are, and the Starkeep delete
 * that came first stands on its own.
 */
export async function trashCameraRollFiles(uris: readonly string[]): Promise<boolean> {
  if (uris.length === 0 || typeof mediaHash?.trashMediaUris !== "function") return false;
  try {
    return await mediaHash.trashMediaUris([...uris]);
  } catch (err) {
    console.warn(`[delete] could not move ${uris.join(", ")} to the trash: ${String(err)}`);
    return false;
  }
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
