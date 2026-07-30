# Expanding the object vocabulary beyond COCO-80

Analysis, 2026-07-30. Scope: what it would actually take to make object detection
recognise substantially more than 80 categories. No code changed.

---

## 1. The constraint, stated precisely

The 80 words are not a configuration value. They are a property of the checkpoint.
`src/vision/coco-classes.ts` says so in its own header: the model emits 80 logits per
query and *the index into that array is the class*. `COCO_CLASSES` is a transcription
of `rtdetr_v2_r101vd`'s `id2label`, and `vision-objects.test.ts` pins it against the
exported `config.json` precisely so nobody "improves" the list without changing the
graph.

So there is no version of this task that is "edit an array". Every route below is a
**model change**, and every model change is a full re-scan of the library — though
that part is free of effort: `OBJECT_MODEL_ID` mismatch already reads as stale and
reprocesses, per-task, with no migration step.

This is the opposite of the *tag* vocabulary, which genuinely is a config value
(`config.tags.vocabulary`, `/api/vision/vocabulary`) because scene tagging scores
stored image embeddings against text embedded at runtime. That asymmetry is the whole
story of this document: **the cheap-vocabulary property comes from storing embeddings
instead of class indices**, and objects don't have it today.

---

## 2. Three routes

### Route A — swap in a larger closed-set detector

Keep the architecture, change the training set. Candidate vocabularies, roughly in
order of size:

| Dataset | Classes | Character |
|---|---|---|
| Objects365 | 365 | Everyday objects, broader than COCO, still object-centric |
| Open Images | 600 boxable | Includes some scene-ish and part-level classes (Tree, Building, Window) |
| LVIS | 1203 | Long-tail, fine-grained, many near-synonyms and rare classes |
| V3Det | ~13k | Research-scale; hierarchical; not realistically shippable |

**Effort: genuinely small.** `OBJECT_DETECTOR_MODEL` pin, `OBJECT_MODEL_ID`,
`OBJECT_CLASS_COUNT`, the `COCO_CLASSES` array (rename it), and the test that pins the
array to `config.json`. `decodeDetections` is unchanged — the argmax loop is already
written against `OBJECT_CLASS_COUNT`, and 300 × 1203 is still a trivial inner loop.
The sidecar's `cls: number` still works. Nothing downstream changes shape.

**The gating practical question is availability**, not effort: this repo's model
contract is one file, one pinned HF revision, one sha256, plus an `id2label` in the
export to pin the array against. RT-DETR-family LVIS/O365 ONNX exports with that shape
need to be verified to exist before this is a plan rather than an intention. Ultralytics
checkpoints in particular are AGPL, which given the care already taken over the
antelopev2 non-commercial gate is a licence question, not a footnote.

**What this does *not* fix**: the overview doc's real complaint (§10.2) is that there
is "no landscape, place, activity, or material" term. Objects365 and LVIS are still
object datasets — they add *more nouns of the same kind*. Open Images adds a few
scene-ish classes. None of them give you "beach", "sunset", "hike". If the goal is
"recognises what is in my photos", a bigger closed vocabulary is a partial answer at
best.

### Route B — an open-vocabulary detector

OWLv2, Grounding DINO, YOLO-World: the class set becomes a *runtime text input*. You
supply phrases, you get boxes for those phrases.

This is architecturally a different feature, and it changes the storage contract:

- `DetectedObject.cls: number` becomes a name or a phrase id. `OBJECT_SIDECAR_VERSION`
  bumps. (Free, mechanically — the staleness check reprocesses.)
- **But naïvely this loses the property that makes the tag vocabulary cheap.** If you
  store the *matched phrase*, then changing the vocabulary means re-running the
  detector over every image — the exact cost the scene path was designed to avoid, and
  the reason `tags.ts` argues at length against caching derived tags in the sidecar.
- The fix is to store the per-box **embedding**, not the label. OWLv2 in particular is
  built for this: box embeddings and text embeddings live in one space, so a
  vocabulary edit is one text encode per new phrase and a dot product per (box,
  phrase) — structurally identical to what `tags.ts` and `/api/vision/vocabulary`
  already do for whole images.

Cost of that: a vector per detection instead of a small integer. At OWLv2-base's 512
dims, fp32, ~10 detections/photo × 10k photos ≈ 200 MB of sidecar. Storable, but it
argues for a compacted binary index like `scene-index.ts` rather than base64 in JSON,
and probably for fp16.

### Route C — class-agnostic proposals + the SigLIP tower already installed

The interesting one, because it needs **no new model download**.

RT-DETRv2 already emits 300 boxes per image; take max-over-classes as an objectness
score and throw the class away. Crop each surviving box from the original image, embed
it with the SigLIP 2 image tower that `scene` already installs, store the vector.
Object "classes" then become entries in a runtime vocabulary scored with the SigLIP
text tower that `search` already installs.

This collapses gaps §10.2 and §10.3 from the overview at once: one vocabulary, one
scoring mechanism, boxes *and* whole-image both open-vocabulary, and "dog" answered the
same way whichever surface asks.

