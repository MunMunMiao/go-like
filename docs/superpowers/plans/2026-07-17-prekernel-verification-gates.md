# LikeGo Pre-kernel Verification Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `@likego/context` 生产代码出现前，建立可机器审计、无空跑成功、可复现的 Context/runtime 契约、manifest、portable boundary、distribution、coverage 与 exact-runtime branch 自检门禁。

**Architecture:** 所有 gate 共享一个 fail-closed result protocol。每次运行先把完整输入 inventory 固化为同一份内容 snapshot，再由 evaluator 消费该 snapshot；status、readiness、result path 与退出码只有 `RunGate` 一个权威。Fixture gate 只验证门禁本身，repository package-admission gate 在真实 package/source 为零时失败；Node/Deno branch 只用 exact-digest Docker 内的原生 coverage。

**Tech Stack:** Bun `1.3.14`、`@types/bun` `1.3.14`、TypeScript `7.0.2` async API、Ajv `8.20.0`、JSON Schema 2020-12、Node `24.18.0` / `26.5.0` native test coverage、Deno `2.9.3` native coverage、Docker Compose。

## Global constraints

- Bun `1.3.14` 是唯一 package manager、开发脚本 runner 和主 unit-test runner；使用 `bun add --dev --exact`、`bun ci`、`bun test`。
- Root `package.json#scripts` 和 `workspaces` 已由 Foundation HEAD `b8717e6` 锁死。任何任务都不得增加、删除或修改 root script/workspace；Task 1 只允许新增 exact `ajv: "8.20.0"` devDependency。
- TypeScript 保持 exact `7.0.2`。AST/semantic gate 只用 `typescript/unstable/async` 与 `typescript/unstable/ast`，不得改用 root compiler API、`unstable/sync`、typescript-estree 或正则模拟类型导出。
- 不引入 `c8`、Vitest、tsx、tsup、Rollup、esbuild 或 tar。Numeric branch 只由 Node 24/26 与 Deno 2.9.3 原生 coverage 证明。
- Bun coverage 结果始终写 `branches:{supported:false,percent:null,reason:"BUN_1_3_14_NO_BRANCH_COUNTER"}`；不得在 `bunfig.toml` 添加无效 branch threshold。
- `tsconfig.json` 必须排除 `**/*.test.ts`、`tools/**/fixtures/**`、`test/**`；`tsconfig.test.json` 必须排除 `tools/**/fixtures/**`。Fixture payload 只作为文件读取，不能被 root TypeScript project import。
- `tools/**/fixtures/**` 与 `test/runtime/probes/**` 的任何 committed payload path 都禁止 `.test.`、`_test_`、`.spec.`、`_spec_`。Task 3 提供一个持续扫描这两棵树的真实 test-discovery invariant；需要表达虚拟 test artifact 的 fixture 使用安全 descriptor 文件名，并在该 fixture-specific descriptor 内容中声明 staging target（通用 `cases.json` shape 不扩展）。`test/runtime/probes/` 的可执行 probe 文件全部以 `.probe.mjs` 结尾。
- 每个 committed fixture family 都有 `fixtures/cases.json`，逐项列出 case id、相对路径、expected issue-code multiset。空、漏、重、额外或不匹配均失败。
- Fixture PASS 只允许 `readinessPolicy:"evaluation-only"`，gate id 必须带 `-fixtures`；它不能成为 package admission 或 release readiness 证据。
- Repository manifest/boundary/distribution/production-coverage 使用 `readinessPolicy:"package-admission"`。真实 package/source 数为零时必须 failed check、`status:"fail"`、`releaseReadiness:"not-ready"`、exit `1`；无 `allow-empty`。
- 输入 snapshot、evaluator 与 artifact hashing 使用同一份 canonical file inventory。Evaluator 不得重新 glob 或重读原文件；需要 TypeScript project 时，从 snapshot bytes materialize 隔离 staging tree。
- 本计划不创建任何 `packages/*` / `adapters/*` 空 production shell，不做 tarball consumer、正式 runtime behavior matrix、Context sentinel integration 或 aggregate release gate。
- Docker probe 使用 exact `tag@digest`、无 host port、显式 platform/working directory、唯一 label/project/result directory，并在所有路径做独立 fail-safe cleanup readback。
- 每个 task 的 RED 只能由该 task 的目标实现缺失导致，不能由依赖未安装、fixture 被 typecheck、Bun 误发现 probe、registry/Docker 不可用或前序 task 未完成导致。
- 每个提交前依次运行 task selector、`bun run verify:workspace`、`bun run typecheck`、`bun run test:coverage`、`git diff --cached --check`。提交后运行 `git diff --check 0a42ad1..HEAD`；两条 whitespace gate 都必须无输出、exit `0`。
- Task 9 建立 tooling source-inventory gate 后，Tasks 10–13 的每个提交还必须在 `bun run test:coverage` 后运行 `bun tools/coverage/check.cli.ts --tools --lcov coverage/lcov.info`；新增但未加载的工具源码不能靠 Bun 的稀疏 LCOV 假通过。

## Common fixture inventory contract

每个 `cases.json` 使用同一 shape：

```json
{
  "schemaVersion": 1,
  "cases": [
    {
      "id": "stable-case-id",
      "path": "relative/case/root-or-file",
      "expectedCodes": []
    }
  ]
}
```

`expectedCodes` 是可重复、排序后比较的 multiset。Negative fixture 只有在 actual code multiset 与 expected 完全一致时才转换成一个 passing meta-check；raw validator issues 绝不直接决定 fixture gate status。Fixture runner 必须拒绝：空 cases、重复 id/path、listed path 缺失、未列出的 fixture payload、错误 code/count、`subjects.expected !== subjects.checked`。

## File map

```text
config/runtime-matrix.json
schemas/{gate-result,capability-manifest,owner-manifest,runtime-image-lock}.schema.json
tools/gates/{result,atomic-writer,fixture-corpus}.ts
tools/runtime/{runtime-manifest,resolve-images,native-runner,branch-probe,evidence}.ts
tools/manifests/{validate,check}.ts
tools/boundaries/{project-session,module-syntax,semantic-global,check}.ts
tools/distribution/{check-build,check-exports,check}.ts
tools/coverage/{lcov,check-bun,check}.ts
tools/**/fixtures/**/cases.json
test/runtime/probes/*.probe.mjs
test/runtime/native-branch/cases.json
test/runtime/docker-compose.branch.yml
evidence/runtime/native-branch/<actual-platform>.json
```

---

### Task 1: Gate result protocol, exact Ajv bootstrap, and canonical atomic emission

**Depends on:** Foundation HEAD `b8717e6` only.

**Files:**
- Create: `schemas/gate-result.schema.json`
- Create: `tools/gates/result.ts`
- Create: `tools/gates/atomic-writer.ts`
- Create: `tools/gates/result.test.ts`
- Create: `tools/gates/protocol-probe.cli.ts`
- Modify: `package.json` only to add `ajv: "8.20.0"`
- Modify: `bun.lock`
- Modify: `tsconfig.json`
- Modify: `tsconfig.test.json`

**Interfaces:**

