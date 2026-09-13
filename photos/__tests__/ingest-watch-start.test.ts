/**
 * The ingest watch starts once when the server starts, and never in the cloud.
 *
 * Gap 6 of the plan's section 3.4: `instrumentation.ts` had no test, and its
 * failure mode was recorded only as a comment in the bundle script — the
 * framework shipped the hook as an entry file whose chunks the bundler never
 * traced, so the Lambda threw at startup and answered
 * `{"message":"Server failed to respond."}` to every request, including the
 * sign-in page, with the cause only in CloudWatch.
 *
 * The hook is an ordinary function `src/serve.ts` calls now, which is what
 * makes that particular failure impossible. What is still worth pinning is the
 * behavior the hook carried: skip in cloud mode, do nothing without a
 * credential, and never fail a server start over background work.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadAppCredentials = vi.fn();
const startIngestWatch = vi.fn();

vi.mock("@starkeep/app-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@starkeep/app-client")>();
  return { ...actual, loadAppCredentials: (appId: string) => loadAppCredentials(appId) };
});

vi.mock("@/derivation/ingest-watch", () => ({
  startIngestWatch: (url: string) => startIngestWatch(url),
}));

import { startIngestWatchIfLocal } from "@/ingest-watch-start";

beforeEach(() => {
  loadAppCredentials.mockReset();
  startIngestWatch.mockReset();
  delete process.env.STARKEEP_APP_CLIENT_MODE;
  loadAppCredentials.mockResolvedValue({
    appId: "photos",
    hmacSecret: "s",
    dataServerUrl: "http://127.0.0.1:9820",
  });
});

afterEach(() => {
  delete process.env.STARKEEP_APP_CLIENT_MODE;
  vi.restoreAllMocks();
});

describe("on the local surface", () => {
  it("starts the watch against the installed data server", async () => {
    expect(await startIngestWatchIfLocal()).toBe(true);
    expect(startIngestWatch).toHaveBeenCalledTimes(1);
    expect(startIngestWatch).toHaveBeenCalledWith("http://127.0.0.1:9820");
  });

  it("starts exactly one watch per call, so a second start is a second watch", async () => {
    // The reason this matters: `serve.ts` calls it once, after `listen`. A
    // caller that called it twice would open two subscriptions to the same
    // stream and derive everything twice.
    await startIngestWatchIfLocal();
    expect(startIngestWatch).toHaveBeenCalledTimes(1);
  });

  it("does nothing when photos is not installed here", async () => {
    // No credential means no data plane to sweep. Nothing is broken — the
    // install writes the credential — so this is silent rather than an error.
    loadAppCredentials.mockResolvedValue(null);
    expect(await startIngestWatchIfLocal()).toBe(false);
    expect(startIngestWatch).not.toHaveBeenCalled();
  });

  it("never throws, whatever the credential load does", async () => {
    // A server that will not boot is an app nobody can open; a sweep that does
    // not begin is a library that fills in when someone presses the button.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadAppCredentials.mockRejectedValue(new Error("SSM is having a day"));
    await expect(startIngestWatchIfLocal()).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("never throws when the watch itself fails to open", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    startIngestWatch.mockImplementation(() => {
      throw new Error("connection refused");
    });
    await expect(startIngestWatchIfLocal()).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});

describe("in cloud mode", () => {
  it("skips the watch and does not even read the credential", async () => {
    // The resize function has a third of a core and thirty seconds. A
    // whole-library sweep in that shape would time out having done and
    // discarded its work, so cloud derivation is on demand instead.
    process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
    expect(await startIngestWatchIfLocal()).toBe(false);
    expect(loadAppCredentials).not.toHaveBeenCalled();
    expect(startIngestWatch).not.toHaveBeenCalled();
  });
});
