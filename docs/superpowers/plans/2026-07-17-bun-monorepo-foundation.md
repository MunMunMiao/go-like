# Bun Monorepo Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 LikeGo 可复现的 Bun-first monorepo 基线，并用测试锁定 exact toolchain、workspace dependency 与 lockfile 规则。

**Architecture:** 根 workspace 只负责编排，正式 package 后续各自 emit ESM dist。Bun `1.3.14` 负责安装、脚本与单测，npm TypeScript `7.0.2` 负责严格 typecheck。一个经过单测的 workspace verifier fail closed 地拒绝浮动依赖、非 Bun lockfile 和不合规 package manifest。

**Tech Stack:** Bun `1.3.14`、`@types/bun` `1.3.14`、TypeScript `7.0.2`、Bun workspaces、`bun:test`。

## Global Constraints

- 所有依赖必须 exact pin；workspace 内部依赖只允许 `workspace:*`。
- 根 package 必须 `private: true`，唯一 lockfile 是 `bun.lock`，CI 安装入口是 `bun ci`。
- Bun 是开发、package manager、脚本和 unit-test runner；本任务不引入 npm/pnpm/yarn 命令。
- Production package source 后续只发布 `dist/*.js + dist/*.d.ts`；本任务不创建空壳 production exports。
- `tsconfig.base.json` 默认 `types: []`，避免 Bun/Node ambient globals 泄漏到 portable source。
- 配置文件是为执行用户明确指定的 Bun 工具链所必需的 bootstrap；production behavior 仍严格 test-first。
- 每个提交前运行 covering tests、typecheck、workspace verifier、`git diff --check` 与 `git diff --cached --check`；提交后运行 `git diff --check 0a42ad1..HEAD` 覆盖整个实现范围。

---

### Task 1: Root Bun workspace and verifier

**Files:**
- Create: `package.json`
- Create: `bunfig.toml`
- Create: `tsconfig.base.json`
- Create: `tsconfig.json`
- Create: `tsconfig.test.json`
- Create: `deno.json`
- Create: `README.md`
- Create: `scripts/verify-workspace.test.ts`
- Create: `scripts/verify-workspace.ts`
- Create: `scripts/verify-workspace.cli.ts`
- Create: `bun.lock` via `bun install --linker isolated`
- Modify: `.gitignore`
- Modify: `docs/adr/0001-kernel-public-api.md`（只移除 EOF 多余空行）
- Modify: `docs/adr/0002-build-runtime-and-coverage.md`（只移除 EOF 多余空行）

**Interfaces:**
- Consumes: ADR 0001 and ADR 0002.
- Produces: `verifyWorkspace(root: string): Promise<readonly WorkspaceIssue[]>`; `verifyBunRuntime(observedVersion: string): WorkspaceIssue | null`; stable root scripts `build`, `typecheck`, `test`, `test:coverage`, `verify:workspace`, `verify`.

- [ ] **Step 1: Add exact Bun and TypeScript bootstrap configuration**

Create `package.json` exactly as follows:

```json
{
  "$schema": "https://json.schemastore.org/package.json",
  "name": "likego",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "packageManager": "bun@1.3.14",
  "workspaces": [
    "packages/*",
    "adapters/*",
    "examples/*"
  ],
  "scripts": {
    "build": "tsc -b --pretty false",
    "typecheck": "tsc -b --pretty false && tsc -p tsconfig.test.json --pretty false",
    "test": "bun test --isolate --no-orphans",
    "test:coverage": "bun test --isolate --no-orphans --coverage",
    "verify:workspace": "bun scripts/verify-workspace.cli.ts",
    "verify": "bun run verify:workspace && bun run typecheck && bun run test:coverage"
  },
  "devDependencies": {
    "@types/bun": "1.3.14",
    "typescript": "7.0.2"
  }
}
```

Create `bunfig.toml`:

```toml
[install]
exact = true

[test]
timeout = 10000
coverageSkipTestFiles = true
coverageReporter = ["text", "lcov"]
coverageDir = "coverage"
coverageThreshold = { lines = 1.0, functions = 1.0 }
```

Create `tsconfig.base.json`:

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": [],
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "useUnknownInCatchVariables": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": false
  }
}
```

Create `tsconfig.json`:

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "types": ["bun"]
  },
  "files": [
    "scripts/verify-workspace.ts",
    "scripts/verify-workspace.cli.ts"
  ],
  "references": []
}
```

Create `tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "types": ["bun"]
  },
  "include": ["scripts/**/*.ts"]
}
```

Create `deno.json`:

```json
{
  "compilerOptions": {
    "lib": ["deno.ns", "dom", "dom.iterable", "es2023"],
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true
  },
  "tasks": {}
}
```

Append `*.tsbuildinfo`, `.artifacts/`, and `reports/` to `.gitignore`. Create a short `README.md` that states the project purpose, Bun `1.3.14` prerequisite, and the commands `bun ci` and `bun run verify`; do not claim any package is implemented.

- [ ] **Step 2: Install with Bun and prove the frozen lockfile works**

Run:

```bash
bun install --linker isolated
bun ci
```

Expected: both exit `0`; `bun.lock` exists; no `bun.lockb`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` or `npm-shrinkwrap.json` exists.

- [ ] **Step 3: Write the failing workspace verifier and CLI tests**

Start `scripts/verify-workspace.test.ts` with the three bootstrap tests below. Tests must use temporary directories and real JSON/lock files, not mocks. Before enabling `ROOT_SCRIPTS`, add the exact six-script object from Step 1 to every root fixture that is not intentionally testing script drift.

```ts
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { verifyWorkspace } from "./verify-workspace.ts"

const Roots: string[] = []

