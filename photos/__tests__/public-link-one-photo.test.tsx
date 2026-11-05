// @vitest-environment jsdom
/**
 * A public link to one photo, on both sides.
 *
 * The owner's dialog names the photo and says what a visitor sees. The
 * visitor's page opens a one-photo link straight into the large view, with no
 * grid and no close control. It says so when the photo has gone, and says
 * the photo is still uploading when its stand-in has not reached the cloud.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PublicLinkDialog } from "../src/photos-ui/components/albums/public-link-dialog";
import { PublicAlbumPage } from "../src/public/PublicAlbumPage";

const TOKEN = "T".repeat(22);

beforeAll(() => {
  globalThis.IntersectionObserver = class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  } as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the owner's dialog for one photo", () => {
  it("names the photo, says what a visitor sees, and creates the link", async () => {
    const create = vi.fn(async () => {});
    render(
      <PublicLinkDialog
        subject={{ kind: "photo", photoId: "r1", name: "beach.jpg" }}
        state={{ available: true, mayPublish: true, viewerBaseUrl: null, links: [] }}
        link={null}
        actions={{ create, changeLifetime: vi.fn(), replace: vi.fn(), stop: vi.fn() }}
        onRetry={async () => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Public link: beach.jpg")).toBeDefined();
    expect(screen.getByText("Anyone with the link can see this photo.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ title: "beach.jpg", lifetime: "30d" }));
  });
});

function visitorAnswers(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(body)),
  );
}

const item = {
  id: "i1",
  category: "image",
  width: 2560,
  height: 1920,
  sizes: [{ longEdge: 2560, url: "https://cdn.example/shared/u/image/bb/hash?Signature=x" }],
  playback: null,
};

describe("the visitor's page for one photo", () => {
  it("opens straight into the large view, with no grid and no close control", async () => {
    visitorAnswers({ title: "Beach", source: "record", items: [item], nextCursor: null, truncated: false, pending: 0 });
    render(<PublicAlbumPage linkToken={TOKEN} />);
    const main = await screen.findByRole("main", { name: "Beach" });
    expect(main.querySelector("img")?.getAttribute("src")).toBe(item.sizes[0]!.url);
    expect(screen.queryByRole("button", { name: "Open photo" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(screen.queryByText(/items?$/)).toBeNull();
  });

  it("says the link shows nothing once the photo has gone", async () => {
    visitorAnswers({ title: "Beach", source: "record", items: [], nextCursor: null, truncated: false, pending: 0 });
    render(<PublicAlbumPage linkToken={TOKEN} />);
    expect(await screen.findByText("This link no longer shows anything.")).toBeDefined();
  });

  it("says the photo is still uploading while its stand-in is on its way", async () => {
    visitorAnswers({ title: "Beach", source: "record", items: [], nextCursor: null, truncated: false, pending: 1 });
    render(<PublicAlbumPage linkToken={TOKEN} />);
    expect(
      await screen.findByText("This photo is still uploading. Try again in a few minutes."),
    ).toBeDefined();
  });

  it("keeps the grid for an album", async () => {
    visitorAnswers({ title: "Summer", source: "label", items: [item], nextCursor: null, truncated: false, pending: 0 });
    render(<PublicAlbumPage linkToken={TOKEN} />);
    expect(await screen.findByRole("heading", { name: "Summer" })).toBeDefined();
    expect(screen.getByText("1 item")).toBeDefined();
  });
});
