import { NextRequest, NextResponse } from "next/server";
import { loadLocalAppCredentials, signRequest } from "../../../../src/lib/local-app-creds";

/**
 * Server-side proxy to the local-data-server. The browser hits us at
 * `/api/local-data/...` and we forward the request to the configured
 * data-server with `X-Starkeep-App-Id` + an HMAC-SHA256 signature over the
 * body. The HMAC secret lives in `.starkeep-local.json` next to the
 * manifest — written by admin-web at install time, gitignored, never sent
 * to the browser.
 */

async function proxy(req: NextRequest, params: { path?: string[] }): Promise<Response> {
  const creds = loadLocalAppCredentials();
  if (!creds) {
    return NextResponse.json(
      {
        error: "photos has not been installed locally — run install from admin-web first",
      },
      { status: 503 },
    );
  }

  const segments = params.path ?? [];
  const url = new URL(req.url);
  const target = `${creds.dataServerUrl}/${segments.join("/")}${url.search}`;

  const body =
    req.method === "GET" || req.method === "HEAD"
      ? undefined
      : await req.text();

  // Pass through Content-Type but strip headers the proxy must set itself.
  const fwdHeaders: Record<string, string> = signRequest(creds, body ?? "");
  const ct = req.headers.get("content-type");
  if (ct) fwdHeaders["Content-Type"] = ct;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: fwdHeaders,
      body,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "Could not reach local-data-server",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }

  // Mirror the response. Some routes return JSON, some SSE / binary — pass
  // through the body and headers verbatim.
  const respHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (key.toLowerCase() === "content-length") return;
    respHeaders.set(key, value);
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: respHeaders,
  });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  return proxy(req, await ctx.params);
}
export async function POST(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  return proxy(req, await ctx.params);
}
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  return proxy(req, await ctx.params);
}
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  return proxy(req, await ctx.params);
}
export async function PUT(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  return proxy(req, await ctx.params);
}
