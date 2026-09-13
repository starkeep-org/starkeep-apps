/**
 * The browser entry point.
 *
 * Photos has two shell paths and no router. `app/page.tsx` used to reach the
 * app through `next/dynamic` with `ssr: false`, which existed to keep a
 * browser-only tree out of a server render; there is no server render now, so
 * the import is direct and the app is the bundle's entry rather than a chunk
 * behind one.
 *
 * The path check is against the app-relative pathname: in the cloud the app is
 * mounted at `/apps/photos` and `location.pathname` carries it, so the mount is
 * stripped with the same build-time constant `withBasePath` prefixes with. The
 * two cannot disagree about where the app lives.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../app";
import { ErrorBoundary } from "./ErrorBoundary";
import { SignInPage } from "./SignInPage";
import { appRelativePath } from "./lib/base-path";
import { SIGN_IN_ROUTE } from "./client-routes";

const root = document.getElementById("root");
if (!root) throw new Error("photos: index.html has no #root to mount into");

const path = appRelativePath(window.location.pathname);

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>{path === SIGN_IN_ROUTE ? <SignInPage /> : <App />}</ErrorBoundary>
  </StrictMode>,
);
