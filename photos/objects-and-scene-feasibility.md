# Objects, scene, and semantic search — plan

The working plan file for the next vision phase. Follows on from
[`../face-recognition-plan.md`](../face-recognition-plan.md) §7, which deferred
objects and scene and pre-settled the model choices — some of which this plan
re-opens, because §7 chose for *tagging* and the priority is now *search*.

## Goals

1. **General whole-image tags**, driving filtering and per-image display, and
   editable — per-photo edits far more often than vocabulary edits.
2. **General semantic search**, spanning faces, objects, and scenes.
   `"Alice at the beach"` is the benchmark query: it is the shape we want to
   handle really well, and it is the one that forces every interesting decision.

Goal 2 is the priority, and it reorders everything — see §10.

**Verdict:** the §7 deferral paid off. The scan loop, progress counters, and
processed-marker discipline are already task-generic. But "additive" is not quite
true today: three seams the plan expected to be per-task are still written in
terms of faces specifically (§3). That refactor is the bulk of the risk. The
tasks themselves are smaller than faces was — neither needs alignment,
embeddings-as-identity, clustering, naming, or a People view. The genuinely new
infrastructure is not a model at all; it is the **persistent query worker** (§9).

---

## 1. What is genuinely additive already

| Seam | Where | Why it holds |
| --- | --- | --- |
| Task registry | `engine/tasks.ts` | `VisionTask = { id, enabled, isProcessed, run }` is exactly the shape §7 asked for. |
| Scan loop | `engine/scan-worker.ts:106–133` | Already `tasks.filter(enabled)` → per-record `pending` → per-task `state.processed[task.id]++`. No second pass needed. |
| Progress state | `types.ts` `ScanState.processed` | Already `Partial<Record<VisionTaskId, number>>`. |
| Scan set | `scan-set.ts` `listOriginals` | Task-independent — originals-only is right for objects and scene too. |
| Model fetch | `models.ts` `VisionModel` + `scripts/lib/verified-download.ts` | URL + sha256 + size + role generalizes to any pinned ONNX graph. |
| Bundle isolation | `__tests__/vision-bundle-isolation.test.ts` | Guards the **directory** `src/vision/engine/`, so new engine modules are covered automatically with no test change. |
| Worker build | `scripts/build-vision-worker.ts` | Single esbuild entry point — new engines picked up with no script change. |
| Label publish | `label-publish.ts` `chunkByRows` + set-valued `POST /data/labels/values` | Row-chunking and tombstone-on-empty are key-agnostic. |
| Local-only guard | `remote.ts` `remoteNotImplemented()` | New routes inherit it. |

## 2. Scope note: local-only

Vision state never leaves the device (face plan §3), and every vision route is
gated by `remoteNotImplemented()`. Search inherits that: it is a **local-target
feature**, unavailable on the cloud deployment, at least initially. Worth stating
because search feels like a thing that should work everywhere, and it will not.

## 3. What must be generalized first

The real prerequisite work. All mechanical, but they touch each other.

### 3.1 The sidecar store is face-shaped — biggest item

`sidecars.ts` (129 lines) and `paths.ts` hardcode faces at every level:
`facesDir()`, `faceSidecarPath()`, `FACE_SIDECAR_VERSION`, `FACE_MODEL_ID`,
`readFaceSidecar`, `processedRecordIds`, `readAllFaceSidecars`.

Needs to become a store parameterized by task: `taskDir(taskId)`,
`sidecarPath(taskId, recordId)`, and per-task `(version, modelId)` for the
`isCurrent` staleness check that drives reprocessing.

Two functions need care rather than a rename:

- **`reapOrphanSidecars`** is called once, unconditionally, in the worker
  (`scan-worker.ts:93`) and reaps only the faces directory. Per-task it must reap
  every task's directory — **including currently disabled tasks**, or turning
  objects off and deleting photos leaves orphans that come back to vote when it
  is turned on again. The empty-library guard (`recordIds.length > 0`) still
  applies and must not be duplicated per task.
