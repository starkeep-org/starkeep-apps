/**
 * Re-read every stored original's EXIF header and write back the capture time
 * the file actually states.
 *
 * ## What is wrong with the stored values
 *
 * Two defects put a wrong string in `captured_at`, and this repairs both
 * because both are repaired by the same act — reading the header again with a
 * reader that no longer consults the machine's clock.
 *
 * **`exifr` ignores the `OffsetTime*` tags.** It revives a date tag by handing
 * the naive EXIF string to `new Date(...)`, which reads it in the *process*
 * zone, whether or not the file states an offset. So every capture time in the
 * library is the wall clock the camera wrote, read in the zone of whichever
 * node ran derivation. It is right only where that zone happened to match the
 * file's. One stored Pixel frame reads `2026:04:04 10:29:21` with
 * `OffsetTimeOriginal = "-06:00"` — an instant of `16:29:21Z` — and was stored
 * as `14:29:21Z`, which is America/Detroit's answer.
 *
 * **A cloud round trip rewrote the strings.** The DSQL metadata read path
 * skipped the `timestamp` conversion every other read applies, so canonical
 * `2026-08-30T19:17:55.000Z` came back as Postgres' `2026-08-30 19:17:55` and
 * overwrote the local row. `new Date` reads that as *local* time, so every
 * capture time in the library read four hours late.
 *
 * ## Order of operations
 *
 * **Deploy the fixed cloud data server before running this.** The read-path
 * conversion is what stops the next round trip rewriting these values again.
 * Repairing first and deploying second repairs nothing.
 *
 * ## Why this rather than a re-derive
 *
 * `deriveAndPublish` returns before it reaches the header whenever a record's
 * ladder is complete (`derive-and-publish.ts`), and the `exif_present` gate
 * sits further down still, so nothing a sweep does re-reads a header that has
 * already been read. This walks the originals directly.
 *
 * The write goes over HTTP through the local data server's metadata route,
 * which goes through `sdk.data.putMetadata` and bumps the record's
 * `updated_at`. **The bump is the point**: a metadata row has no clock of its
 * own and rides its record, so a row written straight at the SQLite file would
 * never reach the cloud. The database is opened read-only so that cannot happen
 * by accident.
 *
 * Idempotent. It compares each file's answer against the stored value and
 * writes only where they differ, so a second run reports nothing to do.
 *
 * Run via:
 *   pnpm -F photos tsx scripts/reread-exif-capture-times.ts [--apply] [--lds URL]
 */

import { createHmac } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { extractExif } from "../src/photos-lib/metadata/exif-reader";

const APP_ID = "photos";

interface Original {
  id: string;
  type: string;
  object_storage_key: string;
  original_filename: string | null;
  captured_at: string | null;
}

/**
 * Mirrors `signRequest` in `@starkeep/app-client/src/sign.ts`.
 *
 * Reimplemented rather than imported for the same reason
 * `reship-stranded-metadata.ts` reimplements it: that package's signing entry
 * point expects an app's own credential bundle, and this reads the secret
 * straight out of the local registry as an operator tool. The HMAC input shape
 * — `${appId}:${METHOD}:${path}:${ts}:` bytes ++ body bytes — must stay in step
 * with it and with `validateAppHmac` in the local data server.
 */
