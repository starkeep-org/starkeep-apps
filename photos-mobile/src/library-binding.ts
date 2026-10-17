/**
 * Binding this phone's library to its user.
 *
 * Every object key carries its owner's segment, `shared/<userId>/...`. A phone
 * may import photos before it is paired, so until a cloud names the user it
 * writes under `LOCAL_USER_SEGMENT`. Before the first sync, the node asks
 * `device/self` whom it syncs for and binds: it moves the files under
 * `shared/local/` and rewrites every stored key, including the phone's own
 * alias and Motion Photo tables. The database half is `@starkeep/storage-sqlite`'s
 * `library-owner.ts`, the same code the local data server binds with, and its
 * header gives the crash and sweep rules.
 *
 * The phone holds no app-specific files: it syncs only the Drive channel, so
 * nothing lives under `apps/`.
 *
 * See `~/projects/starkeep/plan-multi-user-roles-2026-10-16.md`, step 4.9.
 */

import { LOCAL_USER_SEGMENT, sharedObjectPrefix } from "@starkeep/protocol-primitives";
import type { RawDatabase } from "@starkeep/storage-adapter";
import {
  checkLibraryBindable,
  commitLibraryBinding,
  type LibraryKeyColumn,
} from "@starkeep/storage-sqlite";
import { MEDIA_ALIAS_TABLE } from "./media/media-alias";
import { MOTION_INDEX_TABLE } from "./media/motion-index";

/** The phone's own tables that store a key, beyond the ones every node has. */
const PHONE_KEY_COLUMNS: readonly LibraryKeyColumn[] = [
  { table: MEDIA_ALIAS_TABLE, column: "object_storage_key", primaryKey: true },
  { table: MOTION_INDEX_TABLE, column: "object_storage_key", primaryKey: true },
];

/** The part of the phone's object storage that binding needs. */
export interface MovableObjectStorage {
  /** Move every file under one key prefix to another. Returns how many moved. */
  movePrefix(fromPrefix: string, toPrefix: string): number;
}

export interface PhoneBindReport {
  readonly movedFiles: number;
  readonly rewrittenKeys: number;
}

/**
 * Bind the library to `userId`. Refuses a library bound to someone else, with
 * `LibraryBoundElsewhereError`. For a library already bound to `userId`,
 * sweeps up anything still under `local`.
 */
export function bindPhoneLibrary(
  db: RawDatabase,
  storage: MovableObjectStorage | null,
  userId: string,
): PhoneBindReport {
  checkLibraryBindable(db, userId);
  const movedFiles = storage
    ? storage.movePrefix(`shared/${LOCAL_USER_SEGMENT}/`, sharedObjectPrefix(userId))
    : 0;
  const rewrittenKeys = commitLibraryBinding(db, userId, PHONE_KEY_COLUMNS);
  return { movedFiles, rewrittenKeys };
}
