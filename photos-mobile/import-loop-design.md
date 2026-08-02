# The mobile import loop — indexing the camera roll without copying it

Working design for items 13b/15a of `starkeep-core/android-implementation-plan.md`. That plan and
`media-storage-and-transfer-plan.md` remain authoritative for *what* is being built and why; this
covers the one thing neither settles — what import means on a device that already holds the bytes.

Status: design only. Nothing here is implemented.

---

## 1. The premise

A phone is not like a laptop being onboarded. On the laptop the bytes arrive from somewhere and the
node stores them. On the phone the bytes are **already there**, owned by the OS, under a permission
the user granted directly to the media store. Import must therefore add a *record*, not a *copy*.

That single constraint drives everything below:

- **Originals are aliased, never copied.** The MediaStore asset is the local copy. The node holds a
  pointer.
- **Renditions are real bytes in the node's object store.** They are new bytes that exist nowhere
  else, and they are shared image records (media plan §4.4), so other apps and other devices consume
  them.

The asymmetry is the design. It is not a compromise.

---

## 2. Aliasing — the mobile answer to `putSymlink`

### The precedent already exists

`ObjectStorageAdapter.putSymlink?()` (`storage-adapter/src/object-storage/adapter.ts:103`) is an
**optional** method. `storage-fs` implements it with `symlink()` (`storage-fs/src/adapter.ts:62`),
and `sdk.putWithLocalFile` calls it with a `put()` fallback when absent (`sdk/src/sdk.ts:213`). So
"the record's bytes live somewhere else on this machine" is already a blessed shape, and the local
data server already runs on it.

### Why the filesystem version cannot work on Android

- MediaStore hands out `content://` URIs, not paths. Under scoped storage the app has **no**
  filesystem path for the asset — `_data` is deprecated and unavailable on modern Android.
- `expo-file-system` exposes no symlink API.
- Even where a real path happens to exist, using it bypasses the permission model that MediaStore
  exists to enforce.

You cannot `symlink()` to a content URI. So the indirection moves up one layer.

### The alias table

Same idea, implemented in the object-storage adapter instead of in the filesystem: a local table
mapping content-addressed key → the asset that holds those bytes.

| Column | Purpose |
|---|---|
| `object_storage_key` | The content-addressed key, as everywhere else |
| `content_uri` | `content://media/external/images/media/1234` |
| `asset_id` | MediaStore id, for re-resolution |
| `size_bytes` | From the cheap metadata query |
| `modification_time` | **The staleness signal** — see §2.4 |

`ExpoObjectStorageAdapter` consults it in exactly four places, and behaves normally everywhere else:

- `has(key)` — alias row present *and* still valid → `true`
- `stat(key)` — size and content type from the alias row
- `getStream(key)` / `getStream(key, range)` — resolve to the content URI and read from it
- `delete(key)` — **drops the alias row only. Never touches the asset.** Deleting the user's photo
  because a cache policy fired is the worst thing this app could do.
- `put(key, …)` on an aliased key — never happens; treat as a programming error.

### Verified: this needs no native module

`expo-file-system` 57 handles content URIs natively. `ContentProviderFile`
(`android/src/main/java/expo/modules/filesystem/unifiedfile/ContentProviderFile.kt`) implements
`exists()`, `length()`, `inputStream()` and `openFileDescriptor()`, and `FileSystemFile.kt:71`
routes content URIs to `FileSystemFileHandle.forContentURI(uri, mode, contentResolver)` — which is
the ranged-read path. That is precisely the four capabilities the adapter needs, so `new File(uri)`
covers the whole read side.

This is a genuinely nice result: the *storage* half of import needs no native code at all. Only
derivation (§3) does.

### Nothing in the sync engine changes