```ts
export type GateMode = "fixture" | "repository" | "runtime-probe"
export type ReadinessPolicy = "evaluation-only" | "package-admission"
export type GateStatus = "pass" | "fail"
export type ReleaseReadiness = "not-evaluated" | "not-ready" | "ready"
export type CheckStatus = "pass" | "fail" | "skip"

export interface GateCheck {
  readonly id: string
  readonly status: CheckStatus
  readonly path?: string
  readonly expected?: string | number | boolean | null
  readonly actual?: string | number | boolean | null
  readonly detail?: string
}

export interface SnapshotFile {
  readonly Path: string
  readonly RealPath: string
  readonly Sha256: string
  readonly Bytes: Uint8Array
}

export interface InputSnapshot {
  readonly Sha256: string
  readonly Files: readonly SnapshotFile[]
}

export interface GateEvaluation {
  readonly SubjectsChecked: number
  readonly Checks: readonly GateCheck[]
  readonly ArtifactPaths?: readonly { readonly kind: string; readonly path: string }[]
}

export interface GateResult {
  readonly schemaVersion: 1
  readonly runId: string
  readonly gate: string
  readonly mode: GateMode
  readonly status: GateStatus
  readonly releaseReadiness: ReleaseReadiness
  readonly startedAt: string
  readonly completedAt: string
  readonly toolchain: Readonly<Record<string, string>>
  readonly inputsSha256: string | null
  readonly subjects: { readonly expected: number | null; readonly checked: number }
  readonly checks: readonly GateCheck[]
  readonly artifacts: readonly { readonly kind: string; readonly path: string; readonly sha256: string }[]
}

export async function SnapshotInputs(
  root: string,
  paths: readonly string[],
): Promise<{ readonly Snapshot: InputSnapshot | null; readonly Checks: readonly GateCheck[] }>

export async function RunGate(
  options: {
    readonly root: string
    readonly gate: string
    readonly mode: GateMode
    readonly readinessPolicy: ReadinessPolicy
    readonly expectedSubjects: number | null
    readonly inputPaths: readonly string[]
    readonly toolchain: Readonly<Record<string, string>>
    readonly runId?: string
  },
  evaluate: (snapshot: InputSnapshot) => Promise<GateEvaluation>,
): Promise<GateResult>

export async function EmitGateResult(root: string, result: GateResult): Promise<string>
```

- [ ] **Step 0: Establish the declared test dependency**

Run:

```bash
bun add --dev --exact ajv@8.20.0
bun ci
bun pm ls --all
bun run verify:workspace
```

Expected: resolved Ajv is exactly `8.20.0`; workspace verifier exits `0`. Inspect `git diff -- package.json` and require that only one exact devDependency was added. Root scripts/workspaces/verifier are unchanged.

- [ ] **Step 1: Write schema and RED tests**

Schema requirements:

- draft 2020-12 and `additionalProperties:false` on every fixed-shape object; the intentional `toolchain` string map uses `additionalProperties:{"type":"string"}` and permits no non-string value;
- `gate` matches `^[a-z][a-z0-9-]{0,63}$`;
- `runId` matches `^[a-z0-9][a-z0-9_-]{0,95}$`;
- `inputsSha256` is SHA-256 or null;
- timestamps are canonical UTC milliseconds;
- all result fields above are required.

Tests must cover zero checks, zero subjects, no pass check, expected/checked mismatch, missing input, directory input, lexical escape, symlink escape, duplicate lexical path, duplicate realpath, artifact missing, evaluator throw, artifact hashing throw, invalid gate/runId, and status/readiness derivation.

Protocol matrix tests also require: `package-admission` is valid only with `mode:"repository"`; `fixture` and `runtime-probe` require `evaluation-only`; fixture gate ids end in `-fixtures`. Every invalid combination becomes a stable `GATE_PROTOCOL_ERROR`, never a ready result.

Run: `bun test tools/gates/result.test.ts`

Expected RED: module-not-found for `tools/gates/result.ts`; Ajv/schema/toolchain errors are not acceptable.

- [ ] **Step 2: Implement snapshot and single-authority derivation**

`SnapshotInputs` must realpath the root and each regular input exactly once; reject missing paths, directories, lexical root escape, realpath/symlink escape, duplicate canonical lexical paths and duplicate real paths. It sorts canonical `/`-separated paths and hashes `path + NUL + fileSha256 + LF`. Bytes stored in `SnapshotFile` are the only bytes evaluator may parse.

`RunGate` is the sole status/readiness authority:

- derive fail iff any check fails or a stage creates a failed check;
- pass requires `subjects.checked > 0`, at least one pass check, no fail check, and exact expected/checked equality when expected is non-null;
- `evaluation-only` always yields `not-evaluated`;
- `package-admission` yields `ready` on pass and `not-ready` on fail;
- CLI exit is pass `0`, fail `1`.
- reject invalid mode/readiness/gate-id combinations with `GATE_PROTOCOL_ERROR` before evaluator admission: only repository mode may use `package-admission`, while fixture/runtime-probe modes are evaluation-only.

Three failure stages are independent and persisted when emission itself remains available:

1. input snapshot exception/error -> `GATE_INPUT_ERROR`, evaluator not called, `inputsSha256:null`;
2. evaluator exception -> `GATE_INTERNAL_ERROR`;
3. artifact confinement/hash exception -> `GATE_ARTIFACT_ERROR`.

Artifacts undergo the same regular-file, realpath confinement and duplicate-realpath checks as inputs.

- [ ] **Step 3: Implement canonical atomic emission**

Canonical path is `.artifacts/gates/<gate>.json`. Temp file is in the same directory and contains gate, runId, pid and cryptographic random suffix; open exclusively. Validate result first, then write, sync, close and rename. Always remove leftover temp in `finally`.

Only after rename succeeds print exactly one stdout line:

```text
LIKEGO_GATE_RESULT=<compact persisted JSON>
```

Parsed stdout JSON must equal the persisted object. Validation/write/sync/close/rename failure exits `1`, prints no prefix, preserves prior canonical file, cleans temp, and writes only stderr. Consumers bind canonical JSON to the runId returned by the current invocation and reject stale runId.

Injected-writer tests cover pre-existing PASS preservation, unique concurrent temp names, each write-stage failure, temp cleanup and no false result line.

- [ ] **Step 4: Make root TypeScript projects fixture-safe**

Set exact project selectors:

```json
// tsconfig.json
{
  "include": ["scripts/**/*.ts", "tools/**/*.ts"],
  "exclude": ["**/*.test.ts", "tools/**/fixtures/**", "test/**"]
}
```

```json
// tsconfig.test.json
{
  "include": ["scripts/**/*.ts", "tools/**/*.ts", "test/**/*.ts"],
  "exclude": ["tools/**/fixtures/**"]
}
```

Preserve existing compiler options. CLI modules export a testable `Main` and guard side effects with `import.meta.main` so root tests can cover them.

Delete the existing top-level `files` key from both tsconfig files; the shown `include`/`exclude` arrays are the complete source selectors, not additions to the old explicit file list.

- [ ] **Step 5: Verify machine behavior and commit**

Run pass, evaluator-throw, input-error and injected-emission-error protocol probes. Pass/evaluator/input commands must produce current-run canonical JSON; emission failure must preserve old JSON and emit no prefix.

Then run global pre-commit gates, stage exact Task 1 files, run `git diff --cached --check`, commit:

```bash
git commit -m "build: add fail-closed gate result protocol"
git diff --check 0a42ad1..HEAD
```

---

### Task 2: Freeze Context timing/AfterFunc semantics and exact runtime contract

**Depends on:** Task 1.

**Files:**
- Modify: `docs/adr/0001-kernel-public-api.md`
- Modify: `docs/adr/0002-build-runtime-and-coverage.md`
- Create: `config/runtime-matrix.json`
- Create: `tools/runtime/runtime-manifest.ts`
- Create: `tools/runtime/runtime-manifest.test.ts`
- Create: `tools/runtime/runtime-manifest.cli.ts`

**Interfaces:**

```ts
export interface RuntimeLane {
  readonly Id: "bun-exact" | "node-lts" | "node-current" | "deno-exact"
  readonly Runtime: "bun" | "node" | "deno"
  readonly Channel: "exact" | "lts" | "current"
  readonly Version: string
  readonly ImageTag: string
}
export interface RuntimeMatrix {
  readonly SchemaVersion: 1
  readonly TypeScript: "7.0.2"
  readonly Lanes: readonly RuntimeLane[]
}
export function ValidateRuntimeMatrix(snapshot: InputSnapshot): GateEvaluation
```

Exact lanes: Bun `1.3.14`; Node LTS `24.18.0`; Node current `26.5.0`; Deno `2.9.3`. Exact tags: `oven/bun:1.3.14`, `node:24.18.0-bookworm-slim`, `node:26.5.0-bookworm-slim`, `denoland/deno:2.9.3`. No digest is recorded in this task.

