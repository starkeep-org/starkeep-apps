# Object and scene detection — functional overview

*Written 2026-07-30, as background for reconsidering the design. Describes behaviour as
built, not as planned. Faces are omitted deliberately; where they share machinery it is
noted only because that machinery constrains objects and scene too.*

---

## 1. The two features answer different questions

They are often spoken of together because they were built together and run in the same
pass, but functionally they are not variants of one another.

**Object detection answers "what discrete things are in this photo, and where?"** It
produces a list of named boxes — three `person`, one `dog`, a `frisbee` — each with a
rectangle and a confidence. It is *localized* and *countable*. Those two properties are
the whole reason it exists: they are what a bounding-box overlay draws, and what lets a
search for "three dogs" be answered by counting rather than by guessing.

**Scene understanding answers "what is this photo *like*?"** It produces no names, no
boxes, and nothing a person can read. It produces a single vector describing the whole
frame — a position in a space where photos that look and mean similar things sit near
each other, and where *text* can also be placed. It is unlocalized and uncountable. What
it buys is the ability to compare a photo against an arbitrary phrase nobody enumerated
in advance: "at the beach", "birthday party", "snowy street".

So: objects has a **closed, fixed vocabulary and exact positions**. Scene has an **open,
unlimited vocabulary and no positions**. Almost every functional consequence downstream
follows from that one contrast.

---

## 2. Nothing happens until the user opts in, twice

Both features are **off by default**, along with faces. That is not a soft default —
nothing is downloaded, nothing is computed, and nothing appears in the UI until someone
turns them on in Photos' vision settings.

The reason is cost, and it is per-feature:

- **Objects** needs a ~307 MB model download, then roughly a fraction of a second of CPU
  per photo.
- **Scene** needs a ~1.7 GB model download, then noticeably longer per photo — a first
  pass over a large library is measured in hours.

The licences also differ per feature, which is why the settings surface is one card per
feature rather than one vision switch: the face weights are non-commercial, the scene
weights are Apache-2.0. A single "enable vision" toggle would either demand a licence
acceptance that does not apply or hide one that does.

The second opt-in is the scan itself. Enabling a feature does not process anything. The
user must press **Scan**, and this is the *only* trigger in the system — there is no
processing on upload, no background catch-up, no scheduled pass. A library that grows
after a scan simply has un-analysed photos in it until someone presses the button again.
This is probably the single most user-visible gap in the current design.

---

## 3. Everything runs on the user's own machine, and only there

All of this is on-device by explicit design. The models run locally, the results stay in
a local directory next to the app, and nothing is sent anywhere for inference.

The hard edge of that: when Photos is served from the cloud rather than run locally,
**these features do not exist**. The relevant endpoints refuse, and the UI renders no
settings card, no search box, no tag editor, and no overlay toggles — deliberately
absent rather than present-and-disabled, since a disabled control would imply it is
coming. A user with the same library reached two different ways sees two different
feature sets.

---

## 4. One pass over the library, doing whatever is enabled

A scan walks the library once and, for each photo, runs whichever features are enabled
and have not already processed that photo.

What it walks is **originals only** — thumbnails and crops are skipped, since their
content duplicates a photo already in the set.

For each photo the scan fetches the image bytes once and hands the same bytes to every
enabled feature. That is the point of running them together: three features over one
decode, not three passes.

Progress is reported live (eligible / skipped / processed per feature / failed) while it
runs. A single unreadable photo is counted as failed and skipped rather than ending the
pass, and because nothing was recorded for it, the next scan retries it.

Stopping is cooperative — the scan finishes the photo it is on and stops between images,
so everything computed so far is kept and usable. A scan interrupted by an app restart
is noticed and reported as interrupted rather than left looking like it is still
running.

### What the pass leaves behind

Results are stored **one small file per photo per feature**, sitting beside the app.
Three functional consequences worth holding onto:

- **A photo with nothing found still gets a file.** "Analysed, found nothing" and "never
  analysed" are different states, and keeping them apart is what stops every empty photo
  being re-analysed on every pass.
- **The file records which model version produced it.** A file from an older model reads
  as absent, so changing a model automatically re-analyses — no migration step, and it
  is *per feature*, so swapping the scene model does not disturb object results.
- **These files are derived and disposable.** They can be deleted wholesale and rebuilt
  by re-scanning. Nothing a human authored lives in them.

