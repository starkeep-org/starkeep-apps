# Starkeep apps

This repository holds the Photos product, which runs on [Starkeep](https://github.com/starkeep-org/starkeep-core): Photos for the browser, Photos Mobile, and the two packages they share. Photos installs through the same path as a third-party app, and gets the Starkeep platform from the published `@starkeep/*` packages.

The repository as a whole is the unit to copy. Photos' web and mobile apps depend on the shared packages through the workspace, so the `photos/` folder alone does not install. To start an app from Photos, copy the whole repository.

## What Photos does

Photos shows the photos and videos in your Starkeep storage as one library. Photos does not keep a separate copy of your media. Instead, the app uses Starkeep's common shared storage that Starkeep apps can see, if they have permission to access photos and videos.

- Open a photo to see it full size, play a video, or read the camera, date and location details.
- Write a caption on any photo. Captions sync to your other devices.

Photos makes smaller "stand-in" copies of each photo and video so that the library loads quickly. The originals stay unchanged.

## Photos on the web

You can run the Photos web app locally, or you can deploy to the cloud to access your photos remotely on the web.

To add photos, use a watched folder from the Admin app, or install the mobile app on your phone.

## What is here

| Folder                    | What it is                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `photos/`                 | Photos for the browser. The app runs on your computer and, once installed in the cloud, from any browser. Built with Vite and Hono. See [`photos/README.md`](photos/README.md). |
| `photos-mobile/`          | Photos Mobile, the Android app. The app shows the phone's photos and videos and syncs them with your Starkeep cloud. Built with Expo and React Native.                          |
| `packages/photos-info/`   | The rows of a photo's info panel and their formatting, shared by both Photos apps.                                                                                              |
| `packages/photos-ladder/` | The sizes of Photos' renditions and the rule for picking one, shared by both Photos apps.                                                                                       |

## Install the apps

Clone this repository into the same parent folder as `starkeep-core`, and keep the folder name `starkeep-apps`. Then install its dependencies at the root:

```bash
pnpm install
```

Starkeep's admin app starts locally installed apps straight from this checkout. The admin app scans a `starkeep-apps` folder beside `starkeep-core` for apps by default. For a checkout in any other place, click **Discover apps** in the admin app's header and add the checkout's folder.

Follow the [Get Started](https://github.com/starkeep-org/starkeep-core#get-started) guide in `starkeep-core`'s README. The guide installs Photos on your computer and then in the cloud.

To bring an existing checkout up to date, follow [Upgrade Starkeep](https://github.com/starkeep-org/starkeep-core#upgrade-starkeep) in `starkeep-core`'s README. To install Photos without Admin's web page, follow [From the terminal](https://github.com/starkeep-org/starkeep-core#from-the-terminal).

## Build Photos Mobile

Photos Mobile is the Android app. [Build the APK from source](https://github.com/starkeep-org/starkeep-core#build-the-apk-from-source-optional) in `starkeep-core`'s README lists the prerequisites and the build steps. [Part C: install the Photos mobile app](https://github.com/starkeep-org/starkeep-core#part-c-install-the-photos-mobile-app) covers registering the app in the cloud and signing in on the phone.

## Write your own app

An app is any folder that holds a `starkeep.manifest.json`, sits inside a folder that admin-web scans, and depends on the published `@starkeep/*` packages. [`authoring-an-app.md`](https://github.com/starkeep-org/starkeep-core/blob/main/docs/authoring-an-app.md) in `starkeep-core` walks through the parts of an app. To start one, copy [`example-app`](https://github.com/starkeep-org/starkeep-core/tree/main/example-app) from `starkeep-core`, a small app that performs every app-facing data operation.

To make admin-web find your app, click **Discover apps** in admin-web's header and add the folder that contains your app's folder.

## Run the tests

Run the tests from the root of this repository:

```bash
pnpm test
```

The command first runs `pnpm check:links`, which fails on any committed `link:` or `file:` path into `starkeep-core`, and then runs each app's own tests. Run `pnpm typecheck` to check the types. `pnpm test:integration` runs the slower suites that start processes or open sockets.

Photos' end-to-end suites, `pnpm test:e2e` and `pnpm test:aws` in `photos/`, boot a platform from a `starkeep-core` checkout. `scripts/link-core-harness.mjs` finds the checkout before each run, in `STARKEEP_CORE_DIR` or as the `starkeep-core` beside this repository, and links core's test harness. See [`photos/e2e/README.md`](photos/e2e/README.md).

## Develop against an unreleased core

The apps use `@starkeep/*` packages from npm. To try an unreleased change to `starkeep-core`, point the packages at a local core checkout in your working tree only, as `photos-mobile/metro.config.js` describes. Release core before you commit anything that depends on the change. CI fails on a committed path into `starkeep-core`.
