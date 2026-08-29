# Photos tier-3 — the cloud journey, against the real app

Photos' run of the platform's cloud journey, plus the assertions that need
Photos to be true.

```bash
STARKEEP_AWS_TESTS=1 pnpm test:aws
```

Inert without `STARKEEP_AWS_TESTS=1`, like core's. Needs the sibling
`starkeep-core` checkout set up (`pnpm install` there), Playwright's Chromium
(`pnpm exec playwright install chromium`), and AWS credentials in the ambient
profile.

**Stop any Photos dev server of your own first.** Next allows one dev server per
app directory, so a `pnpm dev` left running here would take the ladder step
down. The suite checks `.next/dev/lock` before its first AWS call and refuses to
start, rather than failing fifteen minutes and one Pulumi stack later.

## How the split works

The journey comes from `@starkeep/e2e-aws`, a `link:` dependency on the sibling
starkeep-core checkout — the same arrangement `@starkeep/e2e` uses at tier 2.
`defineCloudJourney` registers the platform steps (bootstrap,
cloud-data-server, Drive, install, sync, labels, the data plane, the session
gate, the browser upload, CloudFront, uninstall), and this file supplies:

- a `JourneyApp` describing Photos — its label keys, `image_enriched`,
  `/api/resize`, and the control that proves sign-in landed;
- a `preflight` that refuses to start against a running dev server;
- `extraSteps`, the three assertions that are about Photos: the app derives its
  full rendition ladder locally, every rung reaches the cloud carrying its label
  *and* its dimensions, and the cloud grid paints a rung rather than the
  original.

Core runs the identical platform journey against its own Probe fixture, so those
platform properties hold in a deployment that has no Photos. What lives here is
what needs Photos.

## Why the ladder assertions are here

They import `applicableStillClasses`, `RENDITION_LABEL_REF` and
`renditionFileName` as ordinary modules. That is the point of the split: the
expectation moves with a respec because it *is* the app's own definition, and
core never has to know what a rung is called.

Core used to read these out of this checkout by absolute path. The suite had
already spent a run discovering that `photos/thumbnail` had become
`photos/rendition`, and reaching across a repository boundary was the workaround
for a test that lived in the wrong repository.

## Run state

`e2e-aws/.run/<prefix>/` in *this* checkout (gitignored), passed as
`runStateDir`. It holds the run's Cognito admin password and registry database,
which have no business landing in core's working tree.
