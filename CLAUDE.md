Always write plans, designs, and other long-form output to a file. Never leave substantial detail only in chat — summarize in chat and link the file.

Use the Typescript LSP proactively as needed.
Use Kysely when writing new SQL or modifying existing SQL.

Run tests from the workspace root with `pnpm test`, which delegates to each app's own `test` script so every app keeps its own vitest version and config. Do not run bare `vitest` from the root: there is no root config, so it misses photos' `@` alias and JSX settings and sweeps in the Playwright specs under `photos/e2e/`. Those failures are an artifact of the missing config, not real.

A green root `pnpm test` spans two different versions of the platform. photos tests against the published `@starkeep/app-client`, while photos-mobile is rewritten by `pnpm.overrides` to `link:` the starkeep-core working tree — and those links resolve through core's `dist/`, so photos-mobile is testing whatever core was last built, not its source. Build core before trusting a photos-mobile result.

When reviewing code that touches a credential, a signing capability, a role assumption, or any privileged operation, run the reachability pass in starkeep-core/review-reachability-pass.md and include its table in the review. It exists because a 2026-06 review contained every fact needed to find the unauthenticated-cloud-apps exposure and never composed them.
