/**
 * Photos app-functionality e2e (platform test plan case 7b): assert what the
 * *app* does on the platform — EXIF/dimension metadata, the derived
 * thumbnail, the shared-vs-app-private caption split — through the real
 * browser UI, with LDS-direct reads for the data-layer assertions.
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

test.describe.configure({ mode: "serial" });

const adminUrl = () => process.env.E2E_ADMIN_URL!;
const ldsUrl = () => process.env.E2E_LDS_URL!;

const PHOTOS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PNG_NAME = "e2e-sunrise.png";
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
  /** Advisory `<appId>/<purpose>` interest-filter marker; null for originals. */
  label: string | null;
  [k: string]: unknown;
}

async function imageMetadata(recordId: string): Promise<Record<string, unknown> | null> {
  const res = await photosApp.fetch(`/data/records/${recordId}/metadata/image`);
  if (!res.ok) throw new Error(`metadata fetch → ${res.status}`);
  const { metadata } = (await res.json()) as { metadata: Record<string, unknown> | null };
  return metadata;
}

async function findRecord(fileName: string): Promise<SharedRecord> {
  const records = (await listRecords(photosApp)) as unknown as SharedRecord[];
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
  await writeFile(pngPath, solidPng([240, 170, 60], 8));
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
  // An uploaded original is general-interest shared data — no advisory label.
  // (Only derived thumbnails carry photos/thumbnail; see the thumbnail test.)
  expect(record.label).toBeNull();

  // The live UI upload now extracts dimensions (createImageBitmap) + EXIF in
  // the browser and writes them through the same proxy, so the shared image
  // metadata row lands for UI uploads too (previously this path wrote none).
  // The fixture PNG is 8×8.
  const meta = await eventually(async () => {
    const m = await imageMetadata(pngRecordId);
    if (!m) throw new Error("image metadata row not written yet");
    return m;
  });
  expect(meta.width).toBe(8);
  expect(meta.height).toBe(8);
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

test("a thumbnail is registered as a shared derived record with parentId", async () => {
  // The UI's orphan-backfill effect fires /api/resize for originals lacking a
  // thumbnail; wait for the derived record to materialize.
  const thumb = await eventually(
    async () => {
      const records = (await listRecords(photosApp)) as unknown as SharedRecord[];
      const t = records.find((r) => r.parent_id === pngRecordId);
      if (!t) throw new Error("thumbnail record not registered yet");
      return t;
    },
    { timeoutMs: 60_000 },
  );
  // Re-encoded as JPEG and named after its original.
  expect(thumb.type).toBe("image/jpeg");
  expect(thumb.original_filename).toBe(`thumb_${PNG_NAME}`);
  // The thumbnail carries the advisory label so other image-declaring apps can
  // filter it out — that's the whole point of the label. Photos sets it on the
  // /api/resize write path (see app/api/resize/route.ts).
  expect(thumb.label).toBe("photos/thumbnail");

  // Shared semantics: another app with image access (Drive) sees the
  // thumbnail, its parent link, AND the advisory label — it's platform data,
  // not photos-private, and the label rides the shared-record sync.
  const drive = await driveCreds(ldsUrl());
  const driveView = (await listRecords(drive)) as unknown as SharedRecord[];
  const driveThumb = driveView.find((r) => r.id === thumb.id);
  expect(driveThumb?.parent_id).toBe(pngRecordId);
  expect(driveThumb?.label).toBe("photos/thumbnail");
  // …and the original stays unlabeled in the cross-app view.
  expect(driveView.find((r) => r.id === pngRecordId)?.label).toBeNull();
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
