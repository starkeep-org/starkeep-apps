/**
 * Metro configuration.
 *
 * The `@starkeep/*` packages this app runs on come from npm, so they resolve
 * inside the project like any other dependency and need no help here.
 *
 * ## Developing against an unpublished core
 *
 * The phone is what validates core's residency work, so the two get developed
 * together, and waiting on a publish to test a core change on a handset is the
 * wrong loop. To point at a sibling `starkeep-core` checkout instead, add
 * scoped overrides to `../package.json`:
 *
 *     "@starkeep/photos-mobile>@starkeep/sync-engine":
 *       "link:../starkeep-core/packages/sync-engine"
 *
 * (scoped to this package so `photos` keeps resolving from the registry), and
 * then teach Metro about the paths that move outside the project:
 *
 *     const coreRoot = path.resolve(projectRoot, "../../starkeep-core");
 *     config.watchFolders = [workspaceRoot, coreRoot];
 *     config.resolver.nodeModulesPaths = [
 *       path.resolve(projectRoot, "node_modules"),     // React must win here
 *       path.resolve(workspaceRoot, "node_modules"),
 *       path.resolve(coreRoot, "node_modules"),        // kysely, ulidx, valibot
 *     ];
 *
 * Both halves are needed. Metro resolves symlinks but only *serves* files under
 * a watched folder, and only resolves modules from the `nodeModulesPaths` it is
 * given; miss either and the failure is a missing-module error pointing at the
 * importer rather than at the link. Keep this app's own `node_modules` first —
 * a linked package picking up a second copy of React is the classic cause of
 * "invalid hook call" on a device.
 *
 * Remember to remove both when the core change is published.
 */

const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "..");

const config = getDefaultConfig(projectRoot);

/**
 * Currently linked: `@starkeep/sync-engine`.
 *
 * `HttpObjectStorageAdapter` moved into it from `apps/local-data-server` so the
 * phone could have a `remoteObjectStorage` at all, and that change is not
 * published yet. The scoped override in `../package.json` points this package
 * (and only this package — `photos` keeps resolving from the registry) at the
 * sibling checkout; the paths below are the other half of it.
 *
 * **Remove both when the change is published.** Both are needed: Metro resolves
 * symlinks but only *serves* files under a watched folder, and only resolves
 * modules from the `nodeModulesPaths` it is given. Miss either and the failure
 * is a missing-module error pointing at the importer rather than at the link.
 */
const coreRoot = path.resolve(projectRoot, "../../starkeep-core");

config.watchFolders = [workspaceRoot, coreRoot];
config.resolver.nodeModulesPaths = [
  // This app's own first, always. A linked package picking up a second copy of
  // React is the classic cause of "invalid hook call" on a device.
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
  path.resolve(coreRoot, "node_modules"),
];

/**
 * Don't watch the sibling app's build output.
 *
 * The workspace has to be watched, because that is where the hoisted
 * `node_modules` live. But it also contains `photos/`, and running that app's
 * dev server writes into `photos/.next` continuously — so Metro saw thousands
 * of file events that had nothing to do with this app and rebuilt on every one.
 * The symptom is the mobile app refreshing over and over the moment the web app
 * starts, with nothing in its logs to explain why, because nothing is wrong
 * with the app: it is being told, correctly, that files it watches changed.
 *
 * Blocked rather than narrowing `watchFolders`, because the folder genuinely
 * needs watching for its `node_modules` and only these subtrees are noise.
 */
config.resolver.blockList = [
  /\/photos\/\.next\/.*/,
  /\/photos\/\.open-next\/.*/,
  /\/photos\/out\/.*/,
  /\/photos\/test-results\/.*/,
  /\/photos\/\.turbo\/.*/,
  /\/node_modules\/\.cache\/.*/,
];

/**
 * Keep Hermes-incompatible code out of the graph.
 *
 * Kysely's barrel re-exports `FileMigrationProvider`, which does a dynamic
 * `import()` of a runtime-computed path. Hermes rejects that outright, so having
 * it anywhere in the module graph fails the bundle — reachability is irrelevant,
 * and no amount of not-calling-it helps. Since kysely ships unbundled ESM, the
 * one offending module can be swapped for a stub; see `./metro/` for why that is
 * a safe trade on a handset.
 */
const KYSELY_FILE_MIGRATION_PROVIDER = path.join(
  "kysely",
  "dist",
  "esm",
  "migration",
  "file-migration-provider.js",
);
const kyselyStub = path.resolve(projectRoot, "metro/kysely-file-migration-provider-stub.js");

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolved = (defaultResolveRequest ?? context.resolveRequest)(
    context,
    moduleName,
    platform,
  );
  if (
    resolved.type === "sourceFile" &&
    resolved.filePath.endsWith(KYSELY_FILE_MIGRATION_PROVIDER)
  ) {
    return { type: "sourceFile", filePath: kyselyStub };
  }
  return resolved;
};

module.exports = config;
