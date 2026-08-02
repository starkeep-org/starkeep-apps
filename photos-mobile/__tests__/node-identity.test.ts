/**
 * The device's node id survives a restart — the property that is otherwise only
 * checkable by killing an app on a handset.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { loadNodeIdentity } from "../src/node-identity";
import { fakeExpoFs } from "./helpers/fake-expo-fs";

const PATH = "/docs/starkeep/node.json";

let fs: ReturnType<typeof fakeExpoFs>;
let issued: number;
const generate = () => `node-${(issued += 1)}`;

beforeEach(() => {
  fs = fakeExpoFs();
  issued = 0;
});

describe("loadNodeIdentity", () => {
  it("generates and persists an id on first launch", async () => {
    const first = await loadNodeIdentity(fs.fs, PATH, generate);
    expect(first).toEqual({ nodeId: "node-1", created: true });
    expect(fs.fs.file(PATH).exists).toBe(true);
  });

  it("returns the same id on every later launch", async () => {
    await loadNodeIdentity(fs.fs, PATH, generate);
    const second = await loadNodeIdentity(fs.fs, PATH, generate);
    const third = await loadNodeIdentity(fs.fs, PATH, generate);

    // The whole point: a device that re-generated would look like a new peer
    // every launch, and its own past records would be attributed to a node it
    // no longer claims to be.
    expect(second).toEqual({ nodeId: "node-1", created: false });
    expect(third.nodeId).toBe("node-1");
    expect(issued).toBe(1);
  });

  it("replaces a corrupt file rather than failing to launch", async () => {
    const file = fs.fs.file(PATH);
    file.create({ intermediates: true, overwrite: true });
    file.write("{ not json");

    const identity = await loadNodeIdentity(fs.fs, PATH, generate);

    expect(identity).toEqual({ nodeId: "node-1", created: true });
  });

  it("replaces a file with no id in it", async () => {
    const file = fs.fs.file(PATH);
    file.create({ intermediates: true, overwrite: true });
    file.write(JSON.stringify({ somethingElse: true }));

    expect((await loadNodeIdentity(fs.fs, PATH, generate)).nodeId).toBe("node-1");
  });
});
