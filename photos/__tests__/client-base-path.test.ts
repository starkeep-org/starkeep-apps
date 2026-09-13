/**
 * basePath fetch-coverage regression tests.
 *
 * The cloud Photos SPA is mounted under /apps/<appId> via Vite's `base`. The
 * build prefixes every asset URL it emits and every `href` in `index.html`,
 * but it does NOT touch raw `fetch()` / `EventSource` / `location.href` — a
 * bundler cannot see those strings. A
 * root-absolute same-origin path like "/api/local-data/data/records" therefore
 * escapes the app entirely and the API Gateway answers with its default 404
 * `{"message":"Not Found"}` — the "signed in but nothing loads" failure that
 * hit /api/local-data/* (the data plane) and /api/photos/cover.
 *
 * The invariant: every root-absolute same-origin path in browser code goes
 * through withBasePath() (src/lib/base-path.ts). This file is the static guard:
 * a scan that fails if any un-wrapped absolute client call reappears. The
 * behavioral counterpart — that wrapped calls actually resolve under the
 * basePath when STARKEEP_APP_BASE_PATH is set — lives in
 * data-client.test.ts (resolveDataSource).
 *
 * The server half is exempted by name, and the exemption is narrow on purpose.
 * `src/routes/` runs inside the app, where a leading `/` is a *data server*
 * path handed to an HMAC-signing fetch, not a browser URL resolved against the
 * origin; prefixing it with the app's mount would be the bug. Everything under
 * `src/` that a browser could execute stays in the scan, so an un-wrapped call
 * moving into a shared module is still caught.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(PKG_DIR, "src");

/**
 * Modules that never run in a browser, so a leading `/` in them is a data-server
 * path rather than a same-origin URL. Listed individually rather than matched by
 * a pattern: each entry is a claim that the file is server-only, and a claim is
 * what should have to be written down.
 */
const SERVER_ONLY = [
  join(SRC_DIR, "routes"),
  join(SRC_DIR, "serve.ts"),
  join(SRC_DIR, "server-app.ts"),
  join(SRC_DIR, "static-handler.ts"),
  join(SRC_DIR, "client-serving.ts"),
  join(SRC_DIR, "ingest-watch-start.ts"),
];

const isServerOnly = (file: string): boolean =>
  SERVER_ONLY.some((entry) => file === entry || file.startsWith(entry + "/"));

/** Every .ts/.tsx file under src/ that a browser could execute. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (isServerOnly(full)) continue;
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
  it("scans a src/ that still holds the browser code", () => {
    // The exemption list above is a hole in this scan, so the scan has to prove
    // it did not swallow the thing it exists to check.
    const scanned = walk(SRC_DIR).map((f) => f.slice(PKG_DIR.length + 1));
    expect(scanned).toContain("src/lib/data-client.ts");
    expect(scanned).toContain("src/lib/vision-client.ts");
    expect(scanned.filter((f) => f.startsWith("src/routes/"))).toEqual([]);
  });

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
