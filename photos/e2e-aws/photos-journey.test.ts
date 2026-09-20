/**
 * Photos' tier-3 cloud journey.
 *
 * Runs the platform's own journey — bootstrap, cloud-data-server, Drive,
 * install, sync, the data plane, the session gate, CloudFront, uninstall —
 * against Photos rather than against a fixture, and adds the assertions that
 * are true of Photos and of nothing else: that the shipping app derives its
 * full rendition ladder, that every rung reaches the cloud as a row in Photos'
 * own table with its dimensions, and that the cloud grid paints a rendition
 * rather than the original.
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

import { it, expect, afterAll } from "vitest";
import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
  startWebServer,
  type LdsApp,
  type WebServer,
} from "@starkeep/e2e";
import {
  applicableStillClasses,
  CHEAP_TARGET_LONG_EDGE,
  renditionSubKey,
  STILL_LADDER,
  type RenditionRow,
} from "../src/photos-lib/ladder";
import { fetchPublishedRenditions } from "../src/photos-lib/renditions/acquire";
import { publishRendition } from "../src/photos-lib/image-processing/publish-renditions";

const PHOTOS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Refuse to start when the operator is already running Photos out of this
 * checkout.
 *
 * The previous framework enforced one dev server per app directory itself and
 * held the claim in a lock file of its own, which is what this used to read. A
 * Node server has no such lock and would start happily — but the ladder step below
 * boots Photos out of this very checkout and drives it, and a second server
 * sharing the same `dist/`, the same `.derivation/` worker bundle and the same
 * sweep state is a race whose failures land fifteen minutes and one
 * Pulumi-provisioned cloud stack into the run.
 *
 * So the claim is made on the build directory instead: `dist/` is what both
 * servers would serve and what a running `pnpm dev` rewrites underneath them.
 * A lock file of this suite's own, holding the pid, probed with signal 0 rather
 * than trusted — signal 0 delivers nothing and only reports whether the process
 * exists, so a lock left behind by a crash does not block a run.
 */
const PHOTOS_LOCK = join(PHOTOS_DIR, ".e2e-photos.lock");

