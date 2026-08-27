# go-like Unrestricted Toolchain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove runtime and toolchain version eligibility gates while retaining tool availability checks, observed-environment evidence, reproducible dependencies, and fixed test fixtures.

**Architecture:** The E2E runner will probe only whether selected tools can execute, normalize their output for evidence, and never compare it with a required version. CI will select current tools without fixed runtime or runner versions. Dependency ranges, `bun.lock`, Action SHAs, and Docker/third-party fixtures remain fixed.

**Tech Stack:** TypeScript, Bun, GitHub Actions, Docker, VitePress, oxfmt.

**Spec:** `docs/superpowers/specs/2026-08-26-unrestricted-toolchain-design.md`

## Execution Record

- Tasks 1-2 and the active runtime-observation policy were implemented in `2d81af6`; the follow-up test-race correction is `b9f6f59`.
- Manifest, Verify, CodeQL, canonical documentation, locale, and package-entrypoint work was completed across `2d81af6` and `af016d8`.
- Task 3's original Release steps were superseded by the later approved removal of Changesets and `.github/workflows/release.yml`.
- Task 6's content change is included in the final tracked planning artifact; its original checkout-separation procedure is historical and no longer applies.
- The constraints and unchecked steps below preserve the original execution record; their worktree, Release, and no-commit instructions are historical and must not be executed against current main.

## Original Global Constraints (Historical)

- Execute in `/Users/munmunmiao/Documents/web/likego/.worktrees/p0-readiness-docs`; do not revert the existing seven-file P0 documentation diff.
- The base commit remains `5bf7faee8926bd9664fcb8d9f41a2b61e6937dae`; all review packages must name this base and the expanded file scope.
- Remove runtime/tool version eligibility only; keep dependency versions, workspace package versions, `overrides`, `bun.lock`, GitHub Action SHAs, and Docker/third-party fixtures.
- A tool may fail preflight because it is missing, times out, terminates abnormally, or exits nonzero; it must not fail because of a version value or output format.
- Observed tool versions remain evidence, never support ranges.
- Historical plans, dogfood records, comparison snapshots, and immutable run records remain unchanged.
- The current POSIX controller unit failure is out of scope; rerun and report it without claiming a full green suite.
- Do not add dependencies, public APIs, runtime adapters, version files, or compatibility matrices.
- Do not commit, push, merge, publish, deploy, alter branch protection, or remove the worktree without explicit authorization.
- Because commits are not authorized, implementers must not stage or commit. Per-task reviews use task-file-scoped working-tree diffs and report `commit: none`; this overrides the generic SDD implementer template's commit step.

---

### Task 1: Remove the shared E2E version eligibility gate

**Files:**

- Modify: `test/e2e-runtime-version.test.ts`
- Modify: `e2e/runtime-versions.ts`
- Modify: `e2e/executor.ts`
- Modify: `test/e2e-runtime-plan.test.ts`
- Modify: `test/e2e-process-supervision.test.ts`
- Modify: `e2e/fixtures/runner/version-preflight.ts`

**Interfaces:**

- Consumes: `SuiteDefinition.requiredTools: readonly RequiredTool[]`, `ProcessSupervisor.run(root, definition)`, and existing `CommandResult` termination fields.
- Produces:

```ts
export interface RuntimeVersionObservation {
  readonly tool: RequiredTool
  readonly actual: string
}

export async function probeRequiredRuntimeVersions(
  root: string,
  tools: readonly RequiredTool[],
  runner: RuntimeProbeRunner,
  dependencies?: RuntimeProbeDependencies
): Promise<readonly RuntimeVersionObservation[]>
```

- Preserves: `requiredToolsForPlan(...)`, `renderRuntimePreflight(...)`, fixed tool order, bounded diagnostics, supervisor preflight, consumer execution, cleanup, containment, and residual checks.

- [ ] **Step 1: Record the expanded worktree baseline**

Run:

```sh
git status --short --branch
git diff --name-only
git rev-parse HEAD
```

Expected: HEAD is the recorded base; the only tracked changes before this task are the seven reviewed P0 documentation files. Append the expanded authorization and this plan path to the ignored SDD ledger; do not edit tracked files in the main checkout.

- [ ] **Step 2: Replace version-eligibility tests with arbitrary-observation tests**

In `test/e2e-runtime-version.test.ts`, remove imports and tests for `RequiredRuntimeVersions`, strict parsers, and `assertRequiredRuntimeVersions`. Keep the filesystem shim and child-process consumer-marker coverage, but change it from mismatch rejection to arbitrary-output acceptance. Keep importing `probeRequiredRuntimeVersions`; renaming a function that still probes the versions of required tools would add churn without changing behavior.

