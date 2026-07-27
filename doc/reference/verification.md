# Verification

LikeGo has two test classes:

- `bun run test:unit` runs deterministic tests that do not require external services.
- `bun run test:e2e` builds the packages and runs real provider, cross-runtime, executable-example, and published-package checks. Docker suites start real services and clean up the resources they create.

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

`fmt`, `typecheck`, `build`, `audit`, and `doc:build` are engineering commands, not additional test classes. A command or script existing in the repository does not prove it has passed; use the current invocation's terminal status and logs.
