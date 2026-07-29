# Face recognition — test coverage audit

**Date:** 2026-07-28. Against the implementation on branch `faces`.

Starting point: **116** vision tests over the pure algorithmic core (geometry,
SCRFD decode, alignment, the sidecar/config store, clustering, the label
publisher) plus the bundle-isolation guard. What follows is what those did
**not** reach.

**Result: 271** vision tests (367 in the package), all passing.

---

## The shape of the gap

The tested part is the part that is easy to test: pure functions over plain data.
Everything with an I/O boundary was untested, and that is where the feature's
actual decisions live.

| Area | Before | Why it matters |
| --- | --- | --- |
| Six `/api/vision/*` route handlers | none | Status codes, the 501 short-circuit, and two side effects (publish on config change, republish on people change) |
| `scan-controller` | none | Four distinct start refusals, and the boot reconciliation of a `running: true` left by a killed process |
| The scan set — "originals only" | none | Trapped inside the ORT-importing worker, so untestable where it was |
| The record paging loop | none | Short-page-is-not-the-end, and the `?? null` cursor guard |
| `FaceEngine.analyze` end to end | none | The plan asked for exactly this and it was never committed (§8 step 3) |
| `faceModelStatus` | none | Decides whether the feature is offered at all |
| Model download verification | none | A truncated download must not become an "installed" model |
| `vision-client` (browser) | none | 501-is-not-an-error is a real branch, not an edge case |
| `FaceOverlay` positioning | none | The EXIF-orientation bug the plan calls "the kind that survives a demo" |

---

## 1. The scan set was untestable by construction

`isOriginal()` and the `/data/records` paging loop lived in
`engine/scan-worker.ts`, which imports the ONNX engine. Importing that module
from a test would have loaded `onnxruntime-node`, and — worse — would have made
the bundle-isolation guard's job ambiguous.

Both are pure functions over listing rows. Moved to `src/vision/scan-set.ts`,
which the worker imports and tests can too. This is the structural fix the
coverage gap pointed at, not a workaround for it.

What is now pinned:

- an original is `parent_id === null` **and** unlabelled by `photos/thumbnail`
  or `photos/crop` — reading the typed edge, not `parent_id`, which is the same
  bug `photos-labels.test.ts` exists to prevent;
- another app's `thumbnail` key does not disqualify a record (namespaces);
- a short page is not the end — only an exhausted cursor is;
- an **absent** `nextCursor` terminates the loop. A current data server sends
  `null`; an older one omits the field, and the un-normalized loop hangs forever.

## 2. Routes

All six handlers, driven directly as functions (they are plain
`Request → Response`), with `STARKEEP_DIR` pointed at a temp root.

Notable invariants that had no test:

- **`/faces/[id]` must not return embeddings.** The overlay needs geometry and a
  name; the 512-d vectors are biometric data with no business in a browser. That
  is a privacy property, and privacy properties that live only in a comment do
  not survive a refactor.
- **The 501 guard comes first** — before reading config, before touching disk. A
  route that read state and *then* refused would still have touched an
  `app-local` directory that a cloud deployment has no business having.
- `processed: false` vs `faces: []` — "not scanned" and "scanned, nothing found"
  are different answers.
- Config `PUT` publishes when `publishLabels` goes on and **retracts** when it
  goes off, and reports a failed publish as a warning rather than failing the
  setting change.
- People `PUT` republishes after rename/merge/split, and a failed republish is a
  warning — the local edit succeeded and is what the user asked for.

## 3. `scan-controller`

The lifecycle owner, and every one of its refusals had a distinct status code
that nothing checked: face detection off → 409, models missing → 409, worker not
built → 500, already running → 409.

Also pinned: **a `running: true` left on disk by a killed process is reconciled
at boot.** Without it the Scan card reports a running scan forever and every
start is rejected as a duplicate — the same failure the worker's `retire()` fixes
from the other end.

## 4. The engine, end to end

The plan asked for "a known image → stable box count, and a cosine-similarity
floor between two photos of the same person" (§8 step 3). This existed only as a
throwaway script.

