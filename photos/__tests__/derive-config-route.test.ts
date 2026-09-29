/**
 * GET|PUT /api/derive/config — this machine's derivation switches.
 *
 * The sweep controller is mocked: whether a switch turned on starts a pass is
 * the question here, not what the pass does.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startSweep = vi.fn();
vi.mock("../src/derivation/sweep-controller", () => ({
  startSweep: (...args: unknown[]) => startSweep(...args),
}));

import { GET, PUT } from "../src/routes/derive/config";

let root: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["STARKEEP_DIR", "STARKEEP_APP_CLIENT_MODE", "STARKEEP_FORCE_REMOTE"] as const;

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  root = mkdtempSync(join(tmpdir(), "starkeep-derive-config-"));
  process.env.STARKEEP_DIR = root;
  delete process.env.STARKEEP_APP_CLIENT_MODE;
  delete process.env.STARKEEP_FORCE_REMOTE;
  startSweep.mockReset();
  startSweep.mockResolvedValue({ ok: true });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(root, { recursive: true, force: true });
});

const put = (body: unknown) =>
  PUT(new Request("http://localhost/api/derive/config", { method: "PUT", body: JSON.stringify(body) }));

describe("the derivation switches", () => {
  it("read as the defaults before anything is saved", async () => {
    const res = await GET();
    expect(await res.json()).toEqual({
      config: { derivePhotoStandIns: true, deriveVideoStandIns: true, downloadOriginalsToDerive: true },
    });
  });

  it("save a change and read it back, starting no pass for a switch turned off", async () => {
    const res = await put({ downloadOriginalsToDerive: false });
    expect((await res.json()).config.downloadOriginalsToDerive).toBe(false);
    expect((await (await GET()).json()).config.downloadOriginalsToDerive).toBe(false);
    expect(startSweep).not.toHaveBeenCalled();
  });

  it("start a pass when a switch turns on, and stay quiet if one is already running", async () => {
    await put({ deriveVideoStandIns: false });
    startSweep.mockResolvedValue({ ok: false, status: 409, error: "a sweep is already running" });
    const res = await put({ deriveVideoStandIns: true });
    expect(startSweep).toHaveBeenCalledTimes(1);
    expect(await res.json()).toEqual({
      config: { derivePhotoStandIns: true, deriveVideoStandIns: true, downloadOriginalsToDerive: true },
    });
  });

  it("answer 501 against a remote data server", async () => {
    process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
    expect((await GET()).status).toBe(501);
    expect((await put({ derivePhotoStandIns: false })).status).toBe(501);
  });
});