Residency is derived, not stored: `residencyOf` (`sync-engine/src/residency.ts:53`) asks
`localStorage.has(recordRow.object_storage_key)` and returns `resident` if true. So an aliased
original is `resident` by the ordinary path. `getFilesToPush` works. The watermark works. No
`Elided` special case, no new residency state, and — importantly — the sync engine never learns what
a camera roll is. That seam is worth protecting; it is the thing that keeps mobile a *configuration*
of the node rather than a second implementation of it.

### 2.4 Staleness is the real risk, and it is handled by demotion

The alias can go stale: the user deletes the photo, or Google Photos "frees up space", or an editor
rewrites the asset. Then `has()` would lie, and lying about blob presence is how a node comes to
believe a byte exists that does not.

`ContentProviderFile.lastModified()` returns `null`, so the file API cannot answer this. But
`AssetMetadata` from the cheap metadata query carries `modificationTime: number | null` — store it
at import and compare on resolve. Mismatch, or a URI that no longer resolves, means the alias is
dead.

**A dead alias demotes the record to `staged`, and must never tombstone it.** `staged` is exactly
right: the metadata is real, the bytes are wanted, and they are not here. If the blob was pushed
before the asset vanished, the phone re-fetches it on demand like any other elided-then-wanted
record. If it was *not* pushed, those bytes are gone — which is real data loss and the honest thing
to do is surface it, not hide it. See §6.

Note `src/media/device-library.ts` does not currently map `modificationTime`. Small change, needed
first.

### 2.5 Aliased originals stay out of the resident-set index

`resident-set.ts` is the budget and eviction index. Aliased originals must not be in it:

- The node **cannot** evict them — eviction means deleting the user's photo.
- They do not consume node-managed bytes. The camera roll's space is not Starkeep's to manage, and
  counting it would make every budget figure on the phone a fiction.

They should still be *visible* in the residency inspector (item 15b) as a distinct state — held by
the device's media store — because "we have these bytes but did not choose to and cannot release
them" is a real and useful thing to see.

One pleasant consequence: media plan §7.2.1's rule that *originals captured here are retained until
confirmed durable elsewhere* is satisfied for free on the phone. The camera roll enforces it. The
phone gets the strongest retention guarantee in the system at zero cost, which is the opposite of
what you would expect from the most storage-constrained node.

---

## 3. Renditions: derive locally, but only once there is a consumer

**Where derivation happens** and **when it is triggered** are separate questions, and conflating
them produced a wrong answer in an earlier draft of this document.

### 3.1 Where: the phone, and nowhere else

Settled by the media plan, and not in tension with anything below:

1. **§4.1's rule is "derive at the first point where the bytes are resident."** On a phone that is
   here, and it costs no egress, no Lambda, no S3 GET, no thaw.
2. **The phone is the only place HEIC decodes at all.** §4.2 is explicit that the cloud fallback
   covers JPEG, PNG, WebP and AVIF *only*, and §8.1 deliberately rejects the custom libvips build
   that would close that. A phone that defers HEIC to the cloud produces a record that never gets a
   ladder from anyone.
3. **The originating node owns derivation indefinitely** (§4.2, case 1). The cloud is a 24-hour
   singleton *fallback*, not the primary.

### 3.2 When: gated on having a session, not on being online

An earlier draft of this document also argued that the local grid needs `image-thumb` because
rendering 60k tiles from full-res `content://` URIs means a full decode per tile. **That argument is
wrong and is withdrawn.** React Native's `Image` on Android goes through Fresco, which does scaled
decode, and MediaStore maintains its own thumbnail service for exactly this. The device's own camera
roll renders fine with no Starkeep rendition anywhere in the picture — which is precisely what the
existing `MediaGrid` already demonstrates.

So the honest accounting of who consumes a rendition:

| Consumer | Exists before sync? |
|---|---|
| The device's own camera-roll grid | **No** — MediaStore/Fresco already serve this |
| Another node (cloud, laptop, second phone) | No |
| The library grid, for records whose bytes are *not* on this device | No — such records only exist once syncing |

