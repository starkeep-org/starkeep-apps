Always write plans, designs, and other long-form output to a file. Never leave substantial detail only in chat — summarize in chat and link the file.

Use the Typescript LSP proactively as needed.
Use Kysely when writing new SQL or modifying existing SQL.

Run tests from the workspace root with `pnpm test`, which delegates to each app's own `test` script so every app keeps its own vitest version and config. Do not run bare `vitest` from the root: there is no root config, so it misses photos' `@` alias and JSX settings and sweeps in the Playwright specs under `photos/e2e/`. Those failures are an artifact of the missing config, not real.

photos-mobile runs two test runners. Vitest runs the logic tests in `__tests__/` in Node. Jest, under `jest-expo/android`, renders the component and hook tests in `__ui_tests__/`. Its `test` script runs both, and `test:ui` runs Jest alone. Put a decision in a plain `.ts` file with a Vitest test where you can, and write a component test only for the wiring that a plain function cannot reach.

Every app resolves `@starkeep/*` packages from npm, so a green `pnpm test` means the apps pass against core as published. `pnpm test` first runs `pnpm check:links`, which fails on any committed `link:` or `file:` path into `starkeep-core`. The private e2e harnesses (`@starkeep/e2e`, `@starkeep/e2e-aws`) are the one exception, and their suites need a sibling core checkout. To develop against unpublished core, follow the linked mode described in `photos-mobile/metro.config.js` in your working tree only, and release core before committing anything that depends on it. CI runs `pnpm check:links`, `pnpm typecheck` and `pnpm test` with no core checkout.

When reviewing code that touches a credential, a signing capability, a role assumption, or any privileged operation, run the reachability pass in starkeep-core/review-reachability-pass.md and include its table in the review. It exists because a 2026-06 review contained every fact needed to find the unauthenticated-cloud-apps exposure and never composed them.
