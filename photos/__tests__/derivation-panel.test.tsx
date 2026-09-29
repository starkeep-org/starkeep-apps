// @vitest-environment jsdom
/**
 * The "Derivation on this machine" panel: three switches, the third meaningless
 * while both derive switches are off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DerivationPanel } from "../src/photos-ui/components/derivation/derivation-panel";

const originalFetch = global.fetch;
let config: Record<string, boolean>;
let puts: unknown[];

beforeEach(() => {
  config = { derivePhotoStandIns: true, deriveVideoStandIns: true, downloadOriginalsToDerive: true };
  puts = [];
  global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const patch = JSON.parse(String(init.body)) as Record<string, boolean>;
      puts.push(patch);
      config = { ...config, ...patch };
    }
    return Response.json({ config });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

const box = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;

describe("the derivation panel", () => {
  it("shows the three switches as saved", async () => {
    render(<DerivationPanel onClose={() => {}} />);
    await screen.findByRole("checkbox", { name: "Derive photo stand-ins here" });
    expect(box("Derive photo stand-ins here").checked).toBe(true);
    expect(box("Derive video stand-ins here").checked).toBe(true);
    expect(box("Download originals to derive missing stand-ins").disabled).toBe(false);
  });

  it("disables the download switch once both derive switches are off", async () => {
    render(<DerivationPanel onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Derive photo stand-ins here" }));
    await waitFor(() => expect(box("Derive photo stand-ins here").checked).toBe(false));
    expect(box("Download originals to derive missing stand-ins").disabled).toBe(false);

    fireEvent.click(box("Derive video stand-ins here"));
    await waitFor(() => expect(box("Download originals to derive missing stand-ins").disabled).toBe(true));
    expect(puts).toEqual([{ derivePhotoStandIns: false }, { deriveVideoStandIns: false }]);
  });

  it("renders nothing where no sweep runs", async () => {
    global.fetch = vi.fn(async () => Response.json({ error: "not here" }, { status: 501 })) as typeof fetch;
    const { container } = render(<DerivationPanel onClose={() => {}} />);
    await waitFor(() => expect(container.innerHTML).toBe(""));
  });
});
