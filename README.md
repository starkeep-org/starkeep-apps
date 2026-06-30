# Starkeep apps

First-party apps built on the public Starkeep SDK. Everything here installs through the same path a third-party app would — there is no privileged build wiring against `starkeep-core`.

The shipping app today is `photos/` (Next.js, deployable both locally and to a per-user AWS account via OpenNext).

## Authoring a third-party app

A third-party app is any directory that contains a `starkeep.manifest.json`, sits inside a parent directory that admin-web is configured to scan, and depends on the published `@starkeep/*` packages.

1. Install the SDK packages from npm:

   ```bash
   pnpm add @starkeep/sdk @starkeep/app-client @starkeep/admin-manifest
   ```

   `@starkeep/admin-manifest` exports the manifest schema and `validateManifest()`; use it in tests to catch manifest errors before install.

2. Write `starkeep.manifest.json` at the app root. The manifest declares `id`, `name`, `version`, `targets` (`local`, `cloud`, or both), and `infraRequirements.fileAccess` — the file-type grants the app needs. See `photos/starkeep.manifest.json` for a worked example. Two grants are reserved and only granted to specific apps: `fileAccessAll` (User-Data-Owner — Drive only) and `brokerPower` (cloud-data-server only).

3. Place the app directory inside any parent dir registered with admin-web. Open the **Dashboard** in admin-web and use the **App discovery** card to add `/path/to/your/app-parent-dir`. The default seed is the sibling `starkeep-apps/` directory of `starkeep-core/`, kept only for developer convenience — you can add or remove dirs freely.

4. Click **Install** on the app's card in admin-web. The install path is identical for first-party and third-party apps: admin-web reads the manifest from the scanned location, validates it, prompts for the user's grant approval, and POSTs to `local-data-server` to register the app and provision its per-app HMAC credentials.

5. For cloud targets, the app must also ship a `pnpm bundle` script that writes a Lambda deployment zip to `$STARKEEP_BUNDLE_OUT`. See `photos/infra/build-bundle.ts` for the contract (env in / file out) and a worked example.

## Developing against an unreleased core

When you need to iterate on `starkeep-core` and an app together, use `pnpm link` (or pnpm's `overrides`) to point `@starkeep/*` at a local checkout. This is purely a dev-ergonomics workflow — the app's `package.json` always declares published version ranges, never `workspace:*` paths into a sibling repo.