function assertNoPhotosDevServer(): void {
  if (!existsSync(PHOTOS_LOCK)) return;
  let lock: { pid?: number; appUrl?: string };
  try {
    lock = JSON.parse(readFileSync(PHOTOS_LOCK, "utf-8")) as {
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
    `A Photos server started by this suite is already running (pid ${lock.pid}${
      lock.appUrl ? `, ${lock.appUrl}` : ""
    }). This journey boots Photos out of that same directory to derive a ` +
      `rendition ladder, and two servers sharing one dist/ race. Stop it ` +
      `(kill ${lock.pid}) and re-run.`,
  );
}

/**
 * A record's rungs, read out of Photos' own table on whichever node is asked.
 *
 * Not a query against `/data/records` any more: a rung stopped being a shared
 * child record in phase 3 of the rendition-ownership plan, because five derived
 * copies of every photograph in a plane every app reads is a library Drive
 * lists at five times its size. The primary key is `(parent_record_id,
 * size_class)`, so this is one indexed lookup and the same one Photos itself
 * issues to decide what is left to derive.
 */
async function renditionRows(app: LdsApp, parentId: string): Promise<RenditionRow[]> {
  const res = await app.fetch(
    `/app-data/db/renditions?where=${encodeURIComponent(
      JSON.stringify({ parent_record_id: parentId }),
    )}&limit=500`,
  );
  if (!res.ok) {
    throw new Error(`rendition rows of ${parentId} → ${res.status} ${await res.text()}`);
  }
  return ((await res.json()) as { rows: RenditionRow[] }).rows;
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

/**
 * Whether this node holds a rung's bytes, as the app's own residency page says.
 *
 * Asked of the paged listing rather than of the targeted lookup because that is
 * the surface Photos' acquisition pass reads, and a rung that vanished from it
 * would leave the pass unable to see what it holds.
 */
async function residentHere(app: LdsApp, subKey: string): Promise<boolean> {
  let cursor: string | null = null;
  do {
    const res = await app.fetch(
      `/app-data/residency${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    if (!res.ok) throw new Error(`residency → ${res.status} ${await res.text()}`);
    const page = (await res.json()) as {
      entries: Array<{ subKey: string; resident: boolean }>;
      nextCursor: string | null;
    };
    const entry = page.entries.find((e) => e.subKey === subKey);
    if (entry) return entry.resident;
    cursor = page.nextCursor;
  } while (cursor);
  throw new Error(`${subKey} is in no residency page`);
}

/** A rendition's bytes, through the app-private file plane that now holds them. */
async function readRenditionBytes(app: LdsApp, subKey: string): Promise<Buffer> {
  const urlRes = await app.fetch(`/app-data/files/${subKey}`);
  if (!urlRes.ok) {
    throw new Error(`app-file url for ${subKey} → ${urlRes.status} ${await urlRes.text()}`);
  }
  const { url } = (await urlRes.json()) as { url: string };
  const blob = await fetch(url);
  if (!blob.ok) throw new Error(`bytes for ${subKey} → ${blob.status}`);
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
let photosLocal: WebServer | undefined;
/** The original whose ladder the rendition steps derive, sync and read back. */
let ladderRecordId: string;
let ladderSourceName: string;
/** The rungs that apply to it, as Photos' own ladder answers the question. */
let ladderClasses: string[];
/** Its object key, so a tile serving the original is distinguishable from a rung. */
let ladderOriginalKey: string;
/** Size class → the app-private sub-key the rung arrived in the cloud under. */
const syncedRungKeys = new Map<string, string>();

function photosSteps(ctx: JourneyContext): void {
  // The ladder-sync step stops the server on its way out, because everything
  // after it reads a library that must stop changing. This is the net for every
  // path that does not reach that line.
  //
  // Without it a step failing between the boot and that stop leaves a server
  // holding this app's directory, and the *next* run refuses to start —
  // correctly, but for a reason that has nothing to do with what it was asked
  // to test. That is not hypothetical: it happened, and cost a run.
  afterAll(async () => {
    await photosLocal?.stop();
    photosLocal = undefined;
    rmSync(PHOTOS_LOCK, { force: true });
  });

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
    // as a fixture.
    photosLocal = await startWebServer({
      appDir: PHOTOS_DIR,
      command: "pnpm",
      args: ["start"],
      portFlag: "-p",
      env: {
        STARKEEP_DIR: ctx.dataDir(),
        STARKEEP_LOCAL_DATA_SERVER_URL: ctx.ldsUrl(),
      },
      // `pnpm start` builds both worker bundles and, if `dist/` is missing,
      // the browser half — the same steps a fresh local install pays. No
      // on-demand compilation any more, but the ladder step still boots this
      // on a machine that is also running a Pulumi-provisioned cloud stack.
      startTimeoutMs: 5 * 60 * 1000,
    });
    // The claim `assertNoPhotosDevServer` reads. Written here rather than by
    // the harness, because it is this suite's rule: one server per checkout,
    // for as long as this run is driving one.
    writeFileSync(
      PHOTOS_LOCK,
      JSON.stringify({ pid: photosLocal.child.pid, appUrl: photosLocal.url }),
    );

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
        const found = await renditionRows(photos, ladderRecordId);
        if (found.length < ladderClasses.length) {
          throw new Error(
            `${found.length} of ${ladderClasses.length} rungs published so far ` +
              `(${found.map((r) => r.size_class).join(", ") || "none"})`,
          );
        }
        return found;
      },
      { timeoutMs: 5 * 60 * 1000, intervalMs: 2_000 },
    );
    // One row per applicable rung and nothing more. Two callers derive this
    // record at once — the boot sweep and the call above — and what keeps that
    // from producing two rungs is the table's primary key, which makes the
    // second write an upsert against the first.
    expect(rungs).toHaveLength(ladderClasses.length);

    const byClass = new Map(rungs.map((rung) => [rung.size_class, rung]));
    expect([...byClass.keys()].sort()).toEqual([...ladderClasses].sort());
    for (const [sizeClass, rung] of byClass) {
      // Dimensions are columns of the row, written with it. A rung with no
      // dimensions cannot be ordered by long edge and is therefore invisible to
      // resolution — which is what the 2026-08-27 failure was — and as not-null
      // columns that state is no longer representable.
      expect(rung.width, `${sizeClass} has no width`).toBeGreaterThan(0);
      expect(rung.height, `${sizeClass} has no height`).toBeGreaterThan(0);
      // The key carries the content hash, which is what lets two nodes that
      // encoded one rung differently both write without overwriting each other.
      expect(rung.sub_key).toBe(
        renditionSubKey(ladderRecordId, sizeClass, rung.content_hash, rung.content_type),
      );
    }

    // The claim the move was made for. Drive lists what the user put in — one
    // photograph — rather than the photograph plus five derived copies of it.
    const drive = ctx.drive();
    const driveChildren = await drive.fetch(
      `/data/records?where=${encodeURIComponent(JSON.stringify({ parent_id: ladderRecordId }))}` +
        `&include=labels&limit=50`,
    );
    expect(driveChildren.status).toBe(200);
    const { records: seenByDrive } = (await driveChildren.json()) as {
      records: Array<{ id: string }>;
    };
    expect(seenByDrive).toEqual([]);
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
    const localRows = await renditionRows(photos, ladderRecordId);
    expect(localRows, "the local ladder must still be intact").toHaveLength(expected);

    // A minute, not ten. The rungs are already derived and already local by the
    // time this runs, so what is left is one sync round shipping five small
    // records — measured at about five seconds. Ten minutes of headroom on a
    // five-second operation does not buy reliability; it buys a ten-minute
    // stall before you learn anything, and the thing it is most likely to be
    // waiting on is a failure that will never resolve.
    let arrived: RenditionRow[];
    try {
      arrived = await eventually(
        async () => {
          const sync = await drive.fetch("/sync/now", { method: "POST" });
          expect(sync.status).toBe(200);
          const rows = await renditionRows(cloudPhotos, ladderRecordId);
          if (rows.length < expected) {
            throw new Error(`${rows.length} of ${expected} rungs have reached the cloud`);
          }
          return rows;
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
      const stillLocal = await renditionRows(photos, ladderRecordId);
      console.error(
        `[photos-tier3] locally the parent has ${stillLocal.length} rendition rows ` +
          `(${stillLocal.map((r) => r.size_class).join(", ") || "none"}).`,
      );
      throw err;
    }
    expect(arrived).toHaveLength(expected);

    for (const rung of arrived) {
      expect(rung.size_class, "a synced rung names no rung").toBeTruthy();
      expect(rung.width, `${rung.size_class} arrived with no width`).toBeGreaterThan(0);
      expect(rung.height, `${rung.size_class} arrived with no height`).toBeGreaterThan(0);
      syncedRungKeys.set(rung.size_class, rung.sub_key);
    }
    expect([...syncedRungKeys.keys()].sort()).toEqual(
      [...ladderClasses].sort(),
    );

    // Nothing about a rung reaches the shared plane any more, so the assertion
    // that used to read the broker's variant resolution reads the absence of
    // the thing it resolved over. A rung that still arrived as a shared child
    // would be exactly the regression phase 3 exists to prevent.
    const cloudChildren = await cloudPhotos.fetch(
      `/data/records?where=${encodeURIComponent(JSON.stringify({ parent_id: ladderRecordId }))}` +
        `&include=labels&limit=50`,
    );
    expect(cloudChildren.status).toBe(200);
    const { records: cloudSeen } = (await cloudChildren.json()) as {
      records: Array<{ id: string }>;
    };
    expect(
      cloudSeen,
      "a rung reached the cloud as a shared child record, which phase 3 removed",
    ).toEqual([]);

    // The bytes shipped too, not just the row. Every other byte round-trip in
    // this journey fetches an original; this is the only one that fetches a
    // rendition, through the same CloudFront-signed file-url a client uses. The
    // bottom rung, chosen by name rather than by iteration order so a failure
    // names the same rung on every run.
    const [sizeClass, cloudSubKey] = [...syncedRungKeys.entries()].sort(
      ([a], [b]) => a.localeCompare(b),
    )[0]!;
    const rung = localRows.find((r) => r.size_class === sizeClass)!;
    expect(
      rung.sub_key,
      "a rung's key is content-addressed and must match across nodes",
    ).toBe(cloudSubKey);
    const localBytes = await readRenditionBytes(photos, rung.sub_key);
    const cloudBytes = await readRenditionBytes(cloudPhotos, cloudSubKey);
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
    // A rendition's bytes live under `apps/photos/syncable/<sub key>`, and a
    // signed URL's path is the object key, so a tile's `src` is matched by
    // suffix rather than by an exact path this test would have to reconstruct.
    const rungSubKeys = [...syncedRungKeys.values()];

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
          if (!rungSubKeys.some((subKey) => path.endsWith(subKey))) {
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

  it("brings a dropped rung back by acquisition, and only the rung that was asked for", async () => {
    // Phase 5's repair rule at tier 3. Every layer below runs against a stub:
    // the acquisition pass against a fake residency page, the app plane against
    // a loopback server. What only a real deployment proves is that the rung
    // another node published comes back out of S3 under the same key, by the
    // route Photos actually takes, with the published row untouched.
    //
    // Two rungs are dropped and one is asked for. The sweep used to ask for
    // every absent rung it could see, which turned a thumbnail request into a
    // download of the library's large rungs; the pair is what makes "only the
    // one" an assertion rather than a coincidence.
    const photos = ctx.localApp();
    const before = await renditionRows(photos, ladderRecordId);
    expect(before.length, "the ladder steps must have run first").toBeGreaterThan(1);
    const byEdge = [...before].sort(
      (a, b) => Math.max(a.width, a.height) - Math.max(b.width, b.height),
    );
    const wanted = byEdge[0]!;
    const untouched = byEdge[1]!;
    const wantedBytes = await readRenditionBytes(photos, wanted.sub_key);

    for (const rung of [wanted, untouched]) {
      const dropped = await photos.fetch(`/app-data/files/${rung.sub_key}/blob`, {
        method: "DELETE",
      });
      expect(dropped.status, `dropping ${rung.size_class} answered ${dropped.status}`).toBe(200);
      expect(await dropped.json()).toMatchObject({ dropped: true });
    }
    // The file survives its bytes, which is what makes this acquisition rather
    // than re-derivation: the row still names the object to go and get.
    const dropped = await renditionRows(photos, ladderRecordId);
    expect(dropped.map((r) => r.sub_key).sort()).toEqual(before.map((r) => r.sub_key).sort());
    expect(await residentHere(photos, wanted.sub_key)).toBe(false);

    const fetched = await fetchPublishedRenditions(
      (path, init) => photos.fetch(path, init),
      [wanted.sub_key],
    );
    expect(fetched).toEqual([wanted.sub_key]);
    expect(await residentHere(photos, wanted.sub_key)).toBe(true);
    expect(
      await residentHere(photos, untouched.sub_key),
      "a request for one rung downloaded another",
    ).toBe(false);

    // The same bytes under the same name. A node that had re-derived instead
    // would have written a different content hash under a different key, which
    // is exactly what the rendition table's primary key cannot express twice.
    const back = await readRenditionBytes(photos, wanted.sub_key);
    expect(back.equals(wantedBytes)).toBe(true);
    const after = await renditionRows(photos, ladderRecordId);
    expect(after.map((r) => `${r.size_class}:${r.content_hash}`).sort()).toEqual(
      before.map((r) => `${r.size_class}:${r.content_hash}`).sort(),
    );

    // Put the other one back, so a later step reads the library the ladder
    // steps left rather than one this step half-emptied.
    await fetchPublishedRenditions((path, init) => photos.fetch(path, init), [untouched.sub_key]);
  }, 300_000);

  it("the cloud declines work it cannot finish, before reading the original", async () => {
    // Section 6.6: the Lambda serves what exists, derives only from an
    // instantly retrievable original it can decode, and only into the cheap
    // tier. Everything else is a decline rather than a failure — the
    // distinction matters because a failure retries and a decline tells the
    // caller to ask a node that can.
    //
    // Driven against the deployed Lambda rather than a mocked broker, which is
    // the only place the ordering is real: a regression that read the source
    // first would still answer `declined` here and would do it after paying for
    // a download.
    const config = ctx.config();
    const session = ctx.session();
    const cloudPhotos = ctx.cloudApp();
    const resize = (body: Record<string, unknown>) =>
      fetch(`${config.apiGatewayUrl}/apps/photos/api/resize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.idToken}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });

    // Above the cheap tier. The rungs that cost real time and memory are a
    // local node's work whatever the original's state is.
    const expensive = await resize({
      targetId: ladderRecordId,
      targetLongEdge: CHEAP_TARGET_LONG_EDGE * 2,
    });
    expect(expensive.status).toBe(200);
    expect(await expensive.json()).toMatchObject({ declined: true, published: [] });

    // A format the cloud's libvips cannot decode. The record carries PNG bytes
    // under a HEIC type deliberately: the decline has to happen on the type,
    // before anything reads or decodes the source, and bytes that would fail a
    // decode are what tells the two apart.
    const { record: heic } = await createRecordWithBytes(ctx.localApp(), {
      type: "image/heic",
      contentType: "image/heic",
      bytes: solidPng([12, 34, 56], 600),
      fileName: `e2e-undecodable-${Date.now()}.heic`,
    });
    const drive = ctx.drive();
    await eventually(
      async () => {
        const round = await drive.fetch("/sync/now", { method: "POST" });
        expect(round.status).toBe(200);
        const found = await cloudPhotos.fetch(`/data/records/${heic.id}`);
        if (found.status !== 200) throw new Error(`the HEIC record has not reached the cloud yet`);
      },
      { timeoutMs: 120_000, intervalMs: 2_000 },
    );
    const undecodable = await resize({ targetId: heic.id, targetLongEdge: 320 });
    expect(undecodable.status).toBe(200);
    expect(await undecodable.json()).toMatchObject({ declined: true, published: [] });
    // No rung was written for a record the cloud declined.
    expect(await renditionRows(cloudPhotos, heic.id)).toEqual([]);

    // And the permitted case, stated only when its precondition holds: a
    // decodable original the cloud can read right now, asked for a cheap rung.
    const facts = await cloudPhotos.fetch(
      `/data/records?where=${encodeURIComponent(JSON.stringify({ id: ladderRecordId }))}&limit=1`,
    );
    expect(facts.status).toBe(200);
    const { records } = (await facts.json()) as {
      records: Array<{ availability?: { state: string } }>;
    };
    if (records[0]?.availability?.state === "instant") {
      const cheap = await resize({ targetId: ladderRecordId, targetLongEdge: 320 });
      expect(cheap.status).toBe(200);
      expect(
        (await cheap.json()) as { declined?: boolean },
        "the cloud declined a cheap rung of an instantly readable PNG",
      ).not.toMatchObject({ declined: true });
    }
  }, 300_000);

  it("keeps a second encoding local: the publication and the cloud are untouched", async () => {
    // First-writer-wins says the rung another node published stays published.
    // This node still paid for a decode, so it keeps its own bytes rather than
    // discarding them — under a `local/` key, in an index beside the bytes, out
    // of the synchronized file table.
    //
    // The half that needs a real cloud is the last one. Locally, "this row does
    // not travel" is a claim about a table nobody is reading; here it is a sync
    // round against a deployment that would have to have stored something.
    const photos = ctx.localApp();
    const cloudPhotos = ctx.cloudApp();
    const drive = ctx.drive();
    const published = (await renditionRows(photos, ladderRecordId)).sort(
      (a, b) => Math.max(a.width, a.height) - Math.max(b.width, b.height),
    )[0]!;

    // Bytes no encoder would produce twice, which is the case this exists for:
    // two encoders, one rung, neither byte-identical to the other.
    const alternate = Buffer.concat([
      Buffer.from("alternate encoding "),
      randomBytes(64),
    ]);
    const contentHash = createHash("sha256").update(alternate).digest("hex");
    const result = await publishRendition(
      (path, init) => photos.fetch(path, init),
      { id: ladderRecordId, originalFilename: ladderSourceName },
      {
        sizeClass: published.size_class,
        contentType: published.content_type,
        width: published.width,
        height: published.height,
        data: new Uint8Array(alternate),
      },
      contentHash,
      true,
    );
    expect(result.subKey.startsWith("local/")).toBe(true);
    expect(result.subKey).not.toBe(published.sub_key);

    // The publication did not move. Every other node still resolves this rung
    // to the key the first writer minted.
    const afterPublish = await renditionRows(photos, ladderRecordId);
    expect(afterPublish.find((r) => r.size_class === published.size_class)?.sub_key).toBe(
      published.sub_key,
    );
    const localFiles = await photos.fetch(
      `/app-data/local-files?prefix=${encodeURIComponent(`local/renditions/${ladderRecordId}/`)}`,
    );
    expect(localFiles.status).toBe(200);
    const listed = (await localFiles.json()) as { files: Array<{ subKey: string }> };
    expect(listed.files.map((f) => f.subKey)).toContain(result.subKey);

    // Three rounds' worth of chances to ship something it must not ship.
    for (let round = 0; round < 3; round++) {
      const sync = await drive.fetch("/sync/now", { method: "POST" });
      expect(sync.status).toBe(200);
    }
    const cloudRows = await renditionRows(cloudPhotos, ladderRecordId);
    expect(
      cloudRows.map((r) => r.sub_key).sort(),
      "a local alternative reached the cloud as a rendition row",
    ).toEqual(afterPublish.map((r) => r.sub_key).sort());
    const stat = await cloudPhotos.fetch(
      `/files/apps/photos/syncable/${result.subKey}/stat`,
    );
    expect(stat.status, "a local alternative's bytes reached cloud storage").not.toBe(200);

    // Taken away again, because every step after this reads the library the
    // ladder steps built and an extra copy of one rung is not part of it.
    const removed = await photos.fetch(`/app-data/files/${result.subKey}`, {
      method: "DELETE",
    });
    expect(removed.ok).toBe(true);
    const afterRemoval = await photos.fetch("/app-data/local-files");
    const remaining = ((await afterRemoval.json()) as { files: Array<{ subKey: string }> }).files;
    expect(remaining.map((file) => file.subKey)).not.toContain(result.subKey);

    // What is left is not this step's doing, and is the mechanism working. The
    // journey is ordered so the cloud Lambda and the local app derive the same
    // records — see the comment above `extraSteps` in the platform journey —
    // and whichever lost that race kept its own encoding here. Every one of
    // them is a `local/` key, because a published rung is named in the
    // synchronized table instead and never in this index.
    for (const file of remaining) {
      expect(file.subKey.startsWith("local/"), `${file.subKey} is in the local index`).toBe(true);
    }
  }, 300_000);
}

const photosApp: JourneyApp = {
  appId: "photos",
  appDir: PHOTOS_DIR,
  // Both keys Photos declares in its manifest. Deliberately not `rendition`,
  // the size-class key: setting it on the journey's record would make the app
  // read that original as its own rendition. `face-count` carries a value in
  // production and is written valueless here, which is what the presence half
  // of the reverse index needs; nothing in Photos reads it back, so the
  // synthetic write changes no behaviour.
  labelKeys: { flag: "face-count", valued: "faces" },
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
