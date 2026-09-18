/**
 * What survives taking Photos off a machine.
 *
 * This is verification steps 1 and 3 of
 * `starkeep/implementation-status-rendition-ownership-phase-1-2026-09-17.md`
 * §5, written as a suite so they are repeatable rather than performed by hand:
 * seed `image_enriched` with a known row count, uninstall Photos locally
 * keeping its data, reinstall, and confirm the count and the app-private files
 * come back unchanged; then drop this node's copy and confirm they do not.
 *
 * Core makes the same platform claims against its Probe fixture, and the halves
 * that need a cloud — that a node-local removal moves nothing on the other side
 * and that a reinstalled node refills from it — are asserted in core's Tier-1
 * over-the-wire suite and in the Tier-3 cloud journey, which runs against
 * Photos' own `image_enriched` table. What is here is the part that needs
 * Photos: the rows are captions written through Photos' UI, so a change to how
 * Photos stores them is a change this suite sees.
 *
 * Serial, and it resets the platform in `beforeAll` rather than inheriting
 * whatever the previous file left — `photos-platform.spec.ts` ends by
 * deliberately corrupting Photos' signing secret.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  installAppDirect,
  installAppViaAdmin,
  putAppFile,
  readAppFile,
  solidPng,
  startAppDaemonViaAdmin,
  stopAppDaemonViaAdmin,
  uninstallAppViaAdmin,
  type LdsApp,
} from "@starkeep/e2e";

test.describe.configure({ mode: "serial" });

const adminUrl = () => process.env.E2E_ADMIN_URL!;
const ldsUrl = () => process.env.E2E_LDS_URL!;

const PHOTOS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Three photos, three captions: a row count that a lost table cannot fake. */
const PHOTOS = ["removal-a.png", "removal-b.png", "removal-c.png"];
const CAPTION_FOR = (name: string) => `caption for ${name}`;
/** An app-private file, the other half of what §5 step 1 asks to survive. */
const PRIVATE_KEY = "removal/private.bin";
const PRIVATE_BYTES = "photos app-private bytes";

let fixturePaths: string[];
let photosUrl: string;
/** Photos' own identity against the local data server. Re-minted on reinstall. */
let photosApp: LdsApp;

function photosCard(page: Page): Locator {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText("Photos", { exact: true }) })
    .first();
}

/** Run one of a card's secondary actions; the menu renders in a portal. */
async function cardMenuAction(page: Page, card: Locator, label: string): Promise<void> {
  await card.getByRole("button", { name: /^More actions for / }).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
}

/** Stop Photos from the dashboard, which both removals require first. */
async function stopFromDashboard(page: Page, card: Locator): Promise<void> {
  const startButton = card.getByRole("button", { name: /^Start / });
  if (await startButton.isVisible().catch(() => false)) return;
  await cardMenuAction(page, card, "Stop");
  await expect(startButton).toBeVisible({ timeout: 60_000 });
}

/**
 * Photos' app-private rows, read through Photos' own signed identity.
 *
 * Counted rather than listed: §5 step 1 asks for a row count, and a count is
 * the assertion that fails when a retained table comes back half-populated —
 * a listing test that looked for one known caption would pass on a table
 * holding only that one.
 */
async function enrichedRows(): Promise<Array<Record<string, unknown>>> {
  // 500 is the query plane's `MAX_LIMIT`; asking for more is a 400, not a
  // clamp. This suite writes three rows, so one page is the whole table.
  const res = await photosApp.fetch("/app-data/db/image_enriched?limit=500");
  expect(res.status, `app-data read → ${res.status}: ${await res.clone().text()}`).toBe(200);
  const { rows } = (await res.json()) as { rows?: Array<Record<string, unknown>> };
  return rows ?? [];
}

/** Install Photos through the consent dialog, start it, and re-mint its creds. */
async function installAndStart(page: Page): Promise<void> {
  const card = photosCard(page);
  await card.getByRole("button", { name: /^Install / }).click();
  await page.getByRole("button", { name: "Approve & Install" }).click();
  await expect(card.getByText("Installed", { exact: true })).toBeVisible({ timeout: 60_000 });
  const { url } = await startAppDaemonViaAdmin(adminUrl(), "photos");
  photosUrl = url;
  photosApp = await installAppDirect(ldsUrl(), photosManifest());
}

/**
 * Photos' manifest, read from the file the app ships rather than restated here.
 * Re-posting it to the LDS returns an active app's existing secret, which is
 * the supported way to recover the identity an install just minted.
 */
function photosManifest(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(PHOTOS_DIR, "starkeep.manifest.json"), "utf-8"),
  ) as Record<string, unknown>;
}

async function captionPhoto(page: Page, altText: string, caption: string): Promise<void> {
  await page.getByAltText(altText).first().click({ timeout: 60_000 });
  await page.getByRole("button", { name: "Info" }).click();
  const field = page.getByPlaceholder("Add a caption…");
  await expect(field).toBeVisible();
  const saved = page.waitForResponse(
    (r) => r.url().includes("/api/photos/captions/") && r.request().method() === "PUT",
  );
  await field.fill(caption);
  await field.blur();
  expect((await saved).ok()).toBe(true);
  await page.keyboard.press("Escape");
}

