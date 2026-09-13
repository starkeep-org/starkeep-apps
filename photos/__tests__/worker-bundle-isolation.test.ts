import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The guard on the cloud bundle.
 *
 * esbuild bundles `src/static-handler.ts` into the browser-facing Lambda, and
 * it inlines eagerly. So a single import of a worker engine from anything that
 * entry reaches drags that engine — and whatever native module it exists to
 * isolate — into a Lambda that serves HTML.
 *
 * This used to be a precaution. Under OpenNext a tracer decided what to ship
 * and `serverExternalPackages` named the two natives, so an accidental import
 * produced a large bundle rather than a broken one. esbuild has no such list to
 * consult, which makes this the load-bearing guard: `onnxruntime-node` is ~270
 * MB unpacked and Lambda's hard ceiling is 250 MB, so the failure it prevents
 * is a deploy that cannot happen with the cause reported by AWS rather than
 * here.
 *
 * Two engines are held behind this rule, for the same reason and by the same
 * mechanism: each is reached only from its own worker entry point, which its
 * controller starts by absolute path.
 *
 *   - `src/vision/engine/` pulls `onnxruntime-node`, ~270 MB unpacked.
 *   - `src/derivation/engine/` pulls the whole library sweep, which has no
 *     business in a request bundle even where sharp legitimately is one — the
 *     resize route derives, so sharp is reachable from it on purpose.
 *
 * Neither is expressible to a type checker, so both are asserted here: walk the
 * real import graph from every route and prove it never arrives.
 *
 * **What the walk starts from moved with the framework.** The route set used to
 * be a directory tree, and this test walked `app/`. It is a module graph now,
 * rooted at `src/server-app.ts`, so the entries below are the files under
 * `src/routes/` plus the three module entries around them. The directory walk
 * would have found nothing after the migration and passed vacuously, which is
 * worse than absent — hence `describe("the traversal itself")`, which fails
 * when the entry set is empty or has lost a route it should contain, and the
 * reachability check that every route file is actually mounted.
 */

const PHOTOS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

interface IsolatedEngine {
  /** What the failure message calls it. */
  name: string;
  /** Directory no route may reach. */
  dir: string;
  /** The controller that must hold its worker as a path and not an import. */
  controller: string;
  /** The bundle path that controller hands to `new Worker(...)`. */
  bundle: string;
  /** The one entry point that *does* reach the engine. */
  workerEntry: string;
}

const ENGINES: IsolatedEngine[] = [
  {
    name: "vision",
    dir: join(PHOTOS_DIR, "src", "vision", "engine"),
    controller: join(PHOTOS_DIR, "src", "vision", "scan-controller.ts"),
    bundle: ".vision/scan-worker.mjs",
    workerEntry: join(PHOTOS_DIR, "src", "vision", "engine", "scan-worker.ts"),
  },
  {
    name: "derivation",
    dir: join(PHOTOS_DIR, "src", "derivation", "engine"),
    controller: join(PHOTOS_DIR, "src", "derivation", "sweep-controller.ts"),
    bundle: ".derivation/derive-worker.mjs",
    workerEntry: join(PHOTOS_DIR, "src", "derivation", "engine", "derive-worker.ts"),
  },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (SOURCE_EXTENSIONS.some((ext) => full.endsWith(ext))) out.push(full);
  }
  return out;
}

/** Every `from "..."` / `import("...")` specifier in a source file. */
function specifiersIn(file: string): string[] {
  const source = readFileSync(file, "utf-8");
  const out: string[] = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) out.push(match[1]);
  }
  return out;
}

