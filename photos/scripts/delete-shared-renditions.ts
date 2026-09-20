/**
 * Delete the rendition records that were published to the *shared* plane.
 *
 * A one-time cleanup, not a migration. Phase 3 of the rendition-ownership plan
 * moved renditions onto Photos' own app-private plane, and the records left
 * behind are a body of derived children that nothing reads any more: the sweep,
 * the library and the viewer all read Photos' table now, and the `notLabel`
 * filter is what keeps these out of the grid in the meantime.
 *
 * They are deleted rather than migrated because Photos' current records are
 * disposable by decision — see the plan's section 2 — and every rung they hold
 * is re-derivable from an original that is still there. A migration would carry
 * bytes whose provenance nobody can now check into a table whose primary key
 * assumes one rung per photograph.
 *
 * ## What it deletes
 *
 * Exactly the records carrying `photos/rendition`. Not every child: a Live
 * Photo clip has a parent too and is real user data. Reading `parent_id !==
 * null` as "is a rendition" is the mistake `photos-lib/labels.ts` exists to stop
 * repeating, and it would delete the clips.
 *
 * ## What happens to the bytes
 *
 * The platform's delete tombstones the record and releases its object, and the
 * tombstone travels — which is what makes one run enough for every node. The
 * app-private plane is untouched: these keys are `shared/image/...`, and
 * Photos' own reaper only ever walks `renditions/`.
 *
 * Dry by default. Run via:
 *   pnpm -F photos tsx scripts/delete-shared-renditions.ts [--apply] [--lds URL]
 */

import { createHmac } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { RENDITION_LABEL_REF } from "../src/photos-lib/labels";

const APP_ID = "photos";
/** The platform's own page cap for a record listing. */
const PAGE = 500;

/** Mirrors `signRequest` in `@starkeep/app-client`; see the sibling scripts. */
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

  // Read-only, and load-bearing: the registry is the only thing this reads
  // directly, and every write goes through the daemon so it reaches the cloud.
  const db = new DatabaseSync(join(starkeepDir, "data.db"), {
    readOnly: true,
  } as ConstructorParameters<typeof DatabaseSync>[1]);
  const secret = (
    db.prepare(`SELECT hmac_secret FROM shared_app_registry WHERE app_id = ?`).get(APP_ID) as
      | { hmac_secret: string }
      | undefined
  )?.hmac_secret;
  if (!secret) throw new Error(`no hmac_secret for "${APP_ID}" in the local registry`);

  const call = async (method: string, path: string, body = "") => {
    const res = await fetch(`${lds}${path}`, {
      method,
      headers: signHeaders(secret, method, path, body),
      ...(body ? { body } : {}),
    });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
    return res;
  };

  // Paged by cursor rather than by offset, and re-asked from the top after each
  // page of deletions: a delete removes rows from the set being walked, so a
  // cursor cut before it points into a set that no longer exists.
  let deleted = 0;
  let found = 0;
  for (;;) {
    const path =
      `/data/records?limit=${PAGE}&label=${encodeURIComponent(RENDITION_LABEL_REF)}`;
    const { records } = (await (await call("GET", path)).json()) as {
      records: Array<{ id: string; original_filename: string | null }>;
    };
    if (records.length === 0) break;
    found += records.length;
    if (!apply) {
      for (const record of records.slice(0, 5)) {
        console.log(`  would delete ${record.id} (${record.original_filename ?? "unnamed"})`);
      }
      console.log(`… ${records.length} on this page; re-run with --apply to delete`);
      break;
    }
    for (const record of records) {
      await call("DELETE", `/data/records/${record.id}`);
      deleted += 1;
    }
    console.log(`deleted ${deleted} so far`);
  }

  console.log(
    apply
      ? `done: ${deleted} shared rendition records deleted`
      : `dry run: ${found} shared rendition records on the first page`,
  );
}

await main();
