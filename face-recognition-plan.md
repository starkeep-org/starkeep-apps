# Local, on-device face recognition for Photos — plan

**Status: implemented 2026-07-28**, on branch `faces` off `cross-app-record-labels`
in both repos. The core dependency (multi-valued labels) landed first — see
[`starkeep-core/multi-value-labels.md`](../starkeep-core/multi-value-labels.md),
now marked implemented — so §5 was not blocked.

Six things landed differently from the plan below, each noted at its section:

- The engine is **validated against real photos**, not just fixtures: same-person
  cosine 0.81 across two portraits, ≤0.29 between different people (§1).
- **Three bundling hazards, not one.** open-next's tracer was the known one;
  Turbopack's `new Worker(…)` handling and its `path.join(process.cwd(), …)`
  heuristic each independently traced the *whole project* into the route bundle
  (§2).
- The scan **worker must exit** when a pass ends, or the host reports a running
  scan forever (§2).
- The "page until a null cursor" loop needs `?? null`: a data server older than
  the current contract **omits** `nextCursor` rather than sending `null`, and the
  loop then never terminates (§8 step 4).
- The People view uses a **new transient face-crop route**, not `/api/photos/crop`
  (§4).
- Clustering runs **after** a pass, not during it (§4).

**Settled decisions (2026-07-27):**

1. **Sync — local-only, full stop.** No vision state on the sync plane (§3).
2. **Scan set — originals only.** Thumbnails *and* crops excluded (§6).
3. **Faces first.** Objects and scene are a follow-up, not this branch (§7).
4. **Publish `photos/face-count` alongside `photos/faces`** (§5).

**Depends on a core change:** multi-valued labels — see
[`starkeep-core/multi-value-labels.md`](../starkeep-core/multi-value-labels.md).
Without it, `faces` cannot be searched by other apps. It should land on
`cross-app-record-labels` before that branch merges (§5).

Scope: on-device face detection + identity vectors + person naming inside the Photos
app, with object detection and scene labelling as follow-on tasks behind the same
pipeline. No cloud inference, no biometric data leaving the device.

---

## 0. Current state (what already exists)

- Both repos sit on `cross-app-record-labels`; `starkeep-core` has uncommitted work
  in progress on that branch.
- `starkeep-apps/face-index` is a **throwaway label-mechanism fixture**, not a face
  detector — its `src/detect.ts` hashes the record id. It publishes
  `face-index/faces-detected` and `face-index/face-count`.
- Photos already has everything this feature needs plumbed:
  - `appSpecificSyncable` with the `image_enriched` table and `files: true`;
  - the mediated app-data pattern — `app/api/photos/captions/[id]/route.ts` calls
    `/app-data/db/image_enriched` via `signedFetch`, keeping the table name an app
    implementation detail;
  - label writes — `app/api/resize/route.ts:164` writes `thumbnail`;
  - `derivation` already separates original / thumbnail / crop off labels
    (`src/lib/photoRecordToAppImage.ts:17`).
- **`starkeep-core` needs no code change.** The whole feature lands in
  `starkeep-apps/photos` plus a manifest edit; the only core change proposed is one
  documentation line (§3).

---

## 1. Engine: `onnxruntime-node` + raw antelopev2 ONNX graphs

**Recommendation: no face SDK. Run the two antelopev2 ONNX graphs directly.**

| Option | Verdict |
| --- | --- |
| **onnxruntime-node + antelopev2 `.onnx`** | ✅ One new runtime dep (v1.27.0, ~270 MB unpacked, prebuilt — no compiler). `sharp` is already a dep for decode/resize. Gets exactly antelopev2. |
| InsightFace (Python) | Zero pre/post-processing to write, but a Python venv + numpy + opencv + onnxruntime-python sidecar. Largest dependency footprint by far. |
| InspireFace | No Node binding exists. Would need koffi/N-API FFI plus a per-platform prebuilt dylib — and its packs (Pikachu/Megatron) are its own models, **not** antelopev2. Worse on both stated axes. |
| face-api.js / @vladmandic/human | Weakest models, and tfjs-node is a heavier native dep than ORT. |

### Cost of this choice, stated plainly

There is no npm package that does SCRFD + ArcFace — verified by search. We write
~300–400 lines ourselves:

- SCRFD anchor decode (strides 8/16/32, 2 anchors per cell, 9 output tensors);
- NMS (IoU 0.4, score threshold 0.5);
- 5-point Umeyama similarity transform to the standard ArcFace 112×112 template.

Well-trodden and testable against fixtures, but **this is the main implementation
risk in the plan.**

> **As built.** ~470 lines across `engine/geometry.ts`, `engine/scrfd.ts`,
> `engine/align.ts`, and `engine/face-engine.ts`, and the risk did not
> materialise. Three departures from the reference worth keeping:
>
> - **Outputs are grouped by shape, not by position.** `scrfd.py` indexes the
>   nine tensors positionally (`outs[i]`, `outs[i+3]`, `outs[i+6]`). A re-exported
>   graph that reordered them would decode keypoints as boxes and produce
>   plausible boxes in the wrong places rather than an error. The last dimension
>   names the kind (1/4/10) and the row count names the stride, so both are read.
> - **The 112×112 warp is ours, not sharp's `affine()`.** 12,544 bilinear samples
>   is nothing, and the sampling convention is the part that has to be exactly
>   right for a model trained on warped crops.
> - **Umeyama is restricted to proper rotations.** The reflection its `S` matrix
>   guards against would mirror the face, and a mirrored face is a different face
>   to ArcFace.
>
> **Validated end to end on real photos**, which is what actually retired the
> risk — an alignment bug survives every unit test and shows up only as
> mediocre similarity scores. Now a committed test
> (`__tests__/vision-engine.integration.test.ts`), skipped unless the models and
> `pnpm vision:fetch-fixtures` have both been run:
>
> | check | result |
> | --- | --- |
> | two different portraits of the same person | cosine **0.81** |
> | different people | ≤ **0.29** |
> | 4-face group photo × a second 4-face group photo | a clean permutation: 0.90 / 0.82 / 0.82 / 0.70 on the diagonal |
> | same photo, EXIF orientation 6 | dimensions swap, box lands in display space, identity holds at 0.87 |
>
> The default 0.45 threshold sits in the empty band between those two clusters
> with room on both sides.
>
> Measured throughput on an M-series Mac, CPU EP: **~250 ms** for a 1-face 8 MP
> photo, **~560 ms** for a 4-face one — the plan's estimate, at the slower end.

### Models

Only 2 of antelopev2's 5 files are needed:

| File | Size | Role |
| --- | --- | --- |
| `scrfd_10g_bnkps.onnx` | 16.9 MB | detection + 5 keypoints |
| `glintr100.onnx` | 261 MB | 512-d identity embedding |

Skipped: `1k3d68.onnx` (144 MB), `2d106det.onnx`, `genderage.onnx`. Full pack is 428 MB.

**Do not commit 278 MB to git.** Add `pnpm vision:fetch-models` — pinned URL +
SHA-256 verify → `~/.starkeep/app-assets/photos/vision/models/`. The UI shows a
"models not installed" state until it has been run.

### License

InsightFace *code* is MIT, but the **training data and the pretrained weights —
including antelopev2 — are non-commercial research use only.** Fine for starkeep,
but record it in the Photos README and manifest `license` notes so it is not
rediscovered later. The fetch script should require an explicit acknowledgement.

### Performance expectation

~0.2–0.4 s/image on CPU (SCRFD @640² plus one R100 pass per detected face) →
~10k photos ≈ 45–60 min for a first pass. A later config option can swap in the
lighter `scrfd_2.5g` / `w600k_r50` pair. CoreML/DirectML acceleration is unverified
for the Node binding — assume CPU EP.

---

## 2. Where it runs

**A `worker_threads` worker inside the Photos Next server, local target only.**

- Keeps inference off the request thread; no new process, no credential handling,
  no daemon lifecycle (already a source of bugs — the pgid issue).
- **Load the worker by absolute file path.** open-next's dependency tracer must
  never see `onnxruntime-node`, or 270 MB lands in the `static` Lambda bundle. Also
  add it to `serverExternalPackages`. This is a live hazard: the `static` handler is
  traced by open-next today.
- New routes, all returning **501 when runtime-config resolves to a remote data
  server** — this feature is on-device, full stop:
  - `POST /api/vision/scan` — start/stop a pass
  - `GET /api/vision/status` — progress
  - `GET /api/vision/faces/[id]` — per-image detections for the overlay
  - `GET|PUT /api/vision/config`
  - `GET|PUT /api/vision/people`

