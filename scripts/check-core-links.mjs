#!/usr/bin/env node
/**
 * Fails when a committed package.json links a package by path outside this
 * repository: a `link:` or `file:` spec in a dependency list or in
 * `pnpm.overrides` that resolves above the repository root.
 *
 * starkeep-apps depends on starkeep-core through npm. A path link makes the
 * build need a sibling checkout at a fixed place, and it hides that core has
 * not published what an app uses: photos-mobile ran on a "temporary" link to
 * unpublished core for eleven weeks while npm drifted 92 commits behind
 * (findings-core-package-publish-drift-2026-10-20.md). With this check, an app
 * change that needs unreleased core code fails CI until core publishes it.
 *
 * Developing against an unpublished core still works in an uncommitted working
 * tree, through the opt-in loop described in photos-mobile/metro.config.js.
 *
 * Allowed: the private e2e harnesses, which boot the platform from core source
 * and are never published. Their suites need a core checkout regardless.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const ALLOWED = new Set(["@starkeep/e2e", "@starkeep/e2e-aws"]);
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const manifests = execFileSync("git", ["ls-files", "--", "package.json", "**/package.json"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);

function outsideRepo(manifest, spec) {
  const match = /^(?:link|file):(.+)$/.exec(spec);
  if (!match) return false;
  const target = resolve(root, dirname(manifest), match[1]);
  return relative(root, target).startsWith("..");
}

const problems = [];
for (const manifest of manifests) {
  const pkg = JSON.parse(readFileSync(resolve(root, manifest), "utf8"));
  for (const field of DEP_FIELDS) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (!ALLOWED.has(name) && outsideRepo(manifest, spec)) {
        problems.push(`${manifest}: ${field}.${name} = "${spec}"`);
      }
    }
  }
  // An override's spec resolves against the root manifest's directory.
  for (const [selector, spec] of Object.entries(pkg.pnpm?.overrides ?? {})) {
    if (typeof spec === "string" && outsideRepo(manifest, spec)) {
      problems.push(`${manifest}: pnpm.overrides["${selector}"] = "${spec}"`);
    }
  }
}

if (problems.length > 0) {
  console.error("Committed path links to packages outside this repository:");
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    "\nDepend on the published package instead. If it lacks what you need, release core first.",
  );
  process.exit(1);
}
console.log(`check-core-links: ${manifests.length} package.json files, no path links outside the repository.`);
