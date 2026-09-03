/**
 * Where the video is inside a Motion Photo, so that opening a photograph does
 * not cost a whole-file read to discover it has none.
 *
 * ## Why this table exists and no second blob does
 *
 * An Android Motion Photo is **one file**: the still, the gain map and a
 * trailing MP4, described in XMP. Import mints one `image/jpeg` record whose
 * blob is the whole thing, and that is the model the rest of the system already
 * uses — the record is budgeted, synced and evicted as one image, because the
 * video was always inside it.
 *
 * So nothing here stores a clip. Six small columns record where the clip sits
 * inside bytes this node already holds, which is what lets the viewer offer
 * playback without a scan and lets an ordinary photograph be opened without one
 * either. Remembering an offset is not storing a video.
 *
 * ## Why the key is the object storage key
 *
 * Because the key is the content hash, and these are facts about the bytes
 * rather than about the record. Two records for the same photograph share one
 * row, and a row survives the re-import that mints a new record id after an
 * interrupted import — which is exactly the crash window `import.ts` is built
 * around.
 *
 * ## Why this is not the alias table
 *
 * `media-alias.ts` states that the alias table must never become an authority on
 * anything but where to look for bytes. A byte range *inside* a file is a
 * different claim about a different thing, and the two tables answer for
 * different sets: an alias exists only for a camera-roll asset, and a Motion
 * Photo can also arrive by sync.
 *
 * ## The two kinds of row, and the one timestamp
 *
 * A row can say "the clip is at this offset" or "there is no clip here". The
 * negative row is what keeps the fallback scan in `motion-photo-playback.ts` from being
 * paid again every time somebody opens the same old photograph.
 *
 * Import writes only the positive kind, because a negative row per still would
 * be a row per image record — sixty thousand of them saying nothing. What makes
 * that safe is {@link MotionIndexStore.scannedFrom}: for a record this node
 * imported at or after that moment, import already looked, so the absence of a
 * row *is* the answer. Below it, absence means nobody has looked yet.
 */

import type { RawDatabase } from "@starkeep/storage-adapter";
import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
} from "kysely";
import type { MotionPhotoVideo } from "./motion-photo";

export interface MotionIndexStore {
  /**
   * Where the clip is, or null.
   *
   * Null covers both "scanned, and there is no clip" and "never scanned" —
   * {@link scanned} is what tells them apart, and only a caller deciding whether
   * to pay for a read needs to ask.
   */
  get(objectStorageKey: string): MotionPhotoVideo | null;
  /** Whether anything has ever looked inside these bytes. */
  scanned(objectStorageKey: string): boolean;
  /**
   * Which of these keys are known to hold a clip.
   *
   * Batched because the caller is a grid. A page of sixty tiles asking
   * {@link get} sixty times is sixty statements to answer one question, and
   * `library.ts` already refuses that shape for renditions and for video
   * durations. Keys with a negative row and keys with no row are both absent
   * from the result: a tile marks motion it is sure of, and neither "looked and
   * found none" nor "nobody looked" is that.
   */
  withMotion(objectStorageKeys: readonly string[]): ReadonlySet<string>;
  /** Record what a scan found, including that it found nothing. */
  record(objectStorageKey: string, video: MotionPhotoVideo | null): void;
  /**
   * When this node began looking for motion at import time, or null if never.
   *
   * A record imported at or after this moment was scanned on the way in, so its
   * absence from this table is an answer rather than an omission. See the header.
   */
  scannedFrom(): number | null;
  /** Set {@link scannedFrom}, once. A later call over a set value does nothing. */
  markScannedFrom(nowMs: number): void;
}

type DB = Record<string, Record<string, unknown>>;
const qb = new Kysely<DB>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

const TABLE = "motion_photo_index";
const MARKER_TABLE = "motion_index_scanned_at";

/**
 * What `via` holds for a scan that found nothing.
 *
 * A value in the column that already discriminates the two XMP dialects, rather
 * than a nullable column of its own: "which dialect described this" and "was
 * anything described" are the same question asked twice, and two columns
 * answering it is two columns that can disagree.
 */
const NO_MOTION = "none";

interface Row {
  object_storage_key: string;
  offset: number;
  length: number;
  mime_type: string;
  presentation_us: number | null;
  via: string;
}

function toVideo(row: Row): MotionPhotoVideo | null {
  if (row.via === NO_MOTION) return null;
  return {
    offset: row.offset,
    length: row.length,
    mimeType: row.mime_type,
    via: row.via as MotionPhotoVideo["via"],
    ...(row.presentation_us === null ? {} : { presentationTimestampUs: row.presentation_us }),
  };
}

