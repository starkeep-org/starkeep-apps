/**
 * Photos' tier-3 cloud journey.
 *
 * Runs the platform's own journey — bootstrap, cloud-data-server, Drive,
 * install, sync, the data plane, the session gate, CloudFront, uninstall —
 * against Photos rather than against a fixture, and adds the assertions that
 * are true of Photos and of nothing else: that the shipping app derives its
 * full rendition ladder, that every rung reaches the cloud carrying its label
 * and its dimensions, and that the cloud grid paints a rendition rather than
 * the original.
 *
 * The journey comes from `@starkeep/e2e-aws`, a `link:` dependency on the
 * sibling starkeep-core checkout — the same arrangement `@starkeep/e2e` uses at
 * tier 2. Core runs the identical journey against its own Probe fixture, so the
 * platform assertions hold in a deployment that has no Photos; what lives here
 * is what needs Photos to be true.
 *
 * The ladder definitions are ordinary imports rather than files read out of
 * another checkout. That is the point of the split: the expectation moves with
 * a respec because it *is* the app's own definition, and core never has to know
 * what a rung is called.
 */

import { it, expect } from "vitest";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chromium,
  defineCloudJourney,
  signInWithBrowser,
  watchPageProblems,
  type JourneyApp,
  type JourneyContext,
} from "@starkeep/e2e-aws";
import {
  createRecordWithBytes,
  eventually,
  solidPng,
  startNextDev,
  type LdsApp,
  type NextDevServer,
} from "@starkeep/e2e";
import { applicableStillClasses, STILL_LADDER } from "../src/photos-lib/ladder";
import {
  RENDITION_LABEL_REF,
  renditionFileName,
} from "../src/photos-lib/image-processing/publish-renditions";

const PHOTOS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Refuse to start when the operator is already running Photos.
 *
 * Next 16 allows one dev server per app directory and holds the claim in
 * `.next/dev/lock`; a second one exits immediately with "Another next dev server
 * is already running". The ladder step boots Photos out of this very checkout,
 * so a dev server left running from ordinary development takes that step down —
 * fifteen minutes and one Pulumi-provisioned cloud stack into the run, which is
 * the most expensive possible moment to learn it.
 *
 * The lock outlives a crashed server, so the pid is probed rather than trusted:
 * signal 0 delivers nothing and only reports whether the process exists.
 */
function assertNoPhotosDevServer(): void {
  const lockPath = join(PHOTOS_DIR, ".next", "dev", "lock");
  if (!existsSync(lockPath)) return;
  let lock: { pid?: number; appUrl?: string };
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf-8")) as {
      pid?: number;
      appUrl?: string;
    };
  } catch {
    return; // Unreadable or half-written: no claim this can act on.
  }
  if (!lock.pid) return;
  try {
    process.kill(lock.pid, 0);
  } catch {
    return; // Stale lock from a server that is gone.
  }
  throw new Error(
    `A Photos dev server is already running (pid ${lock.pid}${
      lock.appUrl ? `, ${lock.appUrl}` : ""
    }). Next allows one per app directory, and this journey boots Photos out of ` +
      `that same directory to derive a rendition ladder. Stop it (kill ${lock.pid}) ` +
      "and re-run.",
  );
}

/** A rendition child as the rendition steps read it back. */
interface RungRecord {
  id: string;
  parent_id: string | null;
  original_filename: string | null;
  object_storage_key: string | null;
  metadata?: { width?: number | null; height?: number | null } | null;
  labels?: Array<{
    app_id: string;
    key: string;
    value: string | null;
    label: string;
  }>;
}

/**
 * A record's `photos/rendition` children, with their labels and their
 * dimensions, from whichever data plane is asked.
 *
 * `parentId` + `label` is one indexed lookup, and it is the same query Photos
 * itself issues to decide what is left to derive — so the assertions read the
 * library the way the app does rather than through a shape invented for a test.
 */
async function renditionChildren(
  app: LdsApp,
  parentId: string,
): Promise<RungRecord[]> {
  const res = await app.fetch(
    `/data/records?parentId=${encodeURIComponent(parentId)}` +
      `&label=${encodeURIComponent(RENDITION_LABEL_REF)}` +
      `&include=labels,metadata&limit=50`,
  );
  if (!res.ok) {
    throw new Error(
      `rendition children of ${parentId} → ${res.status} ${await res.text()}`,
    );
  }
  return ((await res.json()) as { records: RungRecord[] }).records;
}

/** Which rung of the ladder a child is — the `photos/rendition` label's value. */
function renditionClassOf(rung: RungRecord): string {
  return (
    (rung.labels ?? []).find((l) => l.label === RENDITION_LABEL_REF)?.value ??
    ""
  );
}

