/**
 * The bound on on-demand derivation.
 *
 * The number matters because the pool it draws from is small and shared: one
 * cloud page load already issues roughly a dozen invocations against a default
 * ceiling of ten, and going over produces 503s that present as tiles which
 * never arrive rather than as a capacity problem. So the fan-out takes a
 * minority share of a *declared* ceiling rather than a literal.
 */
import { describe, it, expect } from "vitest";
import { inFlightBudget, shouldDeriveOnDemand } from "../src/lib/on-demand-derivation";

describe("how many requests may be in flight", () => {
  it("takes a minority of the pool, leaving room for the page load itself", () => {
    // The resize function shares the account ceiling with the function serving
    // the page the user is looking at.
    expect(inFlightBudget(10)).toBe(3);
    expect(inFlightBudget(30)).toBe(10);
  });

  it("never drops to zero, however small the ceiling", () => {
    expect(inFlightBudget(1)).toBe(1);
    expect(inFlightBudget(2)).toBe(1);
  });

  it("stops growing well before invocation slots stop being the constraint", () => {
    // Somewhere above a ceiling of roughly forty the binding constraint becomes
    // the data server and object storage on the read side rather than
    // invocation slots, so this clamps rather than growing without bound.
    expect(inFlightBudget(1000)).toBe(12);
  });
});

describe("where browser-driven derivation runs", () => {
  it("runs only against the cloud, because the local sweep already owns the work", () => {
    expect(shouldDeriveOnDemand(null)).toBe(false);
    expect(shouldDeriveOnDemand({})).toBe(false);
    expect(shouldDeriveOnDemand({ apiGatewayUrl: "https://photos.invalid" })).toBe(true);
  });
});