Now `__tests__/vision-engine.integration.test.ts`, which **skips unless the
models and fixtures are present** and is otherwise a real run of
`FaceEngine.analyze`. Fixtures are four public-domain US federal portraits
fetched by `pnpm vision:fetch-fixtures` — not committed, because the repo should
not carry photographs of people's faces to run its tests.

It pins the four things a unit test cannot see:

| | |
| --- | --- |
| box count | 1 on a portrait, 4 on a four-person group photo |
| identity floor | ≥ 0.6 between two different portraits of the same person |
| identity ceiling | ≤ 0.4 between different people — the 0.45 default has to sit in the gap |
| EXIF orientation | a rotated copy swaps its reported dimensions and puts the box in **display** space, and matches the unrotated original as the same person |

The orientation case is the one the plan singles out as "the kind of bug that
survives a demo", and it is unreachable without a real decode.

## 5. Model installation and integrity

- `faceModelStatus` treats absent, wrong-size, and correct files correctly. A
  wrong size means "missing", so a truncated file cannot present as installed.
- The download's **SHA-256 verification** was untestable inside a top-level-await
  script. Extracted to `scripts/lib/verified-download.ts` and tested against a
  local HTTP server: a good digest lands the file, a bad one throws **and leaves
  nothing behind** — a partial file that survived would be picked up as installed
  by a later size check.

## 6. The browser client and the overlay

- `vision-client`: 501 returns the `VISION_UNAVAILABLE` sentinel rather than
  throwing, error bodies are unwrapped for their `error` field, and every path
  goes through `withBasePath` — the cloud mount is `/apps/photos`, and a
  root-absolute request that skips it leaves the app.
- `FaceOverlay`: boxes are positioned as percentages of the **sidecar's**
  dimensions, not the record's. On an EXIF-rotated photo those differ by a
  transpose, and scaling by the record's numbers looks right on every photo that
  has no orientation tag — which is most of them.

## 7. Manifest coupling

`photos/faces` and `photos/face-count` have to exist in `starkeep.manifest.json`
or the data server rejects every write to them, and the failure appears only
after a re-install. `PHOTOS_LABEL_KEYS` and the manifest are now asserted to
agree in both directions.

---

## Where the tests ended up

| file | tests | |
| --- | ---: | --- |
| `vision-routes` | 46 | the six handlers |
| `vision-clustering` | 27 | assignment, merge, split, rebuild, the embedding codec |
| `vision-client` | 26 | the browser client, including the basePath case |
| `vision-bundle-isolation` | 22 | the import-graph guard |
| `vision-label-publish` | 19 | the publisher and its row chunking |
| `vision-engine.integration` | 17 | the real engine — skipped without models + fixtures |
| `vision-store` | 15 | sidecars, config, scan state |
| `vision-face-overlay` | 14 | box positioning |
| `vision-models` | 14 | install status and download verification |
| `vision-scrfd` | 14 | anchor decode, NMS, output grouping |
| `vision-geometry` | 13 | IoU, NMS, Umeyama |
| `vision-scan-set` | 13 | originals-only, and the paging walk |
| `vision-scan-controller` | 10 | refusals and liveness reconciliation |
| `vision-align` | 9 | the warp and tensor packing |
| `vision-manifest` | 7 | the label-key contract |
| `vision-remote-guard` | 5 | the 501 signals |

Four of the new assertions were **mutation-checked** — the behaviour was broken
on purpose to confirm the test fails: the embedding-leak guard, both overlay
positioning tests, and the bundle-isolation guard (which reports the offending
import chain).

## Deliberately not covered

- **The People view and settings panel as rendered UI.** Their logic is
  interaction, not computation; the routes they drive are tested, and the parts
  worth pinning (`FaceOverlay`'s positioning) are tested directly.
- **The scan worker as a thread.** Its message protocol and exit paths were
  verified by running it, but a test that spawns a worker, loads 261 MB of
  weights, and waits is not one anybody will keep running.
- **`onnxruntime-node` itself.**
