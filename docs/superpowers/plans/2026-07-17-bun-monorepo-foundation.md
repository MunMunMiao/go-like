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
- 每个提交前运行 covering tests、typecheck、workspace verifier 与 `git diff --check`。

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

**Interfaces:**
- Consumes: ADR 0001 and ADR 0002.
- Produces: `VerifyWorkspace(root: string): Promise<readonly WorkspaceIssue[]>`; stable root scripts `build`, `typecheck`, `test`, `test:coverage`, `verify:workspace`, `verify`.

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
coverage = false
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
  "files": [],
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

Append `.artifacts/` and `reports/` to `.gitignore`. Create a short `README.md` that states the project purpose, Bun `1.3.14` prerequisite, and the commands `bun ci` and `bun run verify`; do not claim any package is implemented.

- [ ] **Step 2: Install with Bun and prove the frozen lockfile works**

Run:

```bash
bun install --linker isolated
bun ci
```

Expected: both exit `0`; `bun.lock` exists; no `package-lock.json`, `pnpm-lock.yaml` or `yarn.lock` exists.

- [ ] **Step 3: Write the failing workspace verifier tests**

Create `scripts/verify-workspace.test.ts` with three focused tests. The tests must use a temporary directory and real JSON/lock files, not mocks:

```ts
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { VerifyWorkspace } from "./verify-workspace.ts"

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

describe("VerifyWorkspace", () => {
  test("accepts the repository root", async () => {
    expect(await VerifyWorkspace(fileURLToPath(new URL("..", import.meta.url)))).toEqual([])
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

    expect((await VerifyWorkspace(root)).map((issue) => issue.Code)).toEqual([
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

    expect((await VerifyWorkspace(root)).map((issue) => issue.Code)).toEqual([
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

- [ ] **Step 4: Run RED and confirm the expected missing-module failure**

Run:

```bash
bun test ./scripts/verify-workspace.test.ts
```

Expected: non-zero exit because `./verify-workspace.ts` does not exist. A syntax, permission, or fixture error is not an acceptable RED; fix the test until the missing implementation is the reason.

- [ ] **Step 5: Implement the minimal verifier**

Create `scripts/verify-workspace.ts`. It must export:

```ts
export interface WorkspaceIssue {
  readonly Code: string
  readonly Path: string
  readonly Message: string
}

export function ExactDependencySpecifier(specifier: string): boolean
export async function VerifyWorkspace(root: string): Promise<readonly WorkspaceIssue[]>
```

Implementation rules:

1. Parse root `package.json` with `Bun.file(...).json()`.
2. Emit issues in the deterministic order asserted above.
3. Compare the workspace array exactly with `packages/*`, `adapters/*`, `examples/*`.
4. Require exact root `@types/bun` and `typescript` versions.
5. Require `bun.lock`; reject `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, and `npm-shrinkwrap.json`.
6. Discover `{packages,adapters,examples}/*/package.json` with `new Bun.Glob(...)`, sorted lexically.
7. Workspace name must start `@likego/`, version must be `0.1.0`, type must be `module`, and `exports` must exist.
8. For `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies`, accept only exact semver strings matching `^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$` or exactly `workspace:*`. Reject `latest`, `next`, `*`, `^`, `~`, URL/Git specifiers, build-metadata variants, and other workspace ranges.
9. The verifier reports all issues; it does not stop after the first.

Use small private helpers for JSON object narrowing and deterministic issue creation. Do not add behavior not listed above.

Create `scripts/verify-workspace.cli.ts`:

```ts
import { VerifyWorkspace } from "./verify-workspace.ts"

const issues = await VerifyWorkspace(process.cwd())

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
bun test ./scripts/verify-workspace.test.ts
bun run verify:workspace
bun run typecheck
bun run test:coverage
git diff --check
```

Expected: three tests pass, verifier emits exactly one `LIKEGO_WORKSPACE_RESULT` line, typecheck exits `0`, coverage reports 100% lines/functions for loaded implementation, and whitespace check exits `0`.

- [ ] **Step 7: Verify lock drift fails and restore it**

Temporarily change `typescript` in `package.json` from `7.0.2` to `7.0.1`, run:

```bash
bun ci
```

Expected: non-zero exit because `package.json` and `bun.lock` disagree. Restore `7.0.2`, then run `bun ci` again and expect exit `0`. Do not commit the temporary mutation.

- [ ] **Step 8: Self-review and commit**

Confirm no package manager other than Bun appears in executable scripts, no production package shell was created, and no test is skipped/todo/only. Then run the Step 6 commands once more and commit:

```bash
git add package.json bun.lock bunfig.toml tsconfig.base.json tsconfig.json tsconfig.test.json deno.json README.md .gitignore scripts
git commit -m "build: establish Bun monorepo foundation"
```
