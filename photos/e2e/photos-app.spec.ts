/**
 * Photos app-functionality e2e (platform test plan case 7b): assert what the
 * *app* does on the platform — EXIF/dimension metadata, the derived rendition
 * ladder, the shared-vs-app-private caption split — through the real browser
 * UI, with LDS-direct reads for the data-layer assertions.
 *
 * Doubles as the worked example of how an app developer tests an app on the
 * Starkeep platform: see ./README.md.
 *
 * Serial: each test continues the state of the previous one (install → run →
 * upload → enrich → restart).
 */

import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRecordWithBytes,
  driveCreds,
  eventually,
  installAppDirect,
  installAppViaAdmin,
  listRecords,
  solidPng,
  startAppDaemonViaAdmin,
  stopAppDaemonViaAdmin,
  type LdsApp,
} from "@starkeep/e2e";
import { jpegWithExif } from "../__tests__/jpeg-fixture";
import { applicableStillClasses } from "../src/photos-lib/ladder";
import { DEFAULT_RENDITION_TYPE } from "../src/photos-lib/image-processing/derive-ladder";
import {
  RENDITION_LABEL_REF,
  renditionFileName,
} from "../src/photos-lib/image-processing/publish-renditions";

test.describe.configure({ mode: "serial" });

const adminUrl = () => process.env.E2E_ADMIN_URL!;
const ldsUrl = () => process.env.E2E_LDS_URL!;

const PHOTOS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PNG_NAME = "e2e-sunrise.png";
/**
 * The PNG fixture's edge, in pixels. Named because the rendition assertions
 * compute the applicable rungs from it: `applicableStillClasses` answers a
 * source size, so a fixture size written twice would let the two answers drift.
 */
const PNG_EDGE = 8;
const JPG_NAME = "e2e-camera.jpg";
const WATCHER_JPG = "e2e-watcher.jpg";
const CAPTION = "First light over the ridge";

let pngPath: string;
let jpgPath: string;
let photosUrl: string;
/** signedFetch as the photos app — its own view of the data plane. */
let photosApp: LdsApp;
/** The PNG original's shared record id, set by the upload test. */
let pngRecordId: string;

interface SharedRecord {
  id: string;
  type: string;
  parent_id: string | null;
  original_filename: string | null;
  /**
   * Present only when the listing asked for `include=labels`. `[]` for a
   * record no app has labelled — absence of labels is an empty set, not an
   * unknown.
   */
  labels?: Array<{ app_id: string; key: string; value: string | null; label: string }>;
  [k: string]: unknown;
}

async function imageMetadata(recordId: string): Promise<Record<string, unknown> | null> {
  const res = await photosApp.fetch(`/data/records/${recordId}/metadata/image`);
  if (!res.ok) throw new Error(`metadata fetch → ${res.status}`);
  const { metadata } = (await res.json()) as { metadata: Record<string, unknown> | null };
  return metadata;
}

async function findRecord(fileName: string): Promise<SharedRecord> {
  const records = (await listRecords(
    photosApp,
    "?include=labels&limit=1000",
  )) as unknown as SharedRecord[];
  const match = records.find((r) => r.original_filename === fileName && r.parent_id === null);
  if (!match) throw new Error(`no original record for ${fileName} yet`);
  return match;
}

async function openViewerCaption(page: Page, altText: string): Promise<Locator> {
  await page.getByAltText(altText).first().click();
  await page.getByRole("button", { name: "Info" }).click();
  const caption = page.getByPlaceholder("Add a caption…");
  await expect(caption).toBeVisible();
  return caption;
}

test.beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "photos-e2e-fixtures-"));
  pngPath = join(dir, PNG_NAME);
  jpgPath = join(dir, JPG_NAME);
  await writeFile(pngPath, solidPng([240, 170, 60], PNG_EDGE));
  await writeFile(jpgPath, await jpegWithExif({ make: "TestMake", model: "TestModel 3000" }));
});

test("install photos through the platform and start its dev server", async ({ page }) => {
  await installAppViaAdmin(adminUrl(), "photos");
  ({ url: photosUrl } = await startAppDaemonViaAdmin(adminUrl(), "photos"));

  // Recover the installed app's credentials for data-layer assertions:
  // re-posting an active app's manifest returns the existing secret.
  const manifest = JSON.parse(
    await readFile(join(PHOTOS_DIR, "starkeep.manifest.json"), "utf-8"),
  ) as Record<string, unknown>;
  photosApp = await installAppDirect(ldsUrl(), manifest);

  await page.goto(photosUrl);
  await expect(page.getByRole("button", { name: "Add Photo" })).toBeVisible({ timeout: 120_000 });
});

