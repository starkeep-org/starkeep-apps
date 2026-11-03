# Starkeep apps

This repository holds the first-party apps that run on [Starkeep](https://github.com/starkeep-org/starkeep-core). Each app installs through the same path as a third-party app and depends only on the published `@starkeep/*` packages.

## What Photos does

Photos shows the photos and videos in your Starkeep storage as one library, grouped by date. Photos does not keep a separate copy. The app reads the same files that other Starkeep apps can see.

- Open a photo to see it full size, play a video, or read the camera, date and location details.
- Write a caption on any photo. Captions sync to your other devices.
- Turn on face recognition to find and name the people in your photos. Face recognition runs only on your computer, and its results never leave it.

Photos makes smaller copies of each photo and video so that the library loads quickly. The originals stay unchanged.

## Photos on the web

The web app runs in two places, and both serve the same build:

- **On your computer.** Admin-web starts Photos from this checkout. The app shows the files in the folders that the data server watches, and the app prepares new files in the background.
- **In the cloud.** Photos runs in your own AWS account, and you open it from any browser. Sign in with your Starkeep account to see the photos that synced from your devices. Face recognition is not available in the cloud.

The web app does not upload photos. To add photos, copy them into a watched folder or sync them from your phone with Photos Mobile.

## What is here

| Folder                    | What it is                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `photos/`                 | Photos for the browser. The app runs on your computer and, once installed in the cloud, from any browser. Built with Vite and Hono. See [`photos/README.md`](photos/README.md). |
| `photos-mobile/`          | Photos Mobile, the Android app. The app shows the phone's photos and videos and syncs them with your Starkeep cloud. Built with Expo and React Native.                          |
| `packages/photos-info/`   | The rows of a photo's info panel and their formatting, shared by both Photos apps.                                                                                              |
| `packages/photos-ladder/` | The sizes of Photos' renditions and the rule for picking one, shared by both Photos apps.                                                                                       |

## Install the apps

Clone this repository beside `starkeep-core`, in the same parent folder, and install its dependencies at the root:

```bash
pnpm install
```

Admin-web starts locally installed apps straight from this checkout, so the dependencies must be present before an app can start. Admin-web also scans this checkout for apps by default.

Then follow the [Get Started](https://github.com/starkeep-org/starkeep-core#get-started) guide in `starkeep-core`'s README. The guide installs Photos on your computer and then in the cloud.

## Install Photos Mobile

Photos Mobile syncs with a Starkeep cloud, so finish [Part B](https://github.com/starkeep-org/starkeep-core#part-b-deploy-starkeep-to-your-aws-account) of the Get Started guide first. You also need the Android SDK, a JDK and a phone with USB debugging turned on.

1. **Register the mobile app in the cloud.** In admin-web's **Cloud** section, **Install Photos in cloud** registers both the web app and the mobile app. To sync a phone without the cloud web app, choose **Register the Photos mobile app only** from the Photos card's menu instead.
2. **Generate the Android project.** The Android project is generated from `app.json` and is not committed:

   ```bash
   pnpm --filter @starkeep/photos-mobile prebuild
   ```

3. **Build the app:**

   ```bash
   cd photos-mobile/android
   ./gradlew assembleRelease
   ```

4. **Install the app on the phone** over USB:

   ```bash
   adb install -r app/build/outputs/apk/release/app-release.apk
   ```

5. **Sign in.** Open Starkeep Photos on the phone and enter the address from the **Cloud address** line in admin-web's **Cloud** section. The app opens the Starkeep sign-in page in the phone's browser. Sign in with your Starkeep account.

The phone then shows its own photos and videos, uploads them to the cloud, and shows the photos that synced from your other devices. The phone holds only the file types that Photos may read.

The build is signed with Expo's public debug key, which the Photos manifest declares. Anyone can build an app that the cloud accepts as Photos, so treat the current build as a development build.

## Write your own app

An app is any folder that holds a `starkeep.manifest.json`, sits inside a folder that admin-web scans, and depends on the published `@starkeep/*` packages. [`authoring-an-app.md`](https://github.com/starkeep-org/starkeep-core/blob/main/docs/authoring-an-app.md) in `starkeep-core` walks through the parts of an app, using Photos as the worked example.

To make admin-web find your app, click **Discover apps** in admin-web's header and add the folder that contains your app's folder.

## Run the tests

Run the tests from the root of this repository:

```bash
pnpm test
```

The command first runs `pnpm check:links`, which fails on any committed `link:` or `file:` path into `starkeep-core`, and then runs each app's own tests. Run `pnpm typecheck` to check the types. `pnpm test:integration` runs the slower suites that start processes or open sockets.

Do not run bare `vitest` from the root. The root has no Vitest config, so a bare run misses each app's settings and reports failures that are not real.

## Develop against an unreleased core

The apps use `@starkeep/*` packages from npm. To try an unreleased change to `starkeep-core`, point the packages at a local core checkout in your working tree only, as `photos-mobile/metro.config.js` describes. Release core before you commit anything that depends on the change. CI fails on a committed path into `starkeep-core`.
