# LikeGo 新代码复审修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复两个已复现的生命周期终止缺陷，清零已知开发链漏洞，并让 Examples、发布前置检查与公开文档只声明已经被真实证据支持的能力。

**Architecture:** 保持现有 Context、Server、App、Web 与 workspace 分层不变。运行时修复只补 Promise observation 和 startup admission settlement；外围门禁复用 Bun audit、现有 workspace discovery、真实程序探针与 Git 本地 remote，不建立新的框架。

**Tech Stack:** TypeScript 7、Bun 1.3.14、Node.js HTTP、Git、VitePress 1.6.4、Docker E2E。

---

执行范围：当前 `main` 工作区；不创建 worktree，不提交，不推送，不发布。计划中的 commit 步骤因用户明确约束而省略。

## 文件映射

- `packages/core/src/app.ts`：立即观察每个 Server start Promise。
- `packages/core/test/app.test.ts`：锁定延迟 startup phase 下无未处理拒绝。
- `packages/web/src/node-server.ts`：让 startup 期间的 clean stop 结算 admission。
- `packages/web/test/node/lifecycle.test.ts`、`packages/web/test/node/host.test.ts`：假 native 状态机与真实端口回归。
- `package.json`、`bun.lock`：稳定依赖 override、audit gate 与 example test 语义。
- `scripts/verify-workspace.ts`、`scripts/verify-workspace.test.ts`：根脚本权威契约。
- `scripts/release-preflight.ts`、`scripts/release-config.test.ts`：发布 Git 状态 fail-closed。
- `test/doc-site.test.ts`、`doc/**/reference/packages.md`：多语言发布包清单一致性。
- `README.md`、`doc/guide/getting-started.md`、`doc/zh-Hans/guide/getting-started.md`、`packages/create/README.md`、`examples/README.md`、`docs/example-portfolio.md`：当前发布状态与 Examples 范围。

### Task 1: Core 在创建 Server Promise 时立即观察 rejection

**Files:**
- Modify: `packages/core/test/app.test.ts`
- Modify: `packages/core/src/app.ts`

- [x] **Step 1: 写失败回归**

新增测试，使用立即拒绝 Server 和延迟 `afterStart`；监听并最终移除 `process` 的 `unhandledRejection` listener：

```ts
test("observes a server rejection while later startup phases are pending", async () => {
  const failure = new Error("start failed")
  const unhandled: unknown[] = []
  const observeUnhandled = (error: unknown): void => {
    unhandled.push(error)
  }
  process.on("unhandledRejection", observeUnhandled)
  try {
    const app = newApp(
      server({
        async start() {
          throw failure
        },
        async stop() {}
      }),
      afterStart(() => Bun.sleep(25))
    )
    await expect(app.run()).rejects.toBe(failure)
    await turn()
    expect(unhandled).toEqual([])
  } finally {
    process.off("unhandledRejection", observeUnhandled)
  }
})
```

- [x] **Step 2: 验证 RED**

Run: `bun test --isolate --no-orphans packages/core/test/app.test.ts --test-name-pattern "observes a server rejection"`
Expected: FAIL，旧实现记录 `start failed` 的 unhandled rejection。

- [x] **Step 3: 最小实现**

在 `executeStart()` 中保留原 Promise，只提前安装 observer：

```ts
const running = invokeStart(subject, serverContext, index)
void running.catch(() => {})
serverPromises.push(running)
```

- [x] **Step 4: 验证 GREEN 与包门禁**

Run: `bun test --isolate --no-orphans packages/core/test/app.test.ts`

Run: `bun run --filter @likego/core test:coverage`
Expected: 全部退出 0，原 Error identity 仍由 `app.run()` 返回。

### Task 2: Node Web 在 startup clean stop 时结算 admission

**Files:**
- Modify: `packages/web/test/node/lifecycle.test.ts`
- Modify: `packages/web/test/node/host.test.ts`
- Modify: `packages/web/src/node-server.ts`

- [x] **Step 1: 写 fake-native RED**

在 delayed listen fixture 中先 `start()`、立即 `stop()`，完成 fake close 后断言 start 与 stop 都 resolve；再触发迟到 listen callback 并断言不会复活。