- **`processedRecordIds` / `isProcessed`** must be per-task, or enabling a second
  task on an already-scanned library looks fully processed and skips everything.

The atomic temp-file-plus-`rename` write and the sidecar-exists-means-processed
invariant carry over unchanged — that is the part worth preserving exactly.

### 3.2 The scan command names face models literally

`worker-protocol.ts` / `scan-controller.ts:152–157` put `detectorPath` and
`embedderPath` directly on the start command. That becomes a per-task map of
model paths, and `faceModelStatus()` becomes `modelStatus(taskId)` folded over
the enabled tasks.

### 3.3 The worker builds the face engine before checking what is enabled

`scan-worker.ts:59–71` constructs `FaceEngine` — loading 278 MB of ONNX — and
only then filters tasks by `enabled`, disposing if the list is empty. With faces
off and scene on, that loads and discards a quarter-gigabyte per pass. Engine
construction must move behind the enabled filter and become per-task, lazily, so
a multi-task scan does not hold every session resident unless it needs to.

### 3.4 Config gating assumes one task

`scan-controller.ts:92` refuses to start with
`"face detection is off — enable it in Settings first"` → becomes "no vision task
is enabled". `mergeVisionConfig` (`config.ts:33`) is hand-written per field and
returns `base` wholesale when `patch.faces` is missing — adding sections is
mechanical, but that early return must go or a PUT touching only `scene` silently
discards itself.

`defaultVisionConfig()`'s comment explicitly says `objects` and `scene` are absent
because dead toggles violate `CLAUDE.md` — so toggles land **with** their tasks.

### 3.5 Status route and Settings panel report faces at top level

`app/api/vision/status/route.ts` returns one `store` block with
`imagesWithFaces` / `facesFound` / `people`; that becomes per-task blocks, and
`vision-panel.tsx` (333 lines) grows a card per task.

### 3.6 Manifest label keys require a Photos re-install

New keys need declaring in `starkeep.manifest.json` `labelKeys`. Access is
granted at install time from the manifest, so keys do not exist until Photos is
re-installed — the step that gated the faces publisher (face plan §8 step 9).
Easy to forget; the symptom is a rejected write, not a missing key.

---

## 4. The signals, and why they are not one vector space

After scene and objects land, each photo carries:

| Signal | Shape | Comparable to a CLIP text query? |
| --- | --- | --- |
| CLIP image embedding | 512-d dense | **Yes** — this is the whole point |
| Scene tags | strings from the vocabulary | Indirectly (lossy quantization of the above) |
| Object classes | strings from a closed COCO-80 list + boxes + counts | No — structured |
| Person names | strings from `people.json`, user-authored | No — structured, exact |
| ArcFace identity embedding | 512-d dense | **No — different space entirely** |
| Caption / title / EXIF date | text, timestamps | No — structured / lexical |

The trap worth naming: the face embedding is **also 512-d**, and sidecars store
both as base64 float32. They are not comparable — ArcFace encodes "who this is"
in a space trained on identity; CLIP encodes "what this looks like" in a space
aligned to language. Cosine between them is noise, and because the shapes match
it fails **silently**. They must be distinguishable by type, not by dimension.

**Consequence:** "photos of Alice" is not a vector search. Alice's *name* is a
string a human typed on a cluster; matching it is an exact lookup. Forcing
identity into the dense path makes an exact signal fuzzy, which is strictly
worse. Search is therefore **hybrid** — structured filtering plus dense ranking —
not one unified embedding.

### 4.1 The text encoder is required, so the vocabulary question dissolves

A free-form query is unbounded, so its embedding cannot be precomputed. Search
needs CLIP's **text encoder plus tokenizer resident at query time**. Once it is
present, a runtime-editable tag vocabulary is the same call on different input
and costs nothing extra — both goals want the same machinery.

The cost lands in the right place: one text encode **per query**, not per photo.
The text tower is also the small half of CLIP (~63 M params, ~250 MB fp32 /
~65 MB int8) and is never touched in the scan loop.

