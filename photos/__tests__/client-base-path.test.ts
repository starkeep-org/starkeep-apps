/**
 * basePath fetch-coverage regression tests.
 *
 * The cloud Photos SPA is mounted under /apps/<appId> via Next's `basePath`.
 * Next transparently prefixes <Link>, next/image, and its own asset/route URLs,
 * but it does NOT touch raw `fetch()` / `EventSource` / `location.href`. A
 * root-absolute same-origin path like "/api/local-data/data/records" therefore
 * escapes the app entirely and the API Gateway answers with its default 404
 * `{"message":"Not Found"}` — the "signed in but nothing loads" failure that
 * hit /api/local-data/* (the data plane) and /api/photos/cover.
 *
 * The invariant: every root-absolute same-origin path in browser code goes
 * through withBasePath() (src/lib/base-path.ts). This has two guards:
 *   1. a static scan that fails if any un-wrapped absolute client call reappears;
 *   2. a behavioral check that the wrapped calls actually resolve under the
 *      basePath when NEXT_PUBLIC_STARKEEP_APP_BASE_PATH is set.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(PKG_DIR, "src");

/** Every .ts/.tsx file under src/ (client + shared modules). */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

// A root-absolute same-origin path ("/…", not "//…" and not a scheme) passed
// directly to a browser navigation/fetch primitive. When wrapped as
// `fetch(withBasePath("/…"))` the char after `(` is a letter, so these patterns
// only ever match the un-prefixed form.
const OFFENDERS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "fetch(\"/…\")", re: /\bfetch\(\s*[`'"]\/(?!\/)/ },
  { label: "new EventSource(\"/…\")", re: /\bnew EventSource\(\s*[`'"]\/(?!\/)/ },
  { label: "location.href = \"/…\"", re: /\blocation\.(href|assign)\s*[=(]\s*[`'"]\/(?!\/)/ },
];

describe("no root-absolute same-origin client call escapes withBasePath", () => {
  it("scans src/ and finds none", () => {
    const violations: string[] = [];
    for (const file of walk(SRC_DIR)) {
      const lines = readFileSync(file, "utf-8").split("\n");
      lines.forEach((line, i) => {
        for (const { label, re } of OFFENDERS) {
          if (re.test(line)) {
            violations.push(
              `${file.slice(PKG_DIR.length + 1)}:${i + 1} — ${label}: ${line.trim()}`,
            );
          }
        }
      });
    }
    expect(
      violations,
      `Root-absolute client calls must use withBasePath() or they 404 under /apps/photos in cloud:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});

describe("data-server-client sync endpoints carry the app basePath", () => {
  const savedBasePath = process.env.NEXT_PUBLIC_STARKEEP_APP_BASE_PATH;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    if (savedBasePath === undefined) delete process.env.NEXT_PUBLIC_STARKEEP_APP_BASE_PATH;
    else process.env.NEXT_PUBLIC_STARKEEP_APP_BASE_PATH = savedBasePath;
  });

  it("prefixes /api/local-data/sync/* with /apps/photos in cloud", async () => {
    process.env.NEXT_PUBLIC_STARKEEP_APP_BASE_PATH = "/apps/photos";
    vi.resetModules(); // re-read basePath into LOCAL_BASE at import time
    const { getSyncStatus, triggerSyncNow } = await import("../src/lib/data-server-client");

    await getSyncStatus();
    await triggerSyncNow();

    expect(fetchMock).toHaveBeenCalledWith("/apps/photos/api/local-data/sync/status");
    expect(fetchMock).toHaveBeenCalledWith(
      "/apps/photos/api/local-data/sync/now",
      { method: "POST" },
    );
  });

  it("leaves paths un-prefixed in local dev (empty basePath)", async () => {
    delete process.env.NEXT_PUBLIC_STARKEEP_APP_BASE_PATH;
    vi.resetModules();
    const { getSyncStatus } = await import("../src/lib/data-server-client");

    await getSyncStatus();

    expect(fetchMock).toHaveBeenCalledWith("/api/local-data/sync/status");
  });
});
