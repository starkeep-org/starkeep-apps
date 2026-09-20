import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ call: vi.fn(), derive: vi.fn(), precheck: vi.fn() }));
vi.mock("@starkeep/app-client", () => ({ loadAppCredentials: async () => ({ appId: "photos" }), signedFetch: (_: unknown, ...args: unknown[]) => mocks.call(...args), USER_TOKEN_HEADER: "X-User-Token" }));
vi.mock("../src/photos-lib/image-processing/derive-and-publish", () => ({ deriveAndPublish: mocks.derive }));
vi.mock("../src/photos-lib/labels", () => ({ precheckThumbnail: mocks.precheck }));
import { handler } from "../infra/src/resize-handler";
import { CHEAP_STILL_CLASSES } from "@starkeep/photos-ladder";

let type: string;
let instant: boolean;
beforeEach(() => {
  vi.clearAllMocks(); type = "image/jpeg"; instant = true;
  mocks.precheck.mockResolvedValue({ alreadyThumbnail: false });
  mocks.derive.mockResolvedValue({ outcome: "complete", published: [], archiveGate: null });
  mocks.call.mockImplementation(async (path: string) => {
    if (path === "/data/records/p") return Response.json({ record: { id: "p", type, mime_type: type, object_storage_key: "shared/image/p" } });
    if (path.startsWith("/data/records?")) return Response.json({ records: [{ availability: { state: instant ? "instant" : "archived" } }] });
    throw Error(`unexpected source access ${path}`);
  });
});
function request(edge = 320) {
  return handler({ rawPath: "/apps/photos/api/resize", requestContext: { http: { method: "POST" } },
    headers: { authorization: "Bearer user" }, body: JSON.stringify({ targetId: "p", targetLongEdge: edge }), isBase64Encoded: false } as Parameters<typeof handler>[0]);
}
describe("cloud acquisition", () => {
  it.each(["image/heic", "image/dng", "image/x-canon-cr2"])("declines %s without reading or decoding the original", async format => {
    type = format;
    const response = await request();
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body!).declined).toBe(true);
    expect(mocks.derive).not.toHaveBeenCalled();
    expect(mocks.call).toHaveBeenCalledTimes(1);
  });
  it("declines archived originals and expensive requested rungs", async () => {
    instant = false;
    expect(JSON.parse((await request()).body!).declined).toBe(true);
    instant = true;
    expect(JSON.parse((await request(2560)).body!).declined).toBe(true);
    expect(mocks.derive).not.toHaveBeenCalled();
  });
  it("emits the whole cheap tier from a single permitted decode", async () => {
    expect((await request()).statusCode).toBe(200);
    expect(mocks.derive).toHaveBeenCalledTimes(1);
    expect(mocks.derive.mock.calls[0]![0].onlyRenditionClasses).toEqual(CHEAP_STILL_CLASSES);
  });
});