test("an uploaded photo appears in the grid as a shared record", async ({ page }) => {
  await page.goto(photosUrl);
  await page.locator('input[type="file"]').first().setInputFiles(pngPath);
  await expect(page.getByAltText(PNG_NAME).first()).toBeVisible({ timeout: 60_000 });

  const record = await eventually(() => findRecord(PNG_NAME));
  pngRecordId = record.id;
  expect(record.type).toBe("image/png");
  // An uploaded original is general-interest shared data — nothing labels it.
  // (Only derived images carry photos/rendition or photos/crop. The original is
  // deliberately not a rung: it is what rungs are derived from.)
  expect(record.labels).toEqual([]);

  // The live UI upload now extracts dimensions (createImageBitmap) + EXIF in
  // the browser and writes them through the same proxy, so the shared image
  // metadata row lands for UI uploads too (previously this path wrote none).
  // The fixture PNG is PNG_EDGE square.
  const meta = await eventually(async () => {
    const m = await imageMetadata(pngRecordId);
    if (!m) throw new Error("image metadata row not written yet");
    return m;
  });
  expect(meta.width).toBe(PNG_EDGE);
  expect(meta.height).toBe(PNG_EDGE);
});

test("a JPEG upload carries EXIF camera fields into shared image metadata", async ({ page }) => {
  // Real cameras and phones emit JPEG with EXIF; the app extracts the IFD0
  // camera fields in the browser (exifr) on upload and writes them to the
  // shared image metadata. Same client path as the PNG above
  // (addPhotoFromPath through the /api/local-data proxy) — driven through the
  // live file input — exercised here for the EXIF fields a camera file carries
  // that a flat PNG does not.
  await page.goto(photosUrl);
  await page.locator('input[type="file"]').first().setInputFiles(jpgPath);
  await expect(page.getByAltText(JPG_NAME).first()).toBeVisible({ timeout: 60_000 });

  const record = await eventually(() => findRecord(JPG_NAME));
  expect(record.type).toBe("image/jpeg");

  const meta = await eventually(async () => {
    const m = await imageMetadata(record.id);
    if (!m) throw new Error("EXIF metadata not written yet");
    return m;
  });
  expect(meta.camera_make).toBe("TestMake");
  expect(meta.camera_model).toBe("TestModel 3000");
  // Dimensions ride the same metadata write (8×8 fixture).
  expect(meta.width).toBe(8);
  expect(meta.height).toBe(8);
});

test("the applicable rendition ladder is registered as shared child records with parentId", async () => {
  // Derivation needs no tab: `instrumentation.register` starts the ingest watch
  // when the app's server starts, and every write on the data server kicks a
  // sweep. A tile waiting on a rung asks for the same work through /api/resize.
  // Both paths publish through derive-and-publish, so this waits on the result
  // rather than on whichever one got there first.
  //
  // Which rungs apply is a question about the source's size, so it is asked
  // rather than written down. A respec that adds or moves a rung moves this
  // expectation with it; a literal list would have to be found and edited by
  // the same change that made it wrong.
  const expectedClasses = applicableStillClasses(PNG_EDGE).map((spec) => spec.sizeClass);

  const children = await eventually(
    async () => {
      const records = (await listRecords(
        photosApp,
        "?include=labels&limit=1000",
      )) as unknown as SharedRecord[];
      const found = records.filter((r) => r.parent_id === pngRecordId);
      if (found.length < expectedClasses.length) {
        throw new Error(
          `${found.length} of ${expectedClasses.length} rungs registered so far`,
        );
      }
      return found;
    },
    { timeoutMs: 60_000 },
  );
  // One child per applicable rung and nothing else: a ladder with a spare child
  // is a record whose archive gate can never be reasoned about.
  expect(children).toHaveLength(expectedClasses.length);

  // Each rung carries Photos' rendition marker, so other image-declaring apps
  // can filter derived images out of a library view. Photos writes it as a
  // cross-app label in the same request as the record (see publish-renditions) —
  // the `photos/` namespace comes from its authenticated identity, never from
  // the body. The rung is the label's VALUE: the old bare `photos/thumbnail`
  // flag could name only one derived size, and the manifest no longer declares
  // it, so the platform now rejects a write of it.
  const rungs = children.map((child) => {
    expect(child.labels).toHaveLength(1);
    const label = child.labels![0]!;
    expect(label.app_id).toBe("photos");
    expect(label.key).toBe("rendition");
    expect(label.label).toBe(RENDITION_LABEL_REF);
    return { child, sizeClass: label.value };
  });
  expect(rungs.map((r) => r.sizeClass).sort()).toEqual([...expectedClasses].sort());

  // Re-encoded by the ladder's default codec and named for its rung, which is
  // what makes two rungs of one original distinguishable in a file listing.
  for (const { child, sizeClass } of rungs) {
    expect(child.type).toBe(DEFAULT_RENDITION_TYPE);
    expect(child.original_filename).toBe(renditionFileName(PNG_NAME, sizeClass!));
  }

  // Shared semantics: another app with image access (Drive) sees the rungs,
  // their parent link, AND their labels — labels are platform data, not
  // photos-private, and any app that can read the type sees every app's
  // labels on it.
  const drive = await driveCreds(ldsUrl());
  const driveView = (await listRecords(
    drive,
    "?include=labels&limit=1000",
  )) as unknown as SharedRecord[];
  for (const { child } of rungs) {
    const driveChild = driveView.find((r) => r.id === child.id);
    expect(driveChild?.parent_id).toBe(pngRecordId);
    expect(driveChild?.labels?.map((l) => l.label)).toEqual([RENDITION_LABEL_REF]);
  }
  // …and the original stays unlabelled in the cross-app view.
  expect(driveView.find((r) => r.id === pngRecordId)?.labels).toEqual([]);

  // The reverse query — the one labels exist for. Drive asks "which records did
  // photos label as renditions?" without knowing anything about Photos.
  const derived = (await listRecords(
    drive,
    `?label=${encodeURIComponent(RENDITION_LABEL_REF)}&limit=1000`,
  )) as unknown as SharedRecord[];
  for (const { child } of rungs) {
    expect(derived.map((r) => r.id)).toContain(child.id);
  }
  expect(derived.map((r) => r.id)).not.toContain(pngRecordId);
});

