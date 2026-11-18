# Verification

A command can exist without having passed. One green lane does not imply every plug, runtime, example, or packed tarball works. Record the candidate tree, tool versions, exact command, exit status, counts, and cleanup.

## Evidence lanes

| Lane                | What it checks                                                                              | External services       | What a pass does not prove               |
| ------------------- | ------------------------------------------------------------------------------------------- | ----------------------- | ---------------------------------------- |
| Format              | Source and documentation formatting                                                         | No                      | Runtime behavior                         |
| Lint                | Oxlint rules                                                                                | No                      | Types or runtime behavior                |
| Typecheck           | Root, package, example, and E2E TypeScript                                                  | No                      | Build output or provider behavior        |
| Unit                | Deterministic tests                                                                         | No                      | Real network, Docker, or packed tarballs |
| Build               | Package ESM and declarations                                                                | No                      | Consumer resolution                      |
| Runtime E2E         | Bun and Node fixtures where declared                                                        | Usually no              | Every plug                               |
| Provider E2E        | Consul, etcd, Kubernetes, ZooKeeper, Redis, RabbitMQ, NATS, and the other declared services | Yes                     | Production availability or hosted CI     |
| Example E2E         | Example process, request, readiness, stop, and cleanup                                      | Sometimes               | A separate installation of every example |
| Published           | Packed tarballs consumed by Node and Bun fixtures                                           | No, except plug imports | npm publication                          |
| Soak                | Long-duration HTTP or service behavior                                                      | Usually no              | A short test, or every plug              |
| Documentation build | VitePress                                                                                   | No                      | Browser layout or translation quality    |
| Audit               | Dependency vulnerability report                                                             | No                      | Application authorization                |

The current public inventory is 20 packages and 75 entries. See [Packages](/reference/packages).

## Declared commands

From the repository root:

```sh
bun install --frozen-lockfile
bun run verify
```

`bun run verify` runs `test:protobuf`, `fmt:check`, `lint:check`, `typecheck`, `build`, and `test:unit:coverage` in that order. The coverage stage runs each root and workspace coverage script and finishes with `coverage:verify`. `examples/payments-ledger` is the unit-scope exception whose coverage script also runs its PostgreSQL and NATS scenario and therefore needs Docker.

`fmt` repairs formatting. `lint` applies safe Oxlint fixes, formats the result, and succeeds only with zero warnings:

```sh
bun run fmt
bun run lint
```

Individual stages narrow a failure. Passing one stage does not replace `verify`:

```sh
bun run test:protobuf
bun run fmt:check
bun run lint:check
bun run typecheck
bun run build
bun run test:unit
bun run test:unit:coverage
bun run test:parallel
bun run test:stability
```

`test:unit:coverage` checks the executable-source inventory and per-file line and function coverage. It does not claim branch coverage. `test:stability` randomizes each root and workspace run, repeats every test file twice, and prints the seed. It does not retry. `test:parallel` runs the unit scope once with two isolated Bun workers. Neither stability nor parallel is part of `verify`.

Documentation build and audit stay separate:

```sh
bun run doc:build
bun run audit
```

`test:protobuf` runs Buf lint and generation, checks generated fixture types, and runs its RPC integration test. It is not a read-only format check.

## E2E scopes

The root scripts are:

```sh
bun run test:e2e:suites
bun run test:e2e:runtimes
bun run test:e2e:providers
bun run test:e2e:examples
bun run test:e2e:published
bun run test:e2e
bun run test:e2e:soak
bun run test:e2e:grpc-soak
```

The scope scripts build first, except `test:e2e:grpc-soak`, which generates protobuf and then runs `e2e/grpc-soak.ts`. Direct `bun e2e/run.ts --scope <name>` does not necessarily build. Say which one you ran.

Provider E2E needs its declared Docker services and cleanup. Published checks pack tarballs and install them into staged consumers. Soak defaults to 60 minutes:

```sh
bun run test:e2e:soak
```

A short HTTP run is not that soak.

This page lists the scripts in the root manifest. It does not record an exit status for them. Step-by-step suite layout lives with the E2E runner, not here.

## Toolchain observation

The repository does not declare runtime or tool versions as execution requirements. A lane checks that each required tool can execute, then records the environment. A missing tool, a timeout, a nonzero status, or a failing consumer fails the run. A version string does not.

Dependency versions, the lockfile, and fixed fixtures are reproducibility inputs.

## Baseline evidence for this documentation track

The supplied contract audit reported the following on commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675`:

```text
bun run typecheck  -> passed
bun run test:unit  -> passed, 2,736 tests across root and 87 workspaces
bun run fmt:check  -> passed, 1,514 files
source export audit -> 66 declared entries imported without an import error
```

That audit describes the pre-migration tree. The current source exports 75 entries across 20 packages. The audit did not run `build`, `doc:build`, `audit`, Docker provider E2E, cross-runtime execution, published tarball checks, npm queries, hosted CI, or the 60-minute soak. This documentation edit does not replace that record with a new pass result.

## What a result allows you to say

| Result                   | Safe statement                                                       |
| ------------------------ | -------------------------------------------------------------------- |
| Source export inspection | "The package exports this symbol at this tree."                      |
| Focused typecheck        | "This source typechecks under this command."                         |
| Focused unit test        | "These cases passed under this command."                             |
| `bun run verify`         | "The recorded verify sequence passed for this tree and environment." |
| Provider E2E             | "This scenario passed with the recorded service and cleanup."        |
| Runtime fixture          | "This fixture passed under this runtime version."                    |
| Published consumer       | "This packed artifact was consumed by the recorded fixture."         |
| Documentation build      | "VitePress built the configured routes."                             |
| Soak                     | "This duration and workload completed with the recorded residuals."  |

Use [Claims](/reference/claims) for the editorial ledger.

## Known boundaries

- A manifest `publishConfig` does not establish npm publication.
- A workflow file does not establish a hosted CI result.
- A package script can be a declared lane without a recent pass.
- Memory providers do not establish cross-process or vendor-protocol behavior.
- A Web `ReadableStream` does not establish internal full-duplex RPC.
- TLS options do not establish application authentication.
- A stop timeout does not establish that every native resource has finished.
