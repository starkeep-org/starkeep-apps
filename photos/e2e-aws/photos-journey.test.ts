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

import { it, expect, afterAll } from "vitest";
import { existsSync, readFileSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
  type Page,
} from "@starkeep/e2e-aws";
import {
  createRecordWithBytes,
  eventually,
  solidPng,
  startWebServer,
  type LdsApp,
  type WebServer,
} from "@starkeep/e2e";
import { applicableStillClasses, classForStandIn, STILL_LADDER } from "../src/photos-lib/ladder";
import {
  renditionFileName,
} from "../src/photos-lib/image-processing/publish-renditions";

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

/** A stand-in as the rendition steps read it back. */
interface RungRecord {
  id: string;
  parent_id: string | null;
  original_filename: string | null;
  object_storage_key: string | null;
  type: string;
  stand_in_role: "canonical" | "smaller" | null;
  fidelity: number | null;
  labels?: Array<{
    app_id: string;
    key: string;
    value: string | null;
    label: string;
  }>;
}

/** The query for a record's stand-ins, the same one Photos issues. */
function standInsQuery(parentId: string): string {
  return (
    `/data/records?where=${encodeURIComponent(
      JSON.stringify({ parent_id: parentId, stand_in_role: { in: ["canonical", "smaller"] } }),
    )}&include=labels&limit=50`
  );
}

/**
 * A record's stand-ins, with their roles and fidelities, from whichever data
 * plane is asked.
 *
 * `parent_id` + `stand_in_role` is one indexed lookup, and it is the same query
 * Photos itself issues to decide what is left to derive — so the assertions
 * read the library the way the app does rather than through a shape invented
 * for a test.
 */
async function renditionChildren(
  app: LdsApp,
  parentId: string,
): Promise<RungRecord[]> {
  const res = await app.fetch(standInsQuery(parentId));
  if (!res.ok) {
    throw new Error(
      `rendition children of ${parentId} → ${res.status} ${await res.text()}`,
    );
  }
  return ((await res.json()) as { records: RungRecord[] }).records;
}

/** Which rung of the ladder a stand-in is, read off its role and fidelity. */
function renditionClassOf(rung: RungRecord): string {
  if (!rung.stand_in_role || rung.fidelity === null) return "";
  return classForStandIn("image", rung.stand_in_role, rung.fidelity) ?? "";
}