Change `probeVersions()` defaults so no fixture depends on a removed required-version constant. Use arbitrary successful observations such as `bun-observed`, `node-observed`, `deno-observed`, `typescript-observed`, and `docker-observed`.

Add this direct observation test:

```ts
test("successful tool probes record arbitrary output without an eligibility gate", async () => {
  const observations = await probeRequiredRuntimeVersions(
    "/repo",
    ["bun", "node", "deno", "typescript", "docker"],
    async (_root, definition) => {
      const executable = definition.command[0] ?? ""
      if (executable === "node") return result("future-node channel")
      if (executable === "deno") return result("custom deno build\nextra detail")
      if (executable === "docker") return result("")
      return result("typescript nightly")
    },
    { bunVersion: () => "bun-canary" }
  )

  expect(observations).toEqual([
    { tool: "bun", actual: "bun-canary" },
    { tool: "node", actual: "future-node channel" },
    { tool: "deno", actual: "custom deno build" },
    { tool: "typescript", actual: "typescript nightly" },
    { tool: "docker", actual: "unreported" }
  ])
})
```

Replace the old Node/TypeScript mismatch test with:

```ts
test("version differences are observed without blocking the selected consumer", async () => {
  const logs: string[] = []
  let started = 0
  const probes = probeVersions({ node: "v999.0.0" })

  await runE2eRequest(
    "/repo",
    { kind: "scope", scope: "suites", processMode: "managed" },
    undefined,
    {
      definitions: [selectedDefinition("consumer", ["node"])],
      validatePlan: async () => {},
      createSupervisor: async () => testSupervisor(probes.runner),
      runtimeProbe: probes.dependencies,
      executeDefinition: async () => {
        started += 1
        return result()
      },
      write: (value) => logs.push(value)
    }
  )

  expect(started).toBe(1)
  expect(logs.join("")).toContain("node=v999.0.0")
  expect(logs.join("")).not.toContain("required=")
})
```

Add retained fail-closed characterization coverage for all preserved tool failures: a thrown runner error (missing/unstartable command), timeout, abnormal termination, and nonzero exit. Each case must assert the selected consumer does not start and the error is `prerequisite-tool-unavailable` with the case-specific reason. These branches already exist; the arbitrary-output/version-drift cases are the RED tests for this behavior change.

For example, the nonzero case remains:

```ts
test("a nonzero required-tool probe prevents the selected consumer", async () => {
  let started = false
  const probes = probeVersions()
  const runner: RuntimeProbeRunner = async () => result("", 17)

  await expect(
    runE2eRequest(
      "/repo",
      { kind: "scope", scope: "suites", processMode: "managed" },
      undefined,
      {
        definitions: [selectedDefinition("consumer", ["node"])],
        validatePlan: async () => {},
        createSupervisor: async () => testSupervisor(runner),
        runtimeProbe: probes.dependencies,
        executeDefinition: async () => {
          started = true
          return result()
        },
        write: () => {}
      }
    )
  ).rejects.toThrow("prerequisite-tool-unavailable: node version probe exited 17")
  expect(started).toBe(false)
})
```

Replace the two old PATH tests with one real-process behavior test that loops over `node`, `deno`, and `typescript`. Its shim returns arbitrary successful output, the child process must exit 0, and the consumer marker must contain `consumer started`. Rename the shared helper to describe acceptance rather than mismatch.

In `e2e/fixtures/runner/version-preflight.ts`, keep the request's real `managed` mode, but inject a minimal `ProcessSupervisor` through `createSupervisor`. Its `run` method delegates to the existing `runCommand`, its preflight reports `strategy: "runtime-managed"` with no containment claim, and `close` is a no-op. This keeps a real PATH/command/consumer integration proof while isolating the version-policy test from the unrelated known native-helper framing failure. Do not add a new process mode or change production supervisor code.

Add one focused sanitization test: a successful probe containing a token-like value must record `<redacted>`, and a successful first line longer than 1,000 characters must be bounded. This protects the new arbitrary-output logging surface rather than merely testing a helper.

- [ ] **Step 3: Run the new tests and verify RED**

Run:

```sh
bun test --isolate --no-orphans test/e2e-runtime-version.test.ts
```

Expected: FAIL because the current strict parser rejects arbitrary output and the Node/TypeScript PATH cases reject drift before writing the consumer marker. The fixture's injected direct-command supervisor keeps this RED result independent of the known POSIX helper failure.

- [ ] **Step 4: Implement version-neutral observations**

In `e2e/runtime-versions.ts`:

1. Delete `RequiredRuntimeVersions`, every strict version parser, `requiredVersion`, `matchesRequiredVersion`, and `assertRequiredRuntimeVersions`. Keep `RuntimeVersionObservation` and remove only its `required` field.
2. Import the existing `redactText` helper beside `boundedTail`, then add:

```ts
function observedOutput(value: string): string {
  const firstLine = value.trim().split(/\r?\n/u, 1)[0]?.trim() ?? ""
  return firstLine.length === 0
    ? "unreported"
    : boundedTail(redactText(firstLine), 1_000)
}
```

3. Keep `probeRequiredRuntimeVersions`. Keep existing command selection and `commandOutput` failure checks, then append:

```ts
observations.push(Object.freeze({ tool, actual: observedOutput(raw) }))
```

4. Render each observed tool as `${tool}=${observation.actual}`; never append `required=...`.

In `e2e/executor.ts`, delete the `assertRequiredRuntimeVersions` import and call; keep the existing probe call.

Update `e2e/fixtures/runner/version-preflight.ts` as described in Step 2. Remove stale `RequiredRuntimeVersions` imports from `test/e2e-runtime-plan.test.ts` and `test/e2e-process-supervision.test.ts`.

- [ ] **Step 5: Run Task 1 verification**

Run:

```sh
bun test --isolate --no-orphans test/e2e-runtime-version.test.ts
bun run typecheck:root
rg -n "\bRequiredRuntimeVersions\b|assertRequiredRuntimeVersions|prerequisite-version-mismatch|prerequisite-version-unparseable|exactOutput|parseNodeVersion|parseDenoVersion|parseTypeScriptVersion|parseObservedVersion" e2e test
git diff --check -- e2e/runtime-versions.ts e2e/executor.ts e2e/fixtures/runner/version-preflight.ts test/e2e-runtime-version.test.ts test/e2e-runtime-plan.test.ts test/e2e-process-supervision.test.ts
```

Expected: test and TypeScript commands exit 0; `rg` exits 1 with no matches; diff check exits 0.

- [ ] **Step 6: Independent Task 1 review**

Reviewer must verify:

- version values and output formats never create a failure branch;
- arbitrary observed output is redacted and bounded before logging;
- missing/timeout/abnormal/nonzero tools still fail before consumer start;
- selected tool order and preflight log remain deterministic;
- the real-process consumer marker proves version drift reaches execution without inventing a process mode or relying on the native-helper controller path;
- no P0 documentation change was reverted.

- [ ] **Step 7: Authorization-gated commit checkpoint**

Only if explicit commit authorization exists:

```sh
git add e2e/runtime-versions.ts e2e/executor.ts test/e2e-runtime-version.test.ts test/e2e-runtime-plan.test.ts test/e2e-process-supervision.test.ts e2e/fixtures/runner/version-preflight.ts
git commit -m "test: remove runtime version eligibility"
```

Otherwise skip and record `commit: none`.

### Task 2: Remove the k6 equality gate while retaining the fixture

**Files:**

- Modify: `test/e2e-soak-lifecycle.test.ts`
- Modify: `e2e/soak.ts`

**Interfaces:**

- Consumes: fixed `K6Image`, `k6VersionCommand(owner)`, `checked(...)`, and `SoakResult.environment.k6Version: string`.
- Produces:

```ts
export function observeK6Version(output: string): string
```

- [ ] **Step 1: Write the failing k6 observation test**

Replace the exact-version test with:

```ts
test("k6 preflight records arbitrary version output without rejecting drift", async () => {
  expect(observeK6Version("k6 v999.1.2 (custom build)\n")).toBe(
    "k6 v999.1.2 (custom build)"
  )
  expect(observeK6Version("")).toBe("unreported")

  const commands: string[][] = []
  const runner: typeof runCommand = async (_root, definition) => {
    commands.push([...definition.command])
    return commandResult("k6 future-channel\n")
  }

  await expect(
    preflightK6("owner", new AbortController().signal, runner)
  ).resolves.toBe("k6 future-channel")
  expect(commands).toEqual([[...k6VersionCommand("owner")]])
})
```

Remove the `K6Version` and `parseK6Version` imports. Keep the existing fixed-image argv test and command-failure tests unchanged.

- [ ] **Step 2: Run the test and verify RED**

Run:

```sh
bun test --isolate --no-orphans test/e2e-soak-lifecycle.test.ts
```

Expected: FAIL because `observeK6Version` does not exist and the current preflight rejects version drift.

- [ ] **Step 3: Implement the minimal observation function**

In `e2e/soak.ts`, delete `K6Version` and replace `parseK6Version` with:

```ts
export function observeK6Version(output: string): string {
  const firstLine = output.trim().split(/\r?\n/u, 1)[0]?.trim() ?? ""
  return firstLine.length === 0
    ? "unreported"
    : boundedTail(redactText(firstLine), 1_000)
}
```

