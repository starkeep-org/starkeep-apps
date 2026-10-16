/**
 * Photos' local surface: `@hono/node-server` in front of the same app the
 * Lambda runs, and the built client beside it.
 *
 * What changed with the framework is the thing problem 1 of the migration plan
 * named: the local surface used to be `next dev`, so a person running Photos on
 * their own machine got on-demand compilation and a development build of React
 * as the product. This serves `vite build`'s output — the same bytes the cloud
 * bundle stages — and `--dev` is the opt-in development mode rather than the
 * only mode.
 *
 * The two surfaces now differ in configuration and nothing else: the base path
 * is empty here, the proxy points at the loopback data server, the origin gate
 * is inert, the runtime config has no pool ids, and the vision and sweep routes
 * run rather than answering 501. Routing is identical, deliberately, and
 * `src/client-serving.ts` is where that is decided.
 *
 * No `load-env` call. admin-web spawns this process from the manifest's
 * `localRun` and it inherits admin-web's environment, which is where
 * `STARKEEP_DIR` comes from; photos lives in its own repository, so a repo-root
 * `.env` lookup from here would find this repo's root rather than the
 * platform's.
 */

// First, so lines written during startup are stamped too. See log-timestamps.ts.
import "./log-timestamps.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getRequestListener } from "@hono/node-server";
import { app, isServerPath } from "./server-app.js";
import { isClientRoute, isFile, resolveClientRequest, SHELL } from "./client-serving.js";
import { startIngestWatchIfLocal } from "./ingest-watch-start.js";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * What the client build reads, as paths under the package.
 *
 * Memo's list plus two. `app.tsx` sits at the package root, outside `src/`,
 * and `src/main.tsx` imports it, so leaving it off would let an edit to the
 * app shell alone go unbuilt. `package.json` stands in for the dependencies:
 * pnpm links packages with the store's original mtimes, so an upgrade never
 * looks newer than the build, but the version range it changed does.
 */
const CLIENT_INPUTS = ["src", "app.tsx", "index.html", "vite.config.ts", "package.json"];

/** The newest mtime under a path, directory or file, or 0 when absent. */
function newestMtime(path: string): number {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = 0;
  for (const entry of readdirSync(path)) newest = Math.max(newest, newestMtime(join(path, entry)));
  return newest;
}

/**
 * Whether `dist/` predates the sources it was built from.
 *
 * A missing build is loud and already handled below. A *stale* one is silent
 * and worse: the server starts, every page renders, and the code running is
 * whatever was last built. A `dist/` from 2026-09-13 hid a month of client
 * changes this way before anyone noticed. Memo hit the same fault first and
 * carries the same check.
 *
 * Checked rather than rebuilt unconditionally: `vite build` empties `dist/`,
 * and a second start against a running instance would delete that instance's
 * assets before failing on the port.
 */
function distIsStale(): boolean {
  const built = newestMtime(SHELL);
  return built > 0 && CLIENT_INPUTS.some((p) => newestMtime(join(PKG_DIR, p)) > built);
}

function portFromArgv(argv: string[]): number {
  // `-p` as well as `--port`: the manifest's `portFlag` is `-p`, which is what
  // admin-web passes, and `--port` is what a person typing this by hand reaches
  // for.
  const at = argv.findIndex((a) => a === "--port" || a === "-p");
  const value = at >= 0 ? Number(argv[at + 1]) : Number(process.env.PORT);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("photos needs a port: -p <n> (admin-web passes it via the manifest portFlag)");
  }
  return value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dev = argv.includes("--dev");
  const port = portFromArgv(argv);

  // Self-healing: a locally installed app that fails to start because nobody
  // ran a build step reports as a platform failure in whichever suite installed
  // it. Staleness is healed on the same terms — see `distIsStale`.
  if (!dev) {
    const missing = !isFile(SHELL);
    if (missing || distIsStale()) {
      console.log(`photos: dist/ is ${missing ? "missing" : "older than its sources"}, running \`vite build\`…`);
      const { build } = await import("vite");
      await build({ root: PKG_DIR });
    }
  }

  const api = getRequestListener(app.fetch);
  let client: (req: IncomingMessage, res: ServerResponse) => void;

  if (dev) {
    // Imported here rather than at the top: Vite belongs to the browser half
    // and has no business being loaded by a production start.
    const { createServer: createViteServer } = await import("vite");
    // `appType: "custom"`, not `"spa"`: Vite's SPA fallback answers *every*
    // unmatched path with the shell, which would make an undeclared client
    // route work in development and 404 in the cloud.
    const vite = await createViteServer({
      root: PKG_DIR,
      appType: "custom",
      server: { middlewareMode: true },
    });
    client = (req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (!isClientRoute(pathname)) {
        // Vite owns the module graph — `/src/main.tsx`, `/@vite/client`, the
        // pre-bundled dependencies — and 404s what it does not recognise.
        vite.middlewares(req, res, () => {
          res.statusCode = 404;
          res.end();
        });
        return;
      }
      void (async () => {
        const html = await vite.transformIndexHtml(
          req.url ?? "/",
          await readFile(join(PKG_DIR, "index.html"), "utf8"),
        );
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.setHeader("cache-control", "no-cache");
        res.end(html);
      })();
    };
  } else {
    client = getRequestListener(async (request) => {
      const pathname = new URL(request.url).pathname;
      const answer = resolveClientRequest(pathname);
      if (answer.kind === "notFound") {
        return Response.json({ error: `Photos has no route for ${pathname}` }, { status: 404 });
      }
      const headers =
        answer.kind === "asset"
          ? { "content-type": answer.contentType, "cache-control": answer.cacheControl }
          : { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" };
      return new Response(await readFile(answer.file), { headers });
    });
  }

  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (isServerPath(pathname)) api(req, res);
    else client(req, res);
  });

  server.listen(port, () => {
    console.log(`photos listening on http://localhost:${port}${dev ? " (dev)" : ""}`);
  });

  // After `listen`, and deliberately not awaited before it. The watch reads the
  // app credential and opens a long-lived subscription; blocking the bind on
  // either would make a slow data server look like a server that failed to
  // start, which is exactly what admin-web's readiness probe would report.
  void startIngestWatchIfLocal();
}

void main();
