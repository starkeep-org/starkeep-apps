import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The guard on the cloud bundle.
 *
 * `onnxruntime-node` is ~270 MB unpacked. open-next traces the Next server's
 * import graph to decide what to ship, and the `static` handler is traced today
 * — so a single static import of the vision engine from anything under `app/`
 * puts a quarter of a gigabyte of native ONNX runtime into a Lambda that serves
 * HTML. Nothing about that fails loudly; the bundle just gets enormous.
 *
 * The engine is therefore reached only from the scan worker, which the scan
 * controller starts by absolute path. That is an invariant no type checker
 * expresses, so it is asserted here: walk the real import graph from every route
 * and prove it never arrives at `src/vision/engine/`.
 */

const PHOTOS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_DIR = join(PHOTOS_DIR, "src", "vision", "engine");
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

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
function pathToEngine(entry: string): string[] | null {
  const queue: string[][] = [[entry]];
  const seen = new Set<string>([entry]);
  while (queue.length > 0) {
    const chain = queue.shift()!;
    const file = chain[chain.length - 1];
    if (file.startsWith(ENGINE_DIR)) return chain;
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

describe("vision engine isolation", () => {
  const routes = walk(join(PHOTOS_DIR, "app"));

  it("finds the routes it is meant to be checking", () => {
    // A traversal bug that found nothing would make every assertion below pass
    // vacuously — which is exactly the shape of failure this guard must not have.
    expect(routes.length).toBeGreaterThan(5);
    expect(routes.map(rel)).toContain("app/api/vision/scan/route.ts");
  });

  it.each(routes.map((file) => [rel(file), file]))(
    "%s does not reach src/vision/engine",
    (_name, file) => {
      const chain = pathToEngine(file);
      expect(
        chain === null,
        chain
          ? `import chain into the ONNX engine:\n  ${chain.map(rel).join("\n→ ")}`
          : undefined,
      ).toBe(true);
    },
  );

  it("the app root component does not reach it either", () => {
    // app.tsx is not under app/ but is the client entry the page renders.
    expect(pathToEngine(join(PHOTOS_DIR, "app.tsx"))).toBeNull();
  });

  it("the scan controller holds the worker only as a path", () => {
    const source = readFileSync(join(PHOTOS_DIR, "src", "vision", "scan-controller.ts"), "utf-8");
    expect(source).toContain(".vision/scan-worker.mjs");
    expect(source).not.toMatch(/from\s+["'].*engine\//);
  });

  it("the worker entry is what reaches the engine", () => {
    // The complement of the assertions above: if this ever stopped being true,
    // they would pass for the wrong reason.
    const worker = join(PHOTOS_DIR, "src", "vision", "engine", "scan-worker.ts");
    expect(pathToEngine(worker)).not.toBeNull();
  });
});
