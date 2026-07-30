// @vitest-environment jsdom
/**
 * The inline search bar.
 *
 * It reports matches upward and the parent filters the grid with them, which makes
 * two of its properties load-bearing in a way a separate result list never was:
 *
 * - **A cleared or failed search must report `null`, not an empty list.** `null` means
 *   "not filtering" and shows the whole library; `[]` means "nothing matched" and
 *   blanks the grid. Confusing the two turns a failed request into an empty gallery.
 * - **One request per settled query.** The parent's callback sits in this component's
 *   debounce dependency chain, so an unstable identity — or a dependency on state this
 *   component sets itself — re-fires the search forever, and the first thing anyone
 *   would notice is the app hammering the query worker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { SearchBar, type SearchMatches } from "../src/photos-ui/components/vision/search-bar";

const originalFetch = global.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

function respondWith(body: unknown, status = 200) {
  fetchMock.mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status })),
  );
}

function results(ids: string[], extra: Record<string, unknown> = {}) {
  return {
    raw: "q",
    terms: [],
    residual: "q",
    results: ids.map((recordId) => ({
      recordId,
      score: 1,
      structured: 0,
      dense: 1,
      matched: [],
    })),
    bands: [],
    total: ids.length,
    denseUnavailable: null,
    ...extra,
  };
}

/** Types into the box the way a user would, so the debounce is exercised. */
async function type(text: string) {
  const box = screen.getByLabelText("Search photos") as HTMLInputElement;
  const { fireEvent } = await import("@testing-library/react");
  fireEvent.change(box, { target: { value: text } });
  return box;
}

function searchUrls(): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url)).filter((u) => u.includes("/search"));
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

describe("what it reports upward", () => {
  it("reports null while the box is empty, so the grid is unfiltered", async () => {
    respondWith(results([]));
    const seen: SearchMatches[] = [];
    render(
      <SearchBar limit={120} onWiden={() => {}} onMatchesChange={(m) => seen.push(m)} />,
    );
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen.at(-1)).toEqual({ recordIds: null, total: 0 });
    // And it did not ask the server anything for an empty query.
    expect(searchUrls()).toEqual([]);
  });

  it("reports the matched record ids once a query settles", async () => {
    respondWith(results(["rec-a", "rec-b"]));
    const seen: SearchMatches[] = [];
    render(
      <SearchBar limit={120} onWiden={() => {}} onMatchesChange={(m) => seen.push(m)} />,
    );
    await type("beach");
    await waitFor(() => expect(seen.at(-1)?.recordIds).toEqual(["rec-a", "rec-b"]));
    expect(seen.at(-1)?.total).toBe(2);
  });

  it("reports back to null when the query is cleared", async () => {
    respondWith(results(["rec-a"]));
    const seen: SearchMatches[] = [];
    render(
      <SearchBar limit={120} onWiden={() => {}} onMatchesChange={(m) => seen.push(m)} />,
    );
    await type("beach");
    await waitFor(() => expect(seen.at(-1)?.recordIds).toEqual(["rec-a"]));

    await type("");
    // `null`, not `[]` — the difference between "show everything" and "show nothing".
    await waitFor(() => expect(seen.at(-1)?.recordIds).toBeNull());
  });

  it("reports null when the request fails, rather than leaving a stale filter", async () => {
    // A grid still showing the previous matches after a failed search would be
    // claiming those are the results for the query now in the box.
    respondWith(results(["rec-a"]));
    const seen: SearchMatches[] = [];
    render(
      <SearchBar limit={120} onWiden={() => {}} onMatchesChange={(m) => seen.push(m)} />,
    );
    await type("beach");
    await waitFor(() => expect(seen.at(-1)?.recordIds).toEqual(["rec-a"]));

    fetchMock.mockImplementation(() => Promise.reject(new Error("worker died")));
    await type("mountains");
    await waitFor(() => expect(seen.at(-1)?.recordIds).toBeNull());
    expect(await screen.findByText(/worker died/)).toBeTruthy();
  });

  it("reports an empty list when a search genuinely matched nothing", async () => {
    respondWith(results([]));
    const seen: SearchMatches[] = [];
    render(
      <SearchBar limit={120} onWiden={() => {}} onMatchesChange={(m) => seen.push(m)} />,
    );
    await type("nothing like this");
    await waitFor(() => expect(seen.at(-1)?.recordIds).toEqual([]));
    expect(await screen.findByText(/Nothing matched/)).toBeTruthy();
  });
});

