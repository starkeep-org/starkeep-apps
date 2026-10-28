// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

/**
 * The gear menu's "Sign out" replaced a "Cloud setup" dialog that predated
 * managed login: a status line naming the API Gateway URL, a "Sign in again"
 * for someone already signed in, and a "Disconnect" that was a sign-out under
 * another name.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The cover-image controls need their provider and have nothing to do with this.
vi.mock("../src/lib/CoverImage", () => ({ CoverImageControls: () => null }));

async function loadMenu() {
  vi.resetModules();
  vi.stubEnv("STARKEEP_APP_BASE_PATH", "/apps/photos");
  const { SettingsMenu } = await import("../src/lib/SettingsMenu");
  const { signOut } = await import("../src/lib/sign-out");
  return { SettingsMenu, signOut };
}

async function openMenu(element: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    createRoot(container).render(element);
  });
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!.click());
  return container;
}

function button(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === label);
}

const layout = { rowHeight: 200, groupByDate: true };

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the gear menu's sign-out", () => {
  it("offers Sign out in the cloud build and calls it", async () => {
    const { SettingsMenu } = await loadMenu();
    const onSignOut = vi.fn();
    const container = await openMenu(
      <SettingsMenu layout={layout} onLayoutChange={vi.fn()} onSignOut={onSignOut} onOpenFaces={null} />,
    );
    expect(button(container, "Cloud setup")).toBeUndefined();
    await act(async () => button(container, "Sign out")!.click());
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it("offers no Sign out in the local build", async () => {
    const { SettingsMenu } = await loadMenu();
    const container = await openMenu(
      <SettingsMenu layout={layout} onLayoutChange={vi.fn()} onSignOut={null} onOpenFaces={vi.fn()} />,
    );
    expect(button(container, "Sign out")).toBeUndefined();
    expect(button(container, "On-device face recognition")).toBeTruthy();
  });

  it("ends the session and follows the platform's sign-out page", async () => {
    const { signOut } = await loadMenu();
    const assigned: string[] = [];
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { assign: (url: string) => assigned.push(url), reload: vi.fn() },
    });
    const fetchMock = vi.fn(async () =>
      Response.json({ signOutUrl: "https://auth.example/logout?client_id=c" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await signOut();

    expect(fetchMock).toHaveBeenCalledWith(
      "/apps/photos/api/session/sign-out",
      expect.objectContaining({ method: "POST" }),
    );
    expect(assigned).toEqual(["https://auth.example/logout?client_id=c"]);
  });
});