- [ ] **Step 1: Write clean RED tests**

Test missing/extra/duplicate lane, non-exact version, wrong channel/tag, TypeScript/packageManager mismatch and ADR marker absence. Run selector; expected RED is only missing `runtime-manifest.ts`.

- [ ] **Step 2: Add the final Context timing decision to ADR 0001**

Freeze these exact semantics:

1. Parent nullish and structural shape validation (`Deadline`, `Done`, `Err`, `Value` callable) happens before any time read or resource allocation.
2. Snapshot `parent.Deadline()` at most once after argument validation. If it reports a deadline, validate its tuple/Date and invoke `Date.prototype.getTime.call(parentDeadline)` exactly once. The effective epoch is the minimum of the requested and parent snapshots; no later parent-deadline read is allowed.
3. `WithDeadline*` invokes `Date.prototype.getTime.call(deadline)` exactly once, applies the parent snapshot, then reads `Date.now()` exactly once into `wallNow`. Non-Date throws `TypeError`; non-finite/invalid deadline or wall sample throws `RangeError`. Store only the numeric deadline snapshot.
4. `WithTimeout*` validates finite `timeoutMs`, snapshots the parent deadline, then reads `Date.now()` exactly once into the same `wallNow` used by all later construction logic. Validate raw `wallNow + timeoutMs` is finite and within inclusive TimeClip range. The requested epoch is `Math.trunc(wallNow + timeoutMs)` and the stored effective epoch is its minimum with the parent snapshot; `Deadline()` always returns a fresh `Date` for it.
5. A shared timer constructor receives `effectiveEpoch` and captured `wallNow` as arguments and is forbidden to read `Date.now()`. If effective epoch `<= wallNow`, return already `DeadlineExceeded` synchronously with no `performance.now()` read and no timer.
6. For a future effective deadline, read `performance.now()` exactly once after the wall sample and project `monotonicTarget = monotonicNow + (effectiveEpoch - wallNow)`. Every arm is `<= 2_147_483_647ms`; wake compares only fresh `performance.now()` with that target and re-arms if early. Wall-clock jumps after construction cannot change expiry. Cancel clears current arm; stale callbacks are no-op. Contract tests instrument both clock getters, assert exact call counts/order, and jump wall time after construction.
7. The optional custom `AfterFunc` property/method is read once and called with `this === ctx`. Callback attempts made synchronously by the delegate are buffered. Only after the delegate returns a callable StopFunc may buffered admission enter the shared once-state. Delegate throw/non-function discards the buffer and the user callback never runs.
8. Public stop and callback admission have one winner: successful stop suppresses callback and returns true once; admitted callback makes stop return false. User callback is queued as a microtask and runs at most once. This private capability adds no public export.

ADR 0002 must state that published-JS numeric branch authority is Node 24/26 and Deno native coverage, not c8; Bun branch remains null/unsupported.

- [ ] **Step 3: Implement runtime-contract gate from one snapshot**

Input inventory is exactly both ADRs, `config/runtime-matrix.json`, `package.json`, `bunfig.toml`, `deno.json`. Evaluator parses only snapshot bytes. Gate is `runtime-contract`, `mode:"repository"`, `readinessPolicy:"evaluation-only"`, expected subjects `4`.

Run tests and CLI. Expected machine result: four checked lanes, pass checks for versions/tags/ADR markers, current runId canonical result, `not-evaluated`.

- [ ] **Step 4: Verify and commit**

Run global gates, stage only Task 2 files, cached whitespace check, commit `docs: freeze Context and runtime contracts`, then range whitespace check.

---

### Task 3: Capability/owner schemas, corpus inventory, and official-package admission

**Depends on:** Tasks 1-2.

**Files:**
- Create: `schemas/capability-manifest.schema.json`
- Create: `schemas/owner-manifest.schema.json`
- Create: `tools/gates/fixture-corpus.ts`
- Create: `tools/gates/fixture-corpus.test.ts`
- Create: `tools/manifests/validate.ts`
- Create: `tools/manifests/validate.test.ts`
- Create: `tools/manifests/check.cli.ts`
- Create: `tools/manifests/fixtures/cases.json`
- Create: `tools/manifests/fixtures/{valid,invalid,application-owned}/**`

**Interfaces:**

```ts
export interface FixtureCase {
  readonly id: string
  readonly path: string
  readonly expectedCodes: readonly string[]
}
export interface CorpusEvaluation {
  readonly SubjectsExpected: number
  readonly SubjectsChecked: number
  readonly Checks: readonly GateCheck[]
}
export function EvaluateFixtureCorpus(
  snapshot: InputSnapshot,
  familyRoot: string,
  validate: (caseFiles: readonly SnapshotFile[]) => readonly ManifestIssue[],
): CorpusEvaluation
export function FindBunDiscoveredFixturePaths(root: string): Promise<readonly string[]>
export function ValidateOfficialPackage(files: readonly SnapshotFile[]): readonly ManifestIssue[]
export function CheckOfficialManifests(snapshot: InputSnapshot): GateEvaluation
```

- [ ] **Step 1: Write `cases.json`, schemas and RED tests**

Schema objects use `additionalProperties:false`. Capability fields are exactly schemaVersion/package/packageKind/stability/releaseBlocking/residency/capabilities/runtimes; owner fields are schemaVersion/package/resources. Lock stable invalid codes for schema, package mismatch, runtime set/version, Node lanes, terminal observability, missing/duplicate/conflicting resources and residency conflict.

Corpus tests cover empty list/root, duplicate id/path, missing path, extra unlisted payload, wrong code/count and exact positive/negative traversal. Expected RED is missing corpus/validator implementation, not schema load failure.

The same test file recursively scans every current/future payload under `tools/**/fixtures/**` and `test/runtime/probes/**`, rejecting Bun discovery substrings `.test.`, `_test_`, `.spec.`, `_spec_`. This test remains active as later tasks add fixture trees. A staged invalid dist-test case uses a safe committed descriptor whose content contains an explicit virtual target path; no committed payload itself may match Bun discovery and the common `cases.json` stays unchanged.

- [ ] **Step 2: Implement exact corpus meta-semantics**

`EvaluateFixtureCorpus` consumes listed snapshot files only. Actual negative codes are sorted and compared as a multiset; exact match produces a passing `FIXTURE_CASE_MATCH` check. Any inventory or code mismatch produces `FIXTURE_INVENTORY_MISMATCH`. PASS requires expected equals checked and both greater than zero.

- [ ] **Step 3: Implement manifest cross-field rules**

Portable/non-resident requires exact Bun/Node/Deno rows, terminal not-applicable and empty owner resources. Resident official adapter requires resources; release-blocking runtime rows must be terminal-observable. Tested versions are exact and at least minimum; Node contains both lanes. Reject LikeGo-owned/native-borrowed, duplicate resource id, application-owned stop contract for LikeGo-owned resource and package/residency mismatch.

Discovery scans only direct official `packages/*` and `adapters/*`. The application-owned structural Server fixture lives outside those roots, has no manifests, and must be ignored.

- [ ] **Step 4: Separate fixture/repository modes and complete inventories**

Fixture CLI input inventory includes both schemas, runtime matrix, cases.json and every listed/discovered fixture payload; gate id `manifest-fixtures`, evaluation-only. Repository CLI input inventory includes both schemas, runtime matrix, each discovered official `package.json`, `capability.json`, `owner.json`; evaluator receives those same bytes.

Current repository mode must exit `1` with `MANIFEST_PACKAGE_ZERO`, checked `0`, not-ready. Fixture mode exits `0` only after exact corpus traversal.

- [ ] **Step 5: Verify and commit**

Run selectors, both CLI modes with expected exits, global gates, cached whitespace, commit `build: enforce official capability and owner manifests`, then range whitespace.

---

### Task 4: TypeScript 7 async project session, diagnostics, and fail-safe worker cleanup

**Depends on:** Task 1.

