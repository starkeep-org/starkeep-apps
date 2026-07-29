# Scene/search model choice — functional tradeoffs

Resolves the open question in [`objects-and-scene-feasibility.md`](objects-and-scene-feasibility.md)
§8.1, which re-opened the face plan's ViT-B/32 pick because §7 chose for *tagging*
and the priority is now *search*. Fold this back into §8.1 once decided.

**Constraints given:** best achievable quality on **personal photos**; MIT
licence preferred but not required; download size and scan compute are not
concerns at this library's scale.

That rules out the mid-range entirely — B/32 and the base-sized SigLIPs are only
interesting when compute matters. What follows is the top end.

---

## Verdict up front

**SigLIP 2 so400m/16-384**, from
[`onnx-community/siglip2-so400m-patch16-384-ONNX`](https://huggingface.co/onnx-community/siglip2-so400m-patch16-384-ONNX)
— Apache-2.0, fp32 image tower.

The MIT preference is the one thing that has to give, and §"Licence" below argues
it costs nothing real while the quality gap it would buy back is large.

---

## What "best for personal photos" actually resolves to

Two independent signals point the same way, which is more than benchmarks alone
would give:

**1. Published retrieval quality.** SigLIP 2 so400m is at or near the top of open
text→image retrieval. It beats SigLIP 1 so400m (better recipe: caption-based
pretraining plus self-distillation), which in turn beat OpenCLIP ViT-H/14 and
CLIP L/14 by clear margins. *These are recalled published results, not measured
here* — the ordering is well replicated, the exact margins are not something I
verified.

**2. A photo app already shipped it.** [Immich](https://immich.app) — self-hosted
personal photo management, i.e. this exact problem — publishes ONNX exports of a
curated model set and `ViT-SO400M-16-SigLIP2-384__webli` is their high-end
option, with visibly more downloads (~4.2 k) than the alternatives. Independent
evidence that this family holds up on *personal* photo distributions, which is
precisely what benchmarks on web/COCO data cannot tell us.

### Why not the neighbours

| Rejected | Why |
| --- | --- |
| SigLIP 2 **gopt**/16-384 | Larger still, marginal retrieval gain over so400m, far less validated in practice. Not worth being the first to find out. |
| SigLIP **1** so400m/14-384 | Genuinely close, and its text tower is far saner (32 k sentencepiece vocab vs SigLIP 2's 256 k Gemma). Superseded on quality, and quality is the stated goal. The best fallback if SigLIP 2 disappoints. |
| **DFN5B** CLIP ViT-H/14-378 | Retrieval-competitive, but `apple-amlr` — materially more restrictive than either MIT or Apache-2.0, and the opposite direction from the stated preference. |
| OpenCLIP ViT-H/14, bigG/14 | **The best MIT options**, and a real step down from SigLIP 2 so400m. See below. |
| CLIP L/14-336 | Well behind, and `onnx-community`'s export has no split vision/text graphs — only a combined `model.onnx`, which §6's architecture cannot use. |

---

## Licence: why Apache-2.0 over the MIT alternative

The best MIT-licensed options are LAION's OpenCLIP ViT-H/14 and bigG/14. Choosing
one costs twice over:

- **Quality.** Both sit clearly below SigLIP 2 so400m on text→image retrieval.
  This is the whole reason to be at the top end.
- **Integration risk.** The available ONNX exports are poorly maintained. The one
  I checked, `Marqo/onnx-open_clip-ViT-H-14`, is **missing its fp32 visual graph
  entirely** (fp16 visual and fp32 textual only) and has zero downloads. That
  means either accepting an unvalidated export or exporting the towers myself —
  real work, and a new way to be subtly wrong.

And what MIT buys over Apache-2.0 here is, functionally, nothing:

- Both are permissive; both allow commercial use; both require only attribution.
- Apache-2.0 adds an **express patent grant**, which is arguably *better* for a
  distributed application.
- Neither is copyleft. There is no viral obligation on Starkeep either way.
- The only extra Apache-2.0 obligation is retaining a NOTICE — the licence file
  already handled for antelopev2.

The decisive point: **Photos already ships genuinely restrictive weights.**
antelopev2 is *non-commercial research use only* (`models.ts` documents this at
length, and it is why `vision:fetch-models` demands an explicit
acknowledgement). Against that, Apache-2.0 is a strict *loosening* of the licence
posture — and unlike faces, the scene models need no acknowledgement gate at all.

---

## Pinning: why the transformers.js export, not Immich's

This decided the *repo*, not the model, and it is worth recording because the
obvious choice is wrong.

`models.ts`'s `VisionModel` is one URL, one sha256, one size, verified once at
fetch time. Immich's OpenCLIP-format exports break that:

- `ViT-SO400M-16-SigLIP2-384__webli` scatters its **text** tower across
  *hundreds* of separate external-data blobs (`textual/onnx__MatMul_5088`,
  `…_5127`, one per weight tensor). Pinning that needs a manifest format the
  repo does not have.
- Its **image** tower is fine — a single 1713 MB `visual/model.onnx`.

The `onnx-community` export is one or two files per tower:

| file | size | notes |
| --- | --- | --- |
| `onnx/vision_model.onnx` | 1714 MB | fp32, **single self-contained file** |
| `onnx/vision_model_int8.onnx` | 434 MB | single file |
| `onnx/text_model.onnx` + `.onnx_data` | 1 MB + 2831 MB | fp32 needs external data (>2 GB protobuf limit) |
| `onnx/text_model_int8.onnx` | 711 MB | **single file** |
| `tokenizer.json`, `tokenizer.model` | small | sentencepiece, for §4.1's resident tokenizer |
| `preprocessor_config.json` | small | the exact resize/normalize params |

Worth noting: `immich-app/ViT-SO400M-14-SigLIP-384__webli` (SigLIP **1**) *does*
have clean single-file towers — 1713 MB visual, 1799 MB textual, plus a 2.4 MB
`tokenizer.json`. If SigLIP 2 has to be abandoned, that is the tidiest fallback.

---

## Precision, and a property worth exploiting

**Image tower: fp32** (`vision_model.onnx`). Compute is not a constraint, so
there is no reason to trade any quality away on the one thing whose output gets
persisted.

**Text tower: fp32 to start, and this is freely revisable.** The asymmetry is
useful and not obvious:

> The image tower's identity is pinned into every sidecar's `model` field, so
> changing it invalidates the store and forces a reprocess. **The text tower is
> never persisted** — it only turns a live query into a vector. Its precision can
> change at any time, with no reprocess, no migration, and no effect on the index.

So text-tower precision is not a decision that needs making now. Start fp32; if
the 2.8 GB resident footprint turns out to bite in §6's persistent query worker —
which is exactly what that section's open worry about idle eviction is about —
dropping to the single-file 711 MB int8 graph is a free swap.

(I earlier warned about "mismatched calibration" between towers at different
precisions. That was overstated: the towers share a learned space, and a slightly
noisy *query* vector shifts all cosines coherently, which §5.1's per-query min-max
normalization and §5.3's rank-order-only stance already absorb. The genuine
consistency requirement is *within* the stored index — every image embedding must
come from the same tower at the same precision — and that is enforced by the
sidecar `model` field.)

---

## Throughput — measured, not estimated

`pnpm vision:bench-scene` exists for this, and the answer on this machine
(Apple Silicon, CPU execution provider, fp32) is:

| | |
| --- | --- |
| Session load | 2.3 s, once per pass |
| **Per image** | **1.63 s** (mean, warm-up excluded; median 1.63 s) |
| Throughput | ~37 images/min |

Extrapolated first pass:

| photos | first pass |
| --- | --- |
| 1 000 | 27 min |
| 5 000 | 2.3 h |
| 10 000 | 4.6 h |
| 50 000 | 22.8 h |

**This corrects an earlier estimate of mine.** I guessed a 10 k library would run
"overnight"; it is ~4.6 hours. Paid once, in a background worker, resumable, and
skipped forever after via the sidecar-as-processed-marker.

The fixtures are 2–4 MP, so decode cost on 48 MP phone photos will push this up
somewhat — inference is flat (everything becomes 384²) but decode is not. Run
`pnpm vision:bench-scene ~/Pictures/*.jpg` for a library-representative figure.

If that ever lands somewhere unacceptable, the int8 image tower (434 MB) or
SigLIP 2 **large**/16-384 are the graceful steps down — each a one-line model-id
change plus a reprocess.

### The embeddings were also sanity-checked

Throughput proves nothing about correctness, and SigLIP's two preprocessing
divergences from CLIP (§"Precision" above) fail *silently*. The benchmark and
`vision-scene-engine.integration.test.ts` both check the pairwise structure on
the fixture set:

| pair | cosine |
| --- | --- |
| same group, two photos | 0.966 |
| same person, two portraits | 0.964 |
| portrait vs group | 0.808 – 0.833 |

Within-subject ~0.965 against across-subject ~0.82 is real semantic structure.
A centre crop or ImageNet normalization would have either collapsed the spread or
scrambled the ordering, so this is meaningful evidence the preprocessing is right
— and it is now a test, not a one-off observation.

---

## What no model choice fixes

Unchanged by going to the top end, and worth stating so the model is not expected
to solve it:

- **Small objects in large scenes.** 384 px helps versus 224, but a global
  embedding still underweights the sign in the background. §5.4 and §9 have the
  right answer: the detector, as a weighted structured term.
- **Counting, negation, spatial relations, text in images.** Properties of
  contrastive embeddings, not of model capacity. `"three dogs"` routes to
  detector counts or it does not work.
- **"Alice".** §4 stays true — the person half of the benchmark query is an exact
  lookup against `people.json`. Model choice only ever affected the
  `"at the beach"` residual.

## Tokenizer

SigLIP 2 uses the Gemma sentencepiece tokenizer (256 k vocab), shipped as
`tokenizer.json` + `tokenizer.model`. Roughly ~150 lines: normalize, `▁` for
spaces, Viterbi max-score segmentation.

I earlier framed sentencepiece as materially harder than CLIP's BPE. That was
overstated — they are comparable in size. The real difference is **verification
risk**: a subtly wrong tokenizer silently degrades every text embedding. The
mitigation is the same either way and is cheap: pin a table of known
`(string → token ids)` vectors taken from `tokenizer.json` as a unit test. Not a
factor in the decision.

---

## Decided

| | |
| --- | --- |
| Model | SigLIP 2 so400m/16-384 |
| Source | `onnx-community/siglip2-so400m-patch16-384-ONNX`, pinned to a commit |
| Licence | Apache-2.0 (looser than the antelopev2 weights already shipped) |
| Image tower | `vision_model.onnx`, fp32, 1714 MB — pinned into the sidecar model id |
| Text tower | `text_model.onnx` + `.onnx_data`, fp32 — **not** pinned, freely swappable to int8 |
| Embedding dim | 1152 → §5.5's linear scan is ~46 MB at 10 k photos. Still milliseconds, still no vector DB. |
| Fallbacks | int8 image tower; SigLIP 2 large/16-384; SigLIP 1 so400m/14-384 (`immich-app`, clean single-file towers) |

Being wrong costs one reprocess: after the step-1 refactor each task carries its
own `(version, modelId)`, so swapping the scene model invalidates **scene**
sidecars only, with no migration and no effect on faces.