`preflightK6(...)` must still call `checked(...)` and return `observeK6Version(output)`. Do not change `K6Image`, `K6Workload`, Docker labels, cleanup, result parsing, or evaluator thresholds.

- [ ] **Step 4: Run Task 2 verification**

Run:

```sh
bun test --isolate --no-orphans test/e2e-soak-lifecycle.test.ts test/e2e-soak-evaluator.test.ts
bun run typecheck:root
rg -n "\bK6Version\b|parseK6Version|expected k6" e2e test
git diff --check -- e2e/soak.ts test/e2e-soak-lifecycle.test.ts
```

Expected: tests and TypeScript exit 0; `rg` exits 1; diff check exits 0.

- [ ] **Step 5: Independent Task 2 review**

Reviewer must verify the fixed image remains byte-for-byte unchanged, version drift no longer fails, and all command/process/cleanup failures remain fail-closed.

- [ ] **Step 6: Authorization-gated commit checkpoint**

Only if explicitly authorized:

```sh
git add e2e/soak.ts test/e2e-soak-lifecycle.test.ts
git commit -m "test: observe k6 without version gating"
```

Otherwise skip.

### Task 3: Remove manifest and hosted-CI toolchain pins

**Files:**

- Modify: `package.json`
- Modify: `.github/workflows/verify.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/codeql.yml`

**Interfaces:**

- Consumes: existing GitHub Action SHAs, release registry settings, OIDC permissions, bootstrap input, and `bun install --frozen-lockfile`.
- Produces: moving hosted-tool selection with dependency, action, authentication, and release reproducibility inputs unchanged.

- [ ] **Step 1: Record the existing pins before editing**

Run:

```sh
rg -n 'packageManager|runs-on: ubuntu-[0-9]|bun-version:|node-version:|npm install --global npm@|name: Bun [0-9]' package.json .github/workflows/verify.yml .github/workflows/release.yml .github/workflows/codeql.yml
```

Expected: the command identifies every pin named by this task. Do not add a source-text unit test for these configuration decisions; it would only detect intentional YAML text changes, while the workflow files, formatter, frozen install, and focused audit are the executable checks.

- [ ] **Step 2: Apply the minimal manifest and workflow changes**

`package.json`:

- delete only `"packageManager": "...",`;
- do not change any dependency, version, workspace, script, override, or metadata field.

`.github/workflows/verify.yml`:

```yaml
jobs:
  verify:
    name: Verify
    runs-on: ubuntu-latest
```

Keep setup-bun's pinned `uses:` line and remove its entire `with: bun-version` block.

`.github/workflows/release.yml`:

- change runner to `ubuntu-latest`;
- remove setup-bun's version input;
- keep setup-node and its `registry-url` / `package-manager-cache` inputs, but remove `node-version`;
- add this to setup-deno:

```yaml
with:
  deno-version: latest
```

- delete the `Set up npm` step;
- leave permissions, environment, install, validation, publish, bootstrap, and tag steps unchanged.

`.github/workflows/codeql.yml`: change only `runs-on` to `ubuntu-latest`.

- [ ] **Step 3: Verify policy, formatting, and frozen dependencies**

Run:

```sh
bunx oxfmt --check package.json .github/workflows/verify.yml .github/workflows/release.yml .github/workflows/codeql.yml
! rg -n 'packageManager|runs-on: ubuntu-[0-9]|bun-version:|node-version:|npm install --global npm@|name: Bun [0-9]' package.json .github/workflows/verify.yml .github/workflows/release.yml .github/workflows/codeql.yml
rg -n 'runs-on: ubuntu-latest' .github/workflows/verify.yml .github/workflows/release.yml .github/workflows/codeql.yml
rg -n 'deno-version: latest' .github/workflows/release.yml
bun install --frozen-lockfile
git diff --exit-code -- bun.lock
git diff --check -- package.json .github/workflows/verify.yml .github/workflows/release.yml .github/workflows/codeql.yml
```

Expected: all commands exit 0 and `bun.lock` has no diff.

- [ ] **Step 4: Independent Task 3 review**

Reviewer must verify:

- no runtime/runner pin remains in the three workflows;
- setup-bun, setup-node, and setup-deno behavior matches the approved design;
- action SHAs, release auth, registry configuration, bootstrap safeguards, dependency ranges, and lockfile remain unchanged;
- the focused audit does not mistake action/dependency/fixture pins for toolchain eligibility.

- [ ] **Step 5: Authorization-gated commit checkpoint**

Only if explicitly authorized:

```sh
git add package.json .github/workflows/verify.yml .github/workflows/release.yml .github/workflows/codeql.yml
git commit -m "ci: remove toolchain version pins"
```

