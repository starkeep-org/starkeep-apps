import { DatabaseSync } from "node:sqlite";
import type { HLCClock } from "@starkeep/protocol-primitives";
import { initializeLocalSchema } from "@starkeep/storage-sqlite";
import type { RawDatabase } from "@starkeep/storage-adapter";
import { createPhotosAppData } from "../../src/photos/app-data";

export function photosDataFixture(clock: HLCClock) {
  const sqlite = new DatabaseSync(":memory:");
  const db: RawDatabase = {
    exec: (sql) => sqlite.exec(sql),
    prepare: (sql) => {
      const stmt = sqlite.prepare(sql);
      return {
        run: (...p: unknown[]) => stmt.run(...(p as never[])),
        get: (...p: unknown[]) => stmt.get(...(p as never[])),
        all: (...p: unknown[]) => stmt.all(...(p as never[])),
      };
    },
  };
  initializeLocalSchema(db);
  return { data: createPhotosAppData(db, clock), close: () => sqlite.close() };
}