**The cost is scan time, and it is not small.** Today a photo costs one SigLIP forward
pass (scene) plus one RT-DETR pass. This makes it 1 + N SigLIP passes, where N is the
surviving box count, on a so400m/384 tower — the heaviest graph in the app. A photo
with 12 objects is roughly an order of magnitude more scene-tower compute than today.
Mitigations: cap N, use a smaller tower for crops (but then crops and whole-images are
in different spaces and the vocabulary has to be embedded twice), or accept it as an
opt-in mode.

Second cost: SigLIP was trained on whole images with a squash-to-square preprocessor.
Small, tightly-cropped, low-resolution boxes are off its training distribution. Expect
this to work well on large salient objects and poorly on the small ones a detector is
otherwise good at. That is an empirical question worth a spike before committing.

---

## 3. What breaks regardless of route, and is not obvious

These are the parts I'd expect to bite, in rough order of nastiness.

**Argmax across near-synonyms.** `decodeDetections` takes one detection per query, its
single best class — deliberately, so a dog is never reported as both dog and cat. With
COCO's coarse, mostly-disjoint 80 that's sound. With LVIS-scale vocabularies containing
`dog` / `puppy` / `pooch`, or `cup` / `mug` / `teacup`, the probability mass splits
across siblings and the argmax flips between them on near-identical photos. Counts
("three dogs") degrade first and most visibly. Fixing it means either a synonym-merge
layer over the emitted classes, or a hierarchy-aware roll-up — new machinery with real
design content, not a tweak.

**The threshold stops being one number.** `DEFAULT_OBJECT_THRESHOLD = 0.35` is tuned
for this checkpoint's focal-loss calibration on 80 balanced-ish classes. Long-tail
vocabularies have rare classes whose calibrated scores sit far lower; a single global
cutoff either drops the tail entirely or floods the head with false positives. Per-class
or frequency-bucketed thresholds are the standard answer, and the settings UI currently
exposes exactly one slider (`vision-panel.tsx`).

**The search parse eats words the dense path needs.** `parse.ts` matches query n-grams
against the closed class list, and every word the object vocabulary claims is a word
that never reaches the SigLIP text tower as residual. At 80 disjoint nouns that's a
clear win. At 600–1200 it starts claiming words that were carrying scene meaning —
Open Images' `Tree` and `Building` would turn "a house behind trees" into two object
chips and an empty residual. The parse's people-before-objects rule protects names, but
nothing protects the residual.

**`resolveClass`'s synonym table doesn't scale, and its own comment says why.** It is a
hand-authored map justified explicitly by the vocabulary being "80 items and closed, so
an explicit table is inspectable and cannot surprise anyone by matching 'carpet' to
'carrot'". Hand-authoring synonyms for 1200 classes is not viable, and the alternatives
(stemming, fuzzy match, embedding-nearest-class) all reintroduce exactly the surprise
that comment is guarding against. Route C dissolves this — the query is embedded, not
matched — which is a real argument in its favour.

**Per-query search cost.** `matchObjects` in `search.ts` folds *every* object sidecar on
every query with an object term, counting by class name. That's linear in library size
today and stays linear, but bigger vocabularies mean more surviving detections per
photo, and Route B/C mean decoding vectors rather than reading integers. At that point
objects need the same compaction treatment `scene-index.ts` gave embeddings — which is
a well-trodden path in this codebase, just not yet trodden for objects.

**Re-scan is the user-visible cost.** Any route re-analyses the whole library. That's
correct and automatic, but on a manual, one-shot Scan (overview §10.1) it means the
feature silently reports nothing until someone presses a button.

---

## 4. What each route buys, honestly

| | A: bigger closed set | B: open-vocab detector | C: proposals + SigLIP |
|---|---|---|---|
| New download | ~300 MB–1 GB | ~600 MB–1 GB | none |
| Code effort | small | medium | medium-large |
| Vocabulary editable at runtime | no | yes, if embeddings stored | yes |
| Scene-level terms (beach, sunset) | no | yes | yes |
| Counting stays crisp | yes | threshold-sensitive | threshold-sensitive |
| Scan-time cost | ~unchanged | ~unchanged | much higher |
| Unifies objects + scene | no | partly | yes |

---

## 5. Recommendation

**Ask what the expansion is for first**, because two different goals point at
different routes:

- *"I want counts and boxes for more kinds of thing"* → Route A. Cheap, low-risk,
  mostly a pin change; the work is verifying a suitable ONNX export exists and
  redoing threshold calibration.
- *"I want it to recognise what's in my photos"* → the object path is the wrong lever.
  The scene path already does open-vocabulary whole-image scoring, and its vocabulary
  ships **empty** (overview §10.9, `DEFAULT_TAG_VOCABULARY`). Populating that list is
  near-zero cost — no re-inference at all — and answers far more of the complaint than
  going from 80 to 600 nouns would. Do that before touching the detector.

If both, Route C is the coherent end state, and its prerequisite is the same:
a good vocabulary source. `types.ts` already records what retired the last hand-authored
seed list — phrases that fired on everything, or nothing — and names the better sources
(user captions and titles, empirical pruning, a captioning model). That measurement
problem is unchanged by any of this, and it is the one that actually decides whether a
larger vocabulary is *good*, as opposed to merely *larger*.

Concretely I'd sequence it: populate the tag vocabulary and measure it → decide whether
detector counts are still the gap → then Route A as a contained follow-up, keeping
Route C as the design target only if the two-vocabulary split proves confusing in use.
