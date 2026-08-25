import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The guard on the cloud bundle.
 *
 * open-next traces the Next server's import graph to decide what to ship, and
 * the `static` handler is traced today. So a single static import of a worker
 * engine from anything under `app/` drags that engine — and whatever native
 * module it exists to isolate — into a Lambda that serves HTML. Nothing about
 * that fails loudly; the bundle just gets enormous.
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
 */

const PHOTOS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

interface IsolatedEngine {
  /** What the failure message calls it. */
  name: string;
  /** Directory nothing under `app/` may reach. */
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

const routes = walk(join(PHOTOS_DIR, "app"));

describe("the traversal itself", () => {
  it("finds the routes it is meant to be checking", () => {
    // A traversal bug that found nothing would make every assertion below pass
    // vacuously — which is exactly the shape of failure this guard must not have.
    expect(routes.length).toBeGreaterThan(5);
    expect(routes.map(rel)).toContain("app/api/vision/scan/route.ts");
    expect(routes.map(rel)).toContain("app/api/derive/sweep/route.ts");
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

    it("the app root component does not reach it either", () => {
      // app.tsx is not under app/ but is the client entry the page renders.
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
