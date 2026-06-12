# Photos app e2e — and how to test an app on the Starkeep platform

This suite asserts **photos' own behavior** on a real local platform: metadata
extraction, the derived thumbnail record, and the shared-vs-app-private data
split. Platform behaviors with photos as the fixture (install consent UX,
daemon lifecycle, dedup, uninstall survival) live in starkeep-core's `e2e/`
suite instead — keep that split when adding tests.

## How it works (the worked example)

- `@starkeep/e2e` is a `link:` dependency on the sibling
  `starkeep-core/e2e` checkout. It exports the harness:
  `startPlatformStack` boots a throwaway local-data-server + admin-web;
  `installAppViaAdmin` / `startAppDaemonViaAdmin` run this app through the
  *real* platform APIs (manifest scan, consent gate, localRun spawn).
- `global-setup.ts` boots one stack for the whole run with **this repo as the
  app parent dir**, exactly like an operator pointing admin-web at their apps
  checkout. Specs read the endpoints from `E2E_*` env vars.
- Data-layer assertions go underneath the UI with `installAppDirect` (re-post
  the app's manifest to recover its installed credentials and `signedFetch`
  as the app) and `driveCreds` (see what *another* app sees — the shared
  surface).
- Image fixtures are generated in-process (`solidPng` from the harness,
  `tiffWithExif` from `__tests__/tiff-fixture.ts`) so byte-identity and EXIF
  contents are deterministic and no binaries live in the repo.

Run with `pnpm test:e2e` (needs the sibling `starkeep-core` checkout set up
with `pnpm install`). Unit tests (`pnpm test`) need no platform at all.

## Gotchas

- Use `localhost`, never `127.0.0.1`, for browser URLs — Next's dev-origin
  protection drops the HMR websocket for the bare IP and hydration stalls.
- One `next dev` per app dir: a stale photos dev server from another session
  will collide with the daemon the admin route spawns.
- App daemon logs are copied to `e2e/test-results/*.log` at teardown — first
  place to look when a flow fails silently (several photos routes swallow
  downstream errors).
