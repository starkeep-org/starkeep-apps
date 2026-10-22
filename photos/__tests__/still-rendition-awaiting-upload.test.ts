/**
 * The cloud's answer for a still whose bytes are still on a phone. An ideal
 * the cloud could derive stays `pending`, so the browser asks for it; one
 * whose rung or original has not been uploaded reads `awaiting-upload`, so
 * the browser waits instead of asking the resize Lambda for the impossible.
 */
import { describe, expect, it } from "vitest";
import { resolveFor, type UpstreamRecord } from "../src/routes/photos/library";
import { displayForRenditionChoice } from "../src/photos-lib/client";

type Candidate = NonNullable<UpstreamRecord["variant_candidates"]>[number];

const TARGET = 540;

function candidate(id: string, long_edge: number, over: Partial<Candidate> = {}): Candidate {
  return {
    id,
    type: "image/avif",
    label_value: "photos-thumb",
    available_here: false,
    width: long_edge,
    height: Math.round(long_edge * (2 / 3)),
    long_edge,
    url: `https://files.invalid/${id}`,
    ...over,
  };
}

function record(candidates: Candidate[], over: Partial<UpstreamRecord> = {}): UpstreamRecord {
  return {
    id: "still-1",
    mime_type: "image/jpeg",
    size_bytes: 8_000_000,
    metadata: { width: 6000, height: 4000 },
    variant_candidates: candidates,
    ...over,
  };
}

function resolve(rec: UpstreamRecord, cloud = true) {
  return resolveFor(rec, [TARGET], cloud, cloud ? null : new Map())[String(TARGET)]!;
}

/** The rung the ladder names for {@link TARGET}, read off an empty record. */
const IDEAL_EDGE = resolve(record([])).ideal.longEdge;
const BELOW_EDGE = 320;

describe("cloud still resolution while bytes are still uploading", () => {
  it("waits for a stand-in at the ideal's edge that has not been uploaded", () => {
    const choice = resolve(record([
      candidate("below", BELOW_EDGE),
      candidate("ideal", IDEAL_EDGE, { url: undefined, awaiting_upload: true }),
    ]));
    expect(choice.ideal).toMatchObject({ available: false, state: "awaiting-upload" });
    expect(choice.fallback?.url).toBe("https://files.invalid/below");
  });

  it("waits when no stand-in exists at the ideal's edge and the original has not been uploaded", () => {
    const choice = resolve(record([candidate("below", BELOW_EDGE)], {
      availability: { state: "awaiting-upload" },
    }));
    expect(choice.ideal).toMatchObject({ available: false, state: "awaiting-upload" });
  });

  it("stays pending when the original is in the cloud, so the cloud derives the rung", () => {
    const choice = resolve(record([candidate("below", BELOW_EDGE)], {
      availability: { state: "instant" },
    }));
    expect(choice.ideal).toMatchObject({ available: false, state: "pending" });
  });

  it("keeps an original the cloud cannot decode undecodable while it uploads", () => {
    const choice = resolve(record([], {
      mime_type: "image/heic",
      availability: { state: "awaiting-upload" },
    }));
    expect(choice.ideal.state).toBe("undecodable-here");
  });

  // The phone already read the format to produce the stand-in, so the cloud's
  // decoder does not matter: the bytes are coming.
  it("waits for a phone's stand-in of an original the cloud cannot decode", () => {
    const choice = resolve(record([
      candidate("ideal", IDEAL_EDGE, { url: undefined, awaiting_upload: true }),
    ], { mime_type: "image/heic" }));
    expect(choice.ideal.state).toBe("awaiting-upload");
  });

  it("asks for no derivation for an awaiting rung", () => {
    const choice = resolve(record([
      candidate("ideal", IDEAL_EDGE, { url: undefined, awaiting_upload: true }),
    ]));
    expect(displayForRenditionChoice(choice, TARGET).awaitingBetter).toBe(false);
  });
});

describe("local still resolution ignores the cloud's upload state", () => {
  it("leaves an absent ideal pending", () => {
    const choice = resolve(record([
      candidate("ideal", IDEAL_EDGE, { url: undefined, awaiting_upload: true }),
    ], { availability: { state: "awaiting-upload" } }), false);
    expect(choice.ideal).toMatchObject({ available: false, state: "pending" });
  });
});
