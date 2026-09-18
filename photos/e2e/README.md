# Photos e2e — and how to test an app on the Starkeep platform

Three Playwright suites, all against a real local platform booted from the
sibling `starkeep-core` checkout:

- **`photos-app.spec.ts`** asserts **photos' own behavior**: metadata
  extraction, the derived rendition ladder, the shared-vs-app-private data
  split.
- **`photos-platform.spec.ts`** asserts **platform behavior with photos as the
  fixture**: install consent UX, daemon lifecycle, cross-app visibility, dedup,
  uninstall survival. Those claims are about the platform, but every one of them
  is made through Photos' UI, so the suite lives where Photos' selectors change.
  Core asserts the same properties against its own fixture app
  (`starkeep-core/test-apps/probe`), which is what keeps them covered in a
  deployment that has no Photos.
- **`photos-removal.spec.ts`** asserts **what survives taking Photos off a
  machine**: an uninstall keeps `image_enriched` and the app-private files, a
  reinstall reads back the same row count, and a node-local removal takes both.
  It is the repeatable form of verification steps 1 and 3 of
  `starkeep/implementation-status-rendition-ownership-phase-1-2026-09-17.md` §5.
  The halves that need a cloud live in core's Tier-1 over-the-wire suite and in
  the Tier-3 journey, which runs against Photos' own `image_enriched` table.

Keep that split when adding tests. The question to ask is not "is this claim
about the platform?" but "does making it require Photos?" — if it does, it
belongs here.

## How it works (the worked example)

- `@starkeep/e2e` is a `link:` dependency on the sibling `starkeep-core/e2e`
  checkout. It exports the harness: `startPlatformStack` boots a throwaway
  local-data-server + admin-web; `installAppViaAdmin` /
  `startAppDaemonViaAdmin` run this app through the *real* platform APIs
  (manifest scan, consent gate, localRun spawn).
- `global-setup.ts` boots one stack for the whole run with **this repo as the
  app parent dir**, exactly like an operator pointing admin-web at their apps
  checkout. Specs read the endpoints from `E2E_*` env vars. Drive's UI is booted
  because the platform-flows suite reads cross-app visibility through it.
- Data-layer assertions go underneath the UI with `installAppDirect` (re-post
  the app's manifest to recover its installed credentials and `signedFetch` as
  the app) and `driveCreds` (see what *another* app sees — the shared surface).
- Image fixtures are generated in-process (`solidPng` from the harness,
  `tiffWithExif` from `__tests__/tiff-fixture.ts`) so byte-identity and EXIF
  contents are deterministic and no binaries live in the repo.

Run with `pnpm test:e2e` (needs the sibling `starkeep-core` checkout set up with
`pnpm install`). Unit tests (`pnpm test`) need no platform at all. The tier-3
cloud journey is separate — see `e2e-aws/README.md`.

## Gotchas

- The suites share one stack and all three drive Photos' install state, so each
  one that needs a particular starting state establishes it in `beforeAll`
  rather than inheriting it. `photos-platform.spec.ts` uninstalls first because
  it drives the consent dialog, which only appears for an app that is not
  installed; `photos-removal.spec.ts` uninstalls **with `deleteData`** and
  reinstalls, because an uninstall keeps the app's tables now and its first
  assertion is a row count. No suite should have to know which file Playwright
  reaches first.
- admin-web serves a **built** client. `pnpm test:e2e` in core builds it through
  turbo; running Playwright directly from here does not, so a core UI change
  that has not been rebuilt shows up as a dialog that never opens. Run
  `pnpm --filter admin-web build` in the core checkout first.
- Use `localhost`, never `127.0.0.1`, for browser URLs — Vite's dev-origin
  protection drops the HMR websocket for the bare IP and the page stalls.
- One dev server per app dir: a stale photos dev server from another session
  will collide with the daemon the admin route spawns.
- App daemon logs are copied to `e2e/test-results/*.log` at teardown — first
  place to look when a flow fails silently (several photos routes swallow
  downstream errors).