Every consumer is downstream of sync. Deriving before then is battery spent on bytes nothing will
read, on a device where battery is the scarcest resource in the system.

**The gate is therefore: the node has a session.** Not "the cloud is reachable" — that distinction
matters and points the other way from the obvious reading:

- A phone that has **never** signed in derives nothing. Its grid comes from MediaStore, its records
  and aliases are written by import, and that is a complete and useful offline node.
- A phone that **is** signed in but currently offline **does** derive. `derive-ladder` is already
  declared `requiresNetwork: false, requiresCharging: true` in `src/work/job-graph.ts`, and that is
  exactly right: derivation is the offline work that makes the *online* moment fast. §4.1 wants
  renditions pushed before originals, so a phone that arrives at a connection with its ladder
  already built makes the library browsable everywhere within seconds instead of hours.

What is missing is not the constraints — those are correct as declared — but the **enablement
check**. `derive-ladder` needs a precondition of "this node is a sync peer", which is a different
kind of thing from a `JobConstraints` field and should not be smuggled in as one.

### 3.3 Cost and ordering

This is item 13b, the open native work — `expo-media-library` does not decode. JPEG might get by
with `expo-image-manipulator`, but HEIC and raw need `ImageDecoder`/`MediaCodec` behind a module
nobody has written yet. The gate above is what buys time: 13b is not on the critical path to a
useful offline app, only to a syncing one.

When it does run: `image-thumb` first for the whole library, then the rest of the ladder per-record,
under the constraint that no work item assumes more than a few seconds.

---

## 4. Face detection — deferred, and cheap to defer

Agreed, defer. Worth recording *why* it is cheap: face results are derived app data keyed by record
id. They do not participate in the import loop, do not change the record shape, and do not change
the alias or the ladder. Adding them later is additive. See `starkeep-apps/face-recognition-plan.md`.

---

## 5. Interoperability with photos-web — the actual blocker

The requirement is right and it is not negotiable: mobile and web are the same app, and a caption
written on the phone offline must be the same caption the web app reads. But two things stand in the
way, and one of them is the same blocker item 15a already has.

### 5.1 The caption's shape is currently a Next.js implementation detail

Captions live in `photos_syncable_image_enriched` (record_id, caption, title, date_taken_override),
reached through `app/api/photos/captions/[id]/route.ts`, which deliberately hides the table name and
row shape as "an implementation detail of the photos app" and enforces the 2000-char limit at the
route.

Mobile has no Next.js route. So that shape and those rules have to become a **shared module** both
front ends call — which is the `photos-lib` split the android plan already flags as a §6 risk
(`photos-lib` is written for Node: `node:crypto`, `node:fs`, `sharp`). The split is a prerequisite
for interop, not a follow-on from it.

If the shape is instead re-implemented on mobile, the two will drift, and the drift will be silent
until a caption written on one device is invisible on the other.

### 5.2 The phone cannot reach the cloud data plane at all — how to fix it

#### What is actually true today (checked against the code, not the doc)

`data-roles-and-permissions.md` §"How data access actually flows at runtime" describes a browser
sending a **Cognito JWT** which a **JWT authorizer** validates before the broker assumes the per-app
role. **That is not what the code does.** `api-handler.ts:1558` is explicit:

> HMAC verification gate. Every `/apps/{appId}/*` route (sync exchange, `/data/*`, `/files/*`,
> `/app-data/*`, `/health`) is HMAC-signed by the caller.

There is no JWT authorizer, and grepping the handler for `cognito` / `userSub` / `authorizer` finds
nothing. **No user identity reaches the cloud data plane at any point.** The deployment is
single-tenant by construction: it is the operator's own AWS account, and "which user" is not a
question the data plane can currently ask.

The roles doc should be corrected on this point separately — it describes an intended end state in
the present tense, which is how this got mis-read once already.

Two further facts that change the shape of the answer:

- **The secret is symmetric and shared.** `~/.starkeep/app-creds/<appId>.json` on the operator's
  machine, mirrored to SSM cloud-side. Whoever holds it *is* the app.
- **Photos sync does not use the photos credential.** Shared records — the photos themselves — flow
  through the Starkeep Drive channel: `sync-supervisor.ts:247` builds
  `/apps/starkeep-drive/...` with `makeSignerFor(DRIVE_APP_ID)`. So the phone needs **two**
  channels, `starkeep-drive` for the images and `photos` for captions, and the credential question
  applies to both.

#### Why not simply ship the secret

1. It is symmetric: a handset holding it can mint any request as that app.
2. Revocation is all-or-nothing. Rotating after a lost phone breaks the laptop and the cloud app
   Lambda too.
3. It is extractable. An APK is distributable and a rooted device reads what the app can read.
4. It never expires.

#### The options

**A — Per-device asymmetric key, registered at sign-in. (Recommended.)**
The phone generates a keypair in the Android Keystore (StrongBox where available, so the private key
is hardware-backed and non-extractable), and registers the *public* key with the cloud, using its
existing Cognito session as the bootstrap authentication. Thereafter the phone signs requests with
the device key; the verifier resolves a key id to a registered public key instead of an app id to a
shared secret.

- Keeps the invariant the code insists on — every request is signed, path-trust is never enough.
- Revocation is per device: delete the row. Nothing else is disturbed.
- Nothing secret is stored cloud-side; the cloud holds public keys.
- Gives per-device attribution, which is also what the residency inspector wants.
- Cost: a device registry table, a registration endpoint, an admin-web screen, and widening
  `loadAppHmacSecret(appId)` into "resolve the verifying key for this request". Server-to-server
  HMAC stays exactly as it is.

**B — Add the JWT authorizer the roles doc already describes.**
Phone sends its Cognito access token plus an app id; the broker verifies and assumes the per-app
role as today.

- Cheapest in new concepts, and it makes the code match its own documentation.
- **But the JWT identifies the user, not the app.** A user token would be usable against any
  `appId`, which is the exact attack the HMAC gate comment cites. It collapses the app boundary for
  anything holding a user token unless app scope is bound into the token.
- Reasonable as a *complement* to A (bootstrap auth for registration), poor as a replacement.

**C — Phone syncs via the laptop's local-data-server over the LAN.**
The laptop holds every credential; the phone never talks to the cloud.

- Zero new cloud auth, and could be built now.
- Sync only works at home with the laptop awake, and it contradicts media plan §7.5's position that
  the phone is a sync *peer* rather than a local-data-server client.
- Genuinely useful as a **development and testing path** — it would let interop be proven end to end
  before any of A lands — but it is not the answer.

**Recommendation: A, bootstrapped by B's token, with C as the near-term test path.** Sign-in already
works on the handset (`src/auth/cognito.ts`) and currently buys nothing; device registration is the
thing that would make it buy sync, which is what the home screen already claims it does.

**One decision to make explicitly while building A:** whether the device registry records a *user*.
Today nothing does, and adding it is far cheaper now than retrofitting it later — but it is only
worth it if multi-user is actually intended. It should be a deliberate answer rather than a default.

### 5.3 Offline captions work regardless

Captions are app-specific *syncable* data. The mobile node writes to its local
`image_enriched` table, the change log picks it up, and it syncs when a session exists. Nothing
about offline authoring depends on §5.2 — only the eventual convergence does. So this can be built
and tested locally before the credential question is answered; it just cannot be *proven*
interoperable until then.

---

## 5b. What import actually costs, measured

Ten files on a real handset, instrumented per asset. The numbers were not what
reasoning predicted, and they are recorded here because the wrong conclusion was
reached twice before measuring.