"User-editable tag vocabulary" means the **candidate list** for zero-shot
tagging. CLIP cannot emit tags on its own; it only scores an image against
candidate strings supplied to it. Editing the vocabulary means adding "birthday
party" or "my dog" and re-scoring the library — a different operation from
editing the tags on one photo. §7 keeps them separate.

---

## 5. Search: query pipeline

Design pass, deliberately stopping short of what only trying it will settle (§11).

    "Alice at the beach"
            │
            ▼
    ┌───────────────────────────────────────┐
    │ parse: longest-match n-grams against  │
    │ known closed vocabularies             │
    └───────────────────────────────────────┘
            │
            ├─► structured: person:alice-id
            └─► residual:   "at the beach"
                    │               │
                    ▼               ▼
            match per photo   CLIP text embed
            (face → Alice?)         │
                    │               ▼
                    │        cosine vs every
                    │        image embedding
                    │               │
                    └───────┬───────┘
                            ▼
                  weighted sum (§5.1)
                            │
                            ▼
                    score-ordered results

**Parse.** The structured vocabularies are small and fully known — person names
from `people.json`, 80 COCO classes, the scene vocabulary. Matching query n-grams
against them lexically (longest match first, so "hot dog" beats "dog") is
tractable, deterministic, local, and needs no model. Start there.

An LLM via the capability broker would parse intent better, but note what a query
contains: **the names of people in the user's library.** Vision state is
local-only by explicit design, so routing queries off-device is a real disclosure
needing its own opt-in on the `publishLabels` model. Not a default, and not in
this phase.

### 5.1 Score and order — every signal adds, nothing is excluded

**The invariant that matters:** a photo with Alice face-tagged *and* beach-y
content must score above either signal alone.

    score(Alice ∧ beach) > score(Alice) , score(beach)

That is an additive fusion, and it makes "hard filter vs soft boost" a false
choice — the hard filter is just the limiting case of a large structured weight.

    score = Σ  w_t · match_t   +   w_dense · normalized_dense
          structured terms

- `match_t ∈ {0, 1}` — does the photo carry a face assigned to Alice, an object
  of that class, a date in range.
- `normalized_dense ∈ [0, 1]` — cosine against the CLIP image embedding.

**Normalization is the one part that must not be skipped.** Raw cosine sits in a
narrow, uncalibrated, query-dependent band (~0.15–0.35), while `match_t` is 0 or
1. Summing them directly makes the weight do all the work and impossible to tune.
Min-max normalize the dense score *across the result pool for this query*, which
is query-relative and so adapts to wherever the band happens to sit.

**Bands fall out of the weights, and that is the grouping.** With
`w_person = 2, w_dense = 1`:

| Photo | structured | dense | total |
| --- | --- | --- | --- |
| Alice, at the beach | 2.0 | ~1.0 | **~3.0** |
| Alice, indoors | 2.0 | ~0.1 | **~2.1** |
| Best beach shot, no Alice | 0.0 | 1.0 | **1.0** |
| Neither | 0.0 | ~0.0 | ~0.0 |

Everything with Alice sits above everything without, ordered within each band by
beach-ness. No special-casing produces that; it is just the weight ratio. Raising
`w_person` sharpens the separation toward a hard filter, lowering it blends the
bands — one tunable knob spanning the whole spectrum.

Making those bands **explicit sections in the UI** ("Alice at the beach" /
"Alice" / "at the beach") is a natural refinement, but a refinement — plain score
ordering is the thing to build and try first.

**This subsumes the backfill hack** an earlier draft proposed. A photo where
Alice is present but undetected still carries the dense signal, so it lands in
the beach band on its own — graceful degradation through the same mechanism,
rather than a separate append step with its own sparseness threshold.

**Exactness for pure-structured queries is preserved.** `"photos of Alice"` has
no residual, so there is no dense term and everything scoring 0 is excluded —
which is exactly a filter. Require at least one signal to fire and the
"only Alice" expectation holds without a special case.

