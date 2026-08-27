# Verification

go-like has several evidence lanes. A command can exist without having passed, and one green lane does not imply every provider, runtime, example, or published package works. Record the candidate tree, tool versions, exact command, exit status, counts, and cleanup observations.

## Evidence lanes

| Lane                | What it checks                                                                     | External services           | What a pass does not prove                                       |
| ------------------- | ---------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------- |
| Format              | Source and documentation formatting                                                | No                          | Runtime behavior or API compatibility                            |
| Lint                | Oxlint static rules                                                                | No                          | Type correctness or runtime behavior                             |
| Typecheck           | Root, E2E, package, and example TypeScript contracts                               | No                          | Build output, runtime semantics, provider behavior               |
| Unit                | Deterministic root, package, and example tests                                     | No                          | Real network, Docker, published tarballs, cross-runtime behavior |
| Build               | Package ESM and declaration output                                                 | No                          | Consumer resolution or runtime behavior                          |
| Runtime E2E         | Bun, Node.js, and Deno fixtures where declared                                     | Usually no                  | Providers or all packages in every runtime                       |
| Provider E2E        | Real Consul, etcd, Kubernetes, ZooKeeper, Redis, RabbitMQ, NATS, or other services | Yes                         | Production availability or hosted CI                             |
| Example E2E         | Executable example processes, requests, readiness, stop, and cleanup               | Sometimes                   | Every example in a separate installation                         |
| Published           | Physical packed tarballs consumed by Node, Bun, and Deno fixtures                  | No, except provider imports | npm registry publication or external consumer adoption           |
| Soak                | Long-duration HTTP or service behavior                                             | Usually no                  | Short tests or all provider behavior                             |
| Documentation build | VitePress route and Markdown build                                                 | No                          | Browser layout or localized semantic parity                      |
| Audit               | Dependency vulnerability report                                                    | No                          | Application security design or authorization completeness        |

## Declared commands

From the repository root:

```sh
bun install --frozen-lockfile
bun run verify
```

`bun run verify` is the canonical repository gate. It runs `fmt:check`, `lint`, `typecheck`, `build`, `test:unit`, and `test:unit:coverage` in that order. The coverage stage finishes with `coverage:verify`, so coverage enforcement is part of the gate.

Run an individual stage only to narrow a failure; passing one stage does not replace the canonical gate:

```sh
bun run fmt:check
bun run lint
bun run typecheck
bun run build
bun run test:unit
bun run test:unit:coverage
```

The root scripts are defined in `package.json`. `bun run lint` checks Oxlint static rules; it does not typecheck or execute runtime behavior. `bun run test:unit` runs root tests and the workspace unit scripts sequentially. `bun run build` builds package output before E2E scopes.

Documentation build and audit remain separate evidence lanes:

```sh
bun run doc:build
bun run audit
```

`bun run doc:build` builds the English and localized VitePress site configured under `doc/`.

The package and example scoped commands are useful when narrowing a failure:

```sh
bun run --cwd examples/healthcare-appointments typecheck
bun run --cwd examples/healthcare-appointments test:unit
bun run --cwd examples/vanilla-web test:unit
```

## E2E scopes

The public scripts build the root packages and then select a scope:

```sh
bun run test:e2e:runtimes
bun run test:e2e:providers
bun run test:e2e:examples
bun run test:e2e:published
bun run test:e2e
bun run test:e2e:soak
```

The direct runner is also available after a build:

```sh
bun run build
bun e2e/run.ts --scope runtimes
bun e2e/run.ts --scope providers
bun e2e/run.ts --scope examples
bun e2e/run.ts --scope published
```

The public scope scripts build first. Direct `bun e2e/run.ts ...` and direct workspace E2E commands do not necessarily build; make the build prerequisite explicit in a run record.

Provider E2E needs its declared Docker services and cleanup. Example E2E requires each `examples/*` workspace to provide a non-empty wrapper. Published checks pack physical tarballs, install them into staged consumers, perform NodeNext emit, run Node, run Bun with `--no-install`, and run Deno checks/runs with the documented permission and prompt settings.

Soak is deliberately separate:

```sh
bun run test:e2e:soak
```

The default script requests 60 minutes. A short k6 or HTTP run is not a 60-minute stability claim.

## Toolchain observation policy