/** An original's size in bytes, as the data plane records it. */
async function renditionOriginalSize(app: LdsApp, recordId: string): Promise<number> {
  const res = await app.fetch(`/data/records/${recordId}`);
  if (!res.ok) throw new Error(`record ${recordId} → ${res.status} ${await res.text()}`);
  return ((await res.json()) as { record: { size_bytes: number } }).record.size_bytes;
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

/** One file of a photo whose rows reach the cloud ahead of its bytes. */
interface HeldFile {
  id: string;
  key: string;
  type: string;
  bytes: Buffer;
}

/**
 * An original's stored metadata on the local data server, once Photos has
 * written it. The detail route takes no `include=metadata`, so this reads the
 * listing.
 *
 * Only an original has a metadata row. A rung's dimensions follow from the
 * original's and the stand-in's fidelity.
 */
async function localMetadata(
  app: LdsApp,
  recordId: string,
): Promise<{ width?: number; height?: number; thumb_hash?: string | null } | null> {
  const where = encodeURIComponent(JSON.stringify({ id: { in: [recordId] } }));
  const res = await app.fetch(`/data/records?where=${where}&include=metadata&limit=1`);
  if (!res.ok) throw new Error(`record ${recordId} → ${res.status} ${await res.text()}`);
  const { records } = (await res.json()) as {
    records: Array<{
      id: string;
      metadata?: { width?: number; height?: number; thumb_hash?: string | null } | null;
    }>;
  };
  return records.find((r) => r.id === recordId)?.metadata ?? null;
}

/**
 * Take a record's file off this machine, keeping its bytes in memory.
 *
 * The local data server reports where it keeps each record's file. With the
 * file gone, the desktop ships the row and fails the upload every round, which
 * is the cloud's view of a phone that has not uploaded yet.
 */
async function holdBackLocalFile(app: LdsApp, recordId: string): Promise<HeldFile> {
  const res = await app.fetch(`/data/records/${recordId}`);
  if (!res.ok) throw new Error(`record ${recordId} → ${res.status} ${await res.text()}`);
  const { record } = (await res.json()) as {
    record: { object_storage_key: string | null; type: string; path: string | null };
  };
  expect(record.path, `the local data server reports no file for ${recordId}`).toBeTruthy();
  expect(record.object_storage_key).toBeTruthy();
  const bytes = readFileSync(record.path!);
  unlinkSync(record.path!);
  return { id: recordId, key: record.object_storage_key!, type: record.type, bytes };
}

/** Upload a file through a data server's own route, and check it kept its key. */
async function uploadFile(app: LdsApp, file: HeldFile): Promise<void> {
  const res = await app.fetch(`/data/files?type=${encodeURIComponent(file.type)}`, {
    method: "POST",
    headers: { "Content-Type": file.type },
    body: file.bytes,
  });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  expect((JSON.parse(text) as { key?: string }).key, "the bytes landed under another key").toBe(
    file.key,
  );
}

type Locator = ReturnType<Page["locator"]>;

/** What one `<img>` puts on screen, read off the DOM. */
interface DrawnImage {
  /** The object key a signed URL names, or the `src` itself for anything else. */
  path: string;
  /** Painted at all: not transparent, and bigger than the viewer's hidden 1 px probe. */
  visible: boolean;
  /** The browser finished with it and has no pixels: the broken-image glyph. */
  broken: boolean;
}

async function imagesIn(root: Locator): Promise<DrawnImage[]> {
  const raw = await root.locator("img").evaluateAll((imgs) =>
    imgs.map((node) => {
      const img = node as HTMLImageElement;
      const src = img.currentSrc || img.src;
      return {
        src,
        visible: Number(getComputedStyle(img).opacity) > 0 && img.offsetWidth > 1,
        broken: src !== "" && !src.startsWith("data:") && img.complete && img.naturalWidth === 0,
      };
    }),
  );
  return raw.map(({ src, visible, broken }) => ({
    path: src.startsWith("http") ? new URL(src).pathname : src,
    visible,
    broken,
  }));
}

/**
 * Watch a surface for the two things a user sees go wrong, and report what it
 * paints.
 *
 * A broken image on screen is recorded rather than thrown, because the checks
 * run inside `eventually`, which would retry past it. The step asserts the
 * record is empty at each stage instead.
 */
function surfaceWatcher(brokenSeen: string[]) {
  return async (root: Locator, where: string): Promise<string | undefined> => {
    const images = await imagesIn(root);
    for (const image of images) {
      if (image.visible && image.broken) brokenSeen.push(`${where}: ${image.path}`);
    }
    // A ThumbHash placeholder is a `data:` URL. It is no photograph.
    return images.find((i) => i.visible && !i.broken && !i.path.startsWith("data:"))?.path;
  };
}

/** Every `/api/resize` request the page makes for one record. */
function watchResizeRequests(page: Page, recordId: string): string[] {
  const asks: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    if (!new URL(request.url()).pathname.endsWith("/api/resize")) return;
    try {
      const body = JSON.parse(request.postData() ?? "{}") as { targetId?: string };
      if (body.targetId === recordId) asks.push(request.postData() ?? "");
    } catch {
      // Not a body this watcher understands, so not a request about this record.
    }
  });
  return asks;
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
/** Size class → the object key the rung arrived in the cloud under. */
const syncedRungKeys = new Map<string, string>();
/**
 * A photo whose rows reach the cloud while both its files stay on this
 * machine: the original, and the one stand-in its ladder takes.
 */