export function createSqliteMotionIndexStore(options: {
  readonly db: RawDatabase;
}): MotionIndexStore {
  const { db } = options;

  db.exec(
    qb.schema
      .createTable(TABLE)
      .ifNotExists()
      .addColumn("object_storage_key", "text", (c) => c.primaryKey())
      .addColumn("offset", "integer", (c) => c.notNull())
      .addColumn("length", "integer", (c) => c.notNull())
      .addColumn("mime_type", "text", (c) => c.notNull())
      .addColumn("presentation_us", "integer")
      .addColumn("via", "text", (c) => c.notNull())
      .compile().sql,
  );
  db.exec(
    qb.schema
      .createTable(MARKER_TABLE)
      .ifNotExists()
      // A fixed primary key, so the table is structurally incapable of holding
      // a second marker that could disagree with the first. Same shape and same
      // argument as `import-cursor.ts`.
      .addColumn("id", "integer", (c) => c.primaryKey())
      .addColumn("scanned_from_ms", "integer")
      .compile().sql,
  );

  const getStmt = db.prepare(
    qb.selectFrom(TABLE).selectAll().where("object_storage_key", "=", sql.raw("?")).compile().sql,
  );
  const putStmt = db.prepare(
    qb
      .insertInto(TABLE)
      .values({
        object_storage_key: sql.raw("?"),
        offset: sql.raw("?"),
        length: sql.raw("?"),
        mime_type: sql.raw("?"),
        presentation_us: sql.raw("?"),
        via: sql.raw("?"),
      })
      .onConflict((oc) =>
        // A re-scan of the same bytes is not an error and must land, because a
        // later reader is entitled to the newer answer: the same key can be
        // written by import and again by the viewer's fallback, and a row that
        // refused to move would keep whichever ran first.
        oc.column("object_storage_key").doUpdateSet((eb) => ({
          offset: eb.ref("excluded.offset"),
          length: eb.ref("excluded.length"),
          mime_type: eb.ref("excluded.mime_type"),
          presentation_us: eb.ref("excluded.presentation_us"),
          via: eb.ref("excluded.via"),
        })),
      )
      .compile().sql,
  );
  const markerGetStmt = db.prepare(
    qb.selectFrom(MARKER_TABLE).select("scanned_from_ms").where("id", "=", sql.lit(0)).compile()
      .sql,
  );
  const markerSetStmt = db.prepare(
    qb
      .insertInto(MARKER_TABLE)
      .values({ id: sql.lit(0), scanned_from_ms: sql.raw("?") })
      // Nothing on conflict, deliberately. The marker names when this node
      // *started* looking, so moving it forward would silently reclassify every
      // record imported in between as covered when nothing scanned it.
      .onConflict((oc) => oc.column("id").doNothing())
      .compile().sql,
  );

  return {
    get(objectStorageKey) {
      const row = getStmt.get(objectStorageKey) as Row | undefined;
      return row ? toVideo(row) : null;
    },
    scanned(objectStorageKey) {
      return getStmt.get(objectStorageKey) !== undefined;
    },
    withMotion(objectStorageKeys) {
      const found = new Set<string>();
      if (objectStorageKeys.length === 0) return found;
      // Built per call rather than prepared once, because the placeholder count
      // is the page size and a prepared statement has a fixed one. The page is
      // the unit either way, so this is one statement per page against the
      // sixty it replaces.
      const stmt = db.prepare(
        qb
          .selectFrom(TABLE)
          .select("object_storage_key")
          .where(
            "object_storage_key",
            "in",
            objectStorageKeys.map(() => sql.raw("?")),
          )
          .where("via", "!=", sql.lit(NO_MOTION))
          .compile().sql,
      );
      for (const row of stmt.all(...objectStorageKeys) as { object_storage_key: string }[]) {
        found.add(row.object_storage_key);
      }
      return found;
    },
    record(objectStorageKey, video) {
      putStmt.run(
        objectStorageKey,
        video?.offset ?? 0,
        video?.length ?? 0,
        video?.mimeType ?? "",
        video?.presentationTimestampUs ?? null,
        video?.via ?? NO_MOTION,
      );
    },
    scannedFrom() {
      const row = markerGetStmt.get() as { scanned_from_ms: number | null } | undefined;
      return row?.scanned_from_ms ?? null;
    },
    markScannedFrom(nowMs) {
      markerSetStmt.run(nowMs);
    },
  };
}