**Files:**
- Create: `tools/boundaries/project-session.ts`
- Create: `tools/boundaries/project-session.test.ts`
- Create: `tools/boundaries/project-session.fixture.cli.ts`
- Create: `tools/boundaries/fixtures/project-session/cases.json`
- Create: `tools/boundaries/fixtures/project-session/**`

**Interfaces:**

```ts
export interface ProjectSession {
  readonly Project: import("typescript/unstable/async").Project
  readonly SourceFiles: readonly import("typescript/unstable/ast").SourceFile[]
  readonly StagedRoot: string
}
export interface SessionIssue {
  readonly Code: string
  readonly Path: string
  readonly Message: string
}
export async function WithProjectSession<T>(
  snapshot: InputSnapshot,
  projectPrefix: string,
  use: (session: ProjectSession) => Promise<T>,
): Promise<T>
export async function AnalyzeProjectSession(
  snapshot: InputSnapshot,
  projectPrefix: string,
): Promise<{ readonly SourceFilesChecked: number; readonly Issues: readonly SessionIssue[] }>
```

- [ ] **Step 1: Write session corpus and clean RED**

Cases cover valid project, wrong canonical tsconfig identity, multiple/missing project, zero source, lexical/realpath escape and each diagnostic family. Spawn success and post-worker-failure probes with a timeout and require natural exit. Expected RED is missing `project-session.ts`.

- [ ] **Step 2: Materialize and open exactly the input snapshot**

Materialize selected snapshot bytes into a unique `.artifacts/gates/work/<runId>/boundary-project/` tree; do not copy/re-read original paths. Start `new API({cwd: stagedRoot})`, call `updateSnapshot({openProjects:[canonicalTsconfig]})`, require exactly the requested project, get source names/files, and realpath-confine selected source to staged package `src`.

Call every diagnostic API explicitly: config-file parsing, program, global, syntactic, bind and semantic. Any diagnostic is a stable failed issue. Missing source/policy/project fails closed.

- [ ] **Step 3: Make cleanup independently fail-safe**

Capture the callback value or primary error before cleanup. In `finally`, independently settle `snapshot.dispose()`, `api.close()` and staging-tree removal; no cleanup action may short-circuit another. When cleanup has any error, throw one `AggregateError([primaryError?, ...cleanupErrors])`; with clean cleanup, return the saved value or rethrow the original primary error unchanged. Inject primary-use failure, each cleanup failure and their combinations; every subprocess must terminate, Task 1 must persist a failed gate result, and a fresh readback must prove the staging path absent whenever removal reported success.

- [ ] **Step 4: Run fixture machine gate and commit**

Fixture gate input includes its cases.json and every project payload. It is `boundary-project-session-fixtures`, evaluation-only, with exact expected/checked case counts. Run selector and subprocess probes, global gates, cached whitespace; commit `build: add TypeScript async project sessions`, then range whitespace.

---

### Task 5: Portable module-syntax boundary

**Depends on:** Task 4.

**Files:**
- Create: `tools/boundaries/module-syntax.ts`
- Create: `tools/boundaries/module-syntax.test.ts`
- Create: `tools/boundaries/module-syntax.fixture.cli.ts`
- Create: `tools/boundaries/fixtures/module-syntax/cases.json`
- Create: `tools/boundaries/fixtures/module-syntax/**`

**Interfaces:**

```ts
export interface ModulePolicy {
  readonly PackageRoot: string
  readonly AllowedWorkspaceDependencies: readonly string[]
}
export function CheckModuleSyntax(
  sourceFiles: readonly import("typescript/unstable/ast").SourceFile[],
  policy: ModulePolicy,
): readonly BoundaryIssue[]
```

- [ ] **Step 1: Write corpus and clean RED**

Cases cover static import, export-from, literal/nonliteral dynamic import, import-equals, direct/parenthesized require, module.require, `node:/bun:/deno:/npm:/jsr:/http:/https:/data:`, absolute/`#` imports, missing `.js`, relative package escape, missing target `.ts`, disallowed workspace/vendor/framework import and valid internal `.js` resolution. Expected RED is missing `module-syntax.ts` after Task 4 session passes.

- [ ] **Step 2: Implement AST-only syntax admission**

Traverse AST nodes, not text grep. Dynamic import requires one string literal. Relative import must end `.js`, resolve to an existing snapshotted `.ts` inside current package `src`, and never escape. Bare package imports must be exact policy entries. Type-only imports obey the same package policy.

- [ ] **Step 3: Run corpus machine gate and commit**

Gate id `boundary-module-syntax-fixtures`, evaluation-only. Input includes cases.json, all payloads and applicable policy bytes. Exact negative code multiset becomes passing meta-checks. Run global/cached gates, commit `build: enforce portable module syntax`, then range whitespace.

---

### Task 6: Semantic free-global and globalThis boundary

**Depends on:** Tasks 4-5.

**Files:**
- Create: `tools/boundaries/semantic-global.ts`
- Create: `tools/boundaries/semantic-global.test.ts`
- Create: `tools/boundaries/semantic-global.fixture.cli.ts`
- Create: `tools/boundaries/fixtures/semantic-global/cases.json`
- Create: `tools/boundaries/fixtures/semantic-global/**`

**Interfaces:**

```ts
export interface GlobalPolicy {
  readonly AllowedFreeGlobals: readonly string[]
}
export async function CheckSemanticGlobals(
  project: import("typescript/unstable/async").Project,
  sourceFiles: readonly import("typescript/unstable/ast").SourceFile[],
  policy: GlobalPolicy,
): Promise<readonly BoundaryIssue[]>
```

- [ ] **Step 1: Write semantic corpus and clean RED**

Valid cases prove property keys, labels, type positions and locally declared names are not free globals. Invalid cases cover Bun/Deno/process/Buffer/global/require/module/exports/filename globals, unknown globals, disallowed `globalThis` property, computed nonliteral access, direct alias, chained alias, destructuring, reassignment, parameter/call escape and return escape; also eval, Function constructor, ambient declarations, triple-slash types, `@ts-ignore` and `@ts-nocheck`.

Expected RED is missing `semantic-global.ts`; TypeScript session/diagnostics already pass.

- [ ] **Step 2: Implement batched semantic classification**

Batch candidate identifiers through `checker.getSymbolAtLocation(nodes)`. Resolve declaration handles and classify declarations as local/imported, default-lib, ambient or unresolved. Only proven local/imported or allowlisted standard globals pass. Property keys/labels/type-only positions are excluded structurally.

Treat any `globalThis` computed/alias/escape flow that cannot be statically proven to access one literal allowlisted property as fail closed. Do not claim general data-flow soundness; explicitly reject the chained/destructure/assignment/call/return fixture patterns.

- [ ] **Step 3: Run corpus machine gate and commit**

Gate id `boundary-semantic-global-fixtures`, evaluation-only, exact cases inventory. Run selector, machine gate, global/cached gates; commit `build: enforce portable global boundaries`, then range whitespace.

---

### Task 7: Boundary policy coverage, corpus aggregation, and repository admission CLI

**Depends on:** Tasks 4-6.

**Files:**
- Create: `tools/boundaries/policy.json`
- Create: `tools/boundaries/check.ts`
- Create: `tools/boundaries/check.test.ts`
- Create: `tools/boundaries/check.cli.ts`

**Interfaces:**

```ts
export interface BoundaryEvaluation {
  readonly PackagesChecked: number
  readonly SourceFilesChecked: number
  readonly Checks: readonly GateCheck[]
}
export function EvaluateBoundaryFixtures(snapshot: InputSnapshot): CorpusEvaluation
export async function EvaluateRepositoryBoundaries(snapshot: InputSnapshot): Promise<GateEvaluation>
```

- [ ] **Step 1: Write CLI/policy RED tests**

Policy has exact rows for context/core/fetch/health/testing, dependency allowlists and per-package free-global allowlists. Test missing/extra policy row, empty repository, policy/package mismatch, fixture family missing/extra, wrong mode/gate id, stale runId and evaluator re-read attempts. Expected RED is missing `check.ts`.

