# Object vocabulary swap: COCO-80 → Objects365

Done 2026-07-30, as a test of "is a bigger vocabulary enough". Code is in;
re-scanning is the remaining step and is yours to run.

## What you asked for vs what shipped

You asked for ~1200 classes. **That does not exist in a usable form.** I checked
Hugging Face for LVIS (1203), Objects365, Detic, and YOLO-World exports: nothing
provides a closed-set detector at that size as a single pinned ONNX file with an
`id2label` to verify against, which is what this repo's model contract requires.
The 1200-class options are all *open-vocabulary* models (OWLv2, Grounding DINO)
where you supply the word list — a real integration, not a swap.

What does exist as a genuine drop-in is **Objects365: 365 classes**, via
`onnx-community/dfine_x_obj365-ONNX`. That's 4.5× the old vocabulary and it
answers the same question, so that is what went in.

It was a near-perfect fit: same DETR-family design, same 300 queries, same
`pixel_values` → `logits`/`pred_boxes` signature, identical preprocessing
(÷255 only, squash to 640×640, no padding), Apache-2.0 like the model it replaces,
and **smaller** — 252 MB against 307 MB. `detr.ts` needed one change.

## Does a bigger vocabulary help? Yes, clearly

Measured on the engine fixtures, both models at the same 0.35 threshold:

| Photo | COCO-80 | Objects365 |
|---|---|---|
| portrait-a1 | 2 boxes: person, tie | **10 boxes**: person, flag ×2, watch, tie ×2, desk ×3, pen/pencil |
| portrait-a2 | 2 boxes: person, tie | 4 boxes: person, tie, flag ×2 |
| group-4 | 7 boxes: person ×4, tie, chair ×2 | **24 boxes**: tie, person ×6, picture/frame ×3, bench ×2, lamp ×3, chair ×5, watch, ring, stool, carpet |
| group-4b | 9 boxes | 12 boxes: person ×4, pillow ×2, tie, couch, ring, clock ×2, watch |

The vocabulary is also a better *shape* for a photo library — shoes, hats,
glasses, watches, rings, pillows, picture frames, lamps, carpets — where COCO
leaned towards street scenes and sports.

**Still no landscape, weather, activity or material terms.** 365 is a bigger bag of
nouns, not a different kind of vocabulary. "beach" and "sunset" still resolve to
nothing.

## Two findings worth knowing

**1. Counting got worse, and it's pinned as a failing-loudly test.** On the
four-person group photo the old model returned exactly four `person` boxes; this one
returns six — four real ones at 0.87–0.95 plus two duplicates/partials at 0.39–0.44.
Search answers "three people" by counting those rows, so counts now over-report on
crowded photos. This is exactly the duplicate-box problem you predicted, and it's
the concrete case for your de-duplication rule (suppress an overlapping box whose
label is semantically close to a higher-scoring one). Recorded in
`vision-objects.test.ts` as an explicit ⚠ test so it can't be forgotten.

**2. A bigger vocabulary started eating search queries.** "show me photos of a dog
at the beach" began matching `photos` → `Picture/Frame` and searching for framed
pictures on walls. `parse.ts` had a stopword list containing "photos" but only
applied it to the leftover text *after* class matching had already consumed the
word — harmless with 80 COCO nouns, none of which meant "photograph". Fixed: a span
that is entirely function words can no longer match a class. This is the
residual-eating risk from `object-vocabulary-expansion.md` §3 arriving on schedule,
and it will keep arriving as the vocabulary grows.

## What changed

- `src/vision/object-classes.ts` — new, replaces `coco-classes.ts`. 366 names
  verbatim from the checkpoint (slot 0 is an unused `None` placeholder — the graph
  really emits 366, probed not assumed). Handles slashed categories (`Monitor/TV` →
  both "tv" and "monitor"), and a revised synonym table including the upstream
  misspelling `Dinning Table`.
- `src/vision/models.ts` — model pin, digest, `OBJECT_MODEL_ID`, class count 80 → 366.
- `src/vision/engine/detr.ts` — decode skips the background slot.
- `src/vision/search/parse.ts` — the function-word fix above.
- Tests updated; **693 pass, typecheck clean**.

## To run it

The model is already downloaded and verified at
`~/.starkeep/app-assets/photos/vision/models/dfine_x_obj365.onnx`. Because
`OBJECT_MODEL_ID` changed, every existing object result reads as stale
automatically — just press Scan. Faces and scene results are untouched.

Two loose ends: the old `rtdetr_v2_r101vd.onnx` (307 MB) is now unreferenced and can
be deleted whenever you like, and `vision-objects-and-scene-overview.md` §5 still
describes the 80-class vocabulary, so it's now out of date.
