/**
 * One node per process, shared by everything that wants one.
 *
 * ## The problem this removes
 *
 * `useNode` opened a node per screen mount and the background task would open
 * its own. Both call `bringUpNode`, both open the same SQLite file, and
 * `op-sqlite-driver.ts` sets no busy timeout — so two writers meet as an
 * immediate `SQLITE_BUSY` rather than as a wait.
 *
 * The two can genuinely coexist. Android's scheduler refuses to run a task
 * while the app is foregrounded, but "foregrounded" is not "the process is
 * gone": an app sitting in the background keeps its React tree, and its node,
 * alive while a window opens around it. Expo's `TaskService` delivers a task to
 * the running JavaScript context when the process is alive and starts a
 * headless one only when it is not, so the two would land in one runtime — and
 * a module-scope singleton is therefore exactly the right scope for the
 * guarantee.
 *
 * ## Why a reference count rather than "open it and never close it"
 *
 * A headless window should give the database back when it ends. Leaving SQLite
 * open in a process the OS is about to freeze is how the next launch finds a
 * lock nobody holds. Counting means the screen and the tick can each say when
 * they are done without either having to know about the other.
 *
 * ## What this deliberately does not do
 *
 * Serialize *operations*. `MobileNode` already serializes `sync`, `exchange`
 * and `verify` against each other, and sharing one node is what lets that
 * guarantee apply to a screen and a background tick together. Adding a second
 * lock here would be a second answer to a question the node has already
 * answered.
 */

import type { MobileNode } from "../node";
import type { NodeIdentity } from "../node-identity";
import type { DeviceKey } from "../auth/device-key";

/**
 * How the node gets built.
 *
 * Injectable, and lazily imported by default, for the reason `power-state.ts`
 * takes its module the same way: `platform.ts` reaches for op-sqlite,
 * expo-file-system and expo-media-library at module scope, so importing it
 * makes a file unloadable outside React Native. Deferring the import to the
 * call keeps the reference counting testable in Node, where it is the only part
 * of this file that can be got wrong.
 */
export type NodeOpener = () => Promise<OpenNode>;

const defaultOpener: NodeOpener = async () => (await import("../platform")).bringUpNode();

export interface OpenNode {
  readonly node: MobileNode;
  readonly identity: NodeIdentity;
  readonly deviceKey: DeviceKey;
}

/** An open node, plus the caller's claim on it. */
export interface NodeLease extends OpenNode {
  /** Give the claim back. Idempotent — a lease released twice releases once. */
  release(): Promise<void>;
}

/**
 * The one node, or the attempt to build it.
 *
 * The *promise* is stored rather than the result, so two callers arriving
 * together share one bring-up instead of racing to open the same database
 * twice. That race is the ordinary case rather than a corner: the screen mounts
 * and the tick starts within the same second of a cold launch.
 */
let opening: Promise<OpenNode> | null = null;
let holders = 0;
/**
 * Bumped whenever the node is torn down out from under its holders.
 *
 * A reset closes the node while leases are still outstanding, and those leases
 * are then claims on something that no longer exists. Without a generation the
 * screen's cleanup would release a claim it no longer holds and drive the count
 * negative, which would close the *replacement* node the moment a second
 * caller let go of it.
 */
let epoch = 0;

/**
 * Take a claim on the node, opening it if nobody has one.
 *
 * Throws what `bringUpNode` throws. A caller that cannot open the database has
 * nothing to do, and the screen already renders that failure as a state.
 */
export async function acquireNode(opener: NodeOpener = defaultOpener): Promise<NodeLease> {
  const mine = epoch;
  holders += 1;
  const attempt = (opening ??= opener());
  let open: OpenNode;
  try {
    open = await attempt;
  } catch (err) {
    // A failed bring-up must not leave the failure cached as the node, or every
    // later caller inherits one transient error for the life of the process.
    if (epoch === mine) holders -= 1;
    if (opening === attempt) opening = null;
    throw err;
  }

  let released = false;
  return {
    ...open,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      // A lease from before a reset is a claim on a node that has already been
      // closed and deleted. Letting it decrement would corrupt the count for
      // the node that replaced it.
      if (epoch !== mine) return;
      holders -= 1;
      if (holders > 0) return;
      // Last one out closes the database. Cleared before the await so a caller
      // arriving mid-close opens a fresh node rather than receiving a handle to
      // one that is shutting down.
      opening = null;
      await open.node.close();
    },
  };
}

/**
 * Close the node whoever holds it, and forget it.
 *
 * For the reset path, which has to close SQLite before deleting the file out
 * from under it. Every outstanding lease is invalidated by this — which is the
 * honest shape of the operation, since the thing they hold a claim on is being
 * deleted.
 */
export async function closeNodeForReset(): Promise<void> {
  const attempt = opening;
  opening = null;
  holders = 0;
  epoch += 1;
  if (attempt === null) return;
  const open = await attempt.catch(() => null);
  if (open !== null) await open.node.close();
}

/** How many claims are outstanding. For the debug section and for tests. */
export function nodeHolders(): number {
  return holders;
}

/**
 * Forget everything, without closing anything.
 *
 * For tests only, and deliberately not exported through anything the app
 * imports: production has exactly one process-wide node and no reason to
 * abandon one without closing it.
 */
export function resetNodeHandleForTests(): void {
  opening = null;
  holders = 0;
  epoch += 1;
}
