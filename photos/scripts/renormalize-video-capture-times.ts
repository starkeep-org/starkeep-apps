/**
 * Put every video `captured_at` back into canonical form.
 *
 * ## What is wrong with the stored values
 *
 * A cloud round trip rewrote the strings. Postgres stores `captured_at` as
 * `timestamp without time zone`, so a canonical `2026-09-07T00:16:28.000Z`
 * parses by keeping the wall clock and discarding the `Z`, and renders back as
 * `2026-09-07 00:16:28`. The DSQL metadata read path skipped the conversion
 * every other read applies, so that rendering came home and overwrote the local
 * row.
 *
 * **The instant survived and the string did not, which is the harmful half.**
 * JavaScript reads a space-separated timestamp as *local* time, so every value
 * in this shape reads four hours late wherever the app constructs a `Date` from
 * it — and it sorts below every canonical value for the same day, because a
 * space sorts below `T`.
 *
 * ## Why a string repair is the whole of it
 *
 * `captureTime` in `src/photos-lib/video/probe.ts` returns `toISOString()`, and
 * always has. No video row was ever non-canonical at the source, so nothing was
 * lost that re-probing sixty clips could recover — the wall clock in the stored
 * string is already the UTC instant the container stated. This parses it as UTC
 * and writes the canonical spelling back.
 *
 * That is also why this repairs a clip whose bytes are not resident: it reads
 * the row rather than the file.
 *
 * ## The image table is already done
 *
 * `reread-exif-capture-times.ts` walked every stored *original* and re-read its
 * EXIF header, which covers the image table and reaches no video row. This is
 * the same defect in the table that pass could not see.
 *
 * ## Order of operations
 *
 * **The fixed cloud data server must be deployed before this runs**, or the
 * next round trip rewrites the repaired values again. It was, on 2026-09-11 at
 * 17:24 UTC — see `implementation-status-exif-capture-time-utc-2026-09-11.md`.
 *
 * The write goes over HTTP through the local data server's metadata route,
 * which goes through `sdk.data.putMetadata` and bumps the record's `updated_at`.
 * **The bump is the point**: a metadata row has no clock of its own and rides
 * its record, so a row written straight at the SQLite file would never reach
 * the cloud. The database is opened read-only so that cannot happen by accident.
 *
 * Idempotent: a value already in canonical form is left alone, so a second run
 * reports nothing to do.
 *
 * Run via:
 *   pnpm -F photos tsx scripts/renormalize-video-capture-times.ts [--apply] [--lds URL]
 */

import { createHmac } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const APP_ID = "photos";

/** Canonical ISO-8601 in UTC at millisecond precision — what the column takes. */
const CANONICAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Postgres's rendering of a `timestamp without time zone`.
 *
 * Seconds are optional because Postgres omits a zero fractional part, and the
 * fraction is captured so a value carrying one is not silently truncated.
 */
const PG_RENDERING = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;

interface VideoRow {
  id: string;
  type: string;
  original_filename: string | null;
  captured_at: string | null;
}

/**
 * Mirrors `signRequest` in `@starkeep/app-client/src/sign.ts`.
 *
 * Reimplemented rather than imported for the same reason
 * `reread-exif-capture-times.ts` reimplements it: that package's signing entry
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

/**
 * The canonical spelling of one Postgres-rendered timestamp, or null.
 *
 * Built from the captured fields rather than by handing the string to `Date`:
 * `new Date("2026-09-07 00:16:28")` applies the *process* zone, which is the
 * defect this repairs rather than the repair. Appending `Z` states the reading
 * explicitly — the wall clock Postgres kept is the UTC instant that was stored.
 */
export function canonicalizePgTimestamp(value: string): string | null {
  const m = PG_RENDERING.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, frac] = m;
  const ms = (frac ?? "").padEnd(3, "0").slice(0, 3);
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${sec}.${ms}Z`;
  // A round trip through `Date` rejects an impossible date the regex accepts,
  // such as a 31st of February.
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString() !== iso ? null : iso;
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

  // Every live video record carrying a capture time, renditions included. A
  // transcode holds no capture time today, but the damage is a property of the
  // column rather than of what wrote it, so the query does not assume that.
  const rows = db
    .prepare(
      `SELECT r.id, r.type, r.original_filename, m.captured_at
         FROM shared_records r
         JOIN shared_record_video_metadata m ON m.record_id = r.id
        WHERE r.deleted_at IS NULL
          AND m.captured_at IS NOT NULL
        ORDER BY m.captured_at`,
    )
    .all() as unknown as VideoRow[];
  db.close();

  const changed: Array<{ row: VideoRow; capturedAt: string }> = [];
  const unrecognized: VideoRow[] = [];
  let canonical = 0;

  for (const row of rows) {
    const stored = row.captured_at!;
    if (CANONICAL.test(stored)) {
      canonical += 1;
      continue;
    }
    const repaired = canonicalizePgTimestamp(stored);
    // Neither canonical nor Postgres's rendering. Reported and left alone: a
    // value in a third shape is something this script does not understand, and
    // guessing at it is how a capture time gets worse rather than better.
    if (repaired === null) unrecognized.push(row);
    else changed.push({ row, capturedAt: repaired });
  }

  console.log(`video rows with a capture time: ${rows.length}`);
  console.log(`  already canonical : ${canonical}`);
  console.log(`  to repair         : ${changed.length}`);
  if (unrecognized.length > 0) {
    console.log(`  in an unrecognized shape, left alone: ${unrecognized.length}`);
    for (const row of unrecognized) {
      console.log(`    ${row.id} ${row.original_filename ?? ""} stored=${row.captured_at}`);
    }
  }
  for (const { row, capturedAt } of changed) {
    console.log(`    ${row.original_filename ?? row.id}: ${row.captured_at} -> ${capturedAt}`);
  }

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
