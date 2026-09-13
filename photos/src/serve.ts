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

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getRequestListener } from "@hono/node-server";
import { app, isServerPath } from "./server-app.js";
import { isClientRoute, isFile, resolveClientRequest, SHELL } from "./client-serving.js";
import { startIngestWatchIfLocal } from "./ingest-watch-start.js";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
  // it.
  if (!dev && !isFile(SHELL)) {
    console.log("photos: dist/ is missing, running `vite build`…");
    const { build } = await import("vite");
    await build({ root: PKG_DIR });
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
