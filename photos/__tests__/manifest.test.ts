/**
 * The whole manifest, against the validator the platform actually installs with.
 *
 * The migration rewrote `localRun`, `publicPaths` and `staticAssetPaths`, and
 * every one of those is read by something outside this repository: admin-web
 * spawns the first, the installer derives gateway routes from the second, and
 * the web adapter serves the third from disk ahead of the gate. A manifest that
 * parses as JSON but fails the schema is an install that fails after the bundle
 * has been built and uploaded.
 *
 * `@starkeep/admin-manifest` is linked from the sibling `starkeep-core`
 * checkout rather than taken from the registry, so this runs the same copy
 * admin-web and the local data server validate with at install time. A
 * published version would be a different validator, checked against a manifest
 * the current platform is the one to read.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateManifest } from "@starkeep/admin-manifest";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const raw = JSON.parse(readFileSync(resolve(PKG_DIR, "starkeep.manifest.json"), "utf8"));

describe("starkeep.manifest.json", () => {
  it("passes the platform's own validation", () => {
    const result = validateManifest(raw);
    expect(result.errors, JSON.stringify(result.errors, null, 2)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("names a localRun the package can actually execute", () => {
    // admin-web spawns this detached and hands it the port through `portFlag`.
    // A script name that does not exist reports as a daemon that died at
    // startup, with the reason in a log file nobody is looking at.
    const pkg = JSON.parse(readFileSync(resolve(PKG_DIR, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(raw.localRun.command).toBe("pnpm");
    expect(pkg.scripts).toHaveProperty(raw.localRun.args[0]);
  });

  it("runs a build rather than a development server", () => {
    // Problem 1 of the migration plan: `localRun` was `pnpm dev` → `next dev`,
    // so a person running Photos on their own machine got on-demand
    // compilation and a development build of React as the product.
    expect(raw.localRun.args).not.toContain("dev");
  });

  it("has left the framework's asset prefix behind", () => {
    const serialized = JSON.stringify(raw);
    expect(serialized).not.toContain("_next");
    expect(serialized).not.toContain("BUILD_ID");
  });
});