Otherwise skip.

### Task 4: Replace canonical version matrices with observation policy

**Files:**

- Modify: `e2e/README.md`
- Modify: `doc/guide/getting-started.md`
- Modify: `doc/guide/zero-to-one.md`
- Modify: `doc/reference/verification.md`
- Modify: `doc/reference/claims.md`
- Modify: `docs/editorial-blueprint.md`
- Modify: `docs/releases/0.0.1.md`

**Interfaces:**

- Consumes: Task 1's version-neutral tool preflight and Task 3's generic `Verify / Verify` check name.
- Produces: one canonical policy statement: required tools must execute, observed versions are evidence, and version numbers are not eligibility.

- [ ] **Step 1: Replace the public policy copy**

Use this exact canonical paragraph in `doc/guide/getting-started.md` and `doc/guide/zero-to-one.md`:

```md
The repository does not use runtime or tool versions as execution eligibility. Each selected verification lane checks that its required tools can run and records the observed environment. Command behavior and results, not version numbers, determine the outcome.
```

In Getting Started's first-run failures, replace the declared-matrix advice with:

```md
- If a runtime rejects the source syntax, record the observed environment and run the corresponding scoped check before treating it as an API failure. A version difference alone is neither a failure explanation nor an exclusion.
```

- [ ] **Step 2: Align E2E and verification references**

In `e2e/README.md`:

- rename “Registered runtimes 与版本” to “Registered runtimes 与工具观察”;
- remove the five-item current-version list and mismatch paragraph;
- state that selected tools must execute successfully, actual output is recorded, and no version value decides admission;
- retain fixed k6 image wording, labeling it a reproducible soak fixture rather than a support range;
- replace “version preflight” in the ownership section with “required-tool preflight”.

In `doc/reference/verification.md`, replace “Toolchain record” and its required-version table with:

```md
## Toolchain observation policy

The repository does not declare runtime or tool versions as execution requirements. A selected lane checks that each required tool can execute, then records the observed environment. Missing tools, timeouts, abnormal termination, nonzero exit status, or failing consumers still fail the run; a version value or unfamiliar version-output format does not.

Dependency versions, lockfiles, Action SHAs, and fixed test fixtures are reproducibility inputs rather than runtime eligibility.
```

Keep historical run records and their observed versions unchanged. Remove the sentence that declares a Node release lane and rewrite later active interpretation so the observed value is evidence rather than a range check.

Specifically, leave the historical fenced run-record values untouched, including the observed Bun and Node values. Replace the active sentence after that record with:

```md
Node.js 26.5.0 is the environment observed by that documentation run. Provider, cross-runtime, published-consumer, hosted CI, and soak lanes remain unexecuted in this documentation phase; the observation does not define an admission or support range.
```

In `doc/reference/claims.md`, replace C26 with:

```md
| C26 | Selected verification lanes require their tools to execute but do not reject an environment by runtime or tool version | `source` | `e2e/runtime-versions.ts`, `e2e/executor.ts`, and `doc/reference/verification.md` |
```

Change the publication checklist's runtime item to require recording the observed environment, not running at a declared version. Keep the historical baseline and third-party comparison snapshots.

- [ ] **Step 3: Align maintainers and release instructions**

In `docs/editorial-blueprint.md`:

- remove Bun from the current root-package metadata bullet;
- replace the validation-matrix paragraph with the no-eligibility policy while retaining the research probe as an observation;
- replace `required Node version` in the runtime ownership row with `required tool execution`;
- replace the C-014 evidence anchor `runtime matrix` with `runtime lanes`;
- replace the open `Node range` gap with an `Observed Node environment` gap that keeps `26.5.0` as historical evidence but explicitly says it is not an admission or support range;
- retain candidate-tree and historical observed results.

In `docs/releases/0.0.1.md`, change the required check name from the versioned name to `Verify / Verify`; do not alter package release versions or bootstrap rules.

- [ ] **Step 4: Verify canonical documentation**

Run:

```sh
bunx oxfmt --check e2e/README.md doc/guide/getting-started.md doc/guide/zero-to-one.md doc/reference/verification.md doc/reference/claims.md docs/editorial-blueprint.md docs/releases/0.0.1.md
bun run doc:build
rg -n "supported validation ranges|declared release lane|prerequisite-version-mismatch|Verify / Bun|current validation requirements|当前验证要求|required Node version|required E2E Node|\*\*Node range|runtime matrix|The declared validation matrix|records Bun .* as the validation matrix" e2e/README.md doc/guide/getting-started.md doc/guide/zero-to-one.md doc/reference/verification.md doc/reference/claims.md docs/editorial-blueprint.md docs/releases/0.0.1.md
git diff --check -- e2e/README.md doc/guide/getting-started.md doc/guide/zero-to-one.md doc/reference/verification.md doc/reference/claims.md docs/editorial-blueprint.md docs/releases/0.0.1.md
```

