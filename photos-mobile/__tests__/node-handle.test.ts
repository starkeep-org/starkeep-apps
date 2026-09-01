/**
 * One node per process.
 *
 * The defect this prevents is two SQLite connections to one file — the screen's
 * and the background tick's — meeting as an immediate `SQLITE_BUSY` rather than
 * as a wait. It is invisible on a handset until a window happens to open while
 * the app is backgrounded but alive, which is the ordinary case rather than a
 * corner, so the counting is asserted here instead.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  acquireNode,
  closeNodeForReset,
  nodeHolders,
  resetNodeHandleForTests,
  type OpenNode,
} from "../src/work/node-handle";

function opener() {
  const close = vi.fn(async () => undefined);
  let built = 0;
  const open: () => Promise<OpenNode> = async () => {
    built += 1;
    return {
      node: { close } as unknown as OpenNode["node"],
      identity: { nodeId: "n1" } as OpenNode["identity"],
      deviceKey: {} as OpenNode["deviceKey"],
    };
  };
  return { open, close, builds: () => built };
}

beforeEach(() => resetNodeHandleForTests());

it("builds one node for two callers arriving together", async () => {
  const o = opener();
  // The ordinary case on a cold launch: the screen mounts and the tick starts
  // within the same second.
  const [a, b] = await Promise.all([acquireNode(o.open), acquireNode(o.open)]);
  expect(o.builds()).toBe(1);
  expect(a.node).toBe(b.node);
  expect(nodeHolders()).toBe(2);
});

it("keeps the database open while anyone still holds a claim", async () => {
  const o = opener();
  const a = await acquireNode(o.open);
  const b = await acquireNode(o.open);
  await a.release();
  expect(o.close).not.toHaveBeenCalled();
  await b.release();
  expect(o.close).toHaveBeenCalledTimes(1);
});

it("ignores a claim released twice", async () => {
  const o = opener();
  const a = await acquireNode(o.open);
  await a.release();
  await a.release();
  expect(o.close).toHaveBeenCalledTimes(1);
  expect(nodeHolders()).toBe(0);
});

it("opens a fresh node after the last holder lets go", async () => {
  const o = opener();
  await (await acquireNode(o.open)).release();
  await acquireNode(o.open);
  expect(o.builds()).toBe(2);
});

it("does not cache a failed bring-up as the node", async () => {
  // Otherwise one transient failure at launch is inherited by every later
  // caller for the life of the process.
  let attempt = 0;
  const open = async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("disk full");
    return {
      node: { close: async () => undefined } as unknown as OpenNode["node"],
      identity: { nodeId: "n1" } as OpenNode["identity"],
      deviceKey: {} as OpenNode["deviceKey"],
    };
  };
  await expect(acquireNode(open)).rejects.toThrow("disk full");
  expect(nodeHolders()).toBe(0);
  await expect(acquireNode(open)).resolves.toBeDefined();
});

describe("reset", () => {
  it("closes the node and invalidates outstanding claims", async () => {
    const o = opener();
    const held = await acquireNode(o.open);
    await closeNodeForReset();
    expect(o.close).toHaveBeenCalledTimes(1);
    expect(nodeHolders()).toBe(0);

    // The screen's cleanup runs after the reset with a claim on a node that no
    // longer exists. Counting it would drive the total negative and close the
    // replacement the moment a second caller let go of it.
    await held.release();
    expect(nodeHolders()).toBe(0);

    const fresh = await acquireNode(o.open);
    expect(nodeHolders()).toBe(1);
    expect(o.close).toHaveBeenCalledTimes(1);
    await fresh.release();
    expect(o.close).toHaveBeenCalledTimes(2);
  });

  it("is safe when nothing is open", async () => {
    await expect(closeNodeForReset()).resolves.toBeUndefined();
  });
});
