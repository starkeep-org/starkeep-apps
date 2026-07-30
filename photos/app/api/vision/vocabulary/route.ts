import { type NextRequest, NextResponse } from "next/server";
import { mergeVisionConfig, readVisionConfig, writeVisionConfig } from "@/vision/config";
import { remoteNotImplemented } from "@/vision/remote";
import { embedQueries, SearchUnavailableError } from "@/vision/search/query-controller";
import { readTagEmbeddings, vocabularyHash, writeTagEmbeddings } from "@/vision/tags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET/PUT /api/vision/vocabulary — the tag candidate list, and its embeddings.
 *
 * **Editing the vocabulary needs no re-inference** (§7). That is the property that
 * makes a runtime-editable vocabulary genuinely cheap rather than nominally
 * possible: the image embeddings are already on disk, so a changed list costs one
 * text encode per *new* tag and then a dot product per (image, tag). No model over
 * images, no image decode, no scan.
 *
 * The embeddings are cached keyed by a hash of the vocabulary, so PUT rebuilds them
 * and GET reports whether the cache matches what is configured. `stale: true` is
 * the honest answer when someone has edited `config.json` by hand — the tags routes
 * decline to guess in that state rather than scoring against a list nobody asked
 * for.
 */
export async function GET(): Promise<Response> {
  const remote = remoteNotImplemented();
  if (remote) return remote;

  const config = readVisionConfig();
  const cached = readTagEmbeddings();
  return NextResponse.json({
    vocabulary: config.tags.vocabulary,
    threshold: config.tags.threshold,
    embedded: cached !== null,
    // Built for a different list than the one configured — the case a hand-edited
    // config produces, and the one that must not silently score against the old one.
    stale: cached !== null && cached.vocabularyHash !== vocabularyHash(config.tags.vocabulary),
  });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const remote = remoteNotImplemented();
  if (remote) return remote;

  const body = (await req.json().catch(() => null)) as unknown;
  if (body === null) {
    return NextResponse.json({ error: "a JSON body is required" }, { status: 400 });
  }

  // Validation and clamping live in `mergeVisionConfig`, so the route cannot drift
  // from what a config write would accept.
  const config = mergeVisionConfig(readVisionConfig(), { tags: body });
  writeVisionConfig(config);

  const vocabulary = config.tags.vocabulary;
  if (vocabulary.length === 0) {
    // An empty vocabulary is a legitimate choice — it means "no suggestions" — and
    // the cache is deleted rather than left describing a list that no longer exists.
    writeTagEmbeddings([], []);
    return NextResponse.json({ vocabulary, threshold: config.tags.threshold, embedded: true });
  }

  try {
    // Batched through the query worker in one `run()`, which is why `embedAll`
    // exists: ~70 tags is one inference rather than seventy round trips.
    const vectors = await embedQueries(vocabulary);
    writeTagEmbeddings(vocabulary, vectors);
  } catch (err) {
    if (err instanceof SearchUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return NextResponse.json({
    vocabulary,
    threshold: config.tags.threshold,
    embedded: true,
  });
}