describe("request behaviour", () => {
  it("issues one request for a settled query, not a stream of them", async () => {
    // The regression this guards: a dependency that this component itself sets inside
    // the same effect re-fires the search indefinitely.
    respondWith(results(["rec-a"]));
    render(<SearchBar limit={120} onWiden={() => {}} onMatchesChange={() => {}} />);
    await type("beach");
    await waitFor(() => expect(searchUrls().length).toBe(1));
    await new Promise((r) => setTimeout(r, 400));
    expect(searchUrls().length).toBe(1);
  });

  it("debounces a burst of keystrokes into a single request", async () => {
    respondWith(results(["rec-a"]));
    render(<SearchBar limit={120} onWiden={() => {}} onMatchesChange={() => {}} />);
    await type("b");
    await type("be");
    await type("bea");
    await type("beach");
    await waitFor(() => expect(searchUrls().length).toBe(1));
    expect(searchUrls()[0]).toContain("q=beach");
  });

  it("passes the limit through as the filter's width", async () => {
    respondWith(results(["rec-a"]));
    render(<SearchBar limit={250} onWiden={() => {}} onMatchesChange={() => {}} />);
    await type("beach");
    await waitFor(() => expect(searchUrls().length).toBe(1));
    expect(searchUrls()[0]).toContain("limit=250");
  });
});

describe("chips", () => {
  const withPerson = results(["rec-a"], {
    terms: [
      {
        kind: "person",
        id: "p-rose",
        key: "person:p-rose",
        matched: "Rose",
        label: "Rose",
        count: null,
      },
    ],
    residual: "at the beach",
  });

  it("renders the parse as a chip", async () => {
    respondWith(withPerson);
    render(<SearchBar limit={120} onWiden={() => {}} onMatchesChange={() => {}} />);
    await type("Rose at the beach");
    expect(await screen.findByText("Rose")).toBeTruthy();
    expect(screen.getByText(/at the beach/)).toBeTruthy();
  });

  it("dismissing a chip re-searches with it dropped", async () => {
    // §5.2: ✕ says the *interpretation* was wrong, not the word — so the query is
    // unchanged and the parse is what is narrowed.
    respondWith(withPerson);
    render(<SearchBar limit={120} onWiden={() => {}} onMatchesChange={() => {}} />);
    await type("Rose at the beach");
    await waitFor(() => expect(searchUrls().length).toBe(1));

    const { fireEvent } = await import("@testing-library/react");
    fireEvent.click(await screen.findByLabelText("Not the person Rose"));

    await waitFor(() => expect(searchUrls().length).toBe(2));
    expect(searchUrls()[1]).toContain("drop=person%3Ap-rose");
    // The query itself is untouched.
    expect(searchUrls()[1]).toContain("q=Rose+at+the+beach");
  });
});

describe("against a remote data server", () => {
  it("renders nothing rather than a search it cannot run", async () => {
    // Vision is local-target only (§2), so a cloud-served Photos simply has no box.
    respondWith({ error: "nope" }, 501);
    const seen: SearchMatches[] = [];
    const { container } = render(
      <SearchBar limit={120} onWiden={() => {}} onMatchesChange={(m) => seen.push(m)} />,
    );
    await type("beach");
    await waitFor(() => expect(container.firstChild).toBeNull());
    // And the grid is left unfiltered rather than emptied.
    expect(seen.at(-1)).toEqual({ recordIds: null, total: 0 });
  });
});