- [ ] **Step 2: Implement one-snapshot fixture aggregation**

Fixture mode input inventory is policy plus all three family `cases.json` and every listed/discovered payload. Aggregate each family’s meta-checks; expected and checked are total case counts and greater than zero. Gate `portable-boundary-fixtures`, evaluation-only.

- [ ] **Step 3: Implement one-snapshot repository admission**

Discovery builds an input path list containing policy, every discovered portable package `package.json`, tsconfig and all `src/**/*.ts`; `RunGate` snapshots it once. Evaluator materializes only those bytes for Task 4 and uses Tasks 5-6 without another glob/read.

Zero source/package produces `BOUNDARY_SOURCE_ZERO`. Repository gate is `portable-boundary`, package-admission. There is no fixture fallback or empty override.

- [ ] **Step 4: Verify process lifecycle, modes, and commit**

Run `--fixtures` expecting exit `0/not-evaluated`; run current repository mode expecting exit `1/not-ready/checked 0`. Both result files must match current runId. Spawn both with timeout and require natural exit. Run global/cached gates, commit `build: compose portable boundary admission`, then range whitespace.

---

### Task 8: Fixture build/exports verification with TypeScript module export symbols

**Depends on:** Tasks 1, 3-4.

**Files:**
- Create: `tools/distribution/policy.json`
- Create: `schemas/distribution-virtual-file.schema.json`
- Create: `tools/distribution/virtual-file.ts`
- Create: `tools/distribution/virtual-file.test.ts`
- Create: `tools/distribution/dist-session.ts`
- Create: `tools/distribution/dist-session.test.ts`
- Create: `tools/distribution/check-build.ts`
- Create: `tools/distribution/check-exports.ts`
- Create: `tools/distribution/check.test.ts`
- Create: `tools/distribution/check.cli.ts`
- Create: `tools/distribution/fixtures/cases.json`
- Create: `tools/distribution/fixtures/{valid,invalid}/**`

**Interfaces:**

```ts
export interface DistributionPolicy {
  readonly Package: string
  readonly Subpaths: readonly string[]
  readonly RuntimeSymbols: Readonly<Record<string, readonly string[]>>
  readonly TypeSymbols: Readonly<Record<string, readonly string[]>>
}
export interface DistributionSession {
  readonly JavaScriptProject: import("typescript/unstable/async").Project
  readonly TypeProject: import("typescript/unstable/async").Project
  readonly JavaScriptEntries: readonly import("typescript/unstable/ast").SourceFile[]
  readonly TypeEntries: readonly import("typescript/unstable/ast").SourceFile[]
}
export interface DistributionVirtualFile {
  readonly schemaVersion: 1
  readonly target: string
  readonly utf8: string
}
export interface DistributionPackageFile {
  readonly Path: string
  readonly Bytes: Uint8Array
  readonly Origin:
    | { readonly Kind: "snapshot"; readonly Path: string }
    | { readonly Kind: "virtual"; readonly DescriptorPath: string }
}
export function ParseDistributionVirtualFiles(
  caseFiles: readonly SnapshotFile[],
): { readonly PackageFiles: readonly DistributionPackageFile[]; readonly Issues: readonly DistributionIssue[] }
export async function WithDistributionSession<T>(
  files: readonly DistributionPackageFile[],
  packagePrefix: string,
  use: (session: DistributionSession) => Promise<T>,
): Promise<T>
export function CheckBuildOutput(files: readonly DistributionPackageFile[]): readonly DistributionIssue[]
export async function CheckExports(
  session: DistributionSession,
  files: readonly DistributionPackageFile[],
  policy: DistributionPolicy,
): Promise<readonly DistributionIssue[]>
export function EvaluateDistributionFixtures(snapshot: InputSnapshot): CorpusEvaluation
export async function EvaluateRepositoryDistribution(snapshot: InputSnapshot): Promise<GateEvaluation>
```

- [ ] **Step 1: Write virtual-descriptor schema and clean RED**

The virtual-file schema is fixed to `{schemaVersion:1,target:string,utf8:string}` with no additional properties. Write focused parser/materializer tests first. Expected RED is only missing `virtual-file.ts` after the committed schema loads.

- [ ] **Step 2: Implement confined virtual-file materialization**

Descriptor files use a safe `.virtual.json` committed name and count as payloads of their common `cases.json` case, but are not themselves package files. Before staging, derive `DistributionPackageFile` entries; a virtual entry records descriptor origin and never fabricates a filesystem `RealPath` or independent input hash. Real entries retain their snapshotted origin, so the gate input SHA remains bound to every source byte/descriptor byte. Targets must be normalized `/`-separated relative paths strictly inside that case's staging root; reject absolute/backslash/NUL/empty/`.`/`..`, symlink parents, duplicate virtual targets and collision with a real payload. Tests cover malformed descriptors, escape, duplicate/collision and prove a virtual `dist/example.test.js` can be materialized without Bun discovering the committed descriptor. Run this selector to GREEN before writing the distribution corpus.

- [ ] **Step 3: Write exact distribution corpus and clean RED**

Cases cover invalid build config, missing dist/d.ts, TS source/map/test artifact in dist, workspace source/absolute path, missing policy, extra/wildcard subpath, wrong condition order, require/runtime condition, target traversal/missing/extension and runtime/type symbol mismatch. Symbol cases include re-export alias, default, class, type-only, value-only and same outward name in type/value namespaces. A hostile top-level JS fixture contains an exit/loop side effect but uses a safe committed filename; the static checker must finish without executing it. Valid fixture has realistic ESM manifest, build config, dist JS/d.ts, README, capability/owner and policy.

Expected RED is missing distribution session/build/export implementation, not descriptor materialization or an existing Task 4 session failure.

- [ ] **Step 4: Implement build and export shape checks**

Require NodeNext/ES2023, rootDir/outDir, declaration JS emit, no maps, tsbuildinfo under `.artifacts`. Package is ESM, sideEffects false, exact files list and explicit allowlisted exports. Each export key order is types/import/default; targets stay under existing `./dist`, import/default same `.js`, types `.d.ts`. Reject source/worktree/sibling paths and unwanted dist files. Prove the materialized virtual `dist/example.test.js` yields the intended dist-test issue.

- [ ] **Step 5: Open dedicated dist-only static-analysis sessions**

Task 4's `src`-confined session is not reused. Materialize the parsed real-plus-virtual package files into a unique staging root and synthesize two fixed configs: a JavaScript project with `allowJs:true`, `checkJs:false`, `noEmit:true`, and a declaration project for `.d.ts`; both are NodeNext/ES2023 and permit only declared `dist` entries. Descriptor JSON is never materialized as a package file. Run all six Task 4 diagnostic families, require non-null module symbols, and use the same primary-error/all-cleanup aggregation contract. Any source outside staged `dist`, project ambiguity, diagnostic, timeout or worker cleanup failure becomes a stable issue.

- [ ] **Step 6: Obtain runtime and type exports statically**

For each staged `.js` and `.d.ts` entry, obtain its module symbol with the TypeScript async checker and call `checker.getExportsOfModule(moduleSymbol)`. Never `import()` or otherwise execute pending-review JS in the gate process. Preserve the outward export name; resolve alias targets with `checker.getAliasedSymbol`, reject unknown/out-of-dist targets, and classify with `SymbolFlags`: runtime exports require a value-space symbol, while type-entry exports include names present in type, value or namespace space (so class/function exports remain visible). Compare sorted unique names exactly with `RuntimeSymbols` and `TypeSymbols`; explicitly test alias, default, class, type-only, value-only and same-name type/value behavior. No regex/text extraction is allowed.

- [ ] **Step 7: Separate modes and complete inputs**

Fixture inventory includes cases/policy plus every package payload. Repository inventory includes distribution policy and every package manifest/build config/dist file/README/capability/owner. Evaluator consumes the snapshot/staging only.

Fixture gate `distribution-fixtures` passes only exact corpus; repository `distribution-build-exports` currently fails `DISTRIBUTION_PACKAGE_ZERO`. No package is created and no pack/install occurs.

