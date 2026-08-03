# Native blob transfer on the phone

## The problem

Pushing a 24.5 MB video crashed the app with a native SIGSEGV (null deref) on the
JS thread, inside `expo::EventEmitter::Listeners::call` → Hermes. Four small
stills had pushed successfully first; the fifth record in `created_at` order is
the first video. The device was simultaneously being pruned by
`lowmemorykiller` ("low watermark is breached and swap is low") and Hermes had
just logged GC-histogram saturation. It is a failed allocation, not a logic bug.

The transfer path is streamed on paper and buffered three times over in practice:

1. `streamFromFile` (`src/storage/expo-object-storage.ts`) cannot open a handle on
   a `content://` MediaStore asset, so it calls `bytesSync()` — the whole object
   arrives as one chunk in the JS heap.
2. `verifyingStream` hashes that buffer.
3. `HttpObjectStorageAdapter.putStream` hands the stream to `fetch`. On SDK 57
   `globalThis.fetch` is `expo/fetch` (`expo/src/winter/runtime.native.ts:52`),
   whose `normalizeBodyInitAsync` calls `convertReadableStreamToUint8ArrayAsync`:
   it drains the stream into a chunk array and then allocates a *second*
   full-size `Uint8Array` and copies. expo-modules-core then copies it again into
   a Kotlin `ByteArray`.

So `file-sync-engine.ts`'s "Streamed, never buffered … a 2 GB clip could not sync
at all" is true of Node and false of the handset. Peak cost is roughly 3–4× the
object size, per blob. Seven more videos are queued behind the one that crashed,
up to 54 MB.

## What the platform actually offers

`expo-file-system`'s `FileSystemUploadTask` (Android) builds an OkHttp
`RequestBody` straight from `UnifiedFileInterface.inputStream()` and streams it
into the sink. It never materialises. `ContentProviderFile` — what a MediaStore
`content://` URI resolves to — implements both `inputStream()` and `length()`,
which is exactly the capability `streamFromFile`'s own doc comment says is
missing. `UploadOptions` supports `httpMethod: 'PUT'`, `BINARY_CONTENT`, and
arbitrary headers, which is all a presigned S3 PUT needs.

That is the fix: **the bytes never enter the JS heap at all.**

## The seam

The engine must not learn what a camera roll is, so this is negotiated as a pair
of optional capabilities on `ObjectStorageAdapter` — the same shape as the
existing `getSignedUrl?` / `putSymlink?`:

```ts
/** The bytes for this key are a file the platform can read directly. */
localFileUriFor?(key: string): string | null;

/** Send a file's bytes without them passing through JS. */
putFromFileUri?(key: string, fileUri: string, options?: PutStreamOptions): Promise<void>;
```

`transfer()` in `file-sync-engine.ts` asks the source for a URI and the
destination whether it can take one. Both present → native path. Either absent →
the existing stream path, untouched. Nothing about phones appears in the engine;
a source that is a file and a destination that can post one is a general fact.

### The checksum rule

`putStream` verifies the whole-object SHA-256 in JS as bytes pass. The native
path cannot — JS never sees a byte. It does not need to: the server pins
`x-amz-checksum-sha256` into the presigned URL's signature for every
content-addressed key (it derives it from the key, which *is* the hash), and a
single-part PUT is verified by S3 itself. The JS check exists for the multipart
case, where S3 cannot check a whole-object digest at all.

So the native path is permitted exactly when the presign response carried a
pinned checksum, or when no verification was requested. If a caller asks for
`expectedSha256Hex` and presign returns no pin, `putFromFileUri` throws
`FileUriTransferRefused` and the engine falls back to the stream path.

**The refusal may only be raised before any bytes move.** A mid-upload failure
falling back would re-send the object through the JS heap — the exact crash this
removes. This is stated on the interface, not left to implementors to infer.

## Changes

### starkeep-core

1. `packages/storage-adapter/src/object-storage/adapter.ts` — the two optional
   members above, documented with the negotiation and the refusal rule.
2. `packages/storage-adapter/src/errors.ts` + `index.ts` — `FileUriTransferRefused`.
3. `packages/sync-engine/src/file-sync-engine.ts` — try the native path in
   `transfer()`, fall back on refusal.
4. `packages/sync-engine/src/transports/http-object-storage.ts` — an injected
   `uploadFile` port (same idiom as `fetch` and `signRequest`), a
   `putFromFileUri` defined only when that port was supplied, and the presign
   body/headers logic shared with `putStream` rather than copied.
5. `__tests__/file-uri-transfer.test.ts` — the native path is taken when both
   sides support it; the buffered *and streamed* methods are untouched when it
   is; refusal falls back and still lands the bytes.

### photos-mobile

6. `src/storage/expo-object-storage.ts`
   - `localFileUriFor(key)` — the stored blob's `file://` URI, or null.
   - `putStream` currently reads the temp file whole and writes it across to the
     final key, because "expo-file-system has no rename on the File class in this
     shape". It does: `moveSync(destination, { overwrite })`. That removes a
     full materialisation from the *pull* path, which has the same OOM exposure.
   - `streamFromFile` reads `bytesSync()` eagerly at stream construction for
     content URIs, so the 24 MB read happens even for a consumer that never
     pulls. Make it lazy, so the fallback path costs nothing when the native path
     is taken.
   - `ExpoFile` port gains `moveSync`.
7. `src/storage/device-media-storage.ts` — `localFileUriFor(key)` returns the
   aliased asset's `content://` URI when the alias is live, else delegates.
   Aliased keys still refuse writes; this is a read.
8. `src/platform.ts` — implement `uploadFile` over `new File(uri).upload(url, …)`
   and pass it to `HttpObjectStorageAdapter`. This is the only file that may
   import expo, which is why the port exists.
9. `__tests__/helpers/fake-expo-fs.ts` — `moveSync`.
10. Tests for the adapter's URI resolution, the lazy stream, and the move.

## Out of scope, deliberately

- **Native download for pull.** Step 6's `moveSync` makes the pull path stream
  end-to-end (expo's fetch *response* body genuinely streams, via
  `didReceiveResponseData`), so pull is bounded after this change. A native
  `File.downloadFileAsync` would avoid the per-chunk JS copies as well, and needs
  the mirrored capability pair plus an answer for verifying a file's digest
  without reading it into JS. Worth doing; not needed to stop the crash.
- **`POST /files/confirm` returning 404.** The cloud data server has no such
  route (only `packages/testkit`'s fake cloud does), so every upload logs a
  warning and `PendingFileDownload` never flips eagerly. Best-effort by design,
  independent of this change, and it needs a cloud redeploy.
- **`getFilesToPush` materialising every candidate blob** to read `localFile.size`
  when `stat()` would answer for free (`file-sync-engine.ts:93`). Not on the
  mobile exchange path, which builds manifests from record metadata.

## Verification

Core unit tests, app unit tests, both typechecks, then `pnpm build` in
sync-engine — photos-mobile consumes it through `dist`, via a symlink into the
core workspace. Then a live Sync now on the handset with `adb logcat` attached:
the eight videos should land, and the JS heap should not move while they do.