**Later refinement:** `match_t` need not stay binary. Cluster assignment already
carries a cosine similarity to the centroid, so a face just over the 0.45
threshold is a weaker Alice signal than one at 0.9 — grading `match_t` by
assignment confidence softens the band boundary using information already stored.
Binary first.

### 5.2 Chips: for parse ambiguity, not for filter strength

A separate problem from §5.1, and worth not conflating: the parse itself can be
wrong. Person names collide with common nouns far more than they first appear —
**Rose, Daisy, Iris, Summer, Mark, Sunny, Robin, Jasmine.** `"rose at the beach"`
is genuinely ambiguous, and no scoring resolves it, because the information is
not in the query.

Rendering the parse as removable chips fixes *that*:

    ┌──────────────────────────────────────────────┐
    │ [👤 Alice ✕] at the beach                    │
    └──────────────────────────────────────────────┘

✕ drops the person interpretation entirely — the right action when the
interpretation is simply wrong, and the wrong tool for tuning how strongly a
*correct* interpretation weighs, which is what §5.1's weights are for.

It is also a measurement instrument: **which chips get removed is the iteration
signal** for parse quality, available immediately without an eval set.

### 5.3 Ranking details

- **No absolute threshold.** CLIP cosine is uncalibrated and its useful range
  shifts per query, so a fixed cutoff either returns the library or returns
  nothing depending on phrasing. Use top-k with "show more" and let rank order
  carry the meaning. (This is also why §5.1 normalizes per query rather than
  globally.)
- **Prompt handling.** CLIP retrieval is sensitive to phrasing and does better
  with a template than a bare fragment. `"a photo of at the beach"` is
  ungrammatical, though, so a blind template hurts. Start by averaging the
  embedding of the raw residual with `"a photo of {residual}"` — standard prompt
  ensembling, one extra text encode. A prime candidate for iteration, not
  something to get right on paper.

### 5.4 Deliberately deferred

- **Tag/object phrase fusion.** Scoring the query against tag phrases is mostly
  redundant — tags are a lossy quantization of the same image embedding, so
  ranking against them is strictly weaker than ranking against the image. The
  real exception is small objects in large scenes, which a global embedding
  underweights and the detector catches. It slots into §5.1 as one more weighted
  term whenever measurement shows object-heavy queries underperforming, which is
  the point of that shape. Adding it up front is untestable complexity.
- **Counting and negation.** CLIP is weak at counting, spatial relations,
  negation, and text in images. Counting is covered structurally —
  `"photos with three dogs"` should route to detector counts, never to CLIP —
  which is a good complementarity argument for objects, but a later phase.
  `"beach without Alice"` is out of scope for now.

### 5.5 Scale: no vector database

10k photos × 512 dims × 4 bytes = **20 MB**. A linear cosine scan over that is
milliseconds. No ANN index, no HNSW, no vector store — the same conclusion the
codebase already reached for clustering (`assignUnclusteredFaces` is an O(n·k)
fold over the whole store).

One caveat: **do not read 10k sidecar JSONs per query.** `readAllFaceSidecars`
is fine for an end-of-scan fold and far too slow interactively. Search needs a
compacted index — one binary file of embeddings plus a record-id table, rebuilt
at the end of a scan. Sidecars stay authoritative; the index is derived and
disposable, so a missing or corrupt one rebuilds rather than breaking.

---

## 6. Runtime architecture: the persistent query worker

**The main new infrastructure, and it follows from a constraint already in the
codebase rather than from anything about search.**

`onnxruntime-node` must never be reachable from `app/` — that is what
`vision-bundle-isolation.test.ts` enforces, and why the engine is reached only
from a worker started by absolute path. But search needs text encoding **per
request, interactively**, and the scan worker's lifecycle is wrong for it: it is
started per pass and `retire()`s itself on completion, deliberately, because the
controller equates "holds a worker" with "a scan is running".

