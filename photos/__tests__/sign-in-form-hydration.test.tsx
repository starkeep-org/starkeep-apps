// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { SignInForm } from "@/lib/SignInForm";

// React refuses to flush effects inside `act` without this, and effects are
// the thing under test here.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The sign-in fields are server-rendered, so a person can type into them
 * before React attaches. Text typed in that window lands in the DOM and
 * nowhere else, and a React that hydrates with empty state leaves the submit
 * button disabled with no way for the person to recover it — they can see
 * their own credentials in the fields and the form will not send them.
 *
 * These tests drive the real hydration path rather than a `render()` that
 * never had a server pass, because the desync only exists across that seam.
 */

function serverRender() {
  const container = document.createElement("div");
  container.innerHTML = renderToString(<SignInForm />);
  document.body.appendChild(container);
  return container;
}

function fields(container: HTMLElement) {
  const [email, password] = container.querySelectorAll<HTMLInputElement>("input");
  if (!email || !password) throw new Error("the server-rendered form has no credential fields");
  return { email, password };
}

function submitButton(container: HTMLElement) {
  const el = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.startsWith("Sign in"),
  );
  if (!el) throw new Error("no submit button in the form");
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("filling the form before it hydrates", () => {
  it("enables the submit button for text typed before React attached", async () => {
    const container = serverRender();
    const typed = fields(container);
    typed.email.value = "person@example.com";
    typed.password.value = "hunter2";

    await act(async () => {
      hydrateRoot(container, <SignInForm />);
    });

    expect(submitButton(container).disabled).toBe(false);
  });

  it("sends the pre-hydration text, not the empty state it hydrated with", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ signedIn: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = serverRender();
    const typed = fields(container);
    typed.email.value = "person@example.com";
    typed.password.value = "hunter2";

    await act(async () => {
      hydrateRoot(container, <SignInForm onSignedIn={() => {}} />);
    });
    await act(async () => {
      submitButton(container).click();
    });

    const signIn = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/api/session/sign-in"));
    expect(signIn).toBeDefined();
    const [, init] = signIn as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      email: "person@example.com",
      password: "hunter2",
    });
  });

  it("leaves an untouched form disabled", async () => {
    const container = serverRender();

    await act(async () => {
      hydrateRoot(container, <SignInForm />);
    });

    expect(submitButton(container).disabled).toBe(true);
  });
});
