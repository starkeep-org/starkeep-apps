/**
 * A record of every sync round this phone ran, kept on the phone.
 *
 * The desktop logs one line per round and the cloud one per exchange, so the
 * phone was the leg nobody could see: logcat needs a cable, and the question is
 * almost always what the phone did while nobody was watching. This table holds
 * the rounds in the node's own database, so a person diagnosing sync can read
 * them off the phone afterwards.
 *
 * Rounds move rows and downloads. Uploads run in the engine's uploader,
 * beside the rounds, and report to the cloud on each batch; see
 * `starkeep-core/docs/runbook-phone-sync-timeline.md`.
 *
 * One row per round, written as the round ends. The last round of a sync also
 * carries why the sync stopped. A sync that ran no round at all — aborted
 * before it began, or failed outright — gets one row of its own so the stop is
 * still on record.
 *
 * Bounded: the oldest rows go once {@link SYNC_TRACE_KEEP} is exceeded. This is
 * a diagnostic, not history, and a phone syncing every thirty seconds would
 * otherwise grow it without end.
 */

import type { ExchangeResult, SyncResult } from "@starkeep/sync-engine";
import type { RawDatabase } from "@starkeep/storage-adapter";
import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
} from "kysely";

/** Rows kept. About a day of foreground use at one sync per thirty seconds. */
export const SYNC_TRACE_KEEP = 500;

/** What started a sync, as the trace records it. */
export type SyncTrigger =
  | "open"
  | "after-import"
  | "after-derive"
  | "timer"
  | "media-change"
  | "button"
  | "background";

export interface SyncTraceRound {
  readonly syncId: string;
  readonly trigger: SyncTrigger;
  /** 1-based; 0 for the row of a sync that ran no round. */
  readonly round: number;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly applied: number;
  readonly shipped: number;
  readonly landed: number;
  readonly landedBytes: number;
  readonly elided: number;
  readonly blocked: boolean;
  readonly hasMore: boolean;
  readonly outboundHasMore: boolean;
  readonly bytesHasMore: boolean;
  /** Why the sync stopped, on its last row only. */
  readonly stopReason: string | null;
}

export interface SyncTraceStore {
  /** Record a round as it ends. */
  recordRound(syncId: string, trigger: SyncTrigger, round: number, startedAt: number, result: ExchangeResult): void;
  /** Record why a sync stopped, on its last round or on a row of its own. */
  finish(syncId: string, trigger: SyncTrigger, startedAt: number, reason: string): void;
  /** The most recent rows, newest first. */
  recent(limit: number): SyncTraceRound[];
}

// Compile-only Kysely: statements run synchronously through the raw handle,
// the same arrangement as the engine's own sync-state store.
type DB = Record<string, Record<string, unknown>>;
const qb = new Kysely<DB>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

const TABLE = "sync_trace";