So search needs a **second, persistent worker** holding the CLIP text session and
the embedding index in memory, started lazily on first search and messaged by the
search route.

- Reuse the `Symbol.for` global-singleton pattern from `scan-controller.ts` so it
  survives dev hot reload — the same reasoning applies.
- Reuse `Reflect.construct(WorkerCtor, [path])` for the Turbopack workaround
  documented at `scan-controller.ts:118`, which is load-bearing.
- Lifecycle is the *opposite* of the scan worker's: stays alive, must not be
  confused with scan liveness, and needs an idle-eviction policy so a background
  tab does not hold ~65 MB of session forever.
- Index invalidation: a completed scan changes the embeddings, so the query
  worker has to reload or be recycled at end of pass.

**Alternative considered:** run the text tower in the browser via
`onnxruntime-web` / transformers.js, POST the 512-d query vector to the route,
and keep the server side to a cosine scan. This sidesteps the worker entirely and
is genuinely tempting for a local-only app where the model caches after first
load. Against it: ~65 MB of browser download, WASM inference latency on every
keystroke-debounced query, and a second inference stack to maintain. Recommend
the worker; revisit if the worker lifecycle turns out to be painful.

---

## 7. Tags: derived versus user-authored

Two kinds, and conflating them loses user data.

**Derived tags** — vocabulary scored against the image. Recomputable, so they
belong in the sidecar, versioned by model id and invalidated by the existing
`isCurrent` staleness check.

**User tags** — typed or corrected per photo. Authoritative, and must survive
re-scan, model swap, vocabulary change, and `reapOrphanSidecars`. They therefore
**cannot live in the sidecar**, whose entire contract is that it is disposable.

User tags are user content, exactly like captions, so they belong in
`image_enriched` — the syncable app table already holding `caption`, `title`,
`date_taken_override`, reached via `/app-data/db/image_enriched`. That is a
manifest column addition plus a Photos re-install (§3.6).

This is the same custody split the codebase already draws: derived bytes are
app-owned and reproducible; what a human authored is not.

**Edits are a diff, not a list.** Removing a suggested tag must persist as a
*negative*, or the next scan re-derives it and it returns. Store
`{ added: [...], removed: [...] }` per photo, display
`(derived − removed) ∪ added`, and keep provenance so the UI can distinguish a
confirmed tag from a suggestion.

**Vocabulary edits need no re-inference.** With the image embedding in the
sidecar, re-scoring is one dot product per (image, tag): 10k photos × 200 tags ×
512 dims ≈ 1 B multiply-adds — a second or two, no model load, no image decode.
This is what makes an editable vocabulary genuinely cheap, and it is the same
structural property that makes face re-clustering cheap.

**Calibration, and why derived tags stay suggestions.** Raw CLIP cosine is
uncalibrated and vocabulary-dependent: values cluster in a narrow band and shift
as candidates are added, so a threshold tuned for one vocabulary mis-fires on the
next. Softmax with CLIP's `logit_scale` forces a distribution over candidates,
which is wrong for multi-label tagging. So treat derived tags as **suggestions
surfaced in the UI**, and publish only user-confirmed tags to the sync plane.
That matches the faces precedent exactly — only *named* clusters are published,
never raw detections — and keeps an uncalibrated number from becoming another
app's ground truth.

---

## 8. Scene (CLIP)

No bounding boxes, so no overlay work — output is a tag list plus the whole-image
embedding. **Store the image embedding in the sidecar from day one**: it makes
vocabulary changes a fold over stored vectors rather than a re-scan, and it is
the thing search is built on.

### 8.1 Model choice is re-opened

Face plan §7 chose **ViT-B/32** when zero-shot tagging was the goal. For
*retrieval* it is the weakest of the usual options — B/32's coarse patches cost
real recall on fine-grained queries — and retrieval is now the priority.
**SigLIP (Apache-2.0)** or ViT-L/14 are materially better at search.