| file | size | read (JSI) | hash (JS) |
|---|---|---|---|
| Screenshot .png | 0.29 MB | 19 ms | 217 ms |
| PXL .jpg | 2.95 MB | 52 ms | 2,100 ms |
| PXL .mp4 | 23.4 MB | 216 ms | 16,715 ms |
| PXL .mp4 | 47.0 MB | 506 ms | 33,793 ms |
| PXL .jpg | 4.26 MB | 104 ms | 3,100 ms |

Totals across all ten: **79.5 MB, 1.05 s reading, 57.1 s hashing.**

- **Read (`bytesSync` across JSI): ~76 MB/s.** Not a problem, and not worth a
  native module to avoid. The whole-file materialisation that §2 was uneasy
  about is cheap.
- **Hash (`js-sha256` on Hermes): ~1.39 MB/s**, with essentially no variance
  across format or size. **98% of import time.**

Two beliefs died here. That pulling whole assets across the bridge was the
expensive part — it is 2% of it. And that a portable JS digest was an acceptable
default on a phone — at 1.4 MB/s a 60k-item library would hash for days.

**The fix is `expo-crypto`**: the same digest in platform code, keeping the read
in JS because the read is fine. The custom native module (item 13b) is still
worth building, but its justification is *streaming* — removing the need to hold
anything whole, which is what {@link MAX_INLINE_READ_BYTES} exists to bound —
not speed, which expo-crypto already recovers.

## 6. What can go wrong, stated plainly

- **Asset deleted before its blob was pushed.** Unrecoverable. The record survives, demoted to
  `staged`, pointing at bytes that no longer exist anywhere. This is the one true data-loss path in
  the design and it deserves a visible state, not a silent one.
- **Hashing cost.** Content-addressed keys mean every original is read end-to-end once to SHA-256 it.
  ~3 MB × 60k items is real work — streaming, so no second copy, but it must be a per-record job
  under the few-seconds constraint, not a library-wide pass.
- **`executeSync` on the JS thread.** Import writes rows. The android plan's standing risk applies:
  this must not run during interaction.

---

## 7. Order of work

1. **Done** — `modificationTime` mapped in `device-library.ts` (§2.4).
2. **Done** — alias table (`src/media/media-alias.ts`) and the overlay adapter
   (`src/storage/device-media-storage.ts`), wired into `createMobileNode` behind a `deviceMedia`
   option so the engine and the importer cannot see different views of what the node holds.
3. **Done** — import job (`src/media/import.ts`), per-asset and resumable, two-phase so a kill
   between the alias write and the record write recovers rather than duplicating.
   `__tests__/mobile-import-sync.test.ts` runs the whole chain: a photo that exists only in the
   media store is imported, counted as resident, and pushed to a peer, with nothing written to the
   phone's object store at any point. Confirmed non-vacuous by sabotaging alias resolution.
4. **Done** — the node is live in the app. `bringUpNode` in `platform.ts` opens it on launch with a
   durable id (`node-identity.ts`), `useNode`/`useLibrary` own its lifecycle, and `LibraryGrid`
   shows the node's records with a viewer on tap.

   Two things fell out of doing it. `transport` and `remoteObjectStorage` became an optional
   `cloud` group, because requiring them said no node exists without a cloud to talk to — the
   sign-in gate this app removed twice, re-appearing as a type signature. And the app now shows
   *two* grids on purpose: the camera roll (what is on this phone) and the library (what this node
   holds). They agree today and stop agreeing the moment anything syncs or is deleted, and saying
   so beats silently picking one.
5. `photos-lib` split (§5.1) — required before either the grid or captions.
6. Captions written to the local `image_enriched` table, offline. Testable without any cloud.
7. Device registration (§5.2 option A), for both the `starkeep-drive` and `photos` channels.
8. `image-thumb` derivation (item 13b), enabled by the §3.2 session gate — i.e. after 7.

Steps 1–6 need no cloud, no account, and no native module. That is the honest boundary: everything
before device registration is buildable and testable today, and everything after it is blocked on a
decision that has not been made.