- [ ] **Step 8: Verify and commit**

Run selector/modes, global/cached gates, commit `build: verify ESM build and exports fixtures`, then range whitespace.

---

### Task 9: Strict LCOV parser, Bun source inventory, and actual pre-kernel tool inventory

**Depends on:** Tasks 1 and 3 fixture-corpus helper.

**Files:**
- Modify: `scripts/verify-workspace.cli.ts`
- Modify: `scripts/verify-workspace.test.ts`
- Create: `tools/coverage/policy.json`
- Create: `tools/coverage/lcov.ts`
- Create: `tools/coverage/lcov.test.ts`
- Create: `tools/coverage/check-bun.ts`
- Create: `tools/coverage/check-bun.test.ts`
- Create: `tools/coverage/check.cli.ts`
- Create: `tools/coverage/fixtures/cases.json`
- Create: `tools/coverage/fixtures/**`

**Interfaces:**

```ts
export interface LcovRecord {
  readonly SourceFile: string
  readonly LF: number
  readonly LH: number
  readonly FNF: number
  readonly FNH: number
  readonly BRF: number | null
  readonly BRH: number | null
}
export function ParseLcov(text: string): readonly LcovRecord[]
export function VerifyLcovInventory(input: {
  readonly Root: string
  readonly ContainerRoot?: string
  readonly ExpectedFiles: readonly string[]
  readonly ExcludedFiles: readonly string[]
  readonly Records: readonly LcovRecord[]
  readonly RequireBranches: boolean
}): readonly CoverageIssue[]
export function EvaluateBunCoverage(snapshot: InputSnapshot, profile: "tooling" | "production"): GateEvaluation
```

- [ ] **Step 1: Write corpus and clean RED**

Cases cover empty/malformed LCOV, zero source, missing/extra/duplicate/escaping SF, line/function miss, missing/partial branch, stale exclusion and canonicalization of Node `SF:work/...` versus Deno `SF:/work/...`. Expected RED is missing parser/checker.

- [ ] **Step 2: Implement strict parser and exact inventory**

Parse TN/SF/FN/FNDA/FNF/FNH/BRDA/BRF/BRH/DA/LF/LH/end_of_record and reject malformed/duplicate totals/unterminated records. Inventory uses already snapshotted expected paths, not a second glob. Every non-excluded file appears once; LF positive and equals LH; FNF equals FNH; total functions positive. Require BRF/BRH and positive branch denominator only for native runtime mode.

Exclusions are exact paths with non-empty reason; stale paths fail. Bun machine coverage writes lines/functions numbers and branch unsupported/null, even if LCOV unexpectedly includes branch records.

- [ ] **Step 3: Add three non-vacuous modes**

- `--fixtures`: exact cases gate `bun-coverage-fixtures`, evaluation-only;
- `--tools --lcov coverage/lcov.info`: inventory every non-test `scripts/**/*.ts` and `tools/**/*.ts`, excluding fixture payload and only ADR-permitted generated/declaration/static-barrel paths; evaluation-only;
- repository `--lcov <per-package-lcov>`: inventories `packages/*/src/**/*.ts` / `adapters/*/src/**/*.ts`; package-admission, zero production source fails `COVERAGE_SOURCE_ZERO`.

For tool mode, every CLI must be importable/testable through `Main` so its lines enter root LCOV; exclusions cannot hide ordinary implementation or CLI wrappers. Refactor the existing workspace CLI behind an `import.meta.main` guard and injectable/testable `Main`, preserve its subprocess behavior, and cover both success/failure paths so `scripts/verify-workspace.cli.ts` joins the real LCOV inventory. The gate rejects zero tooling sources, missing/extra SF records and any stale exclusion.

- [ ] **Step 4: Verify actual Bun inventory and commit**

Run `bun run test:coverage`, prove the LCOV contains the exact non-excluded `scripts/**/*.ts` plus `tools/**/*.ts` implementation set, then run fixture and tools modes expecting pass and repository mode expecting current zero-source failure. Input inventory includes cases/policy, consumed LCOV and every expected source; evaluator parses those snapshot bytes. Run global/cached gates, commit `test: make Bun coverage denominators explicit`, then range whitespace.

---

### Task 10: Exact image-lock resolver, resolver-container cleanup, and live readback commit

**Depends on:** Tasks 1-2 and 9.

**Files:**
- Create: `schemas/runtime-image-lock.schema.json`
- Create: `tools/runtime/command-executor.ts`
- Create: `tools/runtime/resolve-images.ts`
- Create: `tools/runtime/resolve-images.test.ts`
- Create: `tools/runtime/resolve-images.cli.ts`
- Create by live verified command: `tools/runtime/images.lock.json`

**Interfaces:**

```ts
export interface CommandResult {
  readonly ExitCode: number
  readonly Stdout: string
  readonly Stderr: string
}
export interface CommandExecutor {
  Run(argv: readonly string[], options: { readonly TimeoutMs: number }): Promise<CommandResult>
}
export interface LockedImage {
  readonly RuntimeId: "node-lts" | "node-current" | "deno-exact"
  readonly Tag: string
  readonly Digest: string
  readonly Reference: string
  readonly VerifiedPlatform: "linux/amd64" | "linux/arm64"
  readonly ObservedRuntimeVersion: string
  readonly ObservedRuntimePlatform: string
}
export async function ResolveAndVerifyImages(input: {
  readonly Snapshot: InputSnapshot
  readonly Platform: "linux/amd64" | "linux/arm64"
  readonly RunId: string
  readonly Exec: CommandExecutor
}): Promise<{ readonly Images: readonly LockedImage[]; readonly Checks: readonly GateCheck[] }>
```

- [ ] **Step 1: Write fake-executor RED tests**

Test malformed/multiple/missing top-level digest, tag mismatch, wrong version/platform, pull/run timeout, runtime readback failure, `--rm` failure, forced-removal failure, label leak, atomic lock failure and stale lock preservation. Expected RED is missing resolver/command-executor, never Docker availability.

- [ ] **Step 2: Implement fail-safe resolution without embedded digests**

For each Node24/Node26/Deno lane, execute `docker buildx imagetools inspect <tag>`, parse one top-level `Digest: sha256:<64 lowercase hex>`, form exact reference and pull requested platform. Do not copy any digest from reports or this plan.

Each version-readback container has normalized unique name, label `likego.runtime-image-lock=<runId>`, hard timeout and `--rm`. In `finally`, independently attempt `docker rm -f <name>` and then require `docker ps -aq --filter label=likego.runtime-image-lock=<runId>` empty. If `--rm` already removed that exact named container, Docker's exact not-found response is the only idempotent-success exception; every other removal error fails. Cleanup failure fails the result even after correct version output.

Lock schema records exact tag/digest/reference plus VerifiedPlatform, ObservedRuntimeVersion and ObservedRuntimePlatform for each lane. Atomic lock writer preserves prior lock on failure.

- [ ] **Step 3: Run live registry/pull/version readback**

Validate logical runId and choose the actual host Docker platform explicitly:

```bash
bun tools/runtime/resolve-images.cli.ts --platform linux/arm64 --write tools/runtime/images.lock.json
```

Use `linux/amd64` only on an actually selected amd64 Docker run. Gate `runtime-image-lock`, runtime-probe, evaluation-only, expected/checked `3`. Input snapshot includes runtime matrix, lock schema and resolver policy; generated lock is hashed artifact.

Expected: current-run canonical result, three exact references, exact in-container versions/platform and zero resolver-label containers. Any live failure blocks this task; no tag-only/cached-report fallback.

- [ ] **Step 4: Verify generated lock and commit**

Run unit tests, schema/readback verification, independent resolver label readback, global gates, then the Task 9 tooling-inventory gate and cached whitespace. Commit code plus live-generated platform-provenance lock as `test: lock exact native coverage images`, then range whitespace.

---

### Task 11: Native Node/Deno runner contract and probe-discovery invariant