Expected: formatter, docs build, and diff check exit 0; `rg` exits 1.

- [ ] **Step 5: Independent Task 4 review**

Reviewer must distinguish current policy from historical evidence and verify that no immutable run record or package release version was rewritten.

- [ ] **Step 6: Authorization-gated commit checkpoint**

Only if explicitly authorized:

```sh
git add e2e/README.md doc/guide/getting-started.md doc/guide/zero-to-one.md doc/reference/verification.md doc/reference/claims.md docs/editorial-blueprint.md docs/releases/0.0.1.md
git commit -m "docs: remove runtime version eligibility"
```

Otherwise skip.

### Task 5: Synchronize locales and package entrypoints

**Files:**

- Modify: `doc/ar-Arab/guide/zero-to-one.md`
- Modify: `doc/es-Latn/guide/zero-to-one.md`
- Modify: `doc/fr-Latn/guide/zero-to-one.md`
- Modify: `doc/ru-Cyrl/guide/zero-to-one.md`
- Modify: `doc/zh-Hans/guide/zero-to-one.md`
- Modify: `doc/zh-Hant-HK/guide/zero-to-one.md`
- Modify: `doc/zh-Hant-TW/guide/zero-to-one.md`
- Modify: `packages/context/README.md`
- Modify: `packages/prometheus/README.md`
- Modify: `packages/nats/README.md`

**Interfaces:**

- Consumes: Task 4's canonical policy.
- Produces: public locale/package wording that does not recreate a support matrix.

- [ ] **Step 1: Replace the localized zero-to-one policy paragraphs**

Replace only the existing validation-matrix paragraph in each locale:

```text
ar-Arab:
الحزم هي اعتماديات workspace في هذا checkout. لا يستخدم المستودع إصدارات بيئات التشغيل أو الأدوات كشرط للسماح بالتنفيذ. يتحقق كل مسار تحقق محدد من إمكانية تشغيل أدواته المطلوبة ويسجل البيئة المرصودة. سلوك الأوامر ونتائجها، لا أرقام الإصدارات، هو ما يحدد النتيجة. وتقول وثائق الحزم الحالية إن الحزم لم تُنشر بعد إلى npm.

es-Latn:
Los paquetes son dependencias del workspace en este checkout. El repositorio no usa las versiones de runtimes o herramientas como requisito para ejecutar. Cada carril de verificación seleccionado comprueba que sus herramientas requeridas pueden ejecutarse y registra el entorno observado. El comportamiento y los resultados de los comandos, no los números de versión, determinan el resultado. La documentación actual de los paquetes dice que todavía no se han publicado en npm.

fr-Latn:
Les paquets sont des dépendances du workspace dans ce checkout. Le dépôt n'utilise pas les versions des runtimes ou des outils comme condition d'exécution. Chaque voie de vérification sélectionnée contrôle que les outils requis peuvent s'exécuter et consigne l'environnement observé. Le comportement et les résultats des commandes, et non les numéros de version, déterminent le résultat. La documentation actuelle des paquets précise qu'ils ne sont pas encore publiés sur npm.

ru-Cyrl:
В этом checkout пакеты подключаются как workspace dependencies. Репозиторий не использует версии сред выполнения или инструментов как условие допуска к запуску. Каждый выбранный контур проверки убеждается, что необходимые инструменты запускаются, и записывает наблюдаемое окружение. Результат определяют поведение и итог команд, а не номера версий. Текущая документация пакетов сообщает, что они ещё не опубликованы в npm.

zh-Hans:
当前 checkout 中，packages 通过 workspace dependencies 关联。仓库不把运行时或工具版本作为执行资格。每个被选中的验证 lane 只检查所需工具能否运行并记录实际环境；执行结果由命令行为和结果决定，而不是由版本号决定。当前 package 文档说明这些 packages 尚未发布到 npm。

zh-Hant-HK:
目前 checkout 中，packages 透過 workspace dependencies 互相連結。Repository 唔會將 runtime 或工具版本當成執行資格。每個被選中嘅驗證 lane 只會檢查所需工具能否運行，並記錄實際環境；執行結果由命令行為同結果決定，而唔係由版本號決定。目前 package 文件說明呢啲 packages 仲未發布到 npm。

zh-Hant-TW:
目前 checkout 中，packages 透過 workspace dependencies 互相連結。Repository 不會把 runtime 或工具版本當成執行資格。每個被選取的驗證 lane 只檢查所需工具能否執行，並記錄實際環境；執行結果由命令行為與結果決定，而不是由版本號決定。目前 package 文件說明這些 packages 尚未發布到 npm。
```

