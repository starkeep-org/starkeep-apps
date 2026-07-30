# Compositional search: photos as sets of grounded regions, not gestalt vectors

Design exploration, 2026-07-30. Proposal under examination: drop whole-image
embeddings as the semantic substrate; represent a photo by the objects in it and
drive similarity from the language vectors of those objects.

No code changed. Read alongside `object-vocabulary-expansion.md`.

---

## 1. The one decision that determines whether this works

The proposal has a fork in it that is easy to miss, and picking the wrong branch
kills the idea outright.

**Do not pool.** If a photo's representation is the mean of its tag vectors, the
result is *worse* than the gestalt vector it replaces. Mean-pooling `dog` + `beach`
+ `frisbee` produces a vector that is near none of the three and near a lot of
unrelated things. You would have discarded everything the gestalt vector captured
*and* blurred the objects into each other. Every naïve bag-of-tags system fails
here.

**Score by late interaction instead.** Keep the set. Decompose the query into
phrases, and score:

```
score(photo) = Σ_j  max_{r ∈ regions(photo)}  cos(q_j, v_r)
```

Each query phrase finds its own best region. "A dog on a beach" is satisfied by
`dog` matching one region and `beach` matching another — which is precisely the
conjunction a single gestalt vector is known to be bad at, and precisely the thing
`ranking.ts`'s core invariant already wants:

> `score(Alice ∧ beach) > score(Alice), score(beach)`

That invariant is currently enforced only across *different signal types* (person
vs object vs dense). Late interaction extends it *within* the dense signal. This is
the strongest argument for your proposal and I think it's right.