```ts
test("clean stop during startup settles start without accepting a late listen", async () => {
  const { subject, fake } = fixture()
  fake.delayedListen = true
  const running = subject.start(background())
  const stopping = subject.stop(background())
  fake.finishClose()
  await expect(stopping).resolves.toBeUndefined()
  await expect(running).resolves.toBeUndefined()
  fake.finishListen()
  expect(fake.closeCalls).toBe(1)
})
```

- [x] **Step 2: 写真实端口 RED**

使用 `availablePort()` 创建真实 `newNodeServer(..., port(value))`，同一事件循环 start/stop；用 bounded race 证明两个 Promise 结算，并用原生 `createServer` 重新绑定同一端口。

- [x] **Step 3: 验证 RED**

Run: `bun test --isolate --no-orphans packages/web/test/node/lifecycle.test.ts packages/web/test/node/host.test.ts --test-name-pattern "during startup"`
Expected: FAIL，旧实现的 running Promise 超时或保持 pending。

- [x] **Step 4: 最小实现**

Runtime 增加单个私有字段：

```ts
settleStartupStop: (() => void) | null
```

`startServer()` 在 admission executor 中安装一次性函数；它标记 startup 已结算、移除 abort listener、释放 StopFunc、清空自身并 resolve admission。`admitTerminal()` 仅在首次从 `starting` 进入无错误 terminal 时调用。正常 listen 与 `fail()` 也清空该字段。

- [x] **Step 5: 验证 GREEN 与真实 E2E**

Run: `bun test --isolate --no-orphans packages/web/test/node/lifecycle.test.ts packages/web/test/node/host.test.ts`

Run: `bun run --filter @likego/web test:coverage`

Run: `bun run test:e2e:prepared -- --suite web-node-native`
Expected: 全部退出 0，端口可重新绑定。

### Task 3: 清零开发链漏洞并把 audit 纳入 verify

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `scripts/verify-workspace.ts`
- Modify: `scripts/verify-workspace.test.ts`

- [x] **Step 1: 锁定当前 RED**

Run: `bun audit`
Expected: exit 1，报告 2 high、3 moderate。

- [x] **Step 2: 写根脚本契约 RED**

在 `RootScripts` 与有效 manifest fixture 中要求：

```json
"audit": "bun audit"
```

并要求完整 `verify` 在 workspace/manifests 之后执行 `bun run audit`。先运行：

`bun test scripts/verify-workspace.test.ts --test-name-pattern "root scripts"`

Expected: 旧 manifest 因缺少 audit script 失败。

- [x] **Step 3: 应用精确稳定 override 并刷新 lock**

在根 manifest 增加：

```json
"overrides": {
  "fast-uri": "3.1.4",
  "vite": "6.4.3"
}
```

运行 `bun install`，不手改 `bun.lock`。当前 registry 已核实 Ajv 兼容的最新 3.x 正式版为 `3.1.4`；若实施时发生更新，则只使用当日最新正式 3.x，并同步设计文档中的精确版本。

- [x] **Step 4: 验证安全与兼容性**

Run: `bun audit`

Run: `bun install --frozen-lockfile --dry-run`

Run: `bun run verify:doc`

Run: `bun test scripts/verify-workspace.test.ts`
Expected: 全部 exit 0；VitePress 生产构建通过且 audit 无 advisory。

### Task 4: 明确 Examples 门禁与公开文档事实

**Files:**
- Modify: `package.json`
- Modify: `scripts/verify-workspace.ts`
- Modify: `scripts/verify-workspace.test.ts`
- Modify: `test/doc-site.test.ts`
- Modify: `doc/reference/packages.md`
- Modify: `doc/ar-Arab/reference/packages.md`
- Modify: `doc/es-Latn/reference/packages.md`
- Modify: `doc/fr-Latn/reference/packages.md`
- Modify: `doc/ru-Cyrl/reference/packages.md`
- Modify: `doc/zh-Hans/reference/packages.md`
- Modify: `doc/zh-Hant-HK/reference/packages.md`
- Modify: `doc/zh-Hant-TW/reference/packages.md`
- Modify: `doc/**/guide/architecture.md`
- Modify: `doc/**/guide/service-call.md`
- Modify: `README.md`
- Modify: `doc/guide/getting-started.md`
- Modify: `doc/zh-Hans/guide/getting-started.md`
- Modify: `packages/create/README.md`
- Modify: `examples/README.md`
- Modify: `docs/example-portfolio.md`

