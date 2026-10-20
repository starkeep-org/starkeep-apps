/**
 * How Settings names the cloud this phone is signed in to.
 */
import { describe, it, expect } from "vitest";
import { hostLabel } from "../src/auth/connection";

describe("hostLabel", () => {
  it("keeps the host alone", () => {
    expect(hostLabel("https://photos.example.com")).toBe("photos.example.com");
    expect(hostLabel("https://photos.example.com/apps/photos/")).toBe("photos.example.com");
    expect(hostLabel("http://192.168.1.20:8787")).toBe("192.168.1.20");
  });
});
