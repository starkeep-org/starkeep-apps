/**
 * Durable per-item state for a folder import.
 *
 * ## Why this is node-local and deliberately not syncable
 *
 * An import ledger records what *this machine* has done with files on *this
 * machine's* disk. Syncing it would push a laptop's import progress to a phone
 * that has none of those files and can do nothing with the knowledge — and
 * worse, would let one device's `unsupported` verdict tell another device not
 * to bother with a file it could read perfectly well.
 *
 * So it lives under `$STARKEEP_DIR/app-local/photos/`, the same convention
 * Photos' vision state uses: outside both homes the platform gives an app,
 * because both of those sync unconditionally. The platform does not create,
 * enumerate or clean it up, and an uninstall leaves it behind.
 *
 * ## Why a database rather than a JSON file
 *
 * The lookup is "have I already handled this hash", once per file, across tens
 * of thousands of files. A JSON file means holding the whole ledger in memory
 * and rewriting it on every item — which is fine at a thousand items and
 * quadratic misery at fifty thousand, exactly when resumption matters most.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";
import type { ImportItem, ImportItemStatus, ImportRunSummary } from "./import-run";
import { summarize } from "./import-run";

/** Root of Photos' non-syncable import state. */
export function importDir(): string {
  return join(starkeepDir(), "app-local", "photos", "import");
}

export interface ImportStore {
  /** What we already know about this file, by hash. */
  get(contentHash: string): ImportItem | null;
  put(item: ImportItem): void;
  /** Every item of one run, for the report. */
  all(): ImportItem[];
  summary(): ImportRunSummary;
  close(): void;
}

interface Row {
  content_hash: string;
  source_path: string;
  size_bytes: number;
  status: string;
  record_id: string | null;
  duplicate_tier: string | null;
  detail: string | null;
  updated_at_ms: number;
}

function toItem(row: Row): ImportItem {
  return {
    contentHash: row.content_hash,
    sourcePath: row.source_path,
    sizeBytes: row.size_bytes,
    status: row.status as ImportItemStatus,
    recordId: row.record_id,
    duplicateTier: row.duplicate_tier,
    detail: row.detail,
    updatedAtMs: row.updated_at_ms,
  };
}

/**
 * Open (or create) the ledger for one import run.
 *
 * Runs are separate databases keyed by a caller-chosen id rather than rows in a
 * shared table. Two imports of different folders have nothing to say to each
 * other, and a file present in both is genuinely two decisions — the second
 * run should see the library's own dedup, not the first run's verdict about a
 * different folder.
 */
export function openImportStore(runId: string): ImportStore {
  const path = join(importDir(), `${runId}.sqlite`);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);

  db.exec(`
    CREATE TABLE IF NOT EXISTS import_items (
      content_hash   TEXT PRIMARY KEY,
      source_path    TEXT NOT NULL,
      size_bytes     INTEGER NOT NULL,
      status         TEXT NOT NULL,
      record_id      TEXT,
      duplicate_tier TEXT,
      detail         TEXT,
      updated_at_ms  INTEGER NOT NULL
    )
  `);
  // The resume query is "everything not yet terminal", asked once per run over
  // a table with one row per file.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_import_items_status ON import_items (status)`);

  const getStmt = db.prepare(`SELECT * FROM import_items WHERE content_hash = ?`);
  const putStmt = db.prepare(`
    INSERT INTO import_items
      (content_hash, source_path, size_bytes, status, record_id, duplicate_tier, detail, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(content_hash) DO UPDATE SET
      source_path    = excluded.source_path,
      size_bytes     = excluded.size_bytes,
      status         = excluded.status,
      record_id      = excluded.record_id,
      duplicate_tier = excluded.duplicate_tier,
      detail         = excluded.detail,
      updated_at_ms  = excluded.updated_at_ms
  `);
  const allStmt = db.prepare(`SELECT * FROM import_items`);

  return {
    get(contentHash: string): ImportItem | null {
      const row = getStmt.get(contentHash) as unknown as Row | undefined;
      return row ? toItem(row) : null;
    },
    put(item: ImportItem): void {
      putStmt.run(
        item.contentHash,
        item.sourcePath,
        item.sizeBytes,
        item.status,
        item.recordId,
        item.duplicateTier,
        item.detail,
        item.updatedAtMs,
      );
    },
    all(): ImportItem[] {
      return (allStmt.all() as unknown as Row[]).map(toItem);
    },
    summary(): ImportRunSummary {
      return summarize(this.all());
    },
    close(): void {
      db.close();
    },
  };
}
