/**
 * The sync state of one app's private channel, beside the Drive channel's.
 *
 * The phone runs two engines against one database: Drive's, which carries the
 * photographs, and Photos' own, which carries its private rows. Each needs its
 * own watermarks, floors and byte watermarks, because each is a separate
 * conversation with a separate peer. Sharing them would let one channel's
 * watermark claim coverage the other never had.
 *
 * The phone's copy of the desktop's `createPerAppSyncStateStore`
 * (`apps/local-data-server/per-app-sync-state-store.ts`): the same keys,
 * prefixed with the app id, in the same `sync_state` table the Drive channel's
 * store creates. The HLC clock state passes through, because a node has one
 * clock whichever channel a write travels on.
 *
 * It also remembers whether the channel has completed a pull. See
 * {@link ChannelSyncState.pulled}.
 */

import type { RawDatabase } from "@starkeep/storage-adapter";
import type { SyncStateStore, Watermarks } from "@starkeep/sync-engine";
import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
} from "kysely";

export interface ChannelSyncState extends SyncStateStore {
  /**
   * Whether the channel has completed a pull on this library: one sync that
   * drained what the cloud held. Until then a local row may be missing columns
   * another device set, and a write to it would blank them everywhere, because
   * the applier resolves conflicts per row and a scan ships whole rows.
   */
  pulled(): boolean;
  /** Record a completed pull. */
  markPulled(): void;
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

/**
 * `underlying` must be the Drive channel's store over the same `db`: it
 * creates the `sync_state` table, and it holds the node's clock state.
 */
export function createChannelSyncStateStore(
  db: RawDatabase,
  underlying: SyncStateStore,
  appId: string,
): ChannelSyncState {
  const key = (name: string) => `${appId}:${name}`;

  // sql.raw("?") leaves positional placeholders in the compiled SQL so the
  // statements can be prepared once here and bound per call below.
  const getStmt = db.prepare(
    qb.selectFrom("sync_state").select("value_json").where("key", "=", sql.raw("?")).compile().sql,
  );
  const setStmt = db.prepare(
    qb
      .insertInto("sync_state")
      .values({
        key: sql.raw("?"),
        value_json: sql.raw("?"),
        updated_at: sql`strftime('%s','now')`,
      })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet((eb) => ({
          value_json: eb.ref("excluded.value_json"),
          updated_at: eb.ref("excluded.updated_at"),
        })),
      )
      .compile().sql,
  );

  function getJson<T>(name: string): T | null {
    const row = getStmt.get(key(name)) as { value_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.value_json) as T;
  }

  function setJson<T>(name: string, value: T): void {
    setStmt.run(key(name), JSON.stringify(value));
  }

  return {
    async getWatermarks(): Promise<Watermarks> {
      return getJson<Watermarks>("watermarks") ?? {};
    },
    async setWatermarks(watermarks: Watermarks): Promise<void> {
      setJson("watermarks", watermarks);
    },
    async getPeerWatermarks(): Promise<Watermarks> {
      return getJson<Watermarks>("peer_watermarks") ?? {};
    },
    async setPeerWatermarks(watermarks: Watermarks): Promise<void> {
      setJson("peer_watermarks", watermarks);
    },
    async getRepairFloors(): Promise<Watermarks> {
      return getJson<Watermarks>("repair_floors") ?? {};
    },
    async setRepairFloors(floors: Watermarks): Promise<void> {
      setJson("repair_floors", floors);
    },
    async getInboundFloors(): Promise<Watermarks> {
      return getJson<Watermarks>("inbound_floors") ?? {};
    },
    async setInboundFloors(floors: Watermarks): Promise<void> {
      setJson("inbound_floors", floors);
    },
    async getByteWatermarks(): Promise<Watermarks | null> {
      return getJson<Watermarks>("byte_watermarks");
    },
    async setByteWatermarks(watermarks: Watermarks): Promise<void> {
      setJson("byte_watermarks", watermarks);
    },
    async getPeerByteWatermarks(): Promise<Watermarks | null> {
      return getJson<Watermarks>("peer_byte_watermarks");
    },
    async setPeerByteWatermarks(watermarks: Watermarks): Promise<void> {
      setJson("peer_byte_watermarks", watermarks);
    },
    // One clock per node, whichever channel a write travels on.
    getHlcClockState() {
      return underlying.getHlcClockState();
    },
    setHlcClockState(state: { wallTime: number; counter: number }) {
      return underlying.setHlcClockState(state);
    },
    pulled(): boolean {
      return getJson<boolean>("pulled") === true;
    },
    markPulled(): void {
      setJson("pulled", true);
    },
  };
}
