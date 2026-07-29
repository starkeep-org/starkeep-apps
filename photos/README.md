# Photos

Photos is a photo management app built on Starkeep. It demonstrates the thin-client pattern: the Next.js server talks to the data-server over HTTP rather than embedding the SDK directly.

## Running

Requires the data-server to be running first.

```bash
pnpm --filter photos-web dev
```

Opens on port 3000. Run only one of photos-web or admin-web at a time (they share the same port).

## What It Does

- **Browse photos** — Gallery view of all photos stored in Starkeep, with metadata displayed alongside each image
- **Upload photos** — Add new photos via the web interface; files are stored through the data-server and synced to cloud if configured
- **View metadata** — Image dimensions, EXIF data (camera model, capture date, GPS coordinates if present), file size, and MIME type are extracted automatically and displayed per photo
- **Face recognition, on-device** — optional, off by default; see below

## Face recognition

Detects faces, groups them by identity, and lets you name the groups. **It runs
entirely on the machine Photos is running on.** No image and no biometric data
is sent anywhere, and none of the derived state syncs.

Open the **Faces** button in the toolbar. It offers the one-time ~278 MB model
download — accepting the non-commercial-research licence in the process — and
shows its progress; then turn detection on and press *Scan now*. `pnpm dev`
builds the scan worker automatically.

For a headless or scripted install, the same download from a shell:

```bash
pnpm vision:fetch-models   # ~278 MB, once
```

### Where the state lives

`$STARKEEP_DIR/app-local/photos/vision/` — deliberately outside both storage
homes the platform gives an app, because both of those sync unconditionally and
none of this may leave the device.

```
config.json                 toggles and thresholds
faces/<recordId>.json       detections + 512-d identity vectors
people.json                 named groups
scan-state.json             progress of the last pass
```

The downloads live in a separate tree, `$STARKEEP_DIR/app-assets/photos/vision/`,
because they are not state — deleting them costs a re-fetch and nothing else:

```
models/                     the ONNX graphs (`pnpm vision:fetch-models`)
test-fixtures/              the integration test's photographs (`pnpm vision:fetch-fixtures`)
```

A record's sidecar *existing* is what marks it processed — there is no separate
index that could drift. Uninstalling Photos does not remove this directory.

### Models and licensing

Two of antelopev2's five graphs: `scrfd_10g_bnkps.onnx` (detection + 5
keypoints) and `glintr100.onnx` (512-d embedding), run through
`onnxruntime-node` on CPU. Expect roughly 0.2–0.5 s per photo.

**InsightFace's code is MIT, but its pretrained weights — antelopev2 included —
are licensed for non-commercial research use only**
([clarification](https://github.com/deepinsight/insightface/issues/2022)).
Starkeep does not redistribute them. Both download paths — the Faces panel's
button and `vision:fetch-models` — fetch from a commit-pinned URL, verify the
SHA-256 before the file lands, require an explicit acceptance of that
restriction, and record it as `LICENCE-ACKNOWLEDGED.txt` beside the weights.

### Sharing results with other apps

Off by default, and separately from detection itself. When enabled, Photos
publishes two record labels:

- `photos/faces` — one row per **named** person, so another app can ask
  `?label=photos/faces&labelValue=Alice`;
- `photos/face-count` — how many faces were found, as a small integer.

Neither is published for a photo with no faces. Turning the setting off retracts
what was published. Note that publishing makes the people in your library
enumerable by any app that can read your images, which is why it is an explicit
opt-in — see `starkeep-core/multi-value-labels.md`.

**Both keys are new in the manifest, so Photos must be re-installed** before the
data server will accept writes to them: the installer reconciles the label-key
registry at install time and rejects undeclared keys.

### Tests

`pnpm test` covers the whole feature except the engine itself, which needs the
models and four photographs that are not in the repo:

```bash
pnpm vision:fetch-models     # the ONNX graphs
pnpm vision:fetch-fixtures   # 4 public-domain photographs
```

With both installed, `__tests__/vision-engine.integration.test.ts` runs the real
detector and recogniser and pins the things a unit test cannot see — box counts,
the identity floor and ceiling either side of the 0.45 default, and that an
EXIF-rotated photo puts its box in display space. Without them it skips.

### Cloud

Every `/api/vision/*` route answers **501** when Photos is serving against a
remote data server. The feature is on-device, and a cloud deployment has neither
the photos nor the models locally. The engine is loaded only by the scan worker,
by absolute path, so `onnxruntime-node` never enters the Lambda bundle —
`__tests__/vision-bundle-isolation.test.ts` fails if that stops being true.

## Architecture

Photos-web is a thin client. The Next.js server makes authenticated requests to the data-server (running on port 9820 locally) for all data operations — listing records, fetching files, and uploading new photos. The data-server applies access control and returns results.

This means the SDK, type registry, and storage all live in the data-server process, not in photos-web. Photos-web is purely a presentation layer.

EXIF metadata is extracted by a generator registered on the data-server. When a photo is uploaded, the generator runs automatically and the metadata is available for display and search.