**Depends on:** Tasks 9-10.

**Files:**
- Create: `tools/runtime/native-runner.ts`
- Create: `tools/runtime/native-runner.test.ts`
- Create: `tools/runtime/native-runner.fixture.cli.ts`
- Create: `test/runtime/native-branch/cases.json`
- Create: `test/runtime/probes/branch-subject.probe.mjs`
- Create: `test/runtime/probes/branch-miss.node.probe.mjs`
- Create: `test/runtime/probes/branch-full.node.probe.mjs`
- Create: `test/runtime/probes/branch-miss.deno.probe.mjs`
- Create: `test/runtime/probes/branch-full.deno.probe.mjs`

**Interfaces:**

```ts
export interface NativeProbeCommandSet {
  readonly Smoke: readonly string[]
  readonly Enforce: readonly string[]
  readonly ExpectedSmokeExit: 0
  readonly ExpectedEnforceExit: 0 | 1
}
export function NodeProbeCommands(lane: "node-lts" | "node-current", mode: "miss" | "full"): NativeProbeCommandSet
export function DenoProbeCommands(mode: "miss" | "full"): NativeProbeCommandSet
export function VerifyNativeProbeCoverage(
  mode: "miss" | "full",
  lcov: readonly LcovRecord[],
): readonly CoverageIssue[]
```

- [ ] **Step 1: Write probe corpus and clean RED**

`cases.json` uses the common exact `id/path/expectedCodes` shape and inventories all five `.probe.mjs` files. Stable ids map to subject/node-miss/node-full/deno-miss/deno-full roles; validator tests reject an unknown or duplicated role. Reuse Task 3's repository scanner and assert every executable file under `test/runtime/probes` ends `.probe.mjs` with no Bun discovery pattern. The full root `bun test`/coverage run is the execution proof; Bun 1.3.14 has no `--dry-run`, so the plan does not invoke one.

Expected RED is missing native-runner implementation; probe files themselves must not execute under Bun.

- [ ] **Step 2: Implement exact argv builders without Compose**

Every command includes the exact positional runner module `/work/branch-<mode>.<runtime>.probe.mjs`. Node first runs a no-threshold smoke command with native coverage/reporters and requires exit `0`; it then runs a separate enforcement command with `--test-coverage-include=/work/branch-subject.probe.mjs`, lines/functions/branches `100`, spec+LCOV reporters and a distinct mode output. Deno smoke is `deno test --clean --coverage=... --coverage-raw-data-only <exact-mode-module>` and must exit `0`; enforcement is a separate `deno coverage` argv whose include is one exact item `--include=branch-subject\\.probe\\.mjs$`.

No shell command strings. This task only builds/validates argv and LCOV contracts; it does not start Compose.

- [ ] **Step 3: Lock miss/full semantics**

Smoke/collect must exit zero for both miss and full, which distinguishes a test failure from threshold enforcement. Miss enforcement alone is expected non-zero and its LCOV has LF>LH or BRF>BRH with BRF>0. Full enforcement exits zero and has LF=LH, FNF=FNH, BRF=BRH, each denominator positive. Missing/multiple/wrong-source LCOV fails through Task 9 inventory.

- [ ] **Step 4: Run fixture machine gate and commit**

Gate `native-runner-contract-fixtures`, runtime-probe, evaluation-only; input includes exact cases and all probe bytes. Run selector/discovery invariant, global gates, Task 9 tooling-inventory gate and cached whitespace; commit `test: define native branch runner contracts`, then range whitespace.

---

### Task 12: Compose native-branch instrumenter with injected-executor cleanup review

**Depends on:** Tasks 1, 9-11.

**Files:**
- Create: `tools/runtime/branch-probe.ts`
- Create: `tools/runtime/branch-probe.test.ts`
- Create: `tools/runtime/branch-probe.cli.ts`
- Create: `test/runtime/docker-compose.branch.yml`

**Interfaces:**

```ts
export interface BranchProbeInput {
  readonly Snapshot: InputSnapshot
  readonly Platform: "linux/amd64" | "linux/arm64"
  readonly LogicalRunId: string
  readonly Exec: CommandExecutor
}
export async function RunNativeBranchProbe(input: BranchProbeInput): Promise<GateEvaluation>
```

- [ ] **Step 1: Write fake-executor RED tests**

Cover invalid/repeated logical runId, preflight label collision, nonce/project collision, partial lane failure, missing artifact, miss unexpectedly zero, full nonzero, `down` failure, each container/network/volume readback failure, multiple cleanup failures and probe success overridden by cleanup failure. Expected RED is missing branch-probe implementation; no real Docker required.

- [ ] **Step 2: Implement unique staging/result/project identity**

Logical runId matches lowercase `[a-z0-9][a-z0-9_-]*`. Append cryptographic nonce to Compose project; result directory is `.artifacts/runtime/native-branch/<logicalRunId>-<nonce>`. Preflight all project-label container/network/volume readbacks; if any non-empty, refuse to run and never delete unknown resources.

Materialize `/work` from Task 1 snapshot bytes, parse image lock from snapshot, and require selected platform equals every LockedImage VerifiedPlatform. Compose services use exact locked references, `working_dir:/`, `network_mode:none`, read-only root/work mount, writable unique results bind and project-labeled scratch volume. Use exact argv arrays from Task 11; no shell interpolation. YAML quotes Deno include scalar, but the runtime argv value contains the regex without quote characters.

- [ ] **Step 3: Implement independently fail-safe cleanup**

In `finally`, independently run Compose `down --volumes --remove-orphans`, then container, network and volume label readbacks even if down fails. Best-effort every step, collect all errors, and fail with aggregate cleanup checks. Any cleanup nonzero overrides all probe PASS checks.

Capture subprocess stdout/stderr as artifacts; do not leak them into the single machine-result stdout line. Verify each lane/version/platform, miss/full exit contract and LCOV inventory.

- [ ] **Step 4: Fake-executor contract review and commit**

This task is a self-test contract, not a fixture corpus; the common `cases.json` checklist is N/A because all executor transcripts are typed in-memory unit inputs. Run unit/fake integration only under gate `native-branch-meta-contract`, runtime-probe, evaluation-only, expected three lanes. Assert canonical result/runId, deterministic artifact inventory and zero fake cleanup. Run global gates, Task 9 tooling-inventory gate and cached whitespace; commit `test: add fail-safe native branch instrumenter`, then range whitespace. Real Docker and gate id `native-branch-instrumenter` are Task 13.

---

### Task 13: Real Docker live checkpoint and platform-specific normalized evidence

**Depends on:** Tasks 10-12.

**Files:**
- Create: `tools/runtime/evidence.ts`
- Create: `tools/runtime/evidence.test.ts`
- Create: `tools/runtime/evidence.cli.ts`
- Create by live gate: `evidence/runtime/native-branch/linux-arm64.json` or `evidence/runtime/native-branch/linux-amd64.json` for the platform actually run

**Interfaces:**

```ts
export interface NativeBranchEvidence {
  readonly SchemaVersion: 1
  readonly ActualPlatform: "linux/amd64" | "linux/arm64"
  readonly RunId: string
  readonly ProbeResultSha256: string
  readonly Images: readonly {
    readonly RuntimeId: string
    readonly Reference: string
    readonly Digest: string
    readonly ObservedVersion: string
    readonly ObservedPlatform: string
  }[]
  readonly Coverage: readonly {
    readonly RuntimeId: string
    readonly Mode: "miss" | "full"
    readonly LF: number
    readonly LH: number
    readonly FNF: number
    readonly FNH: number
    readonly BRF: number
    readonly BRH: number
  }[]
  readonly Cleanup: { readonly Containers: 0; readonly Networks: 0; readonly Volumes: 0 }
}
export function BuildNativeBranchEvidence(
  snapshot: InputSnapshot,
): { readonly Evidence: NativeBranchEvidence | null; readonly Checks: readonly GateCheck[] }
export function ValidateNativeBranchEvidence(
  evidence: NativeBranchEvidence,
  snapshot: InputSnapshot,
): readonly GateCheck[]
export async function WriteNativeBranchEvidence(
  root: string,
  platform: "linux/amd64" | "linux/arm64",
  evidence: NativeBranchEvidence,
): Promise<"evidence/runtime/native-branch/linux-amd64.json" | "evidence/runtime/native-branch/linux-arm64.json">
```

