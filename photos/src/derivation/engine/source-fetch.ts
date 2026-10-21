/**
 * Reading a record's source bytes for derivation, and naming the one failure
 * that waiting fixes.
 *
 * The data server answers `file-url` with a 502 when the bytes are on neither
 * this node nor the cloud. That covers a device whose upload has not finished
 * and a transient cloud error, and both resolve on a later try. The sweep counts
 * {@link SourceUnavailableError} apart from a failed derivation, and a pass that
 * ends with any schedules a retry (`ingest-watch.ts`).
 */

export class SourceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceUnavailableError";
  }
}

type SignedFetch = (path: string) => Promise<Response>;

/**
 * The source file's response, with a body, or a {@link SourceUnavailableError}.
 *
 * The URL is a self-signed token URL, so the second request needs no HMAC.
 */
export async function fetchSource(
  signedFetch: SignedFetch,
  recordId: string,
  fetchUrl: (url: string) => Promise<Response> = fetch,
): Promise<Response & { body: ReadableStream<Uint8Array> }> {
  const urlRes = await signedFetch(`/data/records/${recordId}/file-url`);
  if (!urlRes.ok) throw new SourceUnavailableError(`file-url failed: ${urlRes.status}`);
  const { url } = (await urlRes.json()) as { url: string };
  const fileRes = await fetchUrl(url);
  if (!fileRes.ok || !fileRes.body) throw new SourceUnavailableError(`file fetch failed: ${fileRes.status}`);
  return fileRes as Response & { body: ReadableStream<Uint8Array> };
}