/** Resolve a specifier to a file in this package, or null if it leaves it. */
function resolveLocal(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(PHOTOS_DIR, "src", specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(fromFile), specifier);
  else return null; // a package — not part of this graph

  for (const candidate of [
    base,
    ...SOURCE_EXTENSIONS.map((ext) => base + ext),
    ...SOURCE_EXTENSIONS.map((ext) => join(base, `index${ext}`)),
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * Breadth-first over the import graph. Returns the first path that reaches the
 * engine, so a failure names the chain rather than just the fact.
 */
function pathToEngine(entry: string, engineDir: string): string[] | null {
  const queue: string[][] = [[entry]];
  const seen = new Set<string>([entry]);
  while (queue.length > 0) {
    const chain = queue.shift()!;
    const file = chain[chain.length - 1];
    if (file.startsWith(engineDir)) return chain;
    for (const specifier of specifiersIn(file)) {
      const resolved = resolveLocal(file, specifier);
      if (!resolved || seen.has(resolved)) continue;
      seen.add(resolved);
      queue.push([...chain, resolved]);
    }
  }
  return null;
}

const rel = (file: string) => relative(PHOTOS_DIR, file);

/** Every file the browser-facing Lambda's entry can reach. */
function graphFrom(entry: string): Set<string> {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const specifier of specifiersIn(file)) {
      const resolved = resolveLocal(file, specifier);
      if (resolved && !seen.has(resolved)) {
        seen.add(resolved);
        queue.push(resolved);
      }
    }
  }
  return seen;
}

const SERVER_APP = join(PHOTOS_DIR, "src", "server-app.ts");
const STATIC_HANDLER = join(PHOTOS_DIR, "src", "static-handler.ts");
const SERVE = join(PHOTOS_DIR, "src", "serve.ts");

/**
 * The dispatch table: every route module, plus the three entries that mount
 * them. `src/serve.ts` is in the set even though it never enters the Lambda,
 * because it is the local surface's entry and the same rule applies — the
 * engines are started by absolute path from both.
 */
const routes = [...walk(join(PHOTOS_DIR, "src", "routes")), SERVER_APP, STATIC_HANDLER, SERVE];

describe("the traversal itself", () => {
  it("finds the routes it is meant to be checking", () => {
    // A traversal bug that found nothing would make every assertion below pass
    // vacuously — which is exactly the shape of failure this guard must not
    // have, and exactly what the old `app/` walk would have done here.
    expect(routes.length).toBeGreaterThan(20);
    expect(routes.map(rel)).toContain("src/routes/vision/scan.ts");
    expect(routes.map(rel)).toContain("src/routes/derive/sweep.ts");
  });

  it("checks a set the server actually mounts", () => {
    // The complement: a route file the Hono app never imports is dead code this
    // guard would be protecting for nothing, and a route that answers requests
    // without appearing here is unguarded. Both are the same drift.
    const mounted = graphFrom(SERVER_APP);
    const unmounted = walk(join(PHOTOS_DIR, "src", "routes"))
      .filter((f) => !mounted.has(f))
      .map(rel);
    expect(unmounted).toEqual([]);
  });
});

describe.each(ENGINES.map((engine) => [engine.name, engine] as const))(
  "%s engine isolation",
  (_name, engine) => {
    it.each(routes.map((file) => [rel(file), file]))(
      `%s does not reach ${rel(engine.dir)}`,
      (_route, file) => {
        const chain = pathToEngine(file, engine.dir);
        expect(
          chain === null,
          chain
            ? `import chain into the ${engine.name} engine:\n  ${chain.map(rel).join("\n→ ")}`
            : undefined,
        ).toBe(true);
      },
    );

    it("the browser entry does not reach it either", () => {
      // `src/main.tsx` is what `index.html` loads, and `app.tsx` is the tree it
      // mounts. A worker engine in the browser bundle is not a size problem —
      // it is a build failure on a native module, a long way from its cause.
      expect(pathToEngine(join(PHOTOS_DIR, "src", "main.tsx"), engine.dir)).toBeNull();
      expect(pathToEngine(join(PHOTOS_DIR, "app.tsx"), engine.dir)).toBeNull();
    });

    it("the controller holds the worker only as a path", () => {
      const source = readFileSync(engine.controller, "utf-8");
      expect(source).toContain(engine.bundle);
      expect(source).not.toMatch(/from\s+["'].*engine\//);
    });

    it("the worker entry is what reaches the engine", () => {
      // The complement of the assertions above: if this ever stopped being
      // true, they would pass for the wrong reason.
      expect(pathToEngine(engine.workerEntry, engine.dir)).not.toBeNull();
    });
  },
);
