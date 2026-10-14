/**
 * Scanning admin-web's pairing code.
 *
 * The camera screen is a thin skin over this state machine, so its rules are
 * pinned here: nothing connects without the person seeing the host first, a
 * bad code is reported once rather than once per camera frame, and nothing is
 * scanned while a code is being confirmed or connected.
 */
import { describe, expect, it } from "vitest";
import { isScanning, pairFlow, PAIR_FLOW_START, type PairFlow } from "../src/ui/pair-flow";

const GOOD = JSON.stringify({
  starkeepPair: 1,
  deviceId: "dev_abc",
  privateKey: Buffer.alloc(32, 7).toString("base64"),
  baseUrl: "https://d123.cloudfront.net",
  label: "Pixel 8",
});

describe("scanning", () => {
  it("asks before connecting, naming the host the code points at", () => {
    const next = pairFlow(PAIR_FLOW_START, { type: "scanned", data: GOOD });
    expect(next).toMatchObject({ kind: "confirming", host: "d123.cloudfront.net" });
    expect(isScanning(next)).toBe(false);
  });

  it("reports a bad code and keeps scanning", () => {
    const next = pairFlow(PAIR_FLOW_START, { type: "scanned", data: "https://example.com" });
    expect(next).toMatchObject({ kind: "scanning", problem: expect.stringMatching(/not a Starkeep pairing code/) });
    expect(isScanning(next)).toBe(true);
  });

  it("answers the same bad code with the same state, so a frame-rate stream does not re-render", () => {
    const once = pairFlow(PAIR_FLOW_START, { type: "scanned", data: "nope" });
    expect(pairFlow(once, { type: "scanned", data: "nope" })).toBe(once);
  });

  it("still takes a good code after a bad one", () => {
    const bad = pairFlow(PAIR_FLOW_START, { type: "scanned", data: "nope" });
    expect(pairFlow(bad, { type: "scanned", data: GOOD }).kind).toBe("confirming");
  });
});

describe("confirming and connecting", () => {
  const confirming = pairFlow(PAIR_FLOW_START, { type: "scanned", data: GOOD });

  it("ignores further codes while asking", () => {
    const other = GOOD.replace("dev_abc", "dev_other");
    expect(pairFlow(confirming, { type: "scanned", data: other })).toBe(confirming);
  });

  it("connects only from the confirmation", () => {
    const connecting = pairFlow(confirming, { type: "connect" });
    expect(connecting).toMatchObject({ kind: "connecting", host: "d123.cloudfront.net" });
    expect(pairFlow(PAIR_FLOW_START, { type: "connect" })).toBe(PAIR_FLOW_START);
  });

  it("goes back to scanning on request, forgetting the code", () => {
    expect(pairFlow(confirming, { type: "rescan" })).toEqual(PAIR_FLOW_START);
  });

  it("reports a failed connection, from which a rescan starts over", () => {
    const connecting = pairFlow(confirming, { type: "connect" });
    const failed = pairFlow(connecting, { type: "failed", message: "disk full" });
    expect(failed).toEqual({ kind: "failed", message: "disk full" });
    expect(pairFlow(failed, { type: "rescan" })).toEqual(PAIR_FLOW_START);
  });

  it("ignores a failure that arrives when nothing is connecting", () => {
    const state: PairFlow = confirming;
    expect(pairFlow(state, { type: "failed", message: "late" })).toBe(state);
  });
});