Not a one-way door: the `FACE_MODEL_ID` staleness mechanism means swapping models
invalidates sidecars and reprocesses with no migration. But re-embedding a large
library is roughly an hour of CPU, so choose deliberately rather than discovering
it after users have scanned.

Weigh retrieval quality against download size (B/32 ~350 MB fp32, L/14 ~1.7 GB)
and scan throughput, on top of the 278 MB faces already asks for. Quantized int8
is worth evaluating for the image tower given it runs over every photo. All of it
lands under `app-assets/photos/vision/models/`, which is re-fetchable and
gitignored — a download-size question, not a state question.

## 9. Objects (RT-DETR / DETR-ResNet50, Apache-2.0)

**Smaller than the face path, not larger.** The DETR family emits set predictions
directly: logits over classes plus boxes as normalized `cxcywh`. No anchor grids,
no stride decoding, **no NMS** — which is most of what `scrfd.ts` (226 lines) is.
And nothing downstream: no alignment (`align.ts`), no `geometry.ts` similarity
fit, no embedding, no clustering, no naming UI.

- `engine/detr.ts` — preprocess (resize + ImageNet normalization), softmax over
  logits, drop the no-object class, threshold, scale boxes to display pixels.
  ~100 lines, simpler than the SCRFD decode it parallels.
- A COCO-80 class-name table.
- `ObjectSidecar` type + `objectTask()` in the registry.
- A model entry in `models.ts` (RT-DETR-r18 is ~80 MB).
- Overlay: `face-overlay.tsx` (127 lines) generalizes to a labeled-box overlay.
  The orientation-correctness work — analyze after EXIF `.rotate()`, store
  display-space coordinates — is already solved and inherited for free.

For search, objects contribute **exact class filters and counts** to the
structured stage, which is the slice CLIP is worst at.

---

## 10. Sequencing

Reordered from an earlier draft, which put objects before scene. Against these
goals that is backwards: **CLIP image embeddings plus the person names we already
have deliver most of the search value on their own.**

1. **Generalize the sidecar store and scan command** (§3.1–3.4), with faces as
   the only task and no behaviour change. The existing vision tests passing
   untouched is the check that the refactor is honest.
2. **CLIP image tower + scene task** — embedding into the sidecar from day one
   (§8), plus the compacted index built at end of scan (§5.5).
3. **Search**: query worker (§6), lexical parse, chips UI, dense ranking (§5).
   Ships against faces + scene, before objects exist.
4. **Tags UI**: vocabulary in vision config, per-photo edits as a diff in
   `image_enriched` (§7).
5. **Objects** (§9): adds count and class filters to the structured stage.
6. **Status/panel per-task** (§3.5) — could fold into step 2, but is easier to
   review separately as the only user-visible surface change.
7. **Publishing + manifest keys** (§3.6), once tags are user-confirmed.

Re-run `pnpm bundle` and check `.open-next` size at the end, as face plan §8
step 10 did — new engine modules are directory-guarded, but the check is cheap.

## 11. Open questions — settle by trying, not by planning

Listed so they are not mistaken for oversights. Each needs a real library and a
few dozen real queries.

- **The weights themselves** (§5.1). `w_person` vs `w_dense` sets how sharply
  structured matches separate into bands, and only real queries settle it. Keep
  them in one place so they are tunable without touching the retrieval code.
- **Whether score bands become explicit UI sections** (§5.1), or plain ordering
  is enough.
- **Prompt template.** Raw residual vs `"a photo of {x}"` vs ensembling (§5.3).
- **Top-k cutoff** — where "show more" falls (§5.3).
- **Whether tag/object fusion earns its complexity** (§5.4) — measure on
  object-heavy queries before building.
- **Graded vs binary `match_t`** (§5.1), using cluster-assignment confidence.
- **Scene vocabulary seed list**: size and content. Too small misses; too large
  makes every photo score something.
- **Model and quantization** (§8.1) — needs a retrieval spot-check on real
  photos, not a benchmark number.
- **Query-worker idle eviction** — what timeout, and whether index reload at
  end-of-scan is worth incremental updating.