The repository does not declare runtime or tool versions as execution requirements. A selected lane checks that each required tool can execute, then records the observed environment. Missing tools, timeouts, abnormal termination, nonzero exit status, or failing consumers still fail the run; a version value or unfamiliar version-output format does not.

Dependency versions, lockfiles, Action SHAs, and fixed test fixtures are reproducibility inputs rather than runtime eligibility.

## Baseline evidence for this documentation track

The supplied repository contract audit reported the following on candidate commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675`:

```text
bun run typecheck  -> passed
bun run test:unit  -> passed, 2,736 tests across root and 87 workspaces
bun run fmt:check  -> passed, 1,514 files
source export audit -> all 66 declared entries imported without an import error
```

This is a baseline evidence report supplied to the documentation phase. It is not a claim that every command in this page ran during the current documentation edit. The supplied audit did not run `build`, `doc:build`, `audit`, Docker/provider E2E, cross-runtime execution, published tarball checks, npm queries, hosted CI inspection, or the 60-minute soak.

The documentation phase should add its own run record after executing the focused docs checks. Do not replace the baseline record with a vague “tests passed” sentence.

## Documentation track run record

This record describes the dirty documentation worktree after the canonical, locale, and focused factual corrections. It is separate from the supplied baseline above. The documentation build, formatter check, and diff check below were rerun after the focused correction pass.

```text
candidate tree:  9385dbf5b6a7d913be56a80ade359e1bf9be8675 plus uncommitted documentation-only changes
environment:     macOS host
Bun:             1.3.14
Node.js:         26.5.0 (declared matrix: 26.x)
command:         bun run doc:build
exit status:     0
summary:         VitePress client/server bundles built and all configured pages rendered; no dead links reported
Docker residual: none started
process/socket residual: none started by the documentation checks
notes:           This proves the configured documentation build, not browser layout, translated prose quality, runtime behavior, provider E2E, npm publication, or production adoption.

command:         bun x oxfmt --check README.md doc docs/capability-comparison.md
exit status:     0
summary:         README, canonical docs, localized docs, VitePress config, and the historical comparison record matched formatting

command:         git diff --check
exit status:     0
summary:         no whitespace errors in the working-tree diff
```

Node.js 26.5.0 is the environment observed by that documentation run. Provider, cross-runtime, published-consumer, hosted CI, and soak lanes remain unexecuted in this documentation phase; the observation does not define an admission or support range.

## Evidence record template

Use a record like this in release notes, review comments, or an audit artifact:

```text
candidate tree:  <commit SHA or explicit dirty-tree description>
environment:     <OS, container/host, process mode>
Bun:            <version>
Node.js:        <version or not used>
Deno:           <version or not used>
TypeScript:     <version if relevant>
command:        <exact command>
started:        <timestamp>
finished:       <timestamp>
exit status:    <integer>
summary:        <test count, package count, or route count>
Docker residual: <none, or exact containers>
process/socket residual: <none, or exact observation>
notes:          <known limits and skipped scopes>
```

## What each result allows you to say

| Result                   | Safe statement                                                                 |
| ------------------------ | ------------------------------------------------------------------------------ |
| Source export inspection | “The package exports this symbol at this tree.”                                |
| Focused typecheck        | “This source/type surface typechecks under this command.”                      |
| Focused unit test        | “These deterministic cases passed under this command.”                         |
| Root Verify sequence     | “The recorded Verify sequence passed for this tree and environment.”           |
| Provider E2E             | “This provider scenario passed with the recorded service/version and cleanup.” |
| Runtime fixture          | “This fixture passed under this runtime version.”                              |
| Published consumer       | “This packed artifact was consumed by the recorded fixture.”                   |
| Documentation build      | “VitePress built the configured documentation routes.”                         |
| Soak                     | “This measured duration and workload completed with the recorded residuals.”   |

Do not turn a unit result into a production-adoption claim, or a source option into a security policy. Use [Claims](/reference/claims) for the editorial claim ledger.

## Known evidence boundaries

- No npm publication state is established by local manifests or `publishConfig`.
- No hosted CI result is established by a workflow file.
- A package's runtime script may be a declared lane without a recent pass result.
- Memory providers do not establish cross-process, durability, or vendor protocol behavior.
- Node-specific subpaths do not establish Deno support.
- A Web `ReadableStream` does not establish internal full-duplex RPC support.
- TLS and mTLS source options do not establish application authentication or authorization.
- A stop timeout does not establish that every native resource is terminal.
