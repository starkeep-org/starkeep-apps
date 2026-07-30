// @vitest-environment jsdom
/**
 * The Vision panel's per-task model-download affordances.
 *
 * A task does nothing at all until its weights are on disk, and the only thing the
 * panel said about that used to be a shell command — which ends the feature for
 * anyone who opened Photos from the launcher.
 *
 * Three things are worth pinning. The prompt must state the size *before* the
 * click, because a download this large is not something to start on someone's
 * behalf silently. The request must carry `acceptLicence` and the group it applies
 * to. And crucially the **licence line must be per group**: antelopev2 is
 * non-commercial-research-only while the scene and search weights are Apache-2.0,
 * so a shared notice would either impose a restriction that does not exist or
 * hide one that does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { VisionPanel } from "../src/photos-ui/components/vision/vision-panel";
import type {
  VisionModelDownload,
  VisionModelGroup,
  VisionStatus,
} from "../src/lib/vision-client";

const originalFetch = global.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

const MB = 1024 * 1024;

function download(over: Partial<VisionModelDownload> = {}): VisionModelDownload {
  return {
    running: false,
    group: null,
    bytesReceived: 0,
    bytesTotal: 0,
    currentFile: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    ...over,
  };
}

function faceModels(over: Partial<VisionModelGroup> = {}): VisionModelGroup {
  return {
    installed: false,
    missing: ["scrfd_10g_bnkps.onnx", "glintr100.onnx"],
    missingBytes: 278 * MB,
    dir: "/tmp/models",
    fetchCommand: "pnpm vision:fetch-models --faces",
    licence: "non-commercial research use only",
    needsAck: true,
    label: "Face recognition",
    purpose: "find and group faces",
    pack: {
      name: "antelopev2",
      files: ["scrfd_10g_bnkps.onnx", "glintr100.onnx"],
      totalBytes: 278 * MB,
    },
    ...over,
  };
}

function sceneModels(over: Partial<VisionModelGroup> = {}): VisionModelGroup {
  return {
    installed: true,
    missing: [],
    missingBytes: 0,
    dir: "/tmp/models",
    fetchCommand: "pnpm vision:fetch-models --scene",
    licence: "Apache-2.0",
    needsAck: false,
    label: "Scene understanding",
    purpose: "describe photos so they can be searched",
    pack: {
      name: "siglip2-so400m-patch16-384",
      files: ["vision_model.onnx"],
      totalBytes: 1634 * MB,
    },
    ...over,
  };
}

/**
 * `models` patches the **face** group, since that is what most of these cases are
 * about; `over` reaches anything else.
 */
function status(
  models: Partial<VisionModelGroup> = {},
  over: Partial<VisionStatus> = {},
): VisionStatus {
  return {
    config: {
      faces: { enabled: false, threshold: 0.45, publishLabels: false },
      scene: { enabled: false },
      objects: { enabled: false, threshold: 0.35 },
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
    download: download(),
    tasks: {
      faces: {
        models: faceModels(models),
        store: {
          processed: 0,
          sidecarsOnDisk: 0,
          imagesWithFaces: 0,
          facesFound: 0,
          people: 0,
          namedPeople: 0,
        },
      },
      scene: {
        models: sceneModels(),
        store: { processed: 0, sidecarsOnDisk: 0, indexed: 0, indexReady: false },
      },
      objects: {
        models: sceneModels({
          label: "Object detection",
          purpose: "label what is in a photo, so you can filter and count by it",
          pack: { name: "rtdetr-v2-r101vd", files: ["rtdetr_v2_r101vd.onnx"], totalBytes: 293 * MB },
        }),
        store: { processed: 0, sidecarsOnDisk: 0, detections: 0, classes: 0, imagesWithObjects: 0 },
      },
    },
    search: {
      models: sceneModels({
        pack: {
          name: "siglip2-so400m-patch16-384",
          files: ["text_model_int8.onnx", "tokenizer.json"],
          totalBytes: 745 * MB,
        },
        label: "Search",
        purpose: "turn what you type into something comparable to your photos",
      }),
      workerRunning: false,
      workerBuilt: true,
      ready: false,
    },
    ...over,
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

    expect(await screen.findByText("pnpm vision:fetch-models --faces")).toBeTruthy();
  });

  it("sends acceptLicence and the group with the request the button makes", async () => {
    serve(status());
    render(<VisionPanel onClose={() => {}} onOpenPeople={() => {}} />);
    (await screen.findByRole("button", { name: "Download 278 MB" })).click();

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].url).toContain("/api/vision/models");
    // The group is what lets the route decide whether the acceptance was even
    // required — it is for these weights and is not for the Apache-2.0 ones.
    expect(posts()[0].body).toEqual({ action: "download", group: "faces", acceptLicence: true });
  });

  it("does not offer the download once the models are installed", async () => {
    serve(status({ installed: true, missing: [], missingBytes: 0 }));
    render(<VisionPanel onClose={() => {}} onOpenPeople={() => {}} />);

    await screen.findByText("✓ antelopev2 installed");
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

    expect(await screen.findByText("✓ antelopev2 installed")).toBeTruthy();
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

    const badge = await screen.findByText("✓ antelopev2 installed");
    expect(badge.closest("[title]")?.getAttribute("title")).toBe("/tmp/models");
  });

  it("is not shown while the models are missing", async () => {
    // The complement: a badge that rendered in both states would say the feature
    // is ready when it is not.
    serve(status());
    render(<VisionPanel onClose={() => {}} onOpenPeople={() => {}} />);

    await screen.findByRole("button", { name: "Download 278 MB" });
    expect(screen.queryByText(/antelopev2 installed/)).toBeNull();
  });
});

describe("while a download is running", () => {
  const running = () =>
    status({}, {
      download: download({
        running: true,
        // The group is what puts the bar on the right card. One transfer runs at a
        // time across all groups, so an unattributed download belongs to none of
        // them — see the test at the end of this block.
        group: "faces",
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
    expect(screen.getByText(/Downloading…/)).toBeTruthy();
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

  it("puts the progress on the group it names, not on every card", async () => {
    // One transfer at a time across all groups, so the faces card must not claim a
    // scene download's bytes. With scene already installed in this fixture, a
    // scene-attributed transfer should leave the faces prompt alone.
    serve(
      status({}, {
        download: download({
          running: true,
          group: "scene",
          bytesReceived: 100 * MB,
          bytesTotal: 1634 * MB,
          currentFile: "vision_model.onnx",
        }),
      }),
    );
    render(<VisionPanel onClose={() => {}} onOpenPeople={() => {}} />);

    // The faces prompt is still a prompt — but its button is held, because there is
    // only one transfer slot.
    const button = await screen.findByRole("button", { name: /Another download is running/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("100 MB / 1.6 GB")).toBeNull();
  });
});

describe("after a failed download", () => {
  const failed = () =>
    status({}, {
      download: download({
        group: "faces",
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
    expect(posts()[0].body).toEqual({ action: "download", group: "faces", acceptLicence: true });
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
