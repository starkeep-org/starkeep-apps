/**
 * Throwing away everything this node has indexed.
 *
 * ## What this deletes, and what it emphatically does not
 *
 * It deletes the node's **database** — records, labels, sync watermarks and the
 * alias table — and the node's **object store**, which holds renditions and any
 * blobs fetched from a peer.
 *
 * It does not touch a single photograph. The originals were never copied here:
 * import aliases them to the MediaStore assets that already hold them
 * (`import-loop-design.md` §2), so what is deleted is Starkeep's *index of* the
 * camera roll, not the camera roll. That the worst case of this function is
 * "re-import everything" rather than "the photos are gone" is a property of the
 * design worth relying on — the same reason `DeviceMediaObjectStorage.delete()`
 * drops an alias row and never an asset.
 *
 * ## Why it lives here rather than in `platform.ts`
 *
 * `platform.ts` is the one deliberately untestable file, and a destructive
 * operation is the last thing that should sit in it. The paths come in as
 * arguments, so "does this ever delete something it was not given" is a test in
 * Node rather than a promise in a comment.
 *
 * ## What survives
 *
 * The **node identity**. It is not data, it is who this device is: it is
 * stamped into every HLC timestamp, and regenerating it would make the phone
 * look like a brand new peer to everyone it has ever synced with. The session
 * survives too — signing out is a separate action, offered separately.
 */

import type { ExpoFileSystem } from "./storage/expo-object-storage";

export interface NodeDataPaths {
  readonly databasePath: string;
  readonly objectsPath: string;
}

/**
 * Delete this node's database and object store.
 *
 * The node must already be closed. SQLite holds the file open, and deleting it
 * from underneath a live connection is how a database ends up half-there.
 */
export function clearNodeFiles(fs: ExpoFileSystem, paths: NodeDataPaths): void {
  // `-wal` and `-shm` too. A reset that left the write-ahead log behind can
  // resurrect rows the main file no longer has, which reads as "clearing did
  // not work" long after anyone has stopped suspecting the reset.
  for (const path of [
    paths.databasePath,
    `${paths.databasePath}-wal`,
    `${paths.databasePath}-shm`,
  ]) {
    const file = fs.file(path);
    if (file.exists) file.delete();
  }

  const objects = fs.directory(paths.objectsPath);
  if (objects.exists) objects.delete();
}