export function createSyncTraceStore(db: RawDatabase, keep = SYNC_TRACE_KEEP): SyncTraceStore {
  db.exec(
    qb.schema
      .createTable(TABLE)
      .ifNotExists()
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("sync_id", "text", (c) => c.notNull())
      .addColumn("trigger", "text", (c) => c.notNull())
      .addColumn("round", "integer", (c) => c.notNull())
      .addColumn("started_at", "integer", (c) => c.notNull())
      .addColumn("ended_at", "integer", (c) => c.notNull())
      .addColumn("applied", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("shipped", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("landed", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("landed_bytes", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("elided", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("blocked", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("has_more", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("outbound_has_more", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("bytes_has_more", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("stop_reason", "text")
      .compile().sql,
  );

  const p = (): never => sql.raw("?") as never;
  const insert = db.prepare(
    qb
      .insertInto(TABLE)
      .values({
        sync_id: p(),
        trigger: p(),
        round: p(),
        started_at: p(),
        ended_at: p(),
        applied: p(),
        shipped: p(),
        landed: p(),
        landed_bytes: p(),
        elided: p(),
        blocked: p(),
        has_more: p(),
        outbound_has_more: p(),
        bytes_has_more: p(),
        stop_reason: p(),
      })
      .compile().sql,
  );
  const lastOfSync = db.prepare(
    qb
      .selectFrom(TABLE)
      .select("id")
      .where("sync_id", "=", p())
      .orderBy("id", "desc")
      .limit(p())
      .compile().sql,
  );
  const setReason = db.prepare(
    qb.updateTable(TABLE).set({ stop_reason: p() }).where("id", "=", p()).compile().sql,
  );
  const prune = db.prepare(
    qb
      .deleteFrom(TABLE)
      .where("id", "<=", sql<number>`(SELECT MAX(id) FROM ${sql.table(TABLE)}) - ${sql.raw(String(keep))}`)
      .compile().sql,
  );
  const selectRecent = db.prepare(
    qb.selectFrom(TABLE).selectAll().orderBy("id", "desc").limit(p()).compile().sql,
  );

  const flag = (value: boolean): number => (value ? 1 : 0);

  return {
    recordRound(syncId, trigger, round, startedAt, result) {
      insert.run(
        syncId,
        trigger,
        round,
        startedAt,
        Date.now(),
        result.applied,
        result.shipped,
        result.landed,
        result.landedBytes,
        result.elided,
        flag(result.blocked),
        flag(result.hasMore),
        flag(result.outboundHasMore),
        flag(result.bytesHasMore),
        null,
      );
      prune.run();
    },
    finish(syncId, trigger, startedAt, reason) {
      const last = lastOfSync.get(syncId, 1) as { id: number } | undefined;
      if (last) {
        setReason.run(reason, last.id);
        return;
      }
      insert.run(syncId, trigger, 0, startedAt, Date.now(), 0, 0, 0, 0, 0, 0, 0, 0, 0, reason);
      prune.run();
    },
    recent(limit) {
      return (selectRecent.all(limit) as Record<string, unknown>[]).map(rowToRound);
    },
  };
}

function rowToRound(row: Record<string, unknown>): SyncTraceRound {
  const num = (key: string): number => Number(row[key] ?? 0);
  return {
    syncId: String(row["sync_id"]),
    trigger: String(row["trigger"]) as SyncTrigger,
    round: num("round"),
    startedAt: num("started_at"),
    endedAt: num("ended_at"),
    applied: num("applied"),
    shipped: num("shipped"),
    landed: num("landed"),
    landedBytes: num("landed_bytes"),
    elided: num("elided"),
    blocked: num("blocked") === 1,
    hasMore: num("has_more") === 1,
    outboundHasMore: num("outbound_has_more") === 1,
    bytesHasMore: num("bytes_has_more") === 1,
    stopReason: row["stop_reason"] === null || row["stop_reason"] === undefined ? null : String(row["stop_reason"]),
  };
}

/**
 * Why a sync stopped, in the words the trace stores.
 *
 * Ordered most specific first, matching the message the Sync section shows: an
 * abort is the one outcome the person caused, and a stall is the one that
 * means something will not transfer.
 */
export function stopReasonOf(result: SyncResult | null, aborted: boolean, error?: unknown): string {
  if (error !== undefined) return `error: ${error instanceof Error ? error.message : String(error)}`;
  if (aborted) return "aborted";
  if (result === null) return "no cloud";
  if (result.complete) return "complete";
  if (result.stalled) return "stalled";
  if (result.refusedAuthors?.length) return `refused authors: ${result.refusedAuthors.join(", ")}`;
  return "incomplete";
}

/** The trace as plain text, one line per round. Newest first. */
export function formatSyncTrace(rounds: readonly SyncTraceRound[]): string {
  const lines = rounds.map((r) => {
    const parts = [
      new Date(r.endedAt).toISOString(),
      `trigger=${r.trigger}`,
      `sync=${r.syncId}`,
      `round=${r.round}`,
      `ms=${Math.max(0, r.endedAt - r.startedAt)}`,
      `applied=${r.applied}`,
      `shipped=${r.shipped}`,
      `landed=${r.landed}/${r.landedBytes}B`,
      `elided=${r.elided}`,
      `blocked=${r.blocked}`,
      `hasMore=${r.hasMore}`,
      `outboundHasMore=${r.outboundHasMore}`,
      `bytesHasMore=${r.bytesHasMore}`,
    ];
    if (r.stopReason !== null) parts.push(`stop=${r.stopReason}`);
    return parts.join(" ");
  });
  return lines.join("\n");
}