- [x] **Step 1: 写 docs package inventory RED**

在 `test/doc-site.test.ts` 复用 `discoverWorkspaces()`，取得 `private === false` 的 46 个 name；对八个 package reference 提取精确 `@likego/<name>` token 并断言集合相等。

Run: `bun test test/doc-site.test.ts --test-name-pattern "package"`
Expected: FAIL，至少报告缺少 `@likego/create`。

- [x] **Step 2: 修正 package reference 与 onboarding**

八个 locale 补齐缺少的公开 package token。根 README、英文/简中 Getting Started 与 Create README 在安装命令前增加“0.0.1 尚未发布到 npm”的显眼说明，并给出当前可执行的仓库验证命令；不删除发布后的目标用法。

- [x] **Step 3: 收敛 Examples 语义**

将根脚本改为：

```json
"test:examples": "bun run --filter '@likego/example-*' --parallel test"
```

同步 workspace 权威测试，并让 `verifyExampleProgram()` 拒绝缺少非空 `scripts.test` 的示例。README 文案改为“仓库工作区内可独立启动的 private workspace 小程序”。将 portfolio 中 `cybersecurity-alert-triage` tier 改为 `production`。

- [x] **Step 4: 验证 docs 与所有 example tests**

Run: `bun test test/doc-site.test.ts scripts/verify-workspace.test.ts`

Run: `bun run test:examples`

Run: `bun run test:examples:programs`
Expected: 44 个 example test workspace 退出 0；38 个 direct-run 程序全部完成启动、探测、SIGTERM 与端口释放。

### Task 5: Release preflight 拒绝非远端 main 快照

**Files:**
- Modify: `scripts/release-config.test.ts`
- Modify: `scripts/release-preflight.ts`

- [x] **Step 1: 扩展本地 Git fixture 并写 RED**

创建临时 bare `origin`，初始化 main、设置 upstream，并依次构造：clean aligned、feature branch、detached HEAD、ahead、behind、错误 upstream。断言只有 aligned 状态返回空 issues。

Run: `bun test scripts/release-config.test.ts --test-name-pattern "release preflight"`
Expected: 旧实现错误接受至少 feature、detached、ahead 与 behind。

- [x] **Step 2: 实现最小 Git 检查**

复用一个 `runGit(root, args)` 私有函数，执行：

```text
symbolic-ref --quiet --short HEAD
rev-parse --abbrev-ref --symbolic-full-name @{upstream}
fetch --quiet origin main
rev-parse HEAD
rev-parse @{upstream}
rev-parse refs/remotes/origin/main
```

新增稳定 issue codes：`RELEASE_BRANCH`、`RELEASE_UPSTREAM`、`RELEASE_REMOTE`。任何命令失败均产生 issue 或由 CLI fail-closed，不允许继续发布。

- [x] **Step 3: 验证 GREEN**

Run: `bun test scripts/release-config.test.ts --test-name-pattern "release preflight"`

Run: `bun test scripts/release-config.test.ts`
Expected: 全部退出 0。

### Task 6: 全仓验收与独立复审

**Files:**
- Verify only: current working tree

- [x] **Step 1: 格式与静态门禁**

Run: `bun run fmt`

Run: `bun run fmt:check`

Run: `bun run verify:workspace`

Run: `bun run verify:manifests`

Run: `bun run verify:file-inventory`
Expected: 全部退出 0；若新增计划/设计文档改变 inventory，先运行现有 inventory 生成器更新事实文件，再重新检查。

- [x] **Step 2: 完整真实验证**

Run: `bun run verify`
Expected: exit 0；覆盖 46 个发布包、44 个 example tests、38 个 direct-run 程序、published runtime/types、81 个 E2E case、28 个 suite 与真实 Docker providers。

- [x] **Step 3: Docker cleanup 回读**

按 `io.likego.e2e.owner`、`com.likego.published.owner` 过滤 container、network、volume；本轮 owner 资源必须为零，不清理 foreign owner。

- [x] **Step 4: 差异与独立审查**

Run: `git diff --check`

Run: `git status --short`
独立 reviewer 检查 spec compliance 与代码质量；任何 Important 先修复并重跑对应门禁。保留用户原有未提交改动，不 commit、push、publish。
