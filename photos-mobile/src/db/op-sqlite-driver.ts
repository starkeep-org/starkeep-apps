/**
 * A `RawDatabase` over op-sqlite, so the phone can use the existing SQLite
 * adapter rather than a second copy of it (item 11a).
 *
 * ## `prepare()` does not prepare
 *
 * op-sqlite's real prepared statements execute **asynchronously**:
 *
 * ```ts
 * PreparedStatement = { bind, bindSync, execute: () => Promise<QueryResult> }
 * ```
 *
 * and `RawDatabase` is synchronous by requirement, not by preference — the
 * change-log write happens inside the same logical operation as the record
 * write it describes, and an async gap there is a window where a record exists
 * and its change-log entry does not, which is the one state the
 * contiguous-prefix watermark cannot represent.
 *
 * So `prepare(sql)` captures the SQL string and each `run`/`get`/`all` calls
 * `executeSync(sql, params)`, which *is* synchronous and *does* bind parameters:
 *
 * ```ts
 * executeSync: (query: string, params?: Scalar[]) => QueryResult
 * ```
 *
 * **What that costs:** SQLite re-parses the statement per call, so there is no
 * statement reuse. That is a performance property and not a correctness one —
 * parameters are still bound rather than interpolated, so nothing about
 * injection, quoting or type coercion changes. Worth measuring against a
 * 60k-row library before deciding it matters, and worth *not* pre-empting by
 * making the interface async, because async is precisely what it cannot be.
 *
 * ## `executeSync` blocks the JS thread
 *
 * This is the real risk of the port, and it is not hidden here: a sync round
 * that walks thousands of rows will block interaction for as long as it takes.
 * The mitigation is that such work runs in a background task rather than during
 * interaction — which the constrained-execution model requires anyway, for
 * unrelated reasons. Anything calling this on the interaction path is a bug
 * even when it feels fast on a dev handset.
 */

import type { RawDatabase, RawStatement } from "@starkeep/storage-adapter";
import type { SqliteDriver } from "@starkeep/storage-sqlite";

/**
 * The slice of op-sqlite this needs.
 *
 * Declared structurally rather than imported so this module — and its tests —
 * do not require the native package to be installed. The real dependency is
 * supplied at the app's edge, which is also what lets the whole driver be
 * exercised in Node against a fake.
 */
export interface OpSqliteConnection {
  executeSync(query: string, params?: unknown[]): { rows?: unknown[] };
  close(): void;
}

export interface OpSqliteModule {
  open(options: { name: string; location?: string }): OpSqliteConnection;
}

/** Wrap one op-sqlite connection as the narrow interface the adapter wants. */
export function rawDatabaseFrom(connection: OpSqliteConnection): RawDatabase {
  return {
    exec(sql: string): void {
      // DDL and pragmas arrive here. op-sqlite runs only the first statement of
      // a multi-statement string on native, so anything relying on `exec` to
      // run a batch would silently apply only its first line — the schema
      // bootstrap issues one statement per call, which is why this is safe and
      // why it must stay that way.
      connection.executeSync(sql);
    },
    prepare(sql: string): RawStatement {
      // The SQL is captured, not compiled — see the note at the top.
      return {
        run(...params: unknown[]) {
          return connection.executeSync(sql, params);
        },
        get(...params: unknown[]) {
          return connection.executeSync(sql, params).rows?.[0];
        },
        all(...params: unknown[]) {
          return connection.executeSync(sql, params).rows ?? [];
        },
      };
    },
  };
}

/**
 * The driver the SQLite adapter takes.
 *
 * `path` is the adapter's vocabulary; op-sqlite wants a database *name* within
 * a directory it manages, so the last path segment becomes the name and the
 * rest becomes the location. A phone has no meaningful notion of an absolute
 * filesystem path the app may choose, which is why the translation belongs here
 * rather than in the adapter.
 *
 * The `file://` scheme is dropped for the same reason. Paths on this platform
 * originate from `expo-file-system`, whose `Paths.document.uri` is a URI, and
 * expo's own `File`/`Directory` want it that way — but op-sqlite works in plain
 * filesystem paths and merely warns before stripping the scheme itself. Both
 * vocabularies are correct for their own module, so the conversion belongs at
 * the boundary between them, which is here.
 */
/**
 * How this connection behaves when it is not the only one.
 *
 * ## Why a phone has more than one connection
 *
 * It should not, and `work/node-handle.ts` is what makes sure of it — one node
 * per process, shared by the screen and the background tick. These pragmas are
 * the insurance behind that argument rather than a substitute for it: the
 * reasoning about which JavaScript context a headless task lands in depends on
 * Expo internals, and being wrong about it should cost a wait rather than a
 * failed write.
 *
 * ## The two settings
 *
 * `busy_timeout` is the one that matters. SQLite's default is **zero** — a
 * second writer does not wait, it returns `SQLITE_BUSY` immediately — so
 * without this the failure mode of two connections is an exception rather than
 * a pause. Five seconds is far longer than any write here takes and far shorter
 * than a window.
 *
 * WAL lets a reader proceed while a writer works, which is the difference
 * between a background sync blocking a grid query and not. It also survives
 * process death cleanly, which matters on a platform that ends processes
 * without warning.
 *
 * Applied per connection, because both are connection-scoped in SQLite — WAL
 * persists in the database file, `busy_timeout` does not.
 */
export function applyConcurrencyPragmas(connection: OpSqliteConnection): void {
  // One statement per call: op-sqlite runs only the first statement of a
  // multi-statement string on native, so a batched pragma string would silently
  // apply only its first line. The same constraint the schema bootstrap works
  // under, for the same reason.
  try {
    connection.executeSync("PRAGMA journal_mode = WAL");
    connection.executeSync("PRAGMA busy_timeout = 5000");
  } catch {
    // A driver that cannot set a pragma is still a usable driver. Failing the
    // open here would turn a tuning setting into a reason the app does not
    // start, which is a worse trade than running with SQLite's defaults.
  }
}

export function createOpSqliteDriver(op: OpSqliteModule): SqliteDriver {
  const connections = new WeakMap<RawDatabase, OpSqliteConnection>();
  return {
    open(uriOrPath: string): RawDatabase {
      const path = uriOrPath.replace(/^file:\/\//, "");
      const slash = path.lastIndexOf("/");
      const name = slash >= 0 ? path.slice(slash + 1) : path;
      const location = slash > 0 ? path.slice(0, slash) : undefined;
      const connection = op.open({ name, ...(location ? { location } : {}) });
      applyConcurrencyPragmas(connection);
      const db = rawDatabaseFrom(connection);
      // Kept beside the wrapper rather than on it: `RawDatabase` deliberately
      // has no `close`, because consumers of a connection have no business
      // closing one — only whoever opened it does.
      connections.set(db, connection);
      return db;
    },
    close(db: RawDatabase): void {
      connections.get(db)?.close();
    },
  };
}