function signHeaders(
  secret: string,
  method: string,
  path: string,
  body: string,
): Record<string, string> {
  const ts = Date.now();
  const prefix = Buffer.from(`${APP_ID}:${method.toUpperCase()}:${path}:${ts}:`, "utf8");
  const input = Buffer.concat([
    prefix as unknown as Uint8Array,
    Buffer.from(body, "utf8") as unknown as Uint8Array,
  ]);
  return {
    "Content-Type": "application/json",
    "X-Starkeep-App-Id": APP_ID,
    "X-Starkeep-App-Sig": createHmac("sha256", secret)
      .update(input as unknown as Uint8Array)
      .digest("hex"),
    "X-Starkeep-App-Ts": String(ts),
  };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const lds = arg("lds") ?? "http://127.0.0.1:9820";
  const starkeepDir = process.env.STARKEEP_DIR ?? join(homedir(), ".starkeep");

  // `readOnly` is load-bearing, not a nicety: this script must reach the
  // database only through the daemon's HTTP route, and opening the file
  // read-only is what makes a stray direct write impossible rather than merely
  // absent. The cast is for the installed `@types/node`, whose
  // `DatabaseSyncOptions` predates the option; the runtime honours it.
  const db = new DatabaseSync(join(starkeepDir, "data.db"), {
    readOnly: true,
  } as ConstructorParameters<typeof DatabaseSync>[1]);

  const secret = (
    db.prepare(`SELECT hmac_secret FROM shared_app_registry WHERE app_id = ?`).get(APP_ID) as
      | { hmac_secret: string }
      | undefined
  )?.hmac_secret;
  if (!secret) throw new Error(`no hmac_secret for "${APP_ID}" in the local registry`);

  // Originals only. A rendition's bytes are re-encoded from a decoded bitmap
  // and carry no EXIF at all, which is why no rendition holds a capture time.
  const originals = db
    .prepare(
      `SELECT r.id, r.type, r.object_storage_key, r.original_filename, m.captured_at
         FROM shared_records r
         LEFT JOIN shared_record_image_metadata m ON m.record_id = r.id
        WHERE r.parent_id IS NULL
          AND r.deleted_at IS NULL
          AND r.type LIKE 'image/%'
        ORDER BY r.id`,
    )
    .all() as unknown as Original[];
  db.close();

  const changed: Array<{ row: Original; capturedAt: string }> = [];
  const lost: Original[] = [];
  let absent = 0;
  let unchanged = 0;
  let noCaptureTime = 0;

  for (const row of originals) {
    const path = join(starkeepDir, "objects", row.object_storage_key);
    // A non-resident original is not a failure. Residency evicts bytes this
    // node no longer needs to hold, and a header that is not here cannot be
    // re-read here.
    if (!existsSync(path)) {
      absent += 1;
      continue;
    }
    const capturedAt = (await extractExif(readFileSync(path))).dateTakenRaw;
    if (capturedAt === null) {
      // The stored row claims a capture time the file no longer yields. Worth
      // seeing rather than acting on: the metadata route treats an absent
      // column as no information, so this script cannot clear one anyway.
      if (row.captured_at !== null) lost.push(row);
      else noCaptureTime += 1;
      continue;
    }
    if (capturedAt === row.captured_at) unchanged += 1;
    else changed.push({ row, capturedAt });
  }

  console.log(`originals: ${originals.length}`);
  console.log(`  bytes not resident here : ${absent}`);
  console.log(`  no capture time, correct: ${noCaptureTime}`);
  console.log(`  already correct         : ${unchanged}`);
  console.log(`  to repair               : ${changed.length}`);
  if (lost.length > 0) {
    console.log(`  stored a time the file no longer yields: ${lost.length}`);
    for (const row of lost.slice(0, 10)) {
      console.log(`    ${row.id} ${row.original_filename ?? ""} stored=${row.captured_at}`);
    }
  }
  for (const { row, capturedAt } of changed.slice(0, 15)) {
    console.log(`    ${row.original_filename ?? row.id}: ${row.captured_at} -> ${capturedAt}`);
  }
  if (changed.length > 15) console.log(`    … and ${changed.length - 15} more`);

  if (changed.length === 0) return;
  if (!apply) {
    console.log("\nread-only; pass --apply to write them.");
    return;
  }

  let ok = 0;
  const failures: string[] = [];
  for (const { row, capturedAt } of changed) {
    const path = `/data/records/${row.id}/metadata`;
    // Only the column this repairs. The write path treats a named column as an
    // overwrite and an absent one as no information, so naming nothing else
    // keeps every other fact the row holds exactly as it is.
    const body = JSON.stringify({ typeId: row.type, metadata: { captured_at: capturedAt } });
    const res = await fetch(`${lds}${path}`, {
      method: "POST",
      headers: signHeaders(secret, "POST", path, body),
      body,
    });
    if (res.ok) ok += 1;
    else failures.push(`${row.id}: ${res.status} ${(await res.text()).slice(0, 160)}`);
  }

  console.log(`\nwrote ${ok} of ${changed.length}`);
  if (failures.length > 0) {
    console.log(`${failures.length} failed:`);
    for (const f of failures.slice(0, 15)) console.log(`  ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log("Each write moved its record's clock; the next sync round carries them.");
}

void main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error("FAILED:", err);
    process.exit(1);
  },
);
