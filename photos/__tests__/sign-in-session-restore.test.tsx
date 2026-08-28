// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

/**
 * The sign-in page recovers a session the browser still holds.
 *
 * `sk_session` outlives `sk_token` by weeks, so about an hour after its last
 * page load every signed-in browser presents a live session and no token. The
 * gateway authorizer and the CloudFront redirect in front of it both read the
 * token, so that browser is sent here — signed in, holding the credential that
 * would prove it, and looking at a password field. `/api/session/refresh` is
 * public at the gateway precisely so this page can spend that credential.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Loaded {
  SignInPage: () => React.ReactElement;
}

async function loadPage(opts: { cloud: boolean }): Promise<Loaded> {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_FORCE_REMOTE", opts.cloud ? "true" : "");
  vi.stubEnv("NEXT_PUBLIC_STARKEEP_APP_BASE_PATH", opts.cloud ? "/apps/photos" : "");
  const mod = (await import("../app/sign-in/page")) as { default: () => React.ReactElement };
  return { SignInPage: mod.default };
}

/** The navigation the page performs on a successful restore. */
function captureNavigation(): { replaced: string[]; assigned: string[] } {
  const replaced: string[] = [];
  const assigned: string[] = [];
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      replace: (url: string) => replaced.push(url),
      assign: (url: string) => assigned.push(url),
    },
  });
  return { replaced, assigned };
}

function fetchReturning(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

async function mount(SignInPage: () => React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    createRoot(container).render(<SignInPage />);
  });
  return container;
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("in the cloud build", () => {
  it("spends the session cookie on a fresh token instead of asking for a password", async () => {
    const nav = captureNavigation();
    const fetchMock = fetchReturning(200, { signedIn: true, email: "person@example.com" });
    const { SignInPage } = await loadPage({ cloud: true });

    await mount(SignInPage);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    // withBasePath, or the request leaves the app's mount entirely and 404s.
    expect(url).toBe("/apps/photos/api/session/refresh");
    expect((init as RequestInit).method).toBe("POST");
    expect(nav.replaced).toEqual(["/apps/photos"]);
  });

  it("shows the form when there is no session to restore", async () => {
    const nav = captureNavigation();
    fetchReturning(401, { error: "Not authenticated" });
    const { SignInPage } = await loadPage({ cloud: true });

    const container = await mount(SignInPage);

    expect(nav.replaced).toEqual([]);
    expect(container.querySelectorAll("input")).toHaveLength(2);
    expect(container.textContent).not.toContain("Checking for an existing session");
  });

  it("shows the form when the refresh call cannot complete", async () => {
    // A network blip is not evidence of being signed out, and a page stuck on
    // "checking" would be a dead end of its own.
    const nav = captureNavigation();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const { SignInPage } = await loadPage({ cloud: true });

    const container = await mount(SignInPage);

    expect(nav.replaced).toEqual([]);
    expect(container.querySelectorAll("input")).toHaveLength(2);
  });

  it("bounces once, not forever", async () => {
    // If the app root sends the browser straight back here, refreshing again
    // would succeed again and bounce again. The second visit shows the form.
    const first = captureNavigation();
    fetchReturning(200, { signedIn: true });
    const { SignInPage } = await loadPage({ cloud: true });
    await mount(SignInPage);
    expect(first.replaced).toEqual(["/apps/photos"]);

    document.body.innerHTML = "";
    const second = captureNavigation();
    const fetchMock = fetchReturning(200, { signedIn: true });
    await mount(SignInPage);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(second.replaced).toEqual([]);
  });
});

describe("in the local build", () => {
  it("asks for nothing — there is no user pool and no gateway", async () => {
    const nav = captureNavigation();
    const fetchMock = fetchReturning(503, { error: "no pool" });
    const { SignInPage } = await loadPage({ cloud: false });

    const container = await mount(SignInPage);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(nav.replaced).toEqual([]);
    expect(container.querySelectorAll("input")).toHaveLength(2);
  });
});
