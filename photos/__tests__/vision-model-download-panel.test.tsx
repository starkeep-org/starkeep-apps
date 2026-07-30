// @vitest-environment jsdom
/**
 * The Faces panel's model-download affordance.
 *
 * The feature does nothing at all until 278 MB of weights are on disk, and until
 * now the only thing the panel said about that was a shell command — which ends
 * the feature for anyone who opened Photos from the launcher.
 *
 * Two things are worth pinning. The prompt must state the size *before* the
 * click, because a quarter-gigabyte download is not something to start on
 * someone's behalf silently. And the request must carry `acceptLicence`: the
 * antelopev2 weights are non-commercial-research-only, and the only thing making
 * a button an acceptable way to fetch them is that the button says so and sends
 * it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { VisionPanel } from "../src/photos-ui/components/vision/vision-panel";
import type { VisionModelDownload, VisionStatus } from "../src/lib/vision-client";

const originalFetch = global.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

const MB = 1024 * 1024;

function download(over: Partial<VisionModelDownload> = {}): VisionModelDownload {
  return {
    running: false,
    bytesReceived: 0,
    bytesTotal: 0,
    currentFile: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    ...over,
  };
}

function status(models: Partial<VisionStatus["models"]> = {}): VisionStatus {
  return {
    config: {
      faces: { enabled: false, threshold: 0.45, publishLabels: false },
      scene: { enabled: false },
    },
    models: {
      installed: false,
      missing: ["scrfd_10g_bnkps.onnx", "glintr100.onnx"],
      missingBytes: 278 * MB,
      dir: "/tmp/models",
      fetchCommand: "pnpm vision:fetch-models",
      download: download(),
      pack: {
        name: "antelopev2",
        files: ["scrfd_10g_bnkps.onnx", "glintr100.onnx"],
        totalBytes: 278 * MB,
      },
      ...models,
    },
    worker: { built: true, path: "/tmp/worker.mjs", buildCommand: "pnpm vision:build-worker" },
    scan: {
      running: false,
      eligible: 0,
      skipped: 0,
      processed: {},
      failed: 0,
      startedAt: null,
      finishedAt: null,
      error: null,
    },
    store: {
      processed: 0,
      sidecarsOnDisk: 0,
      imagesWithFaces: 0,
      facesFound: 0,
      people: 0,
      namedPeople: 0,
    },
  };
}

/** Answers every GET with `body`; records POSTs for inspection. */
function serve(body: VisionStatus) {
  fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      return Promise.resolve(new Response(JSON.stringify({ download: download() }), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });
}

function posts(): { url: string; body: unknown }[] {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
    .map(([url, init]) => ({
      url: String(url),
      body: JSON.parse(String((init as RequestInit).body)) as unknown,
    }));
}

beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("the prompt, before anything is downloaded", () => {
  it("names the size in both the explanation and the button", async () => {
    serve(status());
    render(<VisionPanel onClose={() => {}} onOpenPeople={() => {}} />);

    expect(await screen.findByText(/one-time 278 MB model download/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download 278 MB" })).toBeTruthy();
  });

  it("quotes only what is still missing", async () => {
    // The detector is already installed, so the embedder alone is owed. Quoting
    // 278 MB here would be a number the transfer then contradicts.
    serve(status({ missing: ["glintr100.onnx"], missingBytes: 249 * MB }));
    render(<VisionPanel onClose={() => {}} onOpenPeople={() => {}} />);

    expect(await screen.findByRole("button", { name: "Download 249 MB" })).toBeTruthy();
  });

  it("says the weights are non-commercial-research-only", async () => {
    serve(status());
    render(<VisionPanel onClose={() => {}} onOpenPeople={() => {}} />);

    expect(await screen.findByText(/non-commercial research use only/)).toBeTruthy();
  });

  it("keeps the shell command available as the headless path", async () => {
    serve(status());
    render(<VisionPanel onClose={() => {}} onOpenPeople={() => {}} />);

    expect(await screen.findByText("pnpm vision:fetch-models")).toBeTruthy();
  });

  it("sends acceptLicence with the request the button makes", async () => {
    serve(status());
    render(<VisionPanel onClose={() => {}} onOpenPeople={() => {}} />);
    (await screen.findByRole("button", { name: "Download 278 MB" })).click();

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].url).toContain("/api/vision/models");
    expect(posts()[0].body).toEqual({ action: "download", acceptLicence: true });
  });

  it("does not offer the download once the models are installed", async () => {
    serve(status({ installed: true, missing: [], missingBytes: 0 }));
    render(<VisionPanel onClose={() => {}} onOpenPeople={() => {}} />);

    await screen.findByText(/Detect faces in my photos/);
    expect(screen.queryByRole("button", { name: /^Download/ })).toBeNull();
  });
});

