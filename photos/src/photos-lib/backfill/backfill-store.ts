/**
 * Durable per-record state for a backfill run.
 *
 * Same shape and same reasoning as the import ledger: node-local, deliberately
 * not syncable, SQLite rather than JSON. See `import/import-store.ts` for the
 * full argument — it applies unchanged here, and duplicating it would mean two
 * places to update when it stops being true.
 *
 * The one difference worth stating: a backfill ledger is keyed by **record
 * id**, not content hash. The import loop keys by hash because a file can move
 * between runs and its path cannot identify it; a record's id is already stable
 * and already the thing being worked on.
 *
 * Why it must not sync, specifically: `undecodable` and `unavailable` are
 * verdicts about *this machine* — which formats this build can read, and which
 * originals are resident here. Syncing them would let a laptop tell a phone not
 * to bother with a record the phone could handle perfectly well, which is the
 * exact opposite of what a multi-node library is for.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";
import type { SizeClass } from "../ladder";
import type { BackfillItem, BackfillItemStatus } from "./backfill-run";
import { summarizeBackfill, type BackfillSummary } from "./backfill-run";
import type { BackfillStore } from "./run-backfill";

/** Root of Photos' non-syncable backfill state. */
export function backfillDir(): string {
  return join(starkeepDir(), "app-local", "photos", "backfill");
}

interface Row {
  record_id: string;
  status: string;
  produced_classes: string;
  detail: string | null;
  attempts: number;
  updated_at_ms: number;
}

function toItem(row: Row): BackfillItem {
  return {
    recordId: row.record_id,
    status: row.status as BackfillItemStatus,
    // Stored as JSON rather than as rows in a join table. The list is a handful
    // of short strings read and written whole, never queried into — a join
    // table would be a second table and an index to maintain for a query nobody
    // makes.
    producedClasses: safeParse(row.produced_classes),
    detail: row.detail,
    attempts: row.attempts,
    updatedAtMs: row.updated_at_ms,
  };
}

function safeParse(raw: string): SizeClass[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as SizeClass[]) : [];
  } catch {
    // A corrupt row costs one record its progress and is re-derived; throwing
    // here would abort a run of fifty thousand over one bad cell.
    return [];
  }
}

export interface DurableBackfillStore extends BackfillStore {
  summary(): BackfillSummary;
  close(): void;
}

export function openBackfillStore(runId: string): DurableBackfillStore {
  const path = join(backfillDir(), `${runId}.sqlite`);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);

  db.exec(`
    CREATE TABLE IF NOT EXISTS backfill_items (
      record_id        TEXT PRIMARY KEY,
      status           TEXT NOT NULL,
      produced_classes TEXT NOT NULL DEFAULT '[]',
      detail           TEXT,
      attempts         INTEGER NOT NULL DEFAULT 0,
      updated_at_ms    INTEGER NOT NULL
    )
  `);
  // The resume question is "what is not terminal yet", asked once per run.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_backfill_items_status ON backfill_items (status)`);

  const getStmt = db.prepare(`SELECT * FROM backfill_items WHERE record_id = ?`);
  const putStmt = db.prepare(`
    INSERT INTO backfill_items
      (record_id, status, produced_classes, detail, attempts, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(record_id) DO UPDATE SET
      status           = excluded.status,
      produced_classes = excluded.produced_classes,
      detail           = excluded.detail,
      attempts         = excluded.attempts,
      updated_at_ms    = excluded.updated_at_ms
  `);
  const allStmt = db.prepare(`SELECT * FROM backfill_items`);

  return {
    get(recordId: string): BackfillItem | null {
      const row = getStmt.get(recordId) as unknown as Row | undefined;
      return row ? toItem(row) : null;
    },
    put(item: BackfillItem): void {
      putStmt.run(
        item.recordId,
        item.status,
        JSON.stringify(item.producedClasses),
        item.detail,
        item.attempts,
        item.updatedAtMs,
      );
    },
    all(): BackfillItem[] {
      return (allStmt.all() as unknown as Row[]).map(toItem);
    },
    summary(): BackfillSummary {
      return summarizeBackfill(this.all());
    },
    close(): void {
      db.close();
    },
  };
}
