# Verification

LikeGo has two test classes:

- `bun run test:unit` runs deterministic tests that do not require external services.
- `bun run test:e2e` builds the packages and runs real provider, cross-runtime, executable-example, and published-package checks. Docker suites start real services and clean up the resources they create.

Scopes select execution input; they are not quality tiers. `fmt`, `typecheck`, `build`, `audit`, and `doc:build` are engineering commands, not additional test classes.

Coverage is an optional unit-test report:

```sh
bun run test:unit:coverage
```

The hosted CI intentionally runs only installation, formatting, type checking, building, and unit tests:

```sh
bun install --frozen-lockfile
bun run fmt:check
bun run typecheck
bun run build
bun run test:unit
```

Run E2E locally on a machine with the required runtimes and Docker:

```sh
bun run test:e2e

# Scoped commands build their required package output before running.
bun run test:e2e:runtimes
bun run test:e2e:providers
bun run test:e2e:published
bun run test:e2e:soak
```

The public E2E scripts build the root packages exactly once. Direct `bun e2e/run.ts ...` and direct workspace `test:e2e` invocations do not build; run `bun run build` first. The exact required versions are Bun `1.3.14`, Node.js `26.5.0`, Deno `2.9.4`, TypeScript `7.0.2`, and k6 `2.1.0` inside its fixed-digest image.

The examples scope derives its current input from immediate `examples/*/package.json` workspaces and requires every one to provide a non-empty wrapper. Durable registration, authenticated ACK, participant/result/completed set differences, nonzero child status, and cleanup failures are all fail-closed. New runtime support must update the package script, `e2e/definitions.ts`, its fixture, documentation, and a workspace-owned tsconfig in the same change.

Published checks install real tarballs before validating package resolution. The hosted authoring config is syntax-only; the staged lane performs NodeNext emit, Bun `--no-install` execution, and Deno check/run with `--no-prompt` and minimal permissions. The 10-second k6 run proves only the short path; a long-duration claim requires a separate run measured for at least 60 minutes. k6/soak is not part of the default bounded full command.

LikeGo platform support follows the selected JavaScript runtime's support for the required standard Web APIs and explicit runtime adapters. E2E process management is repository test infrastructure; its host-level containment behavior does not define package compatibility.

The default E2E process mode is `managed`. Its exit and residual fields describe only the current test run. Internal platform-containment experiments are optional supervisor maintenance evidence and do not gate a pull request, release, tag, or product platform-support claim.

Hosted CI green does not mean full E2E green. Release readiness still requires the applicable runtime consumers and real provider, example, published-package, and Docker scenarios to pass in an environment that supplies their declared tools.

A command or script existing in the repository does not prove it passed. Record the candidate commit/tree, exact environment and process mode, completed command, exit status, summary counts, and observed process/Docker residuals.