afterEach(async () => {
  await Promise.all(Roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function Fixture(manifest: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "likego-workspace-"))
  Roots.push(root)
  await Bun.write(join(root, "package.json"), `${JSON.stringify(manifest)}\n`)
  return root
}

describe("verifyWorkspace", () => {
  test("accepts the repository root", async () => {
    expect(await verifyWorkspace(fileURLToPath(new URL("..", import.meta.url)))).toEqual([])
  })

  test("rejects root toolchain and lockfile drift", async () => {
    const root = await Fixture({
      name: "wrong",
      private: false,
      type: "commonjs",
      packageManager: "npm@latest",
      workspaces: ["packages/**"],
      devDependencies: {
        "@types/bun": "^1.3.14",
        typescript: "latest"
      }
    })
    await Bun.write(join(root, "package-lock.json"), "{}\n")

    expect((await verifyWorkspace(root)).map((issue) => issue.Code)).toEqual([
      "ROOT_NAME",
      "ROOT_PRIVATE",
      "ROOT_TYPE",
      "PACKAGE_MANAGER",
      "WORKSPACES",
      "DEV_DEPENDENCY",
      "DEV_DEPENDENCY",
      "BUN_LOCK_MISSING",
      "FOREIGN_LOCKFILE"
    ])
  })

  test("rejects invalid workspace manifests and floating dependencies", async () => {
    const root = await Fixture({
      name: "likego",
      private: true,
      type: "module",
      packageManager: "bun@1.3.14",
      workspaces: ["packages/*", "adapters/*", "examples/*"],
      devDependencies: {
        "@types/bun": "1.3.14",
        typescript: "7.0.2"
      }
    })
    await Bun.write(join(root, "bun.lock"), "lockfileVersion = 1\n")
    await mkdir(join(root, "packages", "bad"), { recursive: true })
    await Bun.write(join(root, "packages", "bad", "package.json"), JSON.stringify({
      name: "bad",
      version: "0.0.0",
      private: false,
      type: "commonjs",
      dependencies: {
        external: "^1.0.0",
        internal: "workspace:^"
      }
    }))

    expect((await verifyWorkspace(root)).map((issue) => issue.Code)).toEqual([
      "WORKSPACE_NAME",
      "WORKSPACE_VERSION",
      "WORKSPACE_TYPE",
      "WORKSPACE_EXPORTS",
      "DEPENDENCY_SPECIFIER",
      "DEPENDENCY_SPECIFIER"
    ])
  })
})
```

Extend the final suite to nine focused tests covering:

1. `verifyBunRuntime` rejects an observed version other than `1.3.14` and accepts `1.3.14`; pass the version directly rather than faking the process runtime.
2. The real repository root passes.
3. Root toolchain/lock drift emits the deterministic baseline issue order without duplicate dependency issues for the two required dev dependencies.
4. Invalid workspace manifests and floating dependency specifiers fail.
5. Actual workspace package ownership requires `workspace:*` internally and exact semver externally; determine ownership from discovered manifest names, never from the `@likego/` prefix alone.
6. Missing, unknown, boolean-valued, Node-runner, or otherwise drifted root scripts produce one `ROOT_SCRIPTS` issue.
7. A real Bun subprocess runs the absolute CLI path from an invalid temporary fixture cwd, exits non-zero, and emits a stable stderr code/path; do not mock `process.exitCode` or subprocess APIs.
8. Extra root dependencies reject floating ranges and `workspace:*` while accepting exact semver; required `@types/bun` and `typescript` continue to use only `DEV_DEPENDENCY`.
9. Root `bun.lockb` and any lockfile nested directly beside an actually discovered workspace manifest produce deterministic `FOREIGN_LOCKFILE` code/path issues.

The CLI integration process must fully exit before fixture cleanup. A fresh valid CLI run must emit exactly one `LIKEGO_WORKSPACE_RESULT={"valid":true}` line.

- [ ] **Step 4: Run RED and confirm the expected missing-module failure**

Run:

```bash
bun test ./scripts/verify-workspace.test.ts
```

Expected: non-zero exit because `./verify-workspace.ts` does not exist. A syntax, permission, or fixture error is not an acceptable RED; fix the test until the missing implementation is the reason.

Then run each review case focused before its implementation:

```bash
bun test ./scripts/verify-workspace.test.ts -t "rejects Bun runtime version drift"
bun test ./scripts/verify-workspace.test.ts -t "rejects missing, unknown, and drifted root scripts"
bun test ./scripts/verify-workspace.test.ts -t "CLI exits non-zero with a stable issue for an invalid fixture cwd"
bun test ./scripts/verify-workspace.test.ts -t "rejects floating and workspace root dependencies"
bun test ./scripts/verify-workspace.test.ts -t "rejects legacy root and nested workspace lockfiles"
```

Expected: each exits non-zero for the missing behavior under test. The runtime test may initially fail because the new export is absent; the remaining tests must fail by receiving no required issue or by the CLI incorrectly exiting zero, not because of fixture, syntax, or process-launch errors.

- [ ] **Step 5: Implement the minimal verifier**

Create `scripts/verify-workspace.ts`. It must export:

```ts
export interface WorkspaceIssue {
  readonly Code: string
  readonly Path: string
  readonly Message: string
}

export function exactDependencySpecifier(specifier: string): boolean
export function verifyBunRuntime(observedVersion: string): WorkspaceIssue | null
export async function verifyWorkspace(root: string): Promise<readonly WorkspaceIssue[]>
```

Implementation rules:

1. `verifyBunRuntime` returns `null` only for observed `1.3.14`; otherwise return a stable `BUN_RUNTIME` issue at `Bun.version`. The CLI calls it with the real `Bun.version` at entry.
2. Parse root `package.json` with `Bun.file(...).json()` and emit all issues in deterministic order.
3. Compare the workspace array exactly with `packages/*`, `adapters/*`, `examples/*`.
4. Compare the complete root `scripts` object by exact key/value equality against the six commands in Step 1. Unknown, missing, boolean-valued, Node-runner, or otherwise drifted values produce one `ROOT_SCRIPTS` issue.
5. Require exact root `@types/bun` and `typescript` versions through `DEV_DEPENDENCY` issues. For every other entry across root `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies`, accept only the exact semver regex `^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$`; root never accepts `workspace:*`.
6. Require root `bun.lock`; reject root `bun.lockb`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, and `npm-shrinkwrap.json`.
7. Discover `{packages,adapters,examples}/*/package.json` with `new Bun.Glob(...)`, sort paths lexically, and read each manifest exactly once into a snapshot. Build the actual workspace name set from string `name` values in these snapshots.
8. Workspace name must start `@likego/`, version must be `0.1.0`, type must be `module`, and `exports` must exist.
9. For workspace `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies`, an actual discovered workspace name accepts only exactly `workspace:*`; any other dependency name accepts only the exact semver regex. Do not infer ownership from a package-name prefix.
10. Beside each actually discovered workspace manifest, deterministically reject `bun.lock`, `bun.lockb`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, and `npm-shrinkwrap.json`. Do not recursively scan `node_modules`.
11. Reject `latest`, `next`, `*`, `^`, `~`, URL/Git specifiers, build-metadata variants, and all non-exact workspace ranges. Report every issue rather than stopping after the first.

Use small private helpers for JSON object narrowing and deterministic issue creation. Do not add behavior not listed above.

Create `scripts/verify-workspace.cli.ts`:

```ts
import { verifyBunRuntime, verifyWorkspace } from "./verify-workspace.ts"

const runtimeIssue = verifyBunRuntime(Bun.version)
const workspaceIssues = await verifyWorkspace(process.cwd())
const issues = runtimeIssue === null ? workspaceIssues : [runtimeIssue, ...workspaceIssues]

if (issues.length > 0) {
  for (const issue of issues) {
    console.error(`${issue.Code} ${issue.Path}: ${issue.Message}`)
  }
  process.exitCode = 1
} else {
  console.log("LIKEGO_WORKSPACE_RESULT={\"valid\":true}")
}
```

- [ ] **Step 6: Run GREEN and the repository gates**

Run:

```bash
bun ci
bun test ./scripts/verify-workspace.test.ts
bun run verify:workspace
bun run typecheck
bun run test:coverage
bun run verify
git diff --check
```

Expected: nine tests pass, the real CLI observes Bun `1.3.14` and emits exactly one `LIKEGO_WORKSPACE_RESULT` line, typecheck exits `0`, coverage reports 100% lines/functions for loaded implementation, frozen install and aggregate verify exit `0`, and whitespace check exits `0`.

- [ ] **Step 7: Verify lock drift fails and restore it**

Temporarily change `typescript` in `package.json` from `7.0.2` to `5.9.3`, run:

```bash
bun ci
```

Expected: non-zero exit because `package.json` and `bun.lock` disagree. Restore `7.0.2`, then run `bun ci` again and expect exit `0`. Do not commit the temporary mutation.

- [ ] **Step 8: Self-review and commit**

Confirm no package manager other than Bun appears in executable scripts, no production package shell was created, no test is skipped/todo/only, and both ADRs end in exactly one newline. Then run the Step 6 commands once more, stage the exact scope, check staged whitespace, and commit:

```bash
git add package.json bun.lock bunfig.toml tsconfig.base.json tsconfig.json tsconfig.test.json deno.json README.md .gitignore scripts docs/adr/0001-kernel-public-api.md docs/adr/0002-build-runtime-and-coverage.md docs/superpowers/plans/2026-07-17-bun-monorepo-foundation.md
git diff --cached --check
git commit -m "build: establish Bun monorepo foundation"
git diff --check 0a42ad1..HEAD
git status --short
```

Expected: staged whitespace check exits `0`; after commit the whole implementation range `0a42ad1..HEAD` exits `0`, and worktree status is empty.