> **As built.** All five exist, plus `GET /api/vision/face-crop/[id]?face=N` (see
> §4). The 501 guard reads two independent signals — `STARKEEP_APP_CLIENT_MODE=cloud`
> (what @starkeep/app-client itself uses to decide it is signing for a remote data
> server) and the build-time `NEXT_PUBLIC_FORCE_REMOTE` — so a cloud build refuses
> even with a misconfigured runtime env.
>
> **The worker has to exit when a pass ends.** The host equates "I hold a worker"
> with "a scan is running", so a worker that idled after finishing left
> `/api/vision/status` reporting a running scan forever and every subsequent start
> rejected as a duplicate. Found by driving the real controller; the pass itself
> had completed correctly in 3 s. There is nothing to keep alive for either — the
> engine is disposed at the end of a pass, so a persistent worker would reload its
> sessions regardless.
>
> ### The bundling hazard was three hazards
>
> "Load the worker by absolute file path" is necessary and *not sufficient*.
> open-next's tracer was the one the plan anticipated; Turbopack contributed two
> more, each of which independently traced the **entire project** — `scripts/`,
> `e2e/`, `vitest.config.ts`, and through them esbuild and vite — into the route
> bundle. Both were found by running `pnpm build`, and both failed the build
> rather than silently bloating it, which was luck.
>
> | trigger | fix |
> | --- | --- |
> | `new Worker(computedPath)` — Turbopack pattern-matches the constructor and emits a worker chunk; unable to resolve the path, it fills the chunk with everything. A `turbopackIgnore` comment does **not** suppress it. | `Reflect.construct(Worker, [path])` — no `new` expression to match |
> | `join(process.cwd(), envOverride)` — a path it cannot constant-fold reads as "this module opens arbitrary files" | dropped the env override; the path is now literal segments only |
> | a static import of the engine from any route | unchanged from the plan — and now asserted by `__tests__/vision-bundle-isolation.test.ts`, which walks the real import graph from every route and prints the offending chain |
>
> **Verified:** `pnpm bundle` produces a clean build with no warnings, and
> `.open-next` contains **no `onnxruntime*`, no `.onnx`, and no native module
> other than the `sharp` binaries that were already there.** The 28 KB
> `.vision/scan-worker.mjs` does ride along — Turbopack constant-folds the path
> and traces that one file, but stops at its externals, which is the desired
> outcome rather than a leak.

---

## 3. Storage, and the sync answer

The platform gives apps exactly two homes and **both sync unconditionally**:
`appSpecificSyncable` tables and the `apps/<appId>/syncable/` prefix. There is no
way to declare a non-syncable table. So "optional, off by default" cannot be a flag
over one store — it would mean two storage backends plus a migration on toggle.

**Recommendation: take the "much easier" option — vectors and all derived vision
state are local-only, off the sync plane entirely.** `system-design.md` explicitly
sanctions this ("Apps that need non-syncable scratch storage handle it themselves").
Cloud sync becomes a future feature rather than a dead toggle.

```
~/.starkeep/app-local/photos/vision/
  config.json                 # toggles + thresholds
  faces/<recordId>.json       # { v, model, processedAt, w, h,
                              #   faces: [{ bbox, score, kps, embedding(b64 f32), personId }] }
  people.json                 # { people: [{ id, name, createdAt }] }
  scan-state.json             # last pass: eligible total, per-type processed, timestamps

~/.starkeep/app-assets/photos/vision/
  models/                     # fetched, gitignored
  test-fixtures/              # fetched, gitignored
```

