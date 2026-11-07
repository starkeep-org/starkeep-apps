# Photos e2e — and how to test an app on the Starkeep platform

Two Playwright suites, both against a real local platform booted from a
`starkeep-core` checkout:

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

Keep that split when adding tests. The question to ask is not "is this claim
about the platform?" but "does making it require Photos?" — if it does, it
belongs here.

## How it works (the worked example)

- `@starkeep/e2e` comes from a starkeep-core checkout, and no `package.json`
  names it. `scripts/link-core-harness.mjs` at the repository root runs before
  every e2e command, finds core and links the harness into
  `node_modules/@starkeep/`. It looks in `STARKEEP_CORE_DIR` first, then at the
  `starkeep-core` beside this repository. It stops with one message naming the
  path it tried when neither holds a checkout with dependencies installed. The
  harness exports: `startPlatformStack` boots a throwaway
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

Run with `pnpm test:e2e`. It needs a `starkeep-core` checkout set up with
`pnpm install`, beside this repository or named by `STARKEEP_CORE_DIR`. Unit tests (`pnpm test`) need no platform at all. The tier-3
cloud journey is separate — see `e2e-aws/README.md`.

## Gotchas

- The two suites share one stack and both drive Photos' install state, so
  `photos-platform.spec.ts` uninstalls first: it drives the consent dialog,
  which only appears for an app that is not installed. Neither suite should have
  to know which file Playwright reaches first.
- Use `localhost`, never `127.0.0.1`, for browser URLs — Vite's dev-origin
  protection drops the HMR websocket for the bare IP and the page stalls.
- One dev server per app dir: a stale photos dev server from another session
  will collide with the daemon the admin route spawns.
- App daemon logs are copied to `e2e/test-results/*.log` at teardown — first
  place to look when a flow fails silently (several photos routes swallow
  downstream errors).
