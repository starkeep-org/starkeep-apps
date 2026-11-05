/**
 * Albums: a grouping the person curates, kept as a label on each member.
 *
 * Membership is the cross-app label `photos/album=<albumId>` on each original.
 * A label rather than a row in Photos' own tables because the platform can
 * read labels: a public share follows an album by its label, labels already
 * sync to every node Photos runs on, and two devices adding one photo to two
 * albums keep both additions, since each `(record, key, value)` row is its own
 * last-writer-wins domain.
 *
 * The value is a random id, never the album's name. The value is part of the
 * row's identity, so a name there would merge two albums that share a name,
 * split an album renamed while a device was offline, break a public share on
 * rename, and cost two label rows per member for every rename. The names, the
 * cover and the creation time live in Photos' syncable `albums` table.
 *
 * See `~/projects/starkeep/proposal-public-sharing-albums-2026-11-05.md`,
 * section "Albums".
 */

import { PHOTOS_APP_ID, PHOTOS_LABEL_KEYS, type LabelledRecord } from "./labels";

/** 128 random bits, as 32 lowercase hex characters. */
const ALBUM_ID = /^[0-9a-f]{32}$/;

/** The longest album title Photos stores. */
export const ALBUM_TITLE_MAX = 200;

/** An album as Photos' own table holds it. */
export interface Album {
  readonly id: string;
  readonly title: string;
  readonly coverRecordId: string | null;
  readonly createdAtMs: number;
}

export function isAlbumId(value: unknown): value is string {
  return typeof value === "string" && ALBUM_ID.test(value);
}

export function newAlbumId(random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  return Array.from(random(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The albums a record belongs to, read off Photos' own labels.
 *
 * A record with a parent belongs to none, whatever it carries: Photos labels
 * originals only, and the platform ignores the label on a child too.
 */
export function albumIdsOf(record: LabelledRecord & { parent_id?: string | null }): string[] {
  if (record.parent_id) return [];
  const ids = new Set<string>();
  for (const label of record.labels ?? []) {
    if (label.app_id !== PHOTOS_APP_ID || label.key !== PHOTOS_LABEL_KEYS.album) continue;
    if (isAlbumId(label.value)) ids.add(label.value);
  }
  return [...ids];
}

/** A title as stored: trimmed, non-empty, bounded. Null when unusable. */
export function normalizeAlbumTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const title = raw.trim();
  return title.length > 0 && title.length <= ALBUM_TITLE_MAX ? title : null;
}

/** One row of the `albums` table, as `/app-data/db/albums` returns it. */
export interface AlbumRow {
  album_id?: unknown;
  title?: unknown;
  cover_record_id?: unknown;
  created_at_ms?: unknown;
  deleted?: unknown;
}

/** The live albums among the rows, newest first. A malformed row is skipped. */
export function albumsFromRows(rows: readonly AlbumRow[]): Album[] {
  const out: Album[] = [];
  for (const row of rows) {
    if (row.deleted === true || row.deleted === 1 || row.deleted === "true") continue;
    if (!isAlbumId(row.album_id)) continue;
    const title = normalizeAlbumTitle(row.title);
    if (title === null) continue;
    out.push({
      id: row.album_id,
      title,
      coverRecordId: typeof row.cover_record_id === "string" ? row.cover_record_id : null,
      createdAtMs: Number(row.created_at_ms) || 0,
    });
  }
  return out.sort((a, b) => b.createdAtMs - a.createdAtMs || a.id.localeCompare(b.id));
}

/** Membership changes per label request. DSQL caps a write at 3,000 rows. */
export const MEMBERS_PER_REQUEST = 1_000;

export function chunk<T>(items: readonly T[], size: number = MEMBERS_PER_REQUEST): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The cover an album shows: its chosen cover while still a member, else its newest member. */
export function coverOf<T extends { id: string }>(album: Album, members: readonly T[]): T | null {
  if (album.coverRecordId) {
    const chosen = members.find((m) => m.id === album.coverRecordId);
    if (chosen) return chosen;
  }
  return members[0] ?? null;
}