- [ ] **Step 1: Write synthetic evidence-validation RED**

Tests build synthetic snapshotted probe results, locks, LCOV and evidence. Reject missing evidence, multiple platform claims, platform/lock mismatch, tag-only image, wrong observed version/platform, missing lane/mode/counter, miss without uncovered branch, full below 100, nonzero cleanup, wrong probe-result SHA or stale runId. Atomic-writer tests cover old-evidence preservation, write/rename failure, absolute/`..` request impossibility, symlink parent/target and platform/path mismatch. Expected RED is only missing `evidence.ts`; live Docker/evidence absence is not a unit RED.

- [ ] **Step 2: Implement and GREEN the independent evidence recorder**

`BuildNativeBranchEvidence` consumes a single snapshot containing the committed image lock, one already-persisted probe result and every LCOV/runtime/cleanup artifact named by that result. It binds the evidence RunId to the probe result and hashes the exact persisted probe JSON as `ProbeResultSha256`. `ValidateNativeBranchEvidence` re-derives and compares all normalized facts without re-reading paths.

`WriteNativeBranchEvidence` accepts only repository root, exact platform and evidence; callers cannot provide an output path. It derives exactly `evidence/runtime/native-branch/linux-{amd64|arm64}.json` and verifies evidence/platform equality. Before temp/open/write it lexically confines the derived path, realpaths the repository root and nearest existing parent, rejects any symlink/non-directory component while creating missing parents, and `lstat`s an existing target to reject symlink/non-regular files. Only then may the same-directory exclusive temp/write/sync/close/rename sequence run, preserving old evidence on failure.

`evidence.cli.ts` runs a separate `native-branch-evidence` gate (`runtime-probe`, evaluation-only). It accepts `--probe-result`, `--platform` and `--run-id`, but no output-path flag. Its evaluator atomically writes the derived evidence path, then returns that path as its own hashed artifact. If evidence generation/write fails, this gate persists fail and the previous evidence remains; consumers require the current evidence-gate result/runId/artifact hash. Evidence is never an artifact of the probe result it summarizes, avoiding self-reference. Run synthetic tests to GREEN before any live command.

- [ ] **Step 3: Re-read live tags and run the instrumenter gate**

Before probe, execute registry inspect for each locked tag and require current top-level digest equals committed Task 10 digest. If moved, stop and rerun/review Task 10; never silently update or use tag-only.

Run the instrumenter only, on exactly one explicitly selected actual platform and fresh logical runId (the concrete `r1` below is an example and must be changed if already used):

```bash
bun tools/runtime/branch-probe.cli.ts --platform linux/arm64 --run-id native-arm64-r1
```

The CLI gate id is exactly `native-branch-instrumenter`, mode `runtime-probe`, evaluation-only. It produces canonical probe result/artifacts but never writes evidence. Use amd64 only for an actually selected amd64 run. Node24, Node26 and Deno2.9.3 must all execute smoke/enforce miss/full probes in real Docker.

- [ ] **Step 4: Verify probe result/cleanup, then run the evidence gate**

Require canonical `.artifacts/gates/native-branch-instrumenter.json` runId equals the just-returned invocation. Independently query exact project/lock labels and require container/network/volume counts zero; compare with persisted probe result. Then invoke the separate recorder:

```bash
bun tools/runtime/evidence.cli.ts \
  --probe-result .artifacts/gates/native-branch-instrumenter.json \
  --platform linux/arm64 \
  --run-id evidence-arm64-r1
```

Require current `.artifacts/gates/native-branch-evidence.json` runId/status and evidence artifact hash to match the invocation/file. Normalized evidence stores only actual platform facts: exact image refs/digests, observed runtime version/platform, every miss/full LF/LH/FNF/FNH/BRF/BRH, cleanup zeros and `ProbeResultSha256`. It must not name or imply successful execution on the other architecture.

- [ ] **Step 5: Re-run evidence tests and commit live checkpoint**

Run evidence selector; rerun instrumenter then evidence recorder if any bound result/artifact/evidence changed. Run all pre-kernel fixture/tool gates, global gates, Task 9 tooling-inventory gate and cached whitespace. Commit validator/recorder plus one actual-platform evidence file as `test: record exact native branch checkpoint`, then run range whitespace.

## Expected command status before a production package exists

| Gate | Exit | Readiness | Meaning |
| --- | ---: | --- | --- |
| gate protocol pass probe | 0 | not-evaluated | protocol works |
| runtime contract | 0 | not-evaluated | exact decisions fixed |
| manifest fixtures | 0 | not-evaluated | corpus exactly matched |
| official manifests repository | 1 | not-ready | zero official packages |
| boundary family/combined fixtures | 0 | not-evaluated | AST gates exactly matched |
| portable boundary repository | 1 | not-ready | zero portable source |
| distribution fixtures | 0 | not-evaluated | checker exactly matched |
| distribution repository | 1 | not-ready | zero built package |
| Bun coverage fixtures/tools | 0 | not-evaluated | parser and tool denominator pass |
| Bun production coverage repository | 1 | not-ready | zero production source |
| runtime image lock / native runner / instrumenter | 0 | not-evaluated | exact runtime tooling/probe passed, not a package |
| native branch evidence recorder | 0 | not-evaluated | current probe facts atomically normalized, not a package |

## Deferred by scope

- Real `@likego/context` source/package/dist behavior.
- Real `bun pm pack`, offline consumer, deep-import rejection and sentinel singleton.
- Formal Bun/Node/Deno published-dist behavior matrix and package branch coverage.
- Aggregate release gate and root `verify` integration.

Fixture/probe PASS cannot substitute any deferred gate. Repository admission remains intentionally red until a real package exists.

## Local verified facts used by this plan

- Bun `1.3.14` with TypeScript `7.0.2` async API has locally completed `new API({cwd})`, `updateSnapshot({openProjects})`, `getProjects()`, `snapshot.dispose()`, `api.close()` and exited naturally.
- Exact-runtime Node `24.18.0` and `26.5.0` native coverage miss commands exited nonzero while still producing LCOV; full commands exited zero.
- Exact-runtime Deno `2.9.3` coverage miss command exited nonzero while still producing LCOV; full command exited zero.
- This plan intentionally records no Docker digest. Task 10 must generate every digest from fresh live readback and commit platform/version provenance.

## Final self-review checklist

For every task before dispatching its implementer, the root agent must confirm:

1. RED imports only that task’s missing implementation; all dependencies/prior tasks are GREEN.
2. Fixture and repository modes/gate ids/readiness policies are explicit and separate.
3. For fixture-corpus tasks, `cases.json` is non-empty and covers every fixture payload exactly once; explicitly non-fixture self-test tasks mark this item N/A and must not use a `-fixtures` gate id.
4. Complete input inventory is snapshotted, hashed and passed to evaluator; evaluator cannot rediscover/re-read originals.
5. No zero-subject/check path can PASS; expected equals checked when expected is known.
6. No exact root script/workspace change is staged; Task 1 package diff contains only exact Ajv addition.
7. Probe names cannot be discovered by Bun.
8. Docker cleanup/readback cannot short-circuit, and evidence claims only the actual platform.
9. Precommit `git diff --cached --check` and postcommit `git diff --check 0a42ad1..HEAD` both pass.

## Remaining blockers (2)

1. **Live image provenance:** exact digests intentionally do not exist in this plan. Task 10 requires live registry, Docker pull/run and cleanup; failure blocks Task 10/13 and cannot be bypassed with report values.
2. **No production denominator:** no real package exists in this pre-kernel scope, so repository manifest/boundary/distribution/production-coverage remain intentionally not-ready. Pre-kernel completion is not release readiness.
