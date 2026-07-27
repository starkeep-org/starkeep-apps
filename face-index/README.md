# face-index — a throwaway cross-app label consumer

This app exists to **exercise the cross-app record-label mechanism**, not to
find faces. When real face detection lands in Photos it replaces
`src/detect.ts` behind the same two labels and nothing else moves.

## Why it's a separate app and not a module inside Photos

Inside Photos, this would be the origin app labelling its own records — the
degenerate case the removed `records.label` column already covered. It would
test none of what the label mechanism adds. A distinct app id is what exercises
the three decisions the design actually rests on:

| What it exercises | Why it's only visible cross-app |
| --- | --- |
| Writing a label with **only a `read` grant** | The whole argument for pricing a label write at `read` is that an OCR service or classifier shouldn't hold destructive power over images it only reads. That claim is vacuous for the origin app, which holds `readwrite` anyway. |
| A **reverse query across a namespace the caller doesn't own** | `image-owner` asks "which of my images did `face-index` flag?" without calling `face-index`. That is the query labels exist for. |
| **`app_id` server-set** | `face-index` never sends an app id and could not send a different one. Squatting is unrepresentable rather than rejected. |

## What it publishes

Declared in `starkeep.manifest.json`; the write path rejects anything else.

| Key | Shape | Meaning |
| --- | --- | --- |
| `faces-detected` | bare flag | This image contains at least one face. |
| `face-count` | valued | How many, as a decimal string. |

**Images with no faces are left unlabelled**, not labelled zero. A presence
query has to mean "there are faces here"; publishing a negative would make
`?label=face-index/faces-detected` match everything.

## Running it

```bash
# Install it from admin-web (it needs credentials), then:
pnpm index-once
```

One pass, not a daemon — a long-running watcher would add lifecycle concerns
that have nothing to do with what this is here to exercise. The pass is
idempotent: it skips records it has already labelled (cheaply, off the
`include=labels` hydration rather than a lookup per record), and the underlying
upsert is keyed on `(record, app, key)`, so a partial failure is safe to rerun.

`pnpm test` boots a real local-data-server and drives the whole thing.