Note the query side is already half-built: `parse.ts` produces n-gram spans plus a
residual, and `embedQueries` takes an array. Phrase-level decomposition is a
natural extension of the existing parse rather than new machinery. (True
token-level ColBERT interaction is *not* available — SigLIP is a dual encoder with
pooled outputs — so phrase-level is the ceiling here, and it's enough.)

---

## 2. Test the hypothesis this week, at zero cost

Before any model work, the core claim — *object composition supports semantic
search* — is falsifiable using data already on disk.

Object sidecars already store class indices. Class names → text vectors is **80 text
encodes, total, shared across the entire library**. Cache them exactly the way
`tags.ts` caches vocabulary embeddings, keyed by a hash.

Then per query:

1. Embed the query phrases (already done today).
2. Dot each phrase against the 80 class vectors → an 80-entry score table. One
   time, per query.
3. Score each photo as `Σ_j max_{c ∈ classes(photo)} table[j][c]`.

Step 3 is a max over a handful of small integers per photo. **This is faster than
the current dense stage**, which does 10k × 1152 multiply-adds against the scene
index. No re-scan, no new model, no sidecar format change, no storage cost.

It also has a property the gestalt path never had: **every ranking is explainable.**
"This photo ranked here because `surfboard` scored 0.31 against your query" is a
sentence you can put in the UI. `ranking.ts` currently documents a band where a
genuine `water` match (0.035) and a spurious `spaceship` match (0.037) are
indistinguishable *in the model*. Compositional scores don't fix the underlying
ambiguity, but they make it legible instead of opaque.

Do this first. It costs a few days and it tells you whether the rest of this
document is worth building.

---

## 3. Where the cheap version hits its ceiling

Two ceilings, and they're different in kind.

### 3.1 Tag strings are a lossy re-encode of information you already had

If the substrate is the *word*, every dog photo becomes identical in the dog
dimension. Query "golden retriever puppy" scores the same against a Labrador
close-up and a distant terrier, because both reduce to `cos(query, v_dog)`. Ranking
*within* a class becomes impossible. The gestalt path does that fine today.

The fix is to embed the **region**, not the word: crop the box, run it through the
image tower, store that vector. It retains breed, colour, pose, lighting — and it
matches "golden retriever" even though the tagger only knows `dog`.

This has a consequence worth sitting with: **once you store region vectors, you
don't need tags for retrieval at all.** Tags become a display and browse layer over
the vectors, not the substrate. Which dissolves the vocabulary-sourcing problem
that killed the scene tag list — you never have to author a candidate list to make
search work.

### 3.2 Detectors give you things, not stuff

This is the structural one. Object detection is trained on discrete, boundable
*things*. Beach, sky, water, grass, snow, mountain, fog, indoors, night — these are
*stuff*: amorphous, unboundable, and absent from COCO by construction (as
`vision-objects-and-scene-overview.md` §5 already notes). No amount of vocabulary
expansion fixes this, because it's the proposal stage that can't see them, not the
label set.

A photo of a sunset over water contains zero detections. Under a pure-object
substrate it is unreachable by any query.

**The cheap mitigation is a fixed tile grid.** Alongside the detections, add a 2×2
or 3×3 grid of crops as pseudo-regions. No new model, no proposal logic, and it
covers stuff by brute force — the tile containing sky embeds as sky. It also gives
coarse spatial locality for free.

And then the whole image is just the 1×1 tile.

---

## 4. The synthesis: gestalt is region zero

That last line is the reframe I'd push hardest.

You framed this as compositional *versus* gestalt. It doesn't have to be a bet.
Make the index a set of `(region, vector)` pairs, where regions are:

- the whole image (1 region) — the current scene embedding, unchanged
- a tile grid (4 or 9 regions) — stuff coverage
- detected object boxes (N regions) — things, with boxes and counts

Late interaction over that set subsumes both designs. A "sunset" query matches the
whole-image region. A "three dogs on a beach" query matches object regions for the
dogs, a tile for the beach, and the count still comes from the structured path,
which is untouched. Nothing regresses, because the current representation is
literally still in the index.

This also keeps the change **contained to what produces the `dense` score**.
`ranking.ts`'s additive fusion, the structured object terms, counts, person
matching, and the chip UI all keep working exactly as they do now. That's a
genuinely small blast radius for a change this conceptually large.

---

## 5. What it costs, honestly

This is where the design stops being free, and the numbers are the main reason to
run §2 first.

**Storage.** 1152-d fp32 is 4.6 KB per region. At ~20 regions/photo (1 whole + 9
tiles + ~10 detections) that's 92 KB/photo, or **~920 MB for a 10k library** —
against the 46 MB the current scene index takes. fp16 halves it; a PCA projection
to 256 dims gets it to ~100 MB. Dimensionality reduction goes from "optional" to
"basically mandatory".

**Query time.** MaxSim over 200k vectors × 1152 dims is ~230M multiply-adds *per
query phrase*. In a Node process that is several hundred milliseconds to a second —
not viable. `scene-index.ts` is proud, correctly, that 10k photos needs "no vector
database, no ANN index, and no HNSW". **Multi-vector search is exactly where that
stops being true.** Either project down aggressively, or accept an ANN structure.
Worth deciding deliberately rather than discovering.

**Scan time.** ~20 image-tower passes per photo instead of 1, on a so400m/384 graph
that is already the heaviest thing in the app. That is the real blocker. The
realistic answer is a smaller crop tower — but crops and whole-images must live in
the *same* space to be MaxSim'd together, so that means re-embedding whole images
with the smaller tower too. One tower for everything, probably a smaller one than
today, and the 1.7 GB so400m download likely goes away. That's a quality tradeoff
made on purpose, and `vision-model-choice.md`'s comparison is the right place to
redo it.

**Detector recall becomes the ceiling for things.** If RT-DETR doesn't propose it,
no query reaches it. Tiles paper over this for stuff but not for small objects.

---

## 6. On "the scene path is a dead end"

I'd separate two things that both live in the scene path, because they died for
different reasons and only one of them is actually dead:

- **Tag suggestions** are dormant because nobody could source a good candidate list
  — `DEFAULT_TAG_VOCABULARY` is empty and `types.ts` records the measurement that
  retired the hand-authored one. That is a real dead end, and it's worth noting
  that a *tag-string* compositional substrate (§3.1) walks straight back into it.
  Region vectors are what escape it.
- **Free-form dense retrieval** never consults the vocabulary at all — `search.ts`
  embeds the residual at query time. Its documented limit is different: `ranking.ts`
  shows it cannot separate a weak real match from noise, and concludes, in its own
  words, that "the detector knows what a boat is". Your instinct is already endorsed
  by the measurements in this repo.

So: the diagnosis holds, but the remedy is to demote the gestalt vector from *the*
representation to *one region among many* — not to delete it. Deleting it is what
costs you sunsets.

---

## 7. Sequencing

1. **Tag-vector late interaction over existing object sidecars** (§2). Days, not
   weeks. Zero new models, zero storage, zero re-scan. Tells you whether
   compositional retrieval is real on your library. Ship it behind the existing
   dense weight so it can be A/B'd against the gestalt score.
2. If it works, **add tiles as pseudo-regions** and embed regions with the image
   tower. This is the point where you decide the storage and query-time questions
   in §5, and probably the point where the model gets smaller.
3. **Then** revisit detector vocabulary (`object-vocabulary-expansion.md`) — but
   note that if §2 pans out, a bigger closed vocabulary matters much less, because
   region vectors already carry more than their labels do. That earlier document's
   Route C and this design converge on the same architecture from opposite
   directions, which is mild evidence it's the right one.

The thing that decides all of it is step 1, and step 1 is cheap.
