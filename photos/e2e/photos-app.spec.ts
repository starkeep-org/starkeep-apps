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
import { tiffWithExif } from "../__tests__/tiff-fixture";

test.describe.configure({ mode: "serial" });

const adminUrl = () => process.env.E2E_ADMIN_URL!;
const ldsUrl = () => process.env.E2E_LDS_URL!;

const PHOTOS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PNG_NAME = "e2e-sunrise.png";
const TIFF_NAME = "e2e-camera.tif";
const CAPTION = "First light over the ridge";

let pngPath: string;
let tiffPath: string;
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
  tiffPath = join(dir, TIFF_NAME);
  await writeFile(pngPath, solidPng([240, 170, 60], 8));
  await writeFile(tiffPath, tiffWithExif({ make: "TestMake", model: "TestModel 3000" }));
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
  expect(record.type).toBe("png");

  // Known gap (registered product finding): the live UI uploads through the
  // generic /api/local-data presign+register proxy and never writes image
  // metadata — only the (currently unused by the UI) POST /api/photos route
  // extracts EXIF/dimensions. Pinned so the fix flips this assertion.
  expect(await imageMetadata(pngRecordId)).toBeNull();
});

test("POST /api/photos extracts dimensions and EXIF camera fields into shared image metadata", async () => {
  // The app's own upload API (exercised directly — see the pinned UI gap
  // above): PNG carries dimensions, TIFF carries IFD0 camera fields.
  const pngForm = new FormData();
  pngForm.append(
    "file",
    new Blob([Uint8Array.from(await readFile(pngPath))], { type: "image/png" }),
    "api-meta.png",
  );
  pngForm.append("originalFilename", "api-meta.png");
  const pngRes = await fetch(`${photosUrl}/api/photos`, { method: "POST", body: pngForm });
  expect(pngRes.status).toBe(201);
  const { image: pngImage } = (await pngRes.json()) as { image: { id: string } };
  const pngMeta = await eventually(async () => {
    const m = await imageMetadata(pngImage.id);
    if (!m) throw new Error("metadata row not written yet");
    return m;
  });
  expect(pngMeta.width).toBe(8);
  expect(pngMeta.height).toBe(8);

  const tiffForm = new FormData();
  tiffForm.append(
    "file",
    new Blob([Uint8Array.from(await readFile(tiffPath))], { type: "image/tiff" }),
    TIFF_NAME,
  );
  tiffForm.append("originalFilename", TIFF_NAME);
  const tiffRes = await fetch(`${photosUrl}/api/photos`, { method: "POST", body: tiffForm });
  expect(tiffRes.status).toBe(201);
  const { image: tiffImage } = (await tiffRes.json()) as { image: { id: string } };
  const record = await eventually(() => findRecord(TIFF_NAME));
  expect(record.id).toBe(tiffImage.id);
  expect(record.type).toBe("tif");
  const tiffMeta = await eventually(async () => {
    const m = await imageMetadata(tiffImage.id);
    if (!m) throw new Error("EXIF metadata not written yet");
    return m;
  });
  expect(tiffMeta.camera_make).toBe("TestMake");
  expect(tiffMeta.camera_model).toBe("TestModel 3000");
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
  expect(thumb.type).toBe("jpg");
  expect(thumb.original_filename).toBe(`thumb_${PNG_NAME}`);

  // Shared semantics: another app with image access (Drive) sees the
  // thumbnail and its parent link — it's platform data, not photos-private.
  const drive = await driveCreds(ldsUrl());
  const driveView = (await listRecords(drive)) as unknown as SharedRecord[];
  expect(driveView.find((r) => r.id === thumb.id)?.parent_id).toBe(pngRecordId);
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
