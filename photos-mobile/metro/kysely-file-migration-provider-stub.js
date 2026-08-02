/**
 * Stands in for `kysely/dist/esm/migration/file-migration-provider.js`.
 *
 * Kysely's barrel re-exports `FileMigrationProvider`, whose `getMigrations()`
 * does `await import(path.join(folder, fileName))` — a dynamic import of a
 * runtime-computed specifier. Hermes cannot compile that ("Invalid expression
 * encountered"), so its mere presence in the graph fails the whole bundle, even
 * though nothing on a handset ever constructs it.
 *
 * Reading migrations off a filesystem directory is a server-side operation with
 * no meaning on a phone, and core's guidance is that migrations are a production
 * concern rather than something in play during development. So the honest shim
 * is a class that exists for the barrel's sake and throws if anyone ever calls
 * it, rather than a silent no-op that would make a real mistake look like an
 * empty migration set.
 *
 * Wired up in `../metro.config.js`.
 */

export class FileMigrationProvider {
  async getMigrations() {
    throw new Error(
      "FileMigrationProvider is not available on React Native: it reads migration " +
        "files from disk with a dynamic import Hermes cannot compile. If this throws, " +
        "something is trying to run filesystem migrations on a device.",
    );
  }
}
