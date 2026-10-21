/**
 * Deleting a library item from the phone.
 *
 * ## What a delete is
 *
 * The same delete Photos web makes through its data server
 * (`stand-ins/delete.ts` in `@starkeep/shared-space-api`): the original, every
 * child of it, and each one's metadata and labels become tombstones. Sync
 * carries them to every node, and each record sits in Drive's Trash until the
 * reaper removes its bytes. The phone reads the adapter directly rather than
 * through that package, so the cascade is written here.
 *
 * ## What happens to the camera-roll file
 *
 * Nothing, here. The alias stays: it is what keeps import from bringing the
 * record back while the asset is still in the camera roll (`alreadyImported`
 * counts a tombstone as imported). This answers the asset URIs instead, and
 * the caller asks Android to move them to its trash, which needs the person's
 * confirmation in a system dialog. Declining that leaves the Starkeep delete
 * standing.
 */

import type { DataRecord, HLCClock, StarkeepId } from "@starkeep/protocol-primitives";
import type { DatabaseAdapter } from "@starkeep/storage-adapter";
import type { MediaAliasStore } from "../media/media-alias";

/** Upper bound on one original's children; the platform's own delete uses the same. */
const MAX_CHILDREN = 1_000;

export interface DeleteRecordDeps {
  readonly database: Pick<
    DatabaseAdapter,
    "get" | "query" | "delete" | "tombstoneMetadata" | "tombstoneLabelsForRecord"
  >;
  readonly clock: HLCClock;
  readonly aliases: Pick<MediaAliasStore, "ofRecord"> | null;
  /** Whether a camera-roll URI still names an asset. */
  readonly assetExists: (uri: string) => boolean;
}

export interface DeleteRecordOutcome {
  /** False when the record was already gone or deleted. */
  readonly deleted: boolean;
  /** The camera-roll assets that hold this record's bytes, for the trash request. */
  readonly cameraRollUris: readonly string[];
}

/**
 * Tombstone `recordId` and its children, and answer its camera-roll assets.
 *
 * Children first, each with its own clock reading, as the platform's delete
 * does: a peer applying rows in clock order then never holds a live child of a
 * deleted original.
 */
export async function deleteLibraryRecord(
  deps: DeleteRecordDeps,
  recordId: StarkeepId,
): Promise<DeleteRecordOutcome> {
  const record = await deps.database.get(recordId);
  if (!record || record.deletedAt) return { deleted: false, cameraRollUris: [] };

  const children = await deps.database.query({
    filters: [
      { field: "parentId", operator: "eq", value: record.id },
      { field: "deletedAt", operator: "isNull" },
    ],
    limit: MAX_CHILDREN,
  });
  for (const row of [...children.records, record] as DataRecord[]) {
    const hlc = deps.clock.now();
    await deps.database.delete(row.id as StarkeepId, hlc);
    await deps.database.tombstoneMetadata(row.type, row.id as StarkeepId, hlc);
    await deps.database.tombstoneLabelsForRecord(row.id as StarkeepId, hlc);
  }

  const cameraRollUris = (deps.aliases?.ofRecord(record.id) ?? [])
    .map((alias) => mediaStoreItemUri(alias.contentUri))
    .filter((uri): uri is string => uri !== null && deps.assetExists(uri));
  return { deleted: true, cameraRollUris: [...new Set(cameraRollUris)] };
}

/**
 * The bare MediaStore item URI, or null for anything else.
 *
 * An alias may carry `requireOriginal=1`, and Android's trash request takes the
 * item's own URI.
 */
export function mediaStoreItemUri(uri: string): string | null {
  if (!uri.startsWith("content://media/")) return null;
  return uri.split("?")[0]!;
}