describe("the installed badge", () => {
  const installed = () => status({ installed: true, missing: [], missingBytes: 0 });

  it("names the pack, standing, whenever the models are there", async () => {
    // Not a completion toast — the question is "what am I running", asked long
    // after the download, and answerable nowhere else in the UI.
    serve(installed());
    render(<VisionPanel onClose={() => {}} onOpenPeople={() => {}} />);

    expect(await screen.findByText("✓ antelopev2 models installed")).toBeTruthy();
  });

  it("lists both graphs and the size on disk", async () => {
    serve(installed());
    render(<VisionPanel onClose={() => {}} onOpenPeople={() => {}} />);

    expect(await screen.findByText("scrfd_10g_bnkps.onnx · glintr100.onnx")).toBeTruthy();
    expect(screen.getByText("278 MB")).toBeTruthy();
  });

  it("points at the directory the weights live in", async () => {
    serve(installed());
    render(<VisionPanel onClose={() => {}} onOpenPeople={() => {}} />);

    const badge = await screen.findByText("✓ antelopev2 models installed");
    expect(badge.closest("[title]")?.getAttribute("title")).toBe("/tmp/models");
  });

  it("is not shown while the models are missing", async () => {
    // The complement: a badge that rendered in both states would say the feature
    // is ready when it is not.
    serve(status());
    render(<VisionPanel onClose={() => {}} onOpenPeople={() => {}} />);

    await screen.findByRole("button", { name: "Download 278 MB" });
    expect(screen.queryByText(/models installed/)).toBeNull();
  });
});

describe("while a download is running", () => {
  const running = () =>
    status({
      download: download({
        running: true,
        bytesReceived: 139 * MB,
        bytesTotal: 278 * MB,
        currentFile: "glintr100.onnx",
        startedAt: new Date().toISOString(),
      }),
    });

  it("shows progress as bytes moved out of bytes owed", async () => {
    serve(running());
    render(<VisionPanel onClose={() => {}} onOpenPeople={() => {}} />);

    expect(await screen.findByText("139 MB / 278 MB")).toBeTruthy();
    expect(screen.getByText(/Downloading face models/)).toBeTruthy();
  });

  it("names the file in flight", async () => {
    serve(running());
    render(<VisionPanel onClose={() => {}} onOpenPeople={() => {}} />);

    expect(await screen.findByText(/glintr100\.onnx/)).toBeTruthy();
  });

  it("replaces the button, so a second click cannot start a second transfer", async () => {
    serve(running());
    render(<VisionPanel onClose={() => {}} onOpenPeople={() => {}} />);

    await screen.findByText("139 MB / 278 MB");
    expect(screen.queryByRole("button", { name: /^Download/ })).toBeNull();
  });
});

describe("after a failed download", () => {
  const failed = () =>
    status({
      download: download({
        error: "SHA-256 mismatch for glintr100.onnx",
        finishedAt: new Date().toISOString(),
      }),
    });

  it("reports the failure and offers a retry", async () => {
    serve(failed());
    render(<VisionPanel onClose={() => {}} onOpenPeople={() => {}} />);

    expect(await screen.findByText(/SHA-256 mismatch/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("retries through the same accepting request", async () => {
    serve(failed());
    render(<VisionPanel onClose={() => {}} onOpenPeople={() => {}} />);
    (await screen.findByRole("button", { name: "Try again" })).click();

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ action: "download", acceptLicence: true });
  });
});

describe("against a remote data server", () => {
  it("renders nothing rather than a download it cannot perform", async () => {
    // 501 from the vision routes: a cloud-served Photos has no models directory
    // and no business running inference on someone else's hardware.
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "nope" }), { status: 501 }));
    const { container } = render(<VisionPanel onClose={() => {}} onOpenPeople={() => {}} />);

    await waitFor(() => expect(container.firstChild).toBeNull());
  });
});