*(As built: the downloads ended up in a sibling `app-assets/` tree rather than in
`app-local/`. They are re-fetchable content, not state, and separating them is what
lets a test read them out of the operator's real `~/.starkeep` — see
`starkeepAssetsDir()` and core's `system-design.md`.)*

Three properties fall out of this and are worth preserving:

- **Processed-state is the sidecar's existence**, not a separate index. One `readdir`
  at boot → a `Set` per vision type → counts are free and cannot drift. An image with
  no faces still gets a sidecar with `faces: []`, so processed-with-zero-results is
  distinguishable from unprocessed. A `model` mismatch means "reprocess".

  > **"Cannot drift" was too strong, and the gap it hid is real** (fixed 2026-07-29).
  > Counts cannot drift from *each other*; the store can still drift from the
  > **library**, which is the only thing a user sees. A directory of files has no
  > foreign key to `shared_records` and no cascade, so a record that goes away
  > leaves its faces behind forever. Found in a dev library that had been
  > re-imported: 7 photos reported as `32 faces in 14 photos`, and — worse —
  > *every* person cluster doubled, because `assignUnclusteredFaces` folds over
  > the whole store and the dead embeddings vote in it.
  >
  > The fix is `reapOrphanSidecars(keep)`, driven from the scan worker right after
  > `listOriginals` — the only place holding a listing that is both complete and
  > authoritative. Two things it forced:
  >
  > - **An empty listing does not reap.** An empty library really does orphan
  >   every sidecar, but it is also what a scan started against a data server
  >   mid-reinstall sees, and the two are indistinguishable from the worker.
  >   Reaping then would discard the store to save a pass with no work in it.
  > - **`people.json` has to be reconciled too** (`reconcilePeopleToStore`).
  >   `faceCount` is not a display counter — it is the running-mean weight in
  >   `PersonAssigner.assign`, so a count left inflated by deleted faces makes
  >   every later face move the centroid less than it should.
  >
  > Worth noting for the platform, not just for Photos: `image_enriched` has the
  > same shape of defect — `record_id` primary key, no FK, no cascade — and there
  > is no `DELETE /data/records/:id` in the local data server at all. Record
  > deletion propagating into app-keyed state is unsolved generally; app-private
  > local state is the app's problem to reconcile, and this is what that costs.
- **Bounding boxes are the sidecar's `bbox`** — satisfying "bboxes as app-specific
  metadata" without a syncable table.
- Only the small `{recordId → [{bbox, personId}]}` projection is held in the Next
  process. Embeddings stay in the worker and are read on demand for clustering.

`~/.starkeep/app-local/` is a new convention (outside `shared/…` and
`apps/<appId>/syncable/…`, as required). Uninstall will not clean it. **Proposed core
change:** one line in `system-design.md`'s "No platform-managed scratch space" bullet
naming the convention.

### EXIF gotcha

The worker must `sharp(buf).rotate()` so boxes land in **display** orientation,
matching what `photo-viewer.tsx` renders. Photos already has orientation handling and
a test for it. A mismatch yields boxes that are correct-but-rotated on a subset of
photos — the kind of bug that survives a demo.

---

## 4. Identity: clustering and naming

- Cosine similarity on L2-normalized 512-d embeddings. Start threshold **0.45**,
  stored in `config.json`.
- **Incremental assignment**, not global O(n²) agglomerative clustering: compare each
  new face against existing cluster centroids; above threshold → join and update the
  centroid; otherwise → new unnamed cluster. O(n·k), and it matches the UX — name a
  cluster once and subsequent matching faces join it automatically.
- UI: a **People** view listing clusters by size with a representative crop (reuse
  `/api/photos/crop`), an inline name field, plus merge and split-off actions. Naming
  writes `people.json`; membership lives as `personId` on each sidecar face.

> **As built**, with two changes.
>
> **Assignment runs after a pass, not inside it.** A scan can be stopped at any
> point, and assignment interleaved with detection would leave clusters whose
> centroids reflect half a library. Detection is idempotent per record;
> assignment is a fold over all of them. The fold also runs after a *stop*, so
> the faces that were found are usable.
>
> **The People view does not reuse `/api/photos/crop`.** That route creates a
> DataRecord — reusing it would put one crop record per face per cluster into the
> user's library, visible in the grid and synced to every device, to render a
> thumbnail. `GET /api/vision/face-crop/[id]?face=N` returns transient JPEG bytes
> and writes nothing.
>
> Two smaller notes: a threshold change cannot be applied incrementally (a looser
> threshold has already destroyed the boundary it fused), so the People view
> offers an explicit, confirmed **Rebuild groups** that discards every name; and
> a merge has two halves in different files — `people.json` *and* every affected
> sidecar's `personId` — so `mergePeopleAndFaces` is the operation callers get,
> with `mergePeople` as the half it delegates to.

---

## 5. The public `faces` label — depends on multi-valued labels

`shared.record_labels` is keyed `(record, app, key)` with a **128-byte value, matched
by equality only** (`packages/protocol-primitives/src/records/labels.ts`). One row per
key per record means a name *list* in one value, which is unqueryable —
`?label=photos/faces&labelValue=Alice` matches nothing on a multi-face photo.

**This is being fixed at the platform level, not worked around here.** See
[`starkeep-core/multi-value-labels.md`](../starkeep-core/multi-value-labels.md):
widen the label PK to `(record_id, app_id, key, value)` so `faces=Alice` and
`faces=Bob` are two rows. The reverse index is already `(app_id, key, deleted_at,
value, record_id)`, so the query works the moment the PK allows the rows to exist.

**Dependency:** that change should land on `cross-app-record-labels` *before* it
merges — it is a PK change, cheap now and a migration later. This plan assumes it.
Consequences for the Photos publisher:

- Emit **one `faces` row per named person**, not a joined list. No truncation policy
  needed; the 128-byte cap now applies to a single name.
- Use the **set-valued write** (`{ recordId, key, values: [...] }`) so a rename or an
  untagging tombstones the stale row atomically.
- Chunk publisher batches on **rows, not images** — rows per image is now variable and
  the DSQL 3,000-row transaction cap is what it must respect.
- **`photos/face-count` is published too** (settled). Not because `faces` is
  unqueryable — a presence query `?label=photos/faces` works fine — but because of
  *what it means*. `faces` only exists once a human has named someone, so it really
  means "has a **named** person", which is gated on user effort and matches nothing
  on a freshly scanned library. `face-count` is written by the scan itself, so it
  covers every processed image with ≥1 face immediately. It is also the only one with
  a usable value: a small integer matched by equality actually works
  (`labelValue=1` → portraits), which is what the platform means by "an enum, a
  count, a timestamp — never a sentence". A name list sits right at that boundary —
  acceptable as a deliberate publication, wrong as the only thing published.
- **Neither key is published for a zero-face image.** A negative would make the
  presence query match everything — the same reasoning as the `face-index` fixture.
- Namespaces keep this collision-free with the fixture app
  (`face-index/face-count` ≠ `photos/face-count`). Leave `face-index` alone for now —
  it is still the only cross-app label test consumer — and retire it once this ships.

**Manifest change:** add `faces` and `face-count` to `labelKeys`. **This requires a
Photos re-install** — `packages/admin-installer/src/dsql-ddl.ts:300` reconciles the
label-key registry at install and deletes stale keys, so an un-reinstalled app has its
label writes rejected.

---

## 6. Config settings

`config.json` plus a Settings panel in the Photos UI, hidden when remote:

```jsonc
{ "faces": { "enabled": false, "threshold": 0.45, "publishLabels": false } }
```

Off by default. `objects` and `scene` are deliberately **absent** until those tasks
land — see §7.

**Scan set:** `derivation === "original"` — thumbnails and crops both excluded
(settled). A crop of a face will therefore carry no detections of its own; if that
turns out to matter, the parent original's boxes can be mapped through the crop
rectangle rather than re-running inference.

---

## 7. Objects and scene labelling — deferred

**Not on this branch** (settled). Recorded here so the model choices are not
re-litigated later. They need different models entirely — InsightFace does faces only.

- **Objects:** an ONNX detector with permissive licensing — **RT-DETR or
  DETR-ResNet50 (Apache-2.0)**. Deliberately **not** YOLOv8, which is AGPL-3.0. The
  DETR family also outputs boxes directly, so no anchor decoding — far less code than
  the SCRFD path.
- **Scene:** **CLIP ViT-B/32 (MIT)**, zero-shot against a user-editable tag
  vocabulary. Yields scene tags *and* a whole-image embedding usable later for
  semantic search.

The pipeline should be a small **task registry** — `{ id, modelFiles, run(image) →
sidecar }` — so tasks 2 and 3 are additive.

**Why deferred:** `CLAUDE.md` says implemented things must be fully hooked up and
unneeded things should not be built. Shipping two dead toggles violates that. The
`objects` and `scene` keys are therefore **absent from `config.json` and from the
Settings panel** until their tasks land — the task registry (§7 above) is what keeps
adding them cheap.

---

## 8. Steps

1. Branch `faces` off `cross-app-record-labels` in both repos (core only for the doc line).
2. `vision:fetch-models` script + license acknowledgement + the
   `~/.starkeep/app-local/photos/vision/` layout.
3. Engine module (isolated, worker-loaded by path): sharp decode → SCRFD → NMS →
   align → glintr100. Fixture tests: a known image → stable box count, and a
   cosine-similarity floor between two photos of the same person.
4. Worker + scan pass: page `/data/records` to exhaustion (null cursor, **not** a
   short page), filter to originals, skip existing sidecars, write results, update
   `scan-state.json`.

   > **As built.** "Page until the cursor is null" needs one guard the plan does
   > not mention: `body.nextCursor ?? null`.
   >
   > A **current** data server always sends `nextCursor: null` on the last page
   > (`QueryResult.nextCursor` is `string | null`, and the SQLite adapter returns
   > an explicit `null`), so against one this is unnecessary. An **older** server
   > omits the field; `JSON.stringify` drops `undefined`, and
   > `while (cursor !== null)` then never terminates. That is not hypothetical —
   > a server old enough to do it was running on the dev machine while this was
   > written, and it hung the scan. Worth normalizing because an app is deployed
   > independently of the data server it talks to and the failure mode is a
   > silent hang rather than an error.
   >
   > The same guard was added to `face-index/src/index-pass.ts`, which has the
   > same loop.
5. Routes + status/progress polling.
6. Settings panel; a Scan card showing `processed / eligible` per type.
7. Bounding-box overlay in the viewer (orientation-correct), toggleable.
8. People view: clusters, naming, merge/split.
9. Label publisher: when `publishLabels` is on, emit one `photos/faces` row per named
   person plus `photos/face-count`, via the set-valued write so renames and untaggings
   tombstone atomically. Chunk on rows, not images. Photos re-install for the new
   manifest keys. **Blocked on the core PK change (§5).**
10. Verify the cloud bundle did not grow — run `pnpm bundle`, check `.open-next` size.

Objects (RT-DETR) and scene (CLIP) are a separate follow-up branch — see §7.

---

## What is not yet verified

Everything above is implemented, typechecked, and covered by 271 vision tests
(367 in the package) — see
[`photos/vision-test-coverage.md`](photos/vision-test-coverage.md) for what the
first pass missed and why. Two things could not be exercised here:

- **Live label publishing.** The publisher is unit-tested against a fake fetcher,
  including the rename-retracts-the-old-row behaviour that motivated the
  set-valued write. It has not been run against a live data server, because the
  local one on this machine predates the branch (it has no `/data/label-keys`
  endpoint) and because the new manifest keys need a **Photos re-install** before
  writes to them are accepted at all — §5.
- **The UI in a browser.** Components are typechecked and the routes they call
  are tested; nobody has looked at them rendered.

Both are the same next step: re-install Photos against a data server built from
this branch, then open the app.

---

## 9. Extracting an npm package (later, not now)

There is no npm package that does SCRFD + ArcFace — that gap is real, and it is the
reason step 3 is the risky one. Publishing the glue would be a genuine contribution.
Two things govern how:

**License drives the API shape.** The code we write is ours and MIT-able; the
antelopev2 *weights* are not. A package that downloads them by default hands every
user a non-commercial restriction they will not read — which is exactly what dragged
InstantID into a public licensing argument for depending on InsightFace while calling
itself Apache-2.0. So: **ship a model-agnostic package, not an antelopev2 package.**
Take the ONNX session plus a config (input size, strides, anchor layout, the 5-point
template) as arguments; bundle no weights and download nothing. antelopev2 becomes one
config a *user* opts into, and `face-detect-yunet-sface` (permissive, commercially
usable) becomes another. The license question moves to where it belongs — the user's
model choice.

**Extract after it works, not before.** Designing for a hypothetical second consumer
before the first one is correct is how the abstraction ends up wrong. Build it inside
Photos, validate against real photos, then extract — by then we will know which parts
were genuinely model-specific, which is precisely what the package's API must encode.
Two things already in this plan (for unrelated reasons) keep that extraction cheap:
the engine is an isolated module loaded by absolute path (§2), and it takes decoded
pixels rather than reaching for storage itself.

---

## Sources

- [antelopev2 pack contents and sizes](https://huggingface.co/Aitrepreneur/insightface/tree/main/models/antelopev2)
- [InsightFace](https://github.com/deepinsight/insightface)
- [Pretrained-weights license clarification](https://github.com/deepinsight/insightface/issues/2022)
- [InspireFace](https://github.com/HyperInspire/InspireFace)