Preserve the localized first sentence saying the packages are workspace dependencies and the final sentence saying they are not yet published to npm. Do not alter neighboring translated application instructions.

- [ ] **Step 2: Replace package-level support matrices**

`packages/context/README.md`:

```md
运行时测试由仓库当前选择的验证 lane 按需执行；实际工具版本只作为本次运行的 evidence 记录，不构成支持门禁。标准 Web API 无法要求一个已被冻结
```

Keep the remainder of that paragraph unchanged.

`packages/prometheus/README.md`: replace `## 运行时矩阵` and its runtime list with:

```md
## 运行时验证

运行时检查使用当前环境中可执行的工具，并记录实际观察值；版本号不构成执行或支持门禁。依赖版本继续由 package manifest 与 lockfile 管理。
```

`packages/nats/README.md`: retain the pinned official NATS dependency versions and known upstream type issue, but replace the Bun/Node test-version sentence with:

```md
固定官方 NATS dependencies 由仓库选择的 runtime lanes 执行验证；实际工具版本只作为 run evidence 记录，不形成支持范围。
```

Keep the following locked TypeScript/upstream-type paragraph unchanged; it records a dependency-specific compatibility fact rather than a runtime admission rule.

- [ ] **Step 3: Verify locale/package synchronization**

In the worktree, run:

```sh
bunx oxfmt --check doc/ar-Arab/guide/zero-to-one.md doc/es-Latn/guide/zero-to-one.md doc/fr-Latn/guide/zero-to-one.md doc/ru-Cyrl/guide/zero-to-one.md doc/zh-Hans/guide/zero-to-one.md doc/zh-Hant-HK/guide/zero-to-one.md doc/zh-Hant-TW/guide/zero-to-one.md packages/context/README.md packages/prometheus/README.md packages/nats/README.md
bun run doc:build
! rg -n 'Bun `1\.x`|Node(?:\.js)? `26\.x`|k6 `2\.1\.0`|运行时测试覆盖 Bun|运行时矩阵|并在 Bun 1\.3\.14' doc/ar-Arab/guide/zero-to-one.md doc/es-Latn/guide/zero-to-one.md doc/fr-Latn/guide/zero-to-one.md doc/ru-Cyrl/guide/zero-to-one.md doc/zh-Hans/guide/zero-to-one.md doc/zh-Hant-HK/guide/zero-to-one.md doc/zh-Hant-TW/guide/zero-to-one.md packages/context/README.md packages/prometheus/README.md packages/nats/README.md
git diff --check -- doc/ar-Arab/guide/zero-to-one.md doc/es-Latn/guide/zero-to-one.md doc/fr-Latn/guide/zero-to-one.md doc/ru-Cyrl/guide/zero-to-one.md doc/zh-Hans/guide/zero-to-one.md doc/zh-Hant-HK/guide/zero-to-one.md doc/zh-Hant-TW/guide/zero-to-one.md packages/context/README.md packages/prometheus/README.md packages/nats/README.md
```

Expected: all commands exit 0.

- [ ] **Step 4: Independent Task 5 review**

Reviewer must verify semantic parity, package/dependency facts, and that no historical document was rewritten.

- [ ] **Step 5: Authorization-gated commit checkpoint**

Only if explicitly authorized, commit the ten tracked locale/package files from the worktree.

Otherwise skip.

### Task 6: Generalize the active P0 planning artifact

**Files:**

- Modify in the main checkout only: `docs/superpowers/plans/2026-08-26-lifecycle-readiness-error-dx.md`

**Interfaces:**

- Consumes: the already-written, untracked P0 implementation plan.
- Produces: a tool-name-only Tech Stack line without copying the artifact into the implementation worktree.

- [ ] **Step 1: Confirm the checkout boundary**

Run from `/Users/munmunmiao/Documents/web/likego`:

```sh
git status --short --branch
test ! -e .worktrees/p0-readiness-docs/docs/superpowers/plans/2026-08-26-lifecycle-readiness-error-dx.md
```

Expected: the target is an untracked main-checkout artifact and does not exist in the worktree.

- [ ] **Step 2: Generalize only the Tech Stack line**

Make the header:

```md
**Tech Stack:** TypeScript、Bun、标准 Web API、VitePress、oxfmt。
```

Do not modify any other line and do not modify historical plans.

- [ ] **Step 3: Verify the untracked artifact**

Run from the main checkout:

```sh
bunx oxfmt --stdin-filepath docs/superpowers/plans/2026-08-26-lifecycle-readiness-error-dx.md < docs/superpowers/plans/2026-08-26-lifecycle-readiness-error-dx.md | diff - docs/superpowers/plans/2026-08-26-lifecycle-readiness-error-dx.md
rg -n '^\*\*Tech Stack:\*\* TypeScript、Bun、标准 Web API、VitePress、oxfmt。$' docs/superpowers/plans/2026-08-26-lifecycle-readiness-error-dx.md
```

Expected: both commands exit 0.

- [ ] **Step 4: Independent Task 6 review**

Reviewer must verify the exact one-line change and main/worktree separation.

No commit checkpoint exists: the target is an untracked planning artifact and commit authorization has not been granted.

### Task 7: Execute combined verification and final review

**Files:**

- Review: every tracked file changed from base `5bf7faee8926bd9664fcb8d9f41a2b61e6937dae`
- Review separately in main checkout: the four untracked spec/plan artifacts

**Interfaces:**

- Consumes: Tasks 1-6 and the prior seven-file P0 documentation diff.
- Produces: a final evidence record with exact successes, failures, checkout boundaries, and no unapproved integration.

- [ ] **Step 1: Audit scope and preserved inputs**

Run in the worktree:

```sh
git status --short --branch
git diff --name-status 5bf7faee8926bd9664fcb8d9f41a2b61e6937dae
git diff --check
git diff --exit-code -- bun.lock
```

Expected: only the seven existing P0 documents plus Tasks 1-5 tracked files; no lockfile diff, dependency change, Action SHA change, or fixture image change.

- [ ] **Step 2: Audit active version-policy remnants**

Run a scoped audit over active policy files:

```sh
rg -n "packageManager|prerequisite-version-mismatch|prerequisite-version-unparseable|\bRequiredRuntimeVersions\b|assertRequiredRuntimeVersions|exactOutput|parseNodeVersion|parseDenoVersion|parseTypeScriptVersion|parseObservedVersion|\bK6Version\b|parseK6Version|bun-version:|node-version:|runs-on: ubuntu-[0-9]|Verify / Bun|supported validation ranges|declared release lane|required Node version|required E2E Node|\*\*Node range|runtime matrix|The declared validation matrix|records Bun .* as the validation matrix|运行时测试覆盖 Bun|运行时矩阵|并在 Bun 1\.3\.14" package.json .github/workflows e2e/runtime-versions.ts e2e/executor.ts e2e/soak.ts e2e/README.md doc/guide doc/reference doc/ar-Arab/guide/zero-to-one.md doc/es-Latn/guide/zero-to-one.md doc/fr-Latn/guide/zero-to-one.md doc/ru-Cyrl/guide/zero-to-one.md doc/zh-Hans/guide/zero-to-one.md doc/zh-Hant-HK/guide/zero-to-one.md doc/zh-Hant-TW/guide/zero-to-one.md docs/editorial-blueprint.md docs/releases/0.0.1.md packages/context/README.md packages/prometheus/README.md packages/nats/README.md test
```

Expected: exit 1. Do not broaden this assertion to historical plans, immutable run records, dependency manifests, action comments, or fixtures.

- [ ] **Step 3: Run focused and structural verification**

```sh
bun test --isolate --no-orphans test/e2e-runtime-version.test.ts test/e2e-soak-lifecycle.test.ts test/e2e-soak-evaluator.test.ts
bun run typecheck:root
bun run fmt:check
bun run doc:build
bun install --frozen-lockfile
git diff --exit-code -- bun.lock
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 4: Run the complete unit suite and classify honestly**

Run:

```sh
bun run test:unit
```

If it exits 0, record exact pass counts. If it reproduces the known POSIX controller failures, compare the failing files and messages with the unmodified-main baseline and report the gate as non-green. Do not modify process supervision or call the full suite passed.

- [ ] **Step 5: Final combined review**

Dispatch a fresh reviewer over the complete working-tree diff and the approved spec/plan. It must verify:

- every active runtime/tool eligibility gate is removed;
- capability and failure checks remain;
- observed versions are evidence only;
- dependency/fixture/action pins are untouched;
- P0 lifecycle/readiness semantics remain correct;
- CI auth and release protections remain intact;
- checkout boundaries and untracked design artifacts are reported accurately.

Fix every Critical or Important finding and re-review until clean.

- [ ] **Step 6: Finish without unauthorized integration**

Because commit/push/merge are not authorized:

- preserve `codex/p0-readiness-docs` and its worktree;
- preserve the main checkout's untracked plan/spec artifacts;
- report tracked file scope, verification results, known baseline failures, and exact paths;
- do not present the branch as merge-ready while the complete unit gate is non-green.