The counterpart to that last point: because the store is a pile of per-photo files with
no link back to the library, **deleting a photo leaves its results behind**. Scans
reconcile this by sweeping results for photos that no longer exist, which is the only
thing standing in for a proper cascade.

---

## 5. Objects: what it knows and what it does

### The vocabulary is fixed at 80 things

The detector recognises exactly 80 categories — the standard COCO set that came with the
model, not a list anyone here chose. Broadly: people and animals, vehicles and traffic
furniture, sports equipment, bags and accessories, kitchen and food items, indoor
furniture, electronics, and a short household tail (book, clock, vase, scissors, teddy
bear, hair drier, toothbrush).

**What is absent matters more than what is present.** There is no building, tree, sky,
water, mountain, road, flower, or beach — nothing landscape- or scene-level, because
COCO is a dataset of discrete photographable objects. There is also no proper noun, no
activity, and no material. A user who expects "detects objects" to mean "recognises what
is in my photos" will find it recognises about eighty nouns and nothing else.

The names carry the model's own spellings — `aeroplane`, `motorbike`, `tvmonitor`,
`pottedplant`, `diningtable` — because those spellings are what the categories mean to
the model. A separate synonym table translates what a person would actually type
("airplane", "couch", "fridge", "phone", "computer") onto them, so the odd spellings do
not leak into search. They *do* leak into the overlay labels.

### What it produces per photo

Every detection carries a category, a rectangle, and a confidence. The model always
considers 300 candidate objects per image regardless of content; each candidate is
resolved to its single best category (so one dog can never be reported as both a dog and
a cat), and anything below a confidence threshold is dropped. There is no cap on
survivors, so a crowded photo can legitimately produce dozens of boxes. Results are
ordered most-confident first.

The confidence threshold is **user-adjustable** in settings, defaulting to a value tuned
for this model. Lowering it invents furniture in every photo; raising it loses real
objects. It is a live knob but changing it does not re-analyse anything — it only
affects photos scanned afterwards, which is a quiet inconsistency worth naming.

Boxes are recorded relative to the photo as *displayed*, i.e. after rotation is applied,
so overlays land correctly on photos that carry a rotation tag.

### Where object results surface

Three places, and only three:

1. **The bounding-box overlay in the photo viewer.** An "Objects" toggle in the viewer
   header, off by default, drawing labelled boxes over the photo with the category and
   its confidence percentage. It shows the detection count when on, and distinguishes
   "not analysed yet" from "analysed, found nothing" in its tooltip. Faces has an
   identical, independent toggle in a different colour, and both can be on at once.
2. **Search**, as a countable filter — see §7.
3. **A count in the settings card**, reporting how many photos carry object results.

Notably, object results are **never published** anywhere outside Photos, and are not
turned into tags, albums, or any browsable index. There is no "show me all photos with a
dog" surface other than typing it into search.

---

## 6. Scene: what it knows and what it does

### It produces a description nobody can read

For each photo, scene analysis produces one vector for the whole frame. That is the
entire output. It has no names in it, cannot be displayed, and cannot be inspected. Its
value is entirely relational: it can be compared to other photos' vectors, and — because
the model was trained to place images and text in the same space — to a vector computed
from a phrase the user types.

There is no threshold, no confidence, and no per-photo notion of success or failure. A
photo either has been described or has not.

### The searchable index

At the end of a scan, all the per-photo scene vectors are compacted into a single index
file so that a query can be scored against the whole library in one read rather than
opening thousands of files. Like the per-photo results, it is derived and disposable —
if it is missing, stale, or built by a different model, it is rebuilt rather than
repaired, and search simply reports that description search is unavailable until then.

This is why scene results only become searchable **at the end of a pass**: the index is
rebuilt then, not incrementally.

### Where scene results surface

Two places:

1. **Description search** — the dense half of the search box (§7).
2. **Tag suggestions** (§8).

Scene produces nothing visible on a photo itself. There is no scene label, no "this
looks like a beach", no auto-album, no grouping of similar photos, and no
similar-photos-to-this-one feature — even though the stored vectors would support all of
those directly.

---

## 7. Search is where the two meet

The search box sits above the photo grid and acts as a **filter on the main library
view** rather than a separate results list: matching photos stay in their normal
chronological grouping. Relevance decides *membership*, not position.

