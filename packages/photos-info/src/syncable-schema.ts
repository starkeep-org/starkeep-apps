/**
 * Photos' private tables, as its manifest declares them.
 *
 * The manifest stays where the install bundle reads it,
 * `photos/starkeep.manifest.json`. This passes along its `appSpecificSyncable`
 * block and nothing else, so Photos Mobile creates the tables the web app's
 * install creates without depending on the web app. One manifest stays the
 * single source of the schema: a column added there reaches the phone with its
 * next build.
 */

import manifest from "../../../photos/starkeep.manifest.json";

/** One column of a private table, as the manifest declares it. */
export interface SyncableColumn {
  readonly name: string;
  /** A platform column type; the manifest validator checks it at install. */
  readonly type: string;
  readonly notNull?: boolean;
  readonly primaryKey?: boolean;
}

/** The manifest's `appSpecificSyncable` block. */
export interface SyncableSchema {
  readonly files: boolean;
  readonly tables: readonly {
    readonly name: string;
    readonly columns: readonly SyncableColumn[];
    readonly indexes?: readonly { readonly columns: readonly string[] }[];
  }[];
}

export const photosSyncableSchema: SyncableSchema =
  manifest.infraRequirements.appSpecificSyncable;
