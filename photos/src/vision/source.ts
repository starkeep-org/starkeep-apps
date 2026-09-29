/**
 * Which bytes vision reads for a photograph: a size already on this machine,
 * never an original fetched for the purpose.
 *
 * A data server read of a file this machine lacks now downloads the file and
 * keeps it until "Free up space". A face scan over a library synced from
 * elsewhere would therefore pull every original down, and the People view
 * would pull one per face tile. Vision reads from the stand-in summary
 * instead: `include=stand-in-urls` carries a URL only for a size resident
 * here, so nothing this module does moves bytes across the network.
 *
 * Split out of the worker for the same reason as `scan-set.ts`: the worker
 * pulls in `onnxruntime-node`, and this is logic a test should reach without
 * it. The face-crop route shares it, so a crop reads the same image the scan
 * did whenever that image is still here.
 */

import type { WireStandInSize, WireStandInSummary } from "../photos-lib/stand-in-candidates";
import type { RecordFetcher } from "./scan-set";

/**
 * The long edge vision prefers. A desktop's sync-down ceiling is 2560, so the
 * 2560 stand-in is resident on every desktop once Photos has derived it, and
 * it holds a group photo's small faces well above the detector's input size.
 */
export const VISION_SOURCE_LONG_EDGE = 2560;

/**
 * The resident size to read: the largest at or below the preferred long edge,
 * or else the smallest above it. Null when nothing is here yet — an original
 * Photos has not derived, or one whose sizes all sit in the cloud.
 *
 * A self-canonical original appears in the summary with role `original`, so a
 * small photograph imported here is read as itself.
 */
export function chooseResidentSize(summary: WireStandInSummary | undefined): WireStandInSize | null {
  const here = (summary?.sizes ?? []).filter((s) => s.placement === "here" && s.url);
  const atOrBelow = here.filter((s) => s.fidelity <= VISION_SOURCE_LONG_EDGE);
  if (atOrBelow.length > 0) return atOrBelow.reduce((a, b) => (b.fidelity > a.fidelity ? b : a));
  if (here.length > 0) return here.reduce((a, b) => (b.fidelity < a.fidelity ? b : a));
  return null;
}

export interface ResidentImage {
  readonly bytes: Uint8Array;
  /** The record whose bytes these are: a stand-in, or the original itself. */
  readonly sourceRecordId: string;
  readonly fidelity: number;
}

/**
 * The bytes of `recordId`'s chosen resident size, or null when none is here.
 *
 * `fetchData` reaches the data server with the app's signature; the URL it
 * hands back is a self-signed local token, fetched with `fetchUrl`.
 */
export async function fetchResidentImage(
  fetchData: RecordFetcher,
  recordId: string,
  fetchUrl: (url: string) => Promise<Response> = (url) => fetch(url),
): Promise<ResidentImage | null> {
  const where = encodeURIComponent(JSON.stringify({ id: recordId }));
  const res = await fetchData(`/data/records?where=${where}&include=stand-in-urls`);
  if (!res.ok) throw new Error(`record read failed: ${res.status}`);
  const { records } = (await res.json()) as {
    records: Array<{ id: string; stand_ins?: WireStandInSummary }>;
  };
  const size = chooseResidentSize(records.find((r) => r.id === recordId)?.stand_ins);
  if (!size?.url || !size.record_id) return null;

  const fileRes = await fetchUrl(size.url);
  if (!fileRes.ok) throw new Error(`file fetch failed: ${fileRes.status}`);
  return {
    bytes: new Uint8Array(await fileRes.arrayBuffer()),
    sourceRecordId: size.record_id,
    fidelity: size.fidelity,
  };
}

/**
 * A face box from a sidecar, in the pixels of an image `scale` times the size
 * the sidecar measured. A crop may read a different size than the scan did —
 * a sidecar written from an original, or a stand-in a later derivation
 * replaced — and the boxes must land on the same face.
 */
export function scaleBox(
  box: readonly [number, number, number, number],
  scale: number,
): [number, number, number, number] {
  return [box[0] * scale, box[1] * scale, box[2] * scale, box[3] * scale];
}
