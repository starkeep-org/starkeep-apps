/**
 * The browser entry point.
 *
 * Photos mounts one of three components and has no router. `/sign-in` gets the
 * sign-in page, `/p/<token>` gets a public link's viewer, and `/` and
 * `/photo/<id>` both get the app, which reads the open
 * photo from the URL itself (`src/lib/photo-route.ts`). `app/page.tsx` used to reach the
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

import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./ErrorBoundary";
import { appRelativePath } from "./lib/base-path";
import { PUBLIC_SHARE_ROUTE_PREFIX, SIGN_IN_ROUTE } from "./client-routes";
import { linkTokenOf } from "./public/public-share-client";

// Each screen is its own chunk. A public link's visitor downloads the viewer
// and nothing of the signed-in app: none of its data routes, its session
// handling or its sign-in page.
const App = lazy(() => import("../app").then((m) => ({ default: m.App })));
const SignInPage = lazy(() => import("./SignInPage").then((m) => ({ default: m.SignInPage })));
const PublicAlbumPage = lazy(() =>
  import("./public/PublicAlbumPage").then((m) => ({ default: m.PublicAlbumPage })),
);

const root = document.getElementById("root");
if (!root) throw new Error("photos: index.html has no #root to mount into");

const path = appRelativePath(window.location.pathname);

/**
 * A public link's page keeps its token out of every request it causes and
 * out of search engines. The shell is one file for every route, so the two
 * tags are added here, before anything loads.
 */
function markPublicPage(): void {
  for (const [name, content] of [
    ["referrer", "no-referrer"],
    ["robots", "noindex, nofollow"],
  ] as const) {
    const meta = document.createElement("meta");
    meta.name = name;
    meta.content = content;
    document.head.prepend(meta);
  }
}

function screen() {
  if (path.startsWith(PUBLIC_SHARE_ROUTE_PREFIX)) {
    markPublicPage();
    const token = linkTokenOf(path);
    return token ? <PublicAlbumPage linkToken={token} /> : <p>This link is not valid.</p>;
  }
  return path === SIGN_IN_ROUTE ? <SignInPage /> : <App />;
}

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <Suspense fallback={null}>{screen()}</Suspense>
    </ErrorBoundary>
  </StrictMode>,
);