test("captions live in the app-private image_enriched table, not in shared data", async ({
  page,
}) => {
  await page.goto(photosUrl);
  const caption = await openViewerCaption(page, PNG_NAME);
  const saved = page.waitForResponse(
    (r) => r.url().includes("/api/photos/captions/") && r.request().method() === "PUT",
  );
  await caption.fill(CAPTION);
  await caption.blur();
  expect((await saved).ok()).toBe(true);

  // The app sees its row via /app-data…
  const row = await eventually(async () => {
    const res = await photosApp.fetch(
      `/app-data/db/image_enriched?record_id=${encodeURIComponent(pngRecordId)}`,
    );
    if (!res.ok) throw new Error(`app-data → ${res.status}`);
    const { rows } = (await res.json()) as { rows?: Array<Record<string, unknown>> };
    if (!rows?.[0]) throw new Error("image_enriched row not written yet");
    return rows[0];
  });
  expect(row.caption).toBe(CAPTION);

  // …while nothing on the shared surface carries the caption: not the record
  // list, not the image metadata row.
  const drive = await driveCreds(ldsUrl());
  const sharedJson = JSON.stringify(await listRecords(drive));
  expect(sharedJson).not.toContain(CAPTION);
  const metaRes = await drive.fetch(`/data/records/${pngRecordId}/metadata/image`);
  expect(JSON.stringify(await metaRes.json())).not.toContain(CAPTION);
});

test("the caption survives a photos restart — app data is durable, not session state", async ({
  page,
}) => {
  await stopAppDaemonViaAdmin(adminUrl(), "photos");
  ({ url: photosUrl } = await startAppDaemonViaAdmin(adminUrl(), "photos"));

  await page.goto(photosUrl);
  await expect(page.getByAltText(PNG_NAME).first()).toBeVisible({ timeout: 120_000 });
  const caption = await openViewerCaption(page, PNG_NAME);
  await expect(caption).toHaveValue(CAPTION);
});

test("opening an image with no metadata row lazily extracts and persists it", async ({ page }) => {
  // Images can enter the system through paths that don't extract metadata — the
  // LDS folder watcher, by design. createRecordWithBytes mimics that: it uploads
  // bytes and registers the shared record, but writes no image metadata row.
  const { record } = await createRecordWithBytes(photosApp, {
    type: "image/jpeg",
    contentType: "image/jpeg",
    bytes: Buffer.from(await jpegWithExif({ make: "WatchMake", model: "WatchModel 9" })),
    fileName: WATCHER_JPG,
  });
  const watcherId = record.id;

  // Precondition: the record exists on the shared plane with no metadata row.
  expect(await imageMetadata(watcherId)).toBeNull();

  // Open the image's Info panel in the real UI. The panel sees width 0 (no row)
  // and runs the lazy backfill in the background, then re-loads — so the
  // Dimensions row flips from 0 × 0 to the decoded 8 × 8 of the fixture.
  await page.goto(photosUrl);
  await page.getByAltText(WATCHER_JPG).first().click({ timeout: 60_000 });
  await page.getByRole("button", { name: "Info" }).click();
  await expect(page.getByText("8 × 8px")).toBeVisible();

  // The backfill is a *persistent* write, not just a display patch: the shared
  // image metadata row now exists, carrying both the decoded dimensions and the
  // EXIF camera fields extracted from the same bytes.
  const meta = await eventually(async () => {
    const m = await imageMetadata(watcherId);
    if (!m) throw new Error("backfilled metadata row not written yet");
    return m;
  });
  expect(meta.width).toBe(8);
  expect(meta.height).toBe(8);
  expect(meta.camera_make).toBe("WatchMake");
  expect(meta.camera_model).toBe("WatchModel 9");
});