A typed query is split into two kinds of thing:

- **Structured terms** — words that match a closed vocabulary the system can answer
  exactly. Today that means named people and the 80 object categories, including
  quantities: "three dogs" is recognised as a count and answered by *counting detections*,
  never by asking the scene model, which is poor at counting. Counts are treated as "at
  least", so a photo of four dogs answers "three dogs".
- **The residual** — whatever is left over, which goes to the scene model as a
  description to match.

So "Alice and two dogs at the beach" becomes: an exact person lookup, an exact count of a
detected category, and a description match on "at the beach" — three different mechanisms
in one query. The parse is deliberately not an LLM: queries contain the names of people
in a private library, and routing them off-device would undo the on-device guarantee.

Results are combined **additively** rather than by intersection. A photo matching only
some terms is still a candidate, ranked below one matching more. The UI groups results by
which terms fired, so the user can see *why* a photo is there, and can dismiss a term
they did not mean.

Two guards worth knowing, both functional rather than technical:

- Object categories are only matched at all **if some object results exist**. Otherwise
  "dog" would become an exact filter matching nothing, in a library where the scene model
  could have answered it.
- The result count is deliberately labelled "results", not "matches", because membership
  is a similarity floor and the band just above it genuinely mixes faint real matches
  with noise.

---

## 8. Tags: the human-facing use of scene

Tags are the one place scene output becomes words. The system scores a **user-editable
vocabulary** — a list of candidate tag phrases — against each photo's scene vector, and
offers the ones that clear a threshold as suggestions.

The central distinction is provenance:

- **Suggested** — the machine proposed it; nobody has agreed.
- **Confirmed** — a suggestion a human explicitly kept.
- **Added** — a tag a human typed, whether or not the vocabulary ever proposed it.

The suggestions are recomputed cache; the human's edits are durable data stored with the
photo, surviving re-scans, model swaps, and vocabulary changes. Edits are stored as a
*diff* (added and removed), because removing a suggestion has to persist as a negative —
otherwise the next scoring re-derives it and it silently comes back.

Editing the vocabulary is cheap and needs **no re-analysis of photos**: the photos are
already described, so a new candidate phrase costs one text encoding and then arithmetic.
That is genuinely a nice property, and it is the thing most worth preserving in any
redesign.

**The shipped vocabulary is empty.** Out of the box there are no suggestions at all, and
the tag editor is simply a manual tagging tool. Everything above about scoring and
provenance is dormant until someone populates a list.

---

## 9. What leaves Photos

Very little, and only by opt-in.

Photos can publish some of what it found as cross-app labels, so other apps can query
the library. What crosses that line is **names and counts only, never vectors and never
boxes**: named people, a face count, and user-confirmed or user-typed tags.

Object detections are **not** published — not the categories, not the counts, not the
boxes. Machine tag suggestions are not published either, on the grounds that an
uncalibrated score must not become another app's ground truth. Only what a human agreed
with crosses.

---

## 10. Functional gaps, stated plainly

Collected for the redesign conversation; each is behaviour as built, not a bug report.

1. **Analysis is manual and one-shot.** The only way anything gets analysed is a human
   pressing Scan. New photos are invisible to search, tags, and overlays until someone
   remembers to press it again.
2. **The object vocabulary is 80 fixed nouns with no landscape, place, activity, or
   material terms** — and no way for a user to extend it, unlike the tag vocabulary.
3. **Objects and scene answer overlapping questions with no shared surface.** "Dog" can
   be answered either by a detection or by description similarity, and which one runs
   depends on whether an object scan has ever happened. The user is not told which
   answered.
4. **Scene output is used for only two things** — search and tag suggestions — despite
   supporting similar-photo grouping, clustering, and automatic albums for free.
5. **Object output is used for only two things** — the overlay and search counts — and is
   never turned into anything browsable or shareable.
6. **Neither feature exists in cloud-served Photos**, so the same library has different
   capabilities depending on how it is reached.
7. **The object threshold is a live setting over already-computed results**, so changing
   it silently produces a library analysed under two different standards.
8. **Results are per-photo files with no link back to the library**, so deletion leaves
   orphans until a later scan sweeps them.
9. **Tag suggestions ship dormant** because the default vocabulary is empty, so the
   feature most likely to make scene understanding legible to a user does nothing on a
   fresh install.