let heldOriginal: HeldFile & { fileName: string };
let heldStandIn: HeldFile;

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
    // With the original's size: a fixture under the platform's size floor
    // stands in for itself above its largest smaller rung and takes no
    // canonical stand-in, and Photos asks the same question the same way.
    const original = await renditionOriginalSize(photos, ladderRecordId);
    ladderClasses = applicableStillClasses(sourceLongEdge, original).map(
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
      // The fidelity is what resolution orders stand-ins by. It rides the
      // record's create call as a column, so no sync round can see the rung
      // without it; asserting it here is what makes the cloud assertion in the
      // next step meaningful rather than vacuous.
      expect(rung.fidelity ?? 0, `${sizeClass} has no fidelity`).toBeGreaterThan(0);
      expect(rung.type, `${sizeClass} is not an AVIF stand-in`).toBe("image/avif");
      expect(rung.parent_id).toBe(ladderRecordId);
      expect(rung.original_filename).toBe(
        renditionFileName(ladderSourceName, sizeClass),
      );
    }
  });

  it("derives a one-rung photo, then holds its files back from the cloud", async () => {
    // The state a phone leaves the cloud in while it uploads: rows first, then
    // stand-ins, then originals. A tile that reads a row before its file lands
    // must not show a broken image, and when the stand-in has landed and the
    // original has not, the grid and the viewer must paint the stand-in. That
    // needs a photo the real app has derived a stand-in for, with both files
    // still missing from the cloud when the rows arrive.
    //
    // 480 px sits above the bottom rung's 320 and below the next rung's 640,
    // so the ladder takes exactly one stand-in. It is the smallest photo that
    // has one, and the cheapest to derive.
    expect(photosLocal, "the ladder step must have booted Photos").toBeDefined();
    const photos = ctx.localApp();
    const drive = ctx.drive();
    const longEdge = 480;
    const fileName = `e2e-held-${Date.now()}.png`;

    // Paused across the derivation and the removal of both files: a write
    // nudges a round within 50 ms, and a round that uploaded either file
    // first would leave nothing to wait for.
    const pause = await drive.fetch("/sync/pause", { method: "POST" });
    expect(pause.status, await pause.clone().text()).toBe(200);
    try {
      const bytes = solidPng([...randomBytes(3)] as [number, number, number], longEdge);
      const { record } = await createRecordWithBytes(photos, { bytes, fileName });
      const classes = applicableStillClasses(
        longEdge,
        await renditionOriginalSize(photos, record.id),
      ).map((spec) => spec.sizeClass);
      expect(classes, "a 480 px photo must take exactly the bottom rung").toEqual(["image-xsmall"]);

      const resize = await fetch(`${photosLocal!.url}/api/resize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: record.id }),
        signal: AbortSignal.timeout(5 * 60 * 1000),
      });
      const resizeBody = await resize.text();
      expect(resize.status, `local /api/resize answered ${resize.status}: ${resizeBody}`).toBe(200);
      const [rung] = await eventually(
        async () => {
          const found = await renditionChildren(photos, record.id);
          if (found.length < 1) throw new Error("the stand-in has not been published yet");
          return found;
        },
        { timeoutMs: 2 * 60 * 1000, intervalMs: 2_000 },
      );
      expect(renditionClassOf(rung!)).toBe("image-xsmall");

      // The grid sizes a tile and resolves its rungs from the original's
      // stored dimensions, and derivation writes the ThumbHash last. Wait for
      // both before the files go, so Photos never meets a missing file while
      // it still reads one.
      await eventually(
        async () => {
          const metadata = await localMetadata(photos, record.id);
          if (!metadata?.width || !metadata.height || !metadata.thumb_hash) {
            throw new Error(`${record.id} has no dimensions or ThumbHash yet: ${JSON.stringify(metadata)}`);
          }
        },
        { timeoutMs: 60_000, intervalMs: 1_000 },
      );

      heldOriginal = { ...(await holdBackLocalFile(photos, record.id)), fileName };
      heldStandIn = await holdBackLocalFile(photos, rung!.id);
    } finally {
      const resume = await drive.fetch("/sync/resume", { method: "POST" });
      expect(resume.status, await resume.clone().text()).toBe(200);
    }

    // Both rows reach the cloud, and neither file does.
    const cloudPhotos = ctx.cloudApp();
    await eventually(
      async () => {
        const sync = await drive.fetch("/sync/now", { method: "POST" });
        expect(sync.status).toBe(200);
        for (const { id } of [heldOriginal, heldStandIn]) {
          const res = await cloudPhotos.fetch(`/data/records/${id}`);
          if (res.status !== 200) throw new Error(`row ${id} has not reached the cloud (${res.status})`);
        }
      },
      { timeoutMs: 60_000, intervalMs: 2_000 },
    );
    for (const { id } of [heldOriginal, heldStandIn]) {
      const res = await cloudPhotos.fetch(`/data/records/${id}/file-url`);
      const body = await res.text();
      expect(res.status, `file-url for ${id} must wait for its upload: ${body}`).toBe(409);
    }
  });

  it("syncs the ladder up: every rung reaches the cloud with its role and its fidelity", async () => {
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
          const res = await cloudPhotos.fetch(standInsQuery(ladderRecordId));
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
      expect(sizeClass, "a synced stand-in names no rung of the ladder").toBeTruthy();
      expect(rung.fidelity ?? 0, `${sizeClass} arrived with no fidelity`).toBeGreaterThan(0);
      syncedRungKeys.set(sizeClass, rung.object_storage_key as string);
    }
    expect([...syncedRungKeys.keys()].sort()).toEqual(
      [...ladderClasses].sort(),
    );

    // The assertion the 2026-08-27 failure would fail, restated for stand-ins:
    // the original's size summary in the cloud names every rung that arrived.
    // This is also the listing the Photos client resolves a tile from. The
    // fixture sits under the size floor, so it is self-canonical and the
    // summary names the original itself as its top size, with role
    // `original`; that entry is not a stand-in and is not counted.
    const resolvedRes = await cloudPhotos.fetch(
      `/data/records?where=${encodeURIComponent(JSON.stringify({ id: { in: [ladderRecordId] } }))}` +
        `&limit=1&include=metadata`,
    );
    expect(resolvedRes.status).toBe(200);
    const { records: parents } = (await resolvedRes.json()) as {
      records: Array<{
        id: string;
        stand_ins?: {
          sizes: Array<{ role: string; record_id: string | null; placement: string }>;
        };
      }>;
    };
    const parent = parents.find((r) => r.id === ladderRecordId);
    expect(parent, "the original must be readable in the cloud").toBeDefined();
    expect(
      parent!.stand_ins?.sizes.filter(
        (size) => size.role !== "original" && size.record_id !== null && size.placement !== "missing",
      ).length ?? 0,
      "the cloud's size summary names fewer stand-ins than arrived",
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
  it("the cloud grid and viewer wait for a photo's files, then paint each as it lands", async () => {
    // The user-facing half of a phone's upload, one stage at a time. Before
    // anything lands, the tile and the viewer wait with a placeholder. Once
    // the stand-in lands, both paint it without a reload, while the original
    // is still on the phone. Once the original lands, the viewer paints it.
    // At no stage does a broken image reach the screen, and nothing asks the
    // resize Lambda to derive from an original the cloud does not hold.
    expect(heldOriginal && heldStandIn, "the hold-back step must have run first").toBeTruthy();
    const config = ctx.config();
    const appUrl = `${config.publicBaseUrl}/apps/photos/`;
    const cloudPhotos = ctx.cloudApp();
    const originalPath = `/${heldOriginal.key}`;
    const standInPath = `/${heldStandIn.key}`;
    const brokenSeen: string[] = [];
    const look = surfaceWatcher(brokenSeen);
    const expectNothingBroken = (stage: string) =>
      expect(brokenSeen, `a broken image reached the screen ${stage}`).toEqual([]);

    const browser = await chromium.launch();
    let problemReport: () => string = () => "";
    try {
      const page = await browser.newPage();
      problemReport = watchPageProblems(page);
      const resizeAsks = watchResizeRequests(page, heldOriginal.id);
      const admin = ctx.adminCredentials();
      await signInWithBrowser({
        page,
        appUrl,
        email: admin.email,
        password: admin.password,
        signedInControl: "Upload Photo",
        problemReport,
      });

      // Located by record id: a tile whose files have not landed may hold no
      // `<img>` to find by alt text.
      const tile = page.locator(`[data-testid="photo-tile"][data-record-id="${heldOriginal.id}"]`);
      await tile.waitFor({ state: "attached", timeout: 120_000 });
      await tile.scrollIntoViewIfNeeded();
      const spinner = tile.getByTestId("tile-loading-spinner");
      const viewer = page.getByTestId("photo-viewer");
      const skeleton = viewer.getByTestId("photo-skeleton");

      // Stage 1: nothing has landed. Watched across the first two retries,
      // at 5 and 10 seconds, so a retry that turned the wait into a broken
      // image would show here.
      await spinner.waitFor({ state: "visible", timeout: 30_000 });
      for (const deadline = Date.now() + 15_000; Date.now() < deadline; ) {
        expect(
          await look(tile, "in the tile before any upload"),
          "the tile painted a photo before either file landed",
        ).toBeUndefined();
        expect(await spinner.isVisible(), "the waiting tile lost its spinner").toBe(true);
        await page.waitForTimeout(1_000);
      }
      await tile.click();
      await viewer.waitFor({ state: "visible", timeout: 30_000 });
      expect(await viewer.getAttribute("data-record-id")).toBe(heldOriginal.id);
      for (const deadline = Date.now() + 8_000; Date.now() < deadline; ) {
        expect(
          await look(viewer, "in the viewer before any upload"),
          "the viewer painted a photo before either file landed",
        ).toBeUndefined();
        expect(await skeleton.isVisible(), "the waiting viewer lost its skeleton").toBe(true);
        await page.waitForTimeout(1_000);
      }
      await viewer.getByRole("button", { name: "Close" }).click();
      await viewer.waitFor({ state: "detached", timeout: 10_000 });
      expectNothingBroken("before any upload");

      // Stage 2: the stand-in lands. The tile was told to wait, so its retry
      // timer is what finds the stand-in; the backoff tops out at a minute.
      await uploadFile(cloudPhotos, heldStandIn);
      await eventually(
        async () => {
          const shown = await look(tile, "in the tile once the stand-in landed");
          if (shown !== standInPath) {
            throw new Error(`the tile paints ${shown ?? "nothing"}, not the stand-in ${standInPath}`);
          }
        },
        { timeoutMs: 120_000, intervalMs: 1_000 },
      );
      expect(await spinner.isVisible(), "the tile kept its spinner over a painted photo").toBe(false);

      // The viewer wants the original, which is still on the phone, so it
      // paints the largest stand-in that has landed.
      await tile.click();
      await viewer.waitFor({ state: "visible", timeout: 30_000 });
      await eventually(
        async () => {
          const shown = await look(viewer, "in the viewer once the stand-in landed");
          if (shown !== standInPath) {
            throw new Error(`the viewer paints ${shown ?? "nothing"}, not the stand-in ${standInPath}`);
          }
        },
        { timeoutMs: 60_000, intervalMs: 1_000 },
      );
      expect(await skeleton.isVisible(), "the viewer kept its skeleton over a painted photo").toBe(
        false,
      );
      expectNothingBroken("while only the stand-in had landed");

      // Stage 3: the original lands, and the open viewer moves up to it.
      await uploadFile(cloudPhotos, heldOriginal);
      await eventually(
        async () => {
          const shown = await look(viewer, "in the viewer once the original landed");
          if (shown !== originalPath) {
            throw new Error(`the viewer paints ${shown ?? "nothing"}, not the original ${originalPath}`);
          }
        },
        { timeoutMs: 150_000, intervalMs: 1_000 },
      );
      expectNothingBroken("once the original landed");

      expect(
        resizeAsks,
        "the page asked the resize Lambda to derive from an original the cloud did not hold",
      ).toEqual([]);
    } catch (err) {
      throw new Error(`${err instanceof Error ? err.message : String(err)}${problemReport()}`, {
        cause: err,
      });
    } finally {
      await browser.close();
    }

    // The desktop gets its copies back, so it stops failing those uploads
    // and no later step inherits a library with files missing.
    await uploadFile(ctx.localApp(), heldOriginal);
    await uploadFile(ctx.localApp(), heldStandIn);
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
