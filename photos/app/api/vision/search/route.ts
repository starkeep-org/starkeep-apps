import { NextResponse } from "next/server";
import { remoteNotImplemented } from "@/vision/remote";
import { SearchUnavailableError } from "@/vision/search/query-controller";
import { DEFAULT_SEARCH_LIMIT, search } from "@/vision/search/search";

export const runtime = "nodejs";
// Reads the sidecar store and the embedding index off local disk, and a cached
// render would serve results from before the last scan.
export const dynamic = "force-dynamic";

/**
 * GET /api/vision/search?q=… — hybrid structured + dense search (plan §5).
 *
 * A GET because a search is a read with no side effects and a shareable URL is a
 * feature: `?q=alice+at+the+beach` is a link to a result set.
 *
 * `drop` carries the chip dismissals (§5.2) as repeated `person:<id>` values. They
 * live in the query string rather than in stored state on purpose — dropping a
 * parse is a property of *this* search, not a preference. "Rose is never a person"
 * would be a different feature with a different lifetime.
 *
 * Inherits `remoteNotImplemented()` like every vision route: search is a
 * local-target feature (§2), and that is worth stating because search feels like
 * something that should work everywhere, and it will not.
 */
export async function GET(request: Request): Promise<Response> {
  const remote = remoteNotImplemented();
  if (remote) return remote;

  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? "";
  if (query.trim() === "") {
    // Not an error — it is what an empty search box means. Returning the shape the
    // client already handles saves it a special case.
    return NextResponse.json({
      raw: query,
      terms: [],
      residual: "",
      results: [],
      bands: [],
      total: 0,
      denseUnavailable: null,
    });
  }

  const dropped = new Set(url.searchParams.getAll("drop"));
  const limitParam = Number(url.searchParams.get("limit"));
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(500, Math.floor(limitParam))
      : DEFAULT_SEARCH_LIMIT;

  try {
    return NextResponse.json(await search(query, { dropped, limit }));
  } catch (err) {
    // A missing model or unbuilt worker is a 409/500 the panel can act on, not a
    // stack trace — the same distinction `startScan` draws.
    if (err instanceof SearchUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