test.beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "photos-removal-fixtures-"));
  fixturePaths = [];
  for (const [i, name] of PHOTOS.entries()) {
    const path = join(dir, name);
    // A distinct colour per file, so the platform's content-hash dedup does not
    // collapse three uploads into one record and one caption.
    await writeFile(path, solidPng([30 + i * 60, 90, 200 - i * 40], 8));
    fixturePaths.push(path);
  }

  // A known-clean start. `deleteData` is spelled out because an uninstall keeps
  // the tables now, and this suite's first assertion is a row count.
  await stopAppDaemonViaAdmin(adminUrl(), "photos").catch(() => {
    /* not running */
  });
  await uninstallAppViaAdmin(adminUrl(), "photos", { deleteData: true }).catch(() => {
    /* not installed */
  });
  await installAppViaAdmin(adminUrl(), "photos");
  const { url } = await startAppDaemonViaAdmin(adminUrl(), "photos");
  photosUrl = url;
  photosApp = await installAppDirect(ldsUrl(), photosManifest());
});

test("seed image_enriched with a known row count and an app-private file", async ({ page }) => {
  await page.goto(photosUrl);
  for (const [i, path] of fixturePaths.entries()) {
    await page.locator('input[type="file"]').first().setInputFiles(path);
    await expect(page.getByAltText(PHOTOS[i]!).first()).toBeVisible({ timeout: 60_000 });
  }
  for (const name of PHOTOS) {
    await captionPhoto(page, name, CAPTION_FOR(name));
  }

  const rows = await enrichedRows();
  expect(rows).toHaveLength(PHOTOS.length);
  expect(rows.map((r) => r.caption).sort()).toEqual(PHOTOS.map(CAPTION_FOR).sort());

  await putAppFile(photosApp, PRIVATE_KEY, PRIVATE_BYTES);
  expect(await readAppFile(photosApp, PRIVATE_KEY)).toBe(PRIVATE_BYTES);
});

test("uninstalling Photos keeps its captions and its app-private file", async ({ page }) => {
  await page.goto(adminUrl());
  const card = photosCard(page);
  await stopFromDashboard(page, card);

  await cardMenuAction(page, card, "Uninstall");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Uninstall Photos?")).toBeVisible();
  // Unticked when it opens: the operator who reads nothing keeps their photos'
  // captions. This is the assertion the whole default exists for.
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  await dialog.getByRole("button", { name: "Uninstall, keep data" }).click();
  await expect(card.getByRole("button", { name: /^Install / })).toBeVisible({
    timeout: 60_000,
  });
});

test("reinstalling reads back the same row count and the same file", async ({ page }) => {
  await page.goto(adminUrl());
  await installAndStart(page);

  const rows = await enrichedRows();
  expect(rows).toHaveLength(PHOTOS.length);
  expect(rows.map((r) => r.caption).sort()).toEqual(PHOTOS.map(CAPTION_FOR).sort());
  expect(await readAppFile(photosApp, PRIVATE_KEY)).toBe(PRIVATE_BYTES);

  // And Photos shows them: the rows are not merely present in the table, they
  // reach the UI that wrote them.
  await page.goto(photosUrl);
  await expect(page.getByAltText(PHOTOS[0]!).first()).toBeVisible({ timeout: 120_000 });
  await page.getByAltText(PHOTOS[0]!).first().click();
  await page.getByRole("button", { name: "Info" }).click();
  await expect(page.getByPlaceholder("Add a caption…")).toHaveValue(CAPTION_FOR(PHOTOS[0]!));
});

test("removing Photos from this node takes its captions and its file with them", async ({
  page,
}) => {
  await page.goto(adminUrl());
  const card = photosCard(page);
  await stopFromDashboard(page, card);

  await cardMenuAction(page, card, "Remove from this node…");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Remove Photos from this node?")).toBeVisible();
  // No choice to offer: this removal deletes this node's copy by definition.
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Remove from this node" }).click();
  await expect(card.getByRole("button", { name: /^Install / })).toBeVisible({
    timeout: 60_000,
  });

  await installAndStart(page);
  expect(await enrichedRows()).toHaveLength(0);
  expect(await readAppFile(photosApp, PRIVATE_KEY)).toBeNull();

  // The photos themselves are the user's, not Photos', and every removal leaves
  // them alone — so the reinstalled app still shows them, with no captions.
  await page.goto(photosUrl);
  await expect(page.getByAltText(PHOTOS[0]!).first()).toBeVisible({ timeout: 120_000 });
  await page.getByAltText(PHOTOS[0]!).first().click();
  await page.getByRole("button", { name: "Info" }).click();
  await expect(page.getByPlaceholder("Add a caption…")).toHaveValue("");
});

test.afterAll(async () => {
  await stopAppDaemonViaAdmin(adminUrl(), "photos").catch(() => {
    /* already stopped */
  });
});