/** A record's bytes, through the data plane's own file-url. */
async function readRecordBytes(app: LdsApp, recordId: string): Promise<Buffer> {
  const urlRes = await app.fetch(`/data/records/${recordId}/file-url`);
  if (!urlRes.ok) {
    throw new Error(
      `file-url for ${recordId} → ${urlRes.status} ${await urlRes.text()}`,
    );
  }
  const { url } = (await urlRes.json()) as { url: string };
  const blob = await fetch(url);
  if (!blob.ok) throw new Error(`bytes for ${recordId} → ${blob.status}`);
  return Buffer.from(await blob.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Photos' own steps
// ---------------------------------------------------------------------------

/**
 * The Photos app running locally against this run's data server. Booted by the
 * ladder step and stopped as soon as its ladder has synced, so no later step
 * runs against a background sweeper.
 */
let photosLocal: NextDevServer | undefined;
/** The original whose ladder the rendition steps derive, sync and read back. */
let ladderRecordId: string;
let ladderSourceName: string;
/** The rungs that apply to it, as Photos' own ladder answers the question. */
let ladderClasses: string[];
/** Its object key, so a tile serving the original is distinguishable from a rung. */
let ladderOriginalKey: string;
/** Size class → the object key the rung arrived in the cloud under. */
const syncedRungKeys = new Map<string, string>();

function photosSteps(ctx: JourneyContext): void {
  it("derives a full rendition ladder locally, through the real Photos app", async () => {
    // The half of the rendition path nothing else reaches. Every other photo in
    // this journey is a flat record created by a test helper: no children, no
    // `photos/rendition` labels, no dimensions — the three properties whose
    // absence caused the 2026-08-27 rendition-invisibility bug. Here the
    // shipping app derives its own ladder, on this machine, from an original
    // this suite put in front of it.
    const photos = ctx.localApp();
    const top = STILL_LADDER[STILL_LADDER.length - 1]!;
    // Above the top rung, so every rung applies and what is under test is the
    // whole ladder rather than whichever prefix a small fixture reaches.
    const sourceLongEdge = top.maxLongEdge + 200;
    // Unique per run: the cloud is kept up between runs and dedupes by content
    // hash.
    ladderSourceName = `e2e-ladder-${Date.now()}.png`;

    // What admin-web writes at local install, and what this suite has no
    // admin-web to write. `cli-install-app` mirrors the registry secret into
    // this same file (see reconcileLocalCredsFile) but leaves `dataServerUrl`
    // unset, and @starkeep/app-client then falls back to the production port
    // 9820 — a daemon this run does not own and must never touch.
    const credsPath = join(ctx.dataDir(), "app-creds", "photos.json");
    mkdirSync(dirname(credsPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      credsPath,
      JSON.stringify(
        {
          appId: photos.appId,
          hmacSecret: photos.hmacSecret,
          dataServerUrl: ctx.ldsUrl(),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    // The derivation worker is a separately bundled `worker_threads` entry
    // point reached only by absolute path, and the manifest's `pnpm dev` builds
    // it before starting Next. Booting Next directly — which is what gives this
    // suite log capture and a killable process group — means building it here.
    const built = spawnSync("pnpm", ["derive:build-worker"], {
      cwd: PHOTOS_DIR,
      stdio: "inherit",
      env: { ...process.env },
    });
    if (built.status !== 0) {
      throw new Error(
        `pnpm derive:build-worker exited with code ${built.status}`,
      );
    }

    // Booting the real app is what starts `instrumentation.register`, and with
    // it the ingest watch and the boot sweep — the derivation worker and the
    // sweep controller, running as they do on an operator's machine rather than
    // as a fixture. NODE_ENV is set explicitly because vitest sets it to `test`,
    // which Next warns about and overrides anyway.
    photosLocal = await startNextDev({
      appDir: PHOTOS_DIR,
      env: {
        STARKEEP_DIR: ctx.dataDir(),
        STARKEEP_LOCAL_DATA_SERVER_URL: ctx.ldsUrl(),
        NODE_ENV: "development",
      },
      // A cold `next dev` compile of this app is the slowest thing in the step,
      // and it is paid once per run on a machine that is also running a
      // Pulumi-provisioned cloud stack.
      startTimeoutMs: 5 * 60 * 1000,
    });

    const { record } = await createRecordWithBytes(photos, {
      bytes: solidPng(
        [...randomBytes(3)] as [number, number, number],
        sourceLongEdge,
      ),
      fileName: ladderSourceName,
    });
    ladderRecordId = record.id;
    ladderOriginalKey = record.object_storage_key as string;
    expect(
      ladderOriginalKey,
      "the original must have landed in object storage",
    ).toBeTruthy();

    // Omitting `targetLongEdge` asks for the whole applicable ladder, which is
    // what a bulk sweep wants. Driven explicitly rather than waited for: the
    // boot sweep reaches this record on its own, but *when* is a timing question
    // and the ladder is not. Both paths run `derive-and-publish`, and a rung
    // published twice dedupes on its content hash, so the two cannot race into
    // two children for one rung.
    const resize = await fetch(`${photosLocal.url}/api/resize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetId: ladderRecordId }),
      // Five rungs off a source above the ladder's top: minutes, not seconds.
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    const resizeBody = await resize.text();
    expect(
      resize.status,
      `local /api/resize answered ${resize.status}: ${resizeBody}`,
    ).toBe(200);

    // Asserted on the resulting ladder rather than on what this call published,
    // because the sweep may have published a rung first and a `published: []`
    // response would then be correct rather than a failure.
    ladderClasses = applicableStillClasses(sourceLongEdge).map(
      (spec) => spec.sizeClass,
    );
    const rungs = await eventually(
      async () => {
        const found = await renditionChildren(photos, ladderRecordId);
        if (found.length < ladderClasses.length) {
          throw new Error(
            `${found.length} of ${ladderClasses.length} rungs published so far ` +
              `(${found.map(renditionClassOf).join(", ") || "none"})`,
          );
        }
        return found;
      },
      { timeoutMs: 5 * 60 * 1000, intervalMs: 2_000 },
    );
    // One child per applicable rung and nothing more. Two callers derive this
    // record at once — the boot sweep and the call above — and the property
    // keeping that from producing two children per rung is content-hash dedup on
    // identical bytes, which nothing else in this suite exercises.
    expect(rungs).toHaveLength(ladderClasses.length);

    const byClass = new Map(
      rungs.map((rung) => [renditionClassOf(rung), rung]),
    );
    expect([...byClass.keys()].sort()).toEqual([...ladderClasses].sort());
    for (const [sizeClass, rung] of byClass) {
      // Dimensions are the property the cloud drops a candidate for. They ride
      // the record's create call precisely so no sync round can see the rung
      // without them; asserting them here is what makes the cloud assertion in
      // the next step meaningful rather than vacuous.
      expect(
        rung.metadata?.width ?? 0,
        `${sizeClass} has no width`,
      ).toBeGreaterThan(0);
      expect(
        rung.metadata?.height ?? 0,
        `${sizeClass} has no height`,
      ).toBeGreaterThan(0);
      expect(rung.parent_id).toBe(ladderRecordId);
      expect(rung.original_filename).toBe(
        renditionFileName(ladderSourceName, sizeClass),
      );
    }
  });

  it("syncs the ladder up: every rung reaches the cloud with its label and its dimensions", async () => {
    // The join nothing else crosses. Each layer below is covered on its own —
    // the worker builds a ladder against a fake data plane, two local data
    // servers exchange rendition dimensions against a fake cloud — and the
    // failure of 2026-08-27 lived in none of them. It lived here, where a rung
    // that arrived without dimensions was dropped as an unorderable candidate
    // and the original reported having no renditions at all.
    const photos = ctx.localApp();
    const cloudPhotos = ctx.cloudApp();
    const drive = ctx.drive();
    const expected = ladderClasses.length;
    const localChildren = await renditionChildren(photos, ladderRecordId);
    expect(localChildren, "the local ladder must still be intact").toHaveLength(
      expected,
    );

    // A minute, not ten. The rungs are already derived and already local by the
    // time this runs, so what is left is one sync round shipping five small
    // records — measured at about five seconds. Ten minutes of headroom on a
    // five-second operation does not buy reliability; it buys a ten-minute
    // stall before you learn anything, and the thing it is most likely to be
    // waiting on is a failure that will never resolve.
    let arrived: RungRecord[];
    try {
      arrived = await eventually(
        async () => {
          const sync = await drive.fetch("/sync/now", { method: "POST" });
          expect(sync.status).toBe(200);
          const res = await cloudPhotos.fetch(
            `/data/records?parentId=${encodeURIComponent(ladderRecordId)}` +
              `&label=${encodeURIComponent(RENDITION_LABEL_REF)}` +
              `&include=labels,metadata&limit=50`,
          );
          expect(res.status).toBe(200);
          const { records } = (await res.json()) as { records: RungRecord[] };
          if (records.length < expected) {
            throw new Error(`${records.length} of ${expected} rungs have reached the cloud`);
          }
          return records;
        },
        { timeoutMs: 60_000, intervalMs: 2_000 },
      );
    } catch (err) {
      // The supervisor swallows a per-engine exchange failure into a logged
      // `lastError` and still answers /sync/now with 200 and shipped: 0, so the
      // responses above cannot tell "nothing to ship" from "every round threw".
      // Without these lines the step fails as a bare timeout saying only that
      // rows did not arrive — which is what it did, once, with nothing to say
      // why. The ship step earlier in the journey has carried this same
      // diagnostic for exactly this reason.
      const syncLines = ctx
        .ldsLogs()
        .split("\n")
        .filter((l) => /\[sync|sync\]|exchange|drive|residency/i.test(l));
      console.error(
        `[photos-tier3] the ladder did not reach the cloud. LDS sync log:\n${
          syncLines.length > 0 ? syncLines.join("\n") : "(no sync lines logged)"
        }`,
      );
      // What the app was doing meanwhile: a background sweep still deriving is
      // one legitimate reason a round ships nothing yet.
      const appLog = (photosLocal?.logs() ?? "").split("\n").slice(-40).join("\n");
      console.error(`[photos-tier3] last 40 lines of the Photos dev server:\n${appLog}`);
      // And what the local side actually holds, which separates "sync did not
      // carry them" from "they were never there to carry".
      const stillLocal = await renditionChildren(photos, ladderRecordId);
      console.error(
        `[photos-tier3] locally the parent has ${stillLocal.length} rendition children ` +
          `(${stillLocal.map(renditionClassOf).join(", ") || "none"}).`,
      );
      throw err;
    }
    expect(arrived).toHaveLength(expected);

    for (const rung of arrived) {
      const sizeClass = renditionClassOf(rung);
      expect(
        sizeClass,
        `a synced rung carries no ${RENDITION_LABEL_REF} value`,
      ).toBeTruthy();
      expect(
        rung.metadata?.width ?? 0,
        `${sizeClass} arrived with no width`,
      ).toBeGreaterThan(0);
      expect(
        rung.metadata?.height ?? 0,
        `${sizeClass} arrived with no height`,
      ).toBeGreaterThan(0);
      syncedRungKeys.set(sizeClass, rung.object_storage_key as string);
    }
    expect([...syncedRungKeys.keys()].sort()).toEqual(
      [...ladderClasses].sort(),
    );

    // The assertion the 2026-08-27 failure would fail. `variant=<label>` with no
    // `variantLongEdge` asks the unnarrowed question — every derived child of
    // this record — and the broker silently drops any candidate with no stored
    // dimensions, so a record whose rungs all arrived dimensionless answers with
    // an empty list that reads as "nothing derived yet". This is also the exact
    // query the Photos client issues to paint a tile.
    const resolvedRes = await cloudPhotos.fetch(
      `/data/records?ids=${encodeURIComponent(ladderRecordId)}` +
        `&include=metadata&variant=${encodeURIComponent(RENDITION_LABEL_REF)}`,
    );
    expect(resolvedRes.status).toBe(200);
    const { records: parents } = (await resolvedRes.json()) as {
      records: Array<{
        id: string;
        variant_candidates?: Array<{ id: string; long_edge: number }>;
      }>;
    };
    const parent = parents.find((r) => r.id === ladderRecordId);
    expect(parent, "the original must be readable in the cloud").toBeDefined();
    expect(
      parent!.variant_candidates?.length ?? 0,
      "the broker resolved fewer candidates than the rungs that arrived — a rung " +
        "reaching the cloud without dimensions is dropped here and nowhere else",
    ).toBe(expected);

    // The bytes shipped too, not just the row. Every other byte round-trip in
    // this journey fetches an original; this is the only one that fetches a
    // rendition, through the same CloudFront-signed file-url a client uses. The
    // bottom rung, chosen by name rather than by iteration order so a failure
    // names the same rung on every run.
    const [sizeClass, cloudKey] = [...syncedRungKeys.entries()].sort(
      ([a], [b]) => a.localeCompare(b),
    )[0]!;
    const rung = localChildren.find((r) => renditionClassOf(r) === sizeClass)!;
    expect(
      rung.object_storage_key,
      "content-addressed keys must match across nodes",
    ).toBe(cloudKey);
    const localBytes = await readRecordBytes(photos, rung.id);
    const cloudBytes = await readRecordBytes(cloudPhotos, rung.id);
    expect(
      cloudBytes.equals(localBytes),
      `${sizeClass} differs between the cloud (${cloudBytes.byteLength} bytes) and ` +
        `this node (${localBytes.byteLength} bytes)`,
    ).toBe(true);

    // Stopped here rather than at the end: everything after this step reads a
    // library that must stop changing, and a background sweeper deriving the
    // browser's upload mid-assertion is a hard failure to read.
    await photosLocal?.stop();
    photosLocal = undefined;
  });

  it("the cloud grid paints a synced rendition, not the original", async () => {
    // The consumption half, and the one the platform's browser step cannot
    // reach: that step watches a photo the browser itself just uploaded, so it
    // proves the upload path renders something and would pass while every tile
    // served a full-size original.
    //
    // This one uploads nothing. It loads the grid over a library synced down
    // from the cloud and reads what a tile actually resolved to. The trap is
    // real rather than theoretical: the source is well under the grid's
    // direct-serve ceiling, so a record whose renditions never resolved paints
    // the original and looks correct to a human and to an alt-text locator.
    expect(
      syncedRungKeys.size,
      "the ladder steps must have run first",
    ).toBeGreaterThan(0);
    const config = ctx.config();
    const appUrl = `${config.publicBaseUrl}/apps/photos/`;
    // A CloudFront signed URL's path is the object key itself — the signature
    // rides the query string — so what a tile resolved to is readable straight
    // off its `src`.
    const rungPaths = new Set(
      [...syncedRungKeys.values()].map((key) => `/${key}`),
    );

    const browser = await chromium.launch();
    let problemReport: () => string = () => "";
    try {
      const page = await browser.newPage();
      problemReport = watchPageProblems(page);
      const admin = ctx.adminCredentials();
      // "Upload Photo", not "Add Photo": in the cloud the app runs FORCE_REMOTE
      // (Cognito-gated), and the local non-remote build is the one that reads
      // "Add Photo" (see app.tsx).
      await signInWithBrowser({
        page,
        appUrl,
        email: admin.email,
        password: admin.password,
        signedInControl: "Upload Photo",
        problemReport,
      });

      // The grid groups by day and shows the newest day first, and this photo
      // carries no EXIF capture time, so it files under today alongside the
      // browser upload — on screen, and therefore asked for.
      const tile = page.getByAltText(ladderSourceName).first();
      await tile.waitFor({ state: "visible", timeout: 120_000 });

      // Polled rather than read once. A tile paints its ThumbHash, then the
      // record's own bytes if they are small enough, and swaps to a rendition
      // when resolution answers — so the first `src` is legitimately the
      // original. What is under test is where it settles.
      const settled = await eventually(
        async () => {
          const src = (await tile.getAttribute("src")) ?? "";
          const path = src.startsWith("http") ? new URL(src).pathname : src;
          if (!rungPaths.has(path)) {
            throw new Error(
              `the tile is serving ${path || "(no src)"}, which is ` +
                (path === `/${ladderOriginalKey}`
                  ? "the ORIGINAL — the cloud resolved no rendition for this record"
                  : "not one of the rungs this run synced up"),
            );
          }
          return path;
        },
        { timeoutMs: 90_000, intervalMs: 1_000 },
      );

      // Said the other way round as well, because "is a rung" and "is not the
      // original" fail differently: the first catches a tile resolving to some
      // other record's bytes, the second catches the fallback path.
      expect(settled).not.toBe(`/${ladderOriginalKey}`);
    } catch (err) {
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}${problemReport()}`,
        {
          cause: err,
        },
      );
    } finally {
      await browser.close();
    }
  });
}

const photosApp: JourneyApp = {
  appId: "photos",
  appDir: PHOTOS_DIR,
  // Both keys Photos declares in its manifest. Deliberately not `rendition`,
  // the size-class key: setting it on the journey's record would make the app
  // read that original as its own rendition.
  labelKeys: { flag: "crop", valued: "faces" },
  appTable: {
    name: "image_enriched",
    row: (recordId) => ({ record_id: recordId, caption: "tier-3 caption" }),
    expectInBody: "tier-3 caption",
  },
  jwtRoute: {
    path: "/api/resize",
    method: "POST",
    // The handler takes { targetId } and resizes to its own fixed max width;
    // there is no caller-supplied width.
    body: (recordId) => ({ targetId: recordId }),
  },
  browser: { signedInControl: "Upload Photo" },
  preflight: assertNoPhotosDevServer,
  extraSteps: photosSteps,
};

// The run state lands in this checkout, not core's: it holds this run's Cognito
// admin password and its registry database.
defineCloudJourney(photosApp, { runStateDir: resolve(PHOTOS_DIR, "e2e-aws") });
