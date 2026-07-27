# LikeGo 包、Transport、Registry 与 Web 实施计划

> **面向执行代理：** 必须使用 `superpowers:subagent-driven-development`（推荐）或
> `superpowers:executing-plans`，按任务逐项实施本计划。步骤使用复选框（`- [ ]`）跟踪。

**目标：** 在不保留旧 adapter 包壳的前提下，把 LikeGo 收敛为 23 个发布包、4 个 private example workspace，
完成内部微服务 Transport/HTTP client+server、外部 Web、Registry/Consul/mDNS，以及热门后端组件的
Go-style TypeScript 生命周期工具包。

**架构：** 公共能力域由小型结构式接口定义；Context 始终是阻塞/I/O 调用的独立首参；Core 只编排
`Server`/`ServerHandle`；Transport 与 Web 完全分域；Registry provider 通过公共 conformance 对齐；runtime
和供应商能力放在明确的 package/export 中，portable 根入口只依赖 ECMAScript 与标准 Web API。

**技术栈：** TypeScript 7.0.2、Bun 1.3.14、Node 24.18.0/26.5.0、Deno 2.9.3、标准 Web API、
`@hono/node-server` 2.0.11、Hono 4.12.31、H3 2.0.1-rc.25、Elysia 1.4.29、Croner 10.0.1、
BullMQ 5.81.1、NATS JS 3.4.0、Pino 10.3.1、Winston 3.19.0、Prom Client 15.1.3、
OpenTelemetry 1.9.1/2.10.0、Docker 29.6.1。

## 全局约束

- 规范源是 `docs/superpowers/specs/2026-07-19-likego-package-transport-web-design.md`；若计划与规范冲突，
  以规范为准并先修订计划。
- 直接在真实路径的 dirty `main` 工作树实施；不创建 worktree、feature branch，不 reset，不覆盖无关修改。
- 未经用户另行授权，不执行 `git add`、`git commit`、push、PR、release 或部署。任务审查使用精确文件清单、
  `git diff --check` 和实际测试输出，不用 commit 边界冒充证据。
- 这明确替代 subagent-driven-development 默认的 per-task commit/BASE/HEAD review package：每项使用仓库外
  before/after 完整 tree、SHA-256、精确任务文件清单、`diff -ruN` 可见 diff 与测试日志组成 review package；
  untracked 文件也必须进入 tree，不能只给 hash。其余双重审查流程不变。
- 大量现有实现是 untracked，`git diff` 不是恢复基线。Task 1 修改任何仓库文件前必须完成下面的全仓
  预检基线；此后每个任务在第一次编辑前、实现后分别复制该任务精确 review scope 的完整内容到
  `/tmp/likego-task-XX.{before,after}-tree/`，生成 SHA-256 与 `diff -ruN`。不得用 HEAD 覆盖这些文件。
- 每个新增或变更行为严格遵守 test-driven-development：先写失败测试并亲眼确认预期失败，再写最小实现，再运行
  针对性测试和上游门禁。纯 identity/路径/manifest 迁移与已经满足批准规范的既有行为先运行 characterization
  baseline；若真实测试已绿，必须保留实现并记录 no behavior delta，不得篡改正确代码或测试来制造假红灯。
- 红灯步骤列出多条命令时，每条都独立执行并保存 exit/output；预期中的首条非零不得短路后续真实
  Node/Docker 红灯。module-not-found、named-export 解析错误、镜像/端口失败或清理残留均不是合格行为红灯。
- 生产代码优先使用 function、functional option、factory 和冻结普通对象；不引入 class、decorator、反射或
  DI 容器。导出函数使用 lower camel case，业务函数和公共 API 写有意义的 JSDoc。
- portable production source 不得静态 import `node:`、Bun、Deno 或供应商 SDK；Node-only 依赖只能从明确的
  `./node` 子路径进入。开发源码的相对 import 不带扩展名，正式交付物不含猫娘化文案。
- 所有 LikeGo 自有 HTTP/TXT header 使用 `Likego-` 前缀；不得出现 `Micro-` alias。
- 每个发布包必须通过 100% line/function coverage 契约；外部协议、崩溃恢复、TTL、ack、stalled job、
  exporter 和 multicast 必须使用真实 Docker 服务，fake 只用于确定性状态机。
- Task 3 清理全部 `dist` 后，任何通过 package name/`package.json#exports` 或显式 `dist` 执行的 smoke、runtime、
  published、Node E2E、Docker E2E，必须先按批准设计第 6 节依赖表自底向上 build 完整 dependency closure；
  `tsc -p` 不会替代这个步骤，也不得依赖早先任务碰巧留下的产物。对应任务的命令块必须显式列出该闭包。
- 每项实施完成后由独立子代理先做规范符合性审查，再做代码质量审查；阻断意见修复并重跑对应 gate 后，
  才能勾选任务。整个计划完成后再执行一次 broad final review。
- 持久进度写入 `.superpowers/sdd/progress.md`；记录任务状态、精确改动文件、验证命令/退出码、审查结论和
  未解决风险，不改写原有历史记录。它是 ignored 文件，必须显式进入每项 before/after review scope；每次只追加，
  最终文件必须逐字保留 preflight 原始内容作为 byte-for-byte prefix。

---

## 必需的预检基线（Task 1 前执行且只执行一次）

- [ ] 从仓库根使用 `rg --files --hidden --no-ignore .` 枚举全部 tracked/untracked reviewable 文件，包括
  README、schemas、docs、源码、测试与 hidden `.omo/evidence`；显式排除 `.git/`、`.idea/`、`.DS_Store`、
  `node_modules/`、`dist/`、`.artifacts/`、coverage、reports、test-build、`*.tsbuildinfo` 和其他可重新生成目录。
  ignored `.superpowers/` 整体排除后，再把 `.superpowers/sdd/progress.md` 作为唯一例外显式加入排序清单，保存为
  `/tmp/likego-preflight.before.files`。
- [ ] 严格按该清单把每个文件的完整相对路径和内容复制到 `/tmp/likego-preflight.before-tree/`，保存
  `/tmp/likego-preflight.before.sha256`，并用 fresh SHA-256 回读证明副本与工作树一致。只保存路径或 hash
  不算通过。
- [ ] 另存 `git status --short --untracked-files=all` 到 `/tmp/likego-preflight.before.status`，保存完整
  `git diff --binary HEAD` 到 `/tmp/likego-preflight.before.patch`。前者保护 untracked identity，后者保护
  tracked dirty patch；两者都不能代替完整 before-tree。
- [ ] 在首次写 progress ledger 之前，从 before-tree 中另存其原始 bytes、byte length 与 SHA-256；先验证这些
  bytes 与当前 ledger 完全相同，再把以上路径、文件数量、回读结果和命令退出码作为新段落追加。追加后立即验证
  原始长度范围内的 byte prefix 完全相同。若清单漏掉 hidden evidence/ignored ledger、任一副本 hash 不同或
  baseline 文件为空，停止实施并修复快照流程。

---

### Task 1：建立唯一的 canonical workspace discovery

**文件：**
- 创建： `tools/workspaces/discovery.ts`
- 创建： `tools/workspaces/discovery.test.ts`
- 修改： `scripts/verify-workspace.ts`
- 修改： `scripts/verify-workspace.test.ts`
- 修改： `scripts/clean-generated.ts`
- 修改： `scripts/generated-artifacts.test.ts`
- 修改： `scripts/verify-dist.ts`
- 创建： `scripts/file-inventory.ts`
- 创建： `scripts/file-inventory.test.ts`
- 修改： `scripts/generate-file-inventory.cli.ts`
- 重新生成： `docs/file-inventory.md`
- 修改： `scripts/published/inventory.ts`
- 修改： `scripts/published/build-stamp.ts`
- 修改： `scripts/published/workspace-coverage.ts`
- 修改： `scripts/published/workspace-coverage.cli.ts`
- 修改： `test/published/published.test.ts`
- 修改： `tools/manifests/check.cli.ts`
- 修改： `tools/manifests/validate.ts`
- 修改： `tools/manifests/validate.test.ts`
- 修改： `e2e/inventory.ts`
- 修改： `e2e/run.ts`
- 修改： `e2e/e2e.test.ts`
- 创建： `test/fixtures/2026-07-19-migration-baseline.json`

- [ ] **Step 1: 先通过现有入口写 workspace discovery 行为红灯**

先在现有 `scripts/verify-workspace.test.ts`、`scripts/generated-artifacts.test.ts`、
`scripts/file-inventory.test.ts`、`tools/manifests/validate.test.ts` 和 `test/published/published.test.ts` 中构造
direct+nested 临时仓库，
通过当前已存在的公共入口断言嵌套 workspace；这样红灯必须是“漏发现/错误 ownership”的断言失败，而不是
import 尚不存在的模块导致 module-not-found。随后才创建并单测以下唯一 authority：

```ts
export interface Workspace {
  readonly root: string
  readonly manifestPath: string
  readonly name: string
  readonly private: boolean
}

export async function discoverWorkspaces(
  repositoryRoot: string
): Promise<readonly Workspace[]>
```

fixture 同时包含 `packages/config`、`packages/config/consul`、`packages/registry`、
`packages/registry/mdns`、`packages/transport`、`packages/transport/http` 和 `examples/demo`。断言：

- 只按 root `package.json#workspaces` 展开，不再硬编码 `{packages,adapters}/*`；
- 结果按 workspace root code-unit 排序，重叠 glob 只产生一次，重复 package name、缺失/非法 manifest、
  symlink escape 和 root 外路径 fail closed；
- parent 与 child 都被发现，但 parent 的发布文件/覆盖率/清理范围不吞入 child；
- `verify-workspace`、manifest、dist、coverage、build stamp、published inventory 使用同一个结果。
- file inventory 仍覆盖仓库级非 workspace 文档/配置，但 workspace 文件 ownership 必须消费 canonical discovery，
  按最深 workspace root 归属且 parent/child 文件各只出现一次；CLI 不再自行猜测 workspace 边界。
- 把迁移前 53 个业务 E2E case ID 与 6 个 Docker suite ID 作为字面量集合写入
  `test/fixtures/2026-07-19-migration-baseline.json`；后续只能保留或增加，不能静默缩水。

- [ ] **Step 2: 运行红灯**

执行：

```sh
bun test --isolate --no-orphans scripts/verify-workspace.test.ts scripts/generated-artifacts.test.ts scripts/file-inventory.test.ts test/published/published.test.ts tools/manifests/validate.test.ts
```

预期： nested workspace 数量、parent/child ownership 或旧 `adapters/*` 硬编码断言失败；不得以语法错误充当红灯。

- [ ] **Step 3: 实现 discovery 与所有消费者**

`discoverWorkspaces` 只读取当前 root manifest 的字面量 workspace globs，规范化 POSIX relative root，使用
realpath/lstat 防止逃逸与 symlink workspace，并冻结返回值。消费者不得再各自扫描目录。构建图仍保持静态，
但 `verify-workspace` 必须把 `tsconfig.build.json#references` 与 canonical inventory 精确比对。

- [ ] **Step 4: 增加 parent tarball containment fixture**

用真实 `bun pm pack --ignore-scripts` 打包 fixture 的 config/registry/transport parent，断言 tarball 不包含
child `package.json`、`src`、`test` 或 `dist`。该测试不依赖最终包迁移即可先通过。

- [ ] **Step 5: 运行绿灯与基线门禁**

执行：

```sh
bun test --isolate --no-orphans tools/workspaces/discovery.test.ts scripts/verify-workspace.test.ts scripts/generated-artifacts.test.ts scripts/file-inventory.test.ts test/published/published.test.ts tools/manifests/validate.test.ts
bun scripts/generate-file-inventory.cli.ts
bun run verify:file-inventory
bun run verify:workspace
bun run verify:manifests
git diff --check
```

预期： 全部退出 0；旧布局仍被当前 root workspaces 正确发现，行为尚未迁移。

### Task 2：一次性升级 capability manifest v2

**文件：**
- 修改： `schemas/capability-manifest.schema.json`
- 修改： `schemas/owner-manifest.schema.json`（仅在 export/resource 交叉校验需要时）
- 修改： `tools/manifests/validate.ts`
- 修改： `tools/manifests/validate.test.ts`
- 修改： `tools/manifests/check.cli.ts`
- 修改： `tools/manifests/capability-vocabulary.ts`
- 修改： `tools/manifests/fixtures/cases.json`
- 修改： `tools/manifests/fixtures/**/capability.json`
- 修改： `tools/manifests/fixtures/**/owner.json`
- 修改： `tools/runtime/runtime-manifest.ts`
- 修改： `tools/runtime/runtime-manifest.test.ts`
- 修改： `scripts/published/contracts.ts`
- 修改： `scripts/published/inventory.ts`
- 修改： `scripts/published/runner.ts`
- 修改： `scripts/published/coverage.ts`
- 修改： `test/published/published.test.ts`
- 修改： `packages/{context,core,config,health,registry,resilience,testing,fetch}/capability.json`
- 修改： `adapters/{config-consul,config-env,config-file,cron-croner,fetch-node,job-bullmq-node,log-pino-node,log-winston-node,metrics-prom-client-node,nats-core-node,nats-jetstream-node,otel-node,registry-consul}/capability.json`
- 修改： `packages/{context,core,config,health,registry,resilience,testing,fetch}/test/package-contract.test.ts`
- 修改： `adapters/{config-consul,config-env,config-file,cron-croner,fetch-node,job-bullmq-node,log-pino-node,log-winston-node,metrics-prom-client-node,nats-core-node,nats-jetstream-node,otel-node,registry-consul}/test/package-contract.test.ts`

- [ ] **Step 1: 写 v2 schema/validator 红灯**

测试固定：

- 顶层 exact keys 为 `schemaVersion/package/packageKind/stability/releaseBlocking/exports`；
- 每个 `package.json#exports` 业务 key 与 capability `exports` 一一对应，只忽略 `./package.json`；
- export 包含 `kind/residency/ownerResources/capabilities/runtimes`；
- `packageKind` 从所有 export 派生为 `portable/integration/hybrid`，目录不参与；
- resident export 必须引用同包 owner resource，non-resident 必须为空；
- capability vocabulary key 改为 `(package, export, capability)` 并绑定非空 code/test evidence；
- v1 在 repository mode 被拒绝，仅 legacy fixture 可以证明拒绝行为；
- runtime/published gate 按 export lane 执行，不把 hybrid package 整包误判为 Node-only。

- [ ] **Step 2: 运行红灯**

执行：

```sh
bun test --isolate --no-orphans tools/manifests/validate.test.ts tools/runtime/runtime-manifest.test.ts test/published/published.test.ts
bun test --isolate --no-orphans packages/*/test/package-contract.test.ts adapters/*/test/package-contract.test.ts
```

预期： 旧 schema const 1、package-level runtime/residency 或 directory-derived packageKind 断言失败。

- [ ] **Step 3: 实现 v2 并原子转换全部现有 manifest**

schema、validator、fixture、21 个现有 package manifest、runtime manifest、published inventory 和 vocabulary
在同一任务完成；repository mode 不接受混用。secret/evidence snapshot 继续 fail closed。

同时把 published runner 的 NATS exact-optional exception 从 `@likego/nats-core-node`/
`@likego/nats-jetstream-node` package-name 分支改为 case 声明的 `(export, directDependency)` policy；runner 必须反查
manifest direct dependency、TypeScript/SDK 版本、exit code 与逐行 diagnostic，未知 policy 继续 fail closed。测试使用
中性 fixture package name，并证明旧布局的两个 package 仍通过；这样 Task 13 的单一 `@likego/nats` 根与
`./jetstream` 可以分别声明 policy，而 shared runner 不再携带旧 LikeGo identity。

- [ ] **Step 4: 运行绿灯**

执行：

```sh
bun test --isolate --no-orphans tools/manifests/validate.test.ts tools/runtime/runtime-manifest.test.ts test/published/published.test.ts tools/gates/fixture-corpus.test.ts
bun test --isolate --no-orphans packages/*/test/package-contract.test.ts adapters/*/test/package-contract.test.ts
bun run verify:manifests
bun run test:published:types
git diff --check
```

预期： 全部退出 0，结果明确报告 schema v2 和按 export 的 lane。

### Task 3：原子切换到 23/27 最终 workspace identity

**文件：**
- 修改： `package.json`
- 修改： `bun.lock`（只由 Bun 1.3.14 生成）
- 修改： `bunfig.toml`
- 修改： `deno.json`
- 修改： `tsconfig.base.json`
- 修改： `tsconfig.build.json`
- 修改： `tsconfig.json`
- 修改： `tsconfig.test.json`
- 修改： `e2e/tsconfig.json`
- 移动： `adapters/config-consul` → `packages/config/consul`
- 合并： `adapters/config-env/src,index tests/docs` → `packages/config/src/env.ts` 与 `packages/config/test/env.test.ts`
- 合并： `adapters/config-file/src,index tests/docs` → `packages/config/src/file.ts` 与 `packages/config/test/file.test.ts`
- 移动： `adapters/cron-croner` → `packages/croner`
- 移动： `adapters/job-bullmq-node` → `packages/bullmq`
- 移动： `adapters/log-pino-node` → `packages/pino`
- 移动： `adapters/log-winston-node` → `packages/winston`
- 移动： `adapters/metrics-prom-client-node` → `packages/prometheus`
- 移动： `adapters/otel-node` → `packages/otel`
- 移动： `adapters/registry-consul` → `packages/registry/consul`
- 合并： `adapters/nats-core-node` 与 `adapters/nats-jetstream-node` → `packages/nats` 根入口和 `./jetstream`
- 合并： `packages/fetch` 与 `adapters/fetch-node` → `packages/web` 根入口、`./node`、`./node/testing`
- 创建： `packages/transport`
- 创建： `packages/transport/http`
- 创建： `packages/registry/mdns`
- 创建： `packages/hono`
- 创建： `packages/h3`
- 创建： `packages/elysia`
- 移动： `examples/vanilla-fetch` → `examples/vanilla-web`
- 移动： `examples/h3-canary` → `examples/h3`
- 移动（不视为新增证明）： each old `adapters/*/.omo/evidence` → corresponding final
  `packages/*/.omo/evidence`
- 成功迁移后删除： `adapters`
- 修改： `scripts/verify-workspace.ts`
- 修改： `scripts/verify-workspace.test.ts`
- 修改： `tools/manifests/capability-vocabulary.ts`
- 修改： `test/published/published.test.ts`
- 修改： `test/published/cases/{portable,integrations,node-services}.ts`
- 修改： `e2e/suites.ts`
- 修改： `e2e/scripts/web-framework-native.ts`
- 修改： every moved/new workspace `package.json`、`bunfig.toml`、`tsconfig*.json`、
  `test/source-policy.test.ts` 与 runtime/integration root helper

- [ ] **Step 1: 写 final inventory 红灯**

在 workspace、manifest、build-reference 和 published tests 中使用字面量 23 个 release package name 与 4 个
private example identity；断言 workspace globs精确为：

```json
[
  "packages/*",
  "packages/config/consul",
  "packages/registry/consul",
  "packages/registry/mdns",
  "packages/transport/http",
  "examples/*"
]
```

负向扫描锁定不存在 `adapters/`、`@likego/fetch`、`@likego/fetch-node`、`@likego/http` 和所有旧 adapter
包名。

- [ ] **Step 2: 运行红灯并保存布局迁移局部状态**

执行：

```sh
bun test --isolate --no-orphans scripts/verify-workspace.test.ts tools/manifests/validate.test.ts test/published/published.test.ts
git status --short --untracked-files=all
```

预期： final inventory 断言失败；`git status` 输出记录到 progress ledger，用于保护原有 dirty 修改。

全仓原始 dirty-main 已由 Required 预检基线 在 Task 1 前封存；这里仍须在任何移动前建立布局任务的
局部 review package。使用 `rg --files --hidden --no-ignore` 枚举 `packages/`、`adapters/`、`examples/`、
`e2e/`、`scripts/`、`test/`、`tools/`，显式排除 `node_modules/`、`dist/`、`.artifacts/`，并加入 root
`package.json`、`bun.lock`、`bunfig.toml`、`deno.json` 与 `tsconfig*.json`；排序清单和 SHA-256 保存到
`/tmp/likego-layout.before.{files,sha256}`，包括 hidden `.omo/evidence`。严格按清单把完整文件内容复制到
`/tmp/likego-layout.before-tree/`，不能只保存路径或 hash。

迁移后按最终 review scope 建立 `/tmp/likego-layout.after-tree/` 与 after SHA-256，并保存
`diff -ruN /tmp/likego-layout.before-tree /tmp/likego-layout.after-tree` 为
`/tmp/likego-layout.review.diff`。只有 hidden evidence、tracked/untracked 源码与根配置都可在该 diff 中审阅，
才允许移除旧目录。全仓原始 `git diff --binary HEAD` 已在 preflight 保存；此处另存当前 tracked diff 仅用于
标记 Task 3 起点，不得把它误称为用户原始 baseline。

- [ ] **Step 3: 完成一次性目录/包名/exports 切换**

先运行批准范围内的 `bun run clean:generated`，然后只迁移 canonical inventory 中的 reviewable
`LICENSE/README/package.json/capability.json/owner.json/bunfig.toml/tsconfig*.json/src/test` 文件。
旧 `.omo/evidence` 按文件名移到对应新包并标记为 pre-migration historical evidence，不能冒充新 identity 的
验证结果。不得整目录搬运 `node_modules`、`dist`、`.artifacts`；每个目标路径若已存在则停止该移动并先做
内容级合并，不能覆盖。源文件和 evidence 做 after-hash readback 后，才删除旧目录内可重新生成的
`node_modules/dist/.artifacts` 并移除空 `adapters` 目录。

所有 package manifest 使用最终 name、最终 `package.json#exports` key 与精确 `workspace:*` 依赖；现有源码和
测试只做 identity-preserving 迁移，不在本任务改行为。全新 package 只建立 manifest、许可证、tsconfig 和测试
落点，不创建 `throw new Error("not implemented")`、空 `export {}` 或兼容壳。它们在 Task 4/5/9/11 先用
package-contract 的“目标源码/导出尚不存在”断言取得红灯，再创建真实源码并进入行为红绿循环。

本任务是设计第 12 节明确允许的不可发布中间态：只要求精确 23/27 identity、workspace link 和 final export
声明成立；`verify:manifests`、全量 typecheck/build/published gate 在相应源码与 evidence 完成前预期不可用，
不得把该状态描述为 release-ready。

所有嵌套/搬迁 workspace 同批修正 `package.json` scripts、`bunfig.toml`、`tsconfig*.json` extends/references、
`test/source-policy.test.ts` 允许路径、runtime/integration 脚本 repository root 与 `../../`/`../../../` 深度。
合并 `packages/nats` 时必须原子保留两套既有真实 harness，把冲突的两个 `e2e:docker` script 精确命名为
`e2e:docker:core` 与 `e2e:docker:jetstream`，并同步 `e2e/suites.ts` command；Task 13 characterization 不得因
missing script 丢失任一迁移前 NATS 证据。

NATS 的 11 组同名异内容文件按以下无损映射落位，禁止覆盖或把两份文件直接拼接：

| 旧相对路径 | Core 最终落点 | JetStream 最终落点 |
| --- | --- | --- |
| `src/index.ts` | `src/index.ts` | `src/jetstream.ts` 的 public subpath exports |
| `src/server.ts` | `src/server.ts` | `src/jetstream.ts` 的 JetStream lifecycle implementation |
| `test/e2e/docker-e2e.ts` | `test/e2e/core-docker-e2e.ts` | `test/e2e/jetstream-docker-e2e.ts` |
| `test/lifecycle.test.ts` | `test/core-lifecycle.test.ts` | `test/jetstream-lifecycle.test.ts` |
| `test/package-contract.test.ts` | `test/core-package-contract.test.ts` | `test/jetstream-package-contract.test.ts` |
| `test/public-api.test.ts` | `test/core-public-api.test.ts` | `test/jetstream-public-api.test.ts` |
| `test/public-types.ts` | `test/core-public-types.ts` | `test/jetstream-public-types.ts` |
| `test/source-policy.test.ts` | `test/core-source-policy.test.ts` | `test/jetstream-source-policy.test.ts` |
| `test/upstream-types-repro.ts` | `test/core-upstream-types-repro.ts` | `test/jetstream-upstream-types-repro.ts` |
| `test/smoke/package-smoke.ts` | `test/smoke/core-package-smoke.ts` | `test/smoke/jetstream-package-smoke.ts` |
| `test/coverage-contract.ts` | 合并到唯一 `test/coverage-contract.ts` | 合并到同一文件；expected production inventory 是 Core/JetStream 最终源码并集，保留两边 100% line/function 约束 |

为该映射生成仓库外 `/tmp/likego-nats-merge-map.before.tsv`，记录每个旧文件 SHA-256、最终落点及处置方式。
`package.json#test`/`tsconfig.test.json` 必须包含两组 renamed tests/types/smoke；`test:coverage` 运行合并后的唯一
coverage contract。Task 3 identity gate 额外断言 20 个非-coverage 输入各有且只有一个处置记录（JetStream 的
index/server 两个输入语义合并到一个 public implementation，因此得到 19 个 unique target path）、两套 E2E
command 各指向对应文件、迁移前所有测试名称/断言文本均能在 after-tree review 中追溯，才允许删除两个旧
NATS 目录。

- [ ] **Step 4: 重建路径、references、lockfile 和 manifests**

根 `paths` 覆盖每个公开子路径；每包 `tsconfig.json` 的 relative `rootDir/outDir/references` 在嵌套目录下仍
正确。使用固定 Bun：

```sh
bun install
bun install --frozen-lockfile
```

预期： 两次退出 0；第二次不修改 `bun.lock`。

- [ ] **Step 5: 验证 identity 原子状态**

Run（只执行 identity/link gate）:

```sh
bun run verify:workspace
bun test --isolate --no-orphans scripts/verify-workspace.test.ts
test ! -d adapters
git diff --check
```

预期： 23/23 release package manifest、27/27 workspace identity 与 build reference 精确一致，旧
`adapters` 目录不存在；命令不声称 manifest evidence、类型或行为已通过。

### Task 4：实现 `@likego/transport` 公共契约与 conformance

**文件：**
- 创建/修改： `packages/transport/src/types.ts`
- 创建/修改： `packages/transport/src/options.ts`
- 创建/修改： `packages/transport/src/errors.ts`
- 创建/修改： `packages/transport/src/message.ts`
- 创建/修改： `packages/transport/src/headers.ts`
- 创建/修改： `packages/transport/src/testing.ts`
- 创建/修改： `packages/transport/src/index.ts`
- 创建/修改： `packages/transport/test/options.test.ts`
- 创建/修改： `packages/transport/test/message.test.ts`
- 创建/修改： `packages/transport/test/conformance.test.ts`
- 创建/修改： `packages/transport/test/public-api.test.ts`
- 创建/修改： `packages/transport/test/public-types.ts`
- 创建/修改： `packages/transport/test/negative-types.ts`
- 创建/修改： `packages/transport/test/package-contract.test.ts`
- 创建/修改： `packages/transport/test/source-policy.test.ts`
- 创建/修改： `packages/transport/test/coverage-contract.ts`
- 创建/修改： `packages/transport/test/smoke/package-smoke.ts`
- 创建/修改： `packages/transport/test/runtime/portable-runtime.ts`
- 创建/修改： `packages/transport/package.json`
- 创建/修改： `packages/transport/{capability.json,owner.json,README.md,tsconfig.json,tsconfig.test.json,bunfig.toml,LICENSE}`
- 创建： `packages/testing/src/listener.ts`
- 修改： `packages/testing/src/index.ts`
- 修改： `packages/testing/package.json`
- 创建/修改： `packages/testing/test/listener.test.ts`
- 修改： `packages/testing/test/{public-api,package-contract,source-policy}.test.ts`
- 修改： `packages/testing/test/public-types.ts`
- 修改： `packages/testing/test/smoke/package-smoke.ts`
- 修改： `packages/testing/{capability.json,README.md,tsconfig.json,tsconfig.test.json}`

- [ ] **Step 1: 先写 package-contract 存在性红灯，再写公共类型行为红灯**

`package-contract.test.ts` 先只读取 manifest/源码 inventory，断言 `src/index.ts`、`src/headers.ts` 及最终
export targets 存在；在 Task 3 的 identity-only 状态下它以普通 assertion failure 变红。创建这些真实源码后，
再按下述类型/行为测试取得第二次红灯，不能用 module-not-found 当行为证据。
同一步先为 `@likego/testing/listener` 写 conformance harness 的失败测试，再创建 runner-neutral 实现；它只通过
devDependency 进入 transport/Web 测试图。

Run（existence 红灯）:

```sh
bun test --isolate --no-orphans packages/transport/test/package-contract.test.ts packages/testing/test/package-contract.test.ts
```

预期： 仅因最终 transport/testing source 或 export target 尚不存在而 assertion failure。

按批准规范逐字锁定 `Transport`、`Message`、`Socket`、`Client`、`Listener`、`AcceptHandler`、
`MessageCodec`、`TransportLogger`、`TLSEncodedBytes`、`Option`/`DialOption`/`ListenOption`、
`TLSConfig`、四类稳定错误及 `./headers` 14 个 lowerCamel 常量；签名以规范第 7.3 节补充声明为准。
负向类型 fixture 证明所有 I/O callable 都把 `Context` 作为独立首参，不接受隐藏 option Context。

- [ ] **Step 2: 运行红灯**

执行：

```sh
bun run --cwd packages/transport typecheck
bun run --cwd packages/transport test
bun test --isolate --no-orphans packages/testing/test/listener.test.ts
```

预期： 缺失 options、errors、defensive copy 或 conformance 失败。

- [ ] **Step 3: 实现最小公共包**

functional option 使用 immutable reducer，后者覆盖前者；`options()`/Message/TLS material 都做深度防御性复制；
默认 dial timeout 5,000ms、HTTP/2 buffer 4MiB。`init` 不执行 I/O，第三方结构实现不依赖 private brand。

- [ ] **Step 4: 运行 package 与三 runtime 绿灯**

执行：

```sh
bun run --cwd packages/context build
bun run --cwd packages/core build
bun run --cwd packages/testing typecheck
bun run --cwd packages/testing test:coverage
bun run --cwd packages/testing build
bun run --cwd packages/testing smoke:bun
bun run --cwd packages/testing smoke:node
bun run --cwd packages/testing smoke:deno
bun run --cwd packages/transport typecheck
bun run --cwd packages/transport test:coverage
bun run --cwd packages/transport build
bun run --cwd packages/transport smoke:bun
bun run --cwd packages/transport smoke:node
bun run --cwd packages/transport smoke:deno
```

预期： 全部退出 0，production line/function 100%。

### Task 5：实现 `@likego/transport-http` portable unary client/server

**文件：**
- 创建/修改： `packages/transport/http/src/types.ts`
- 创建/修改： `packages/transport/http/src/options.ts`
- 创建/修改： `packages/transport/http/src/address.ts`
- 创建/修改： `packages/transport/http/src/headers.ts`
- 创建/修改： `packages/transport/http/src/client.ts`
- 创建/修改： `packages/transport/http/src/socket.ts`
- 创建/修改： `packages/transport/http/src/listener.ts`
- 创建/修改： `packages/transport/http/src/transport.ts`
- 创建/修改： `packages/transport/http/src/errors.ts`
- 创建/修改： `packages/transport/http/src/testing.ts`
- 创建/修改： `packages/transport/http/src/index.ts`
- 创建/修改： `packages/transport/http/test/{options,address,client,listener,wire,conformance}.test.ts`
- 创建/修改： `packages/transport/http/test/{public-api,package-contract,source-policy}.test.ts`
- 创建/修改： `packages/transport/http/test/public-types.ts`
- 创建/修改： `packages/transport/http/test/coverage-contract.ts`
- 创建/修改： `packages/transport/http/test/runtime/portable-runtime.ts`
- 创建/修改： `packages/transport/http/test/smoke/package-smoke.ts`
- 创建/修改： `packages/transport/http/package.json`
- 创建/修改： `packages/transport/http/{capability.json,owner.json,README.md,tsconfig.json,tsconfig.test.json,bunfig.toml,LICENSE}`

- [ ] **Step 1: 先写 package-contract 存在性红灯，再写 HTTP host SPI 与 unary wire 红灯**

先由 package-contract 对 `src/index.ts`、`src/types.ts`、`src/transport.ts` 的缺失产生 assertion failure；
创建最小真实模块后，再导入并锁定以下行为。

Run（existence 红灯）:

```sh
bun test --isolate --no-orphans packages/transport/http/test/package-contract.test.ts
```

预期： 仅因最终 transport-http source 或 export target 尚不存在而 assertion failure。

锁定 `HTTPHost` 两阶段 `bind → serve/ready`、`HTTPHostHandle`、`HTTPServeHandle`、
`HTTPHostCapabilities`、`HTTPTransport`、`HTTPListener.accepted`、borrowed `HTTPExecutor`、
`executor(value)` 和 `newHTTPTransport`。fake host 测试：capability admission 在网络副作用前完成，
根入口不解析 Node 模块；constructor 只接收 HTTP-specific executor，common `Option` 只通过 `init` 应用。

- [ ] **Step 2: 写 client FIFO/Context 红灯**

覆盖 send invocation-order FIFO、recv-before-send、单 active recv、provisional slot、同一 Error identity、
后续 send 恢复、200/非 200 `HTTPStatusError` 64KiB defensive accessor、hop-by-hop header 拒绝、
Context/timeout/close cleanup、
防御性复制和真实 Fetch 请求内容。额外使用真实标准 `ReadableStream` 锁定：非 200 truncation 的
underlying-source `cancel()` 同步调用 `client.close(background())` 并返回同一 owner Promise 时，recv 与 owner
有界结算且 cancel exactly once；同一约束覆盖 200 active-reader cleanup，并明确标准 Promise assimilation 产生
不等同于 owner 的包装 Promise 时仍只切断同步 owner-reentry 边，而非重入 pending cleanup 仍由 owner 真实等待。
Client 200、非 200 status 与 server POST 的每个 chunk 必须是 `Uint8Array`；错误 chunk、read/result getter，
以及 detached/out-of-bounds `Uint8Array` 的防御性复制失败，都统一产生保留原 Error cause exact identity 的
`TransportProtocolError`。

- [ ] **Step 3: 写 listener/arbiter 红灯**

覆盖 listen bind/actual addr、one-shot accept、accepted identity、ready/serve.done/host.done 真值表、handler 隔离、
正常 close、accept Context 取消、primary/secondary Error 顺序和稳定状态错误。增加同步 admission 窗口的
cancel→serve throw、cancel→invalid serve handle 与 close→serve throw：每个 borrowed serve/handle 边界后先复核
Context/mode，Context 先发生时 `accept()`/`accepted()` 共享同一 identity，后到 failure 只作为 secondary，host
close 与 terminal owner exactly once。再覆盖 `ready()` 内部 cancel→ready throw 与 close→ready throw：
canceled/closed 保持 admission 主语义，ready failure 在同步栈内进入 terminal secondary，底层 close exactly once，
terminal owner identity 稳定且不得因延迟一个 microtask 而丢失失败。

- [ ] **Step 4: 运行红灯**

执行：

```sh
bun test --isolate --no-orphans packages/transport/http/test/*.test.ts
```

预期： 缺失 factory、wire、slot 或 terminal arbiter 行为失败。

- [ ] **Step 5: 实现 portable unary transport**

严格按批准规范实现；`withStream`、自定义 Fetch TLS material、insecure skip verify、无法兑现的 connection-close
和显式 H2 buffer 在任何网络副作用前抛 unsupported。server 对外 500 不泄露内部 Error 文本。

- [ ] **Step 6: 三 runtime 绿灯**

执行：

```sh
bun run --cwd packages/context build
bun run --cwd packages/core build
bun run --cwd packages/testing build
bun run --cwd packages/transport build
bun run --cwd packages/transport/http typecheck
bun run --cwd packages/transport/http test:coverage
bun run --cwd packages/transport/http build
bun run --cwd packages/transport/http smoke:bun
bun run --cwd packages/transport/http smoke:node
bun run --cwd packages/transport/http smoke:deno
```

预期： portable exports 全部通过，line/function 100%。

三 runtime smoke 必须实际运行上述标准 ReadableStream owner-cycle、三类 byte-chunk validation 与结构式 HTTPHost
admission cancellation；Bun、Node、Deno 都要有有界结算、`unhandled=0`、Context/Error identity 与 cleanup
exactly-once 证据，不能只复用 Bun 单元测试结果。

### Task 6：实现 HTTP lifecycle Server 与真实 Node host

**文件：**
- 创建/修改： `packages/transport/http/src/server.ts`
- 创建/修改： `packages/transport/http/src/node.ts`
- 创建/修改： `packages/transport/http/src/node-host.ts`
- 修改： `packages/transport/http/src/index.ts`
- 修改： `packages/transport/http/src/errors.ts`
- 创建/修改： `packages/transport/http/test/server.test.ts`
- 创建/修改： `packages/transport/http/test/node-host.test.ts`
- 创建/修改： `packages/transport/http/test/loopback.test.ts`
- 创建/修改： `packages/transport/http/test/e2e/node-e2e.ts`
- 修改： `packages/transport/http/test/{package-contract,public-api,source-policy}.test.ts`
- 修改： `packages/transport/http/test/public-types.ts`
- 修改： `packages/transport/http/package.json`
- 修改： `packages/transport/http/{capability.json,owner.json,README.md}`
- 修改： `packages/testing/src/listener.ts`
- 创建： `e2e/cases/transport-http-unary-loopback.case.ts`
- 创建： `e2e/cases/transport-http-graceful-drain.case.ts`
- 创建： `e2e/cases/transport-http-hard-force.case.ts`
- 创建： `e2e/cases/transport-http-passive-failure.case.ts`
- 修改： `e2e/case.ts`
- 修改： `e2e/contracts.ts`
- 修改： `e2e/validate.ts`
- 修改： `e2e/e2e.test.ts`
- 修改： `e2e/suites.test.ts`
- 修改： `e2e/suites.ts`

- [ ] **Step 1: 先写 Node/server package-contract 存在性红灯**

先修改 package-contract，断言最终 `./node` export target 以及 `src/server.ts`、`src/node.ts`、
`src/node-host.ts` 存在，运行该单测并观察普通 assertion failure。随后只创建可加载的类型、option/error 声明与
模块边界，不创建网络副作用或伪造成功的 factory；后续行为测试使用 namespace import 先断言 factory/API
存在，因此红灯不得是 module-not-found、missing named export 或语法错误。

执行：

```sh
bun test --isolate --no-orphans packages/transport/http/test/package-contract.test.ts
```

预期： 仅因最终 Node/server 源文件或 export target 尚不存在而 assertion failure。

- [ ] **Step 2: 写 lifecycle 红灯**

锁定 `newHTTPServer(host, handler, ...options)`、`newNodeHTTPServer`、`address`、`transport`、
`hardDrainTimeout`、`HTTPServerDrainTimeoutError` 和 `HTTPTransportUnexpectedExitError`。测试 start one-shot、
bind 后 ready 前 rollback、startup Context 与长期 owner Context 分离、stable `address/done`。
manifest 同时锁定 root 的 `http-client/http-listener/http-server` 与 `./node` 的
`http-server/node-http-host` owner resource IDs。

- [ ] **Step 3: 写 drain/terminal 红灯**

覆盖 graceful in-flight、caller-scoped stop、第二 stop join、25s owner timeout 与 30s Core budget、force capability、
无 force orphan、passive failure、late failure ledger、端口释放与 borrowed transport/host 不被误关。

- [ ] **Step 4: 写 sourced E2E inventory/proof-contract 红灯**

增加 release-blocking `transport-http-node` suite 与四个 sourced case，scenario ID 分别为
`unary-loopback`、`graceful-drain`、`hard-force-cleanup`、`passive-host-failure`。来源只使用当前核验的
micro/go-micro Transport/HTTP、MDN Fetch 与 Node HTTP 官方页面；`e2e/validate.ts` 保留 2026-07-18 既有证据并
允许 2026-07-19 新证据，GitHub allowlist 只新增 `/micro/go-micro/` 精确前缀。
`E2eDomain` 与 required-domain gate 新增独立 `transport`，四个 case 不得塞入外部 `web` 域。

先加入 suite/cases 但不加入 proof contract，然后运行：

```sh
bun test --isolate --no-orphans e2e/e2e.test.ts e2e/suites.test.ts
```

预期： `transport-http-node has no release evidence/service/cleanup contract` 的普通 assertion failure；不得通过
删除 releaseBlocking、case 或 validation 来变绿。随后再加入精确 proof contract，逐项约束四个 scenario、
standard Fetch/Node HTTP/LikeGo Transport 服务版本，以及 terminal、socket、port、process-tree cleanup。

- [ ] **Step 5: 运行行为红灯**

执行：

```sh
bun test --isolate --no-orphans packages/transport/http/test/server.test.ts packages/transport/http/test/node-host.test.ts packages/transport/http/test/loopback.test.ts
```

预期： namespace API 存在性、lifecycle 或 terminal assertion failure；不得用 module-not-found、missing named
export 或语法错误充当红灯。

- [ ] **Step 6: 实现 Node host 与 Core Server**

Node host 只实现 HTTP transport envelope 与 socket ownership，不依赖 `@likego/web`。Server 从 start 同一 turn
观察 accept Promise，等待 `accepted` 后返回；timeout 不伪造 `done`。

- [ ] **Step 7: 真实 loopback 与 package 绿灯**

执行：

```sh
bun run --cwd packages/context build
bun run --cwd packages/core build
bun run --cwd packages/testing typecheck
bun run --cwd packages/testing test:coverage
bun run --cwd packages/testing build
bun run --cwd packages/testing smoke:bun
bun run --cwd packages/testing smoke:node
bun run --cwd packages/testing smoke:deno
bun run --cwd packages/transport build
bun run --cwd packages/transport/http typecheck
bun run --cwd packages/transport/http test:coverage
bun run --cwd packages/transport/http build
bun run --cwd packages/transport/http e2e:node
bun run test:e2e:inventory
bun e2e/run.ts --suite transport-http-node
```

预期： client→listener→handler→response 真实 TCP loopback 通过，端口和 socket 全部清理。

### Task 7：扩展 `@likego/registry` 公共 Registry 与 conformance

> 本任务记录早期实现步骤，Registry 公共体验已由
> [`../specs/2026-07-19-likego-package-transport-web-design.md`](../specs/2026-07-19-likego-package-transport-web-design.md)
> 第 9 节的替代说明和当前包 README 接管。

**文件：**
- 重写： `packages/registry/src/types.ts`
- 重写： `packages/registry/src/errors.ts`
- 创建： `packages/registry/src/options.ts`
- 创建： `packages/registry/src/canonical.ts`
- 重写： `packages/registry/src/registration.ts`
- 重写： `packages/registry/src/discovery.ts`
- 修改： `packages/registry/src/selector.ts`
- 修改： `packages/registry/src/snapshot.ts`
- 创建： `packages/registry/src/testing.ts`
- 重写： `packages/registry/src/index.ts`
- 重写/新增： `packages/registry/test/{options,canonical,registration,discovery,conformance}.test.ts`
- 修改/新增： `packages/registry/test/{public-api,package-contract,source-policy}.test.ts`
- 修改： `packages/registry/test/public-types.ts`
- 修改： `packages/registry/test/coverage-contract.ts`
- 修改： `packages/registry/package.json`
- 修改： `packages/registry/{capability.json,owner.json,README.md,tsconfig.json,tsconfig.test.json}`

- [ ] **Step 1: 写公共契约红灯**

逐字锁定 `Value/Endpoint/Node/Service/Result/Watcher/RegistrationHandle/Registry/Registrar`、六组 immutable
option、`RegistryCapabilities`、`registration`、`ServiceInstanceResolver` 和 `discovery`。负向类型 fixture
证明旧 `ServiceInstance` registrar、`RegistrationOptions`、`ServiceInstanceSource` 不再可用。

- [ ] **Step 2: 写 canonical/hash/ownership 红灯**

固定 Unicode code-point sort、service-content/identity-content/identity 三种 preimage 与 SHA-256 Base32 vector；
测试单 Node Result、content conflict fail-closed、duplicate publisher refcount、watch overflow terminal、immutable
snapshot、caller Context 与 owner Context 分离。

- [ ] **Step 3: 运行红灯**

执行：

```sh
bun run --cwd packages/registry typecheck
bun run --cwd packages/registry test
```

预期： 旧 registrar 类型、缺 Registry/Watcher/options/hash 行为导致失败。

- [ ] **Step 4: 实现公共 Registry 与 provider-neutral conformance**

`./testing` 接收 capability snapshot 参数化 common suite；`listServices` 只保证 name；`discovery` 必须显式
resolver，watch-first/get/reconcile/resync 不虚构 linearizability。

- [ ] **Step 5: 三 runtime 绿灯**

执行：

```sh
bun run --cwd packages/context build
bun run --cwd packages/core build
bun run --cwd packages/registry typecheck
bun run --cwd packages/registry test:coverage
bun run --cwd packages/registry build
bun run --cwd packages/registry smoke:bun
bun run --cwd packages/registry smoke:node
bun run --cwd packages/registry smoke:deno
```

预期： 全部退出 0，line/function 100%。

### Task 8：迁移并收敛 `@likego/registry-consul`

**文件：**
- 重写/修改： `packages/registry/consul/src/{types,options,codec,http,runtime,registration,discovery,errors,index}.ts`
- 重写/新增： `packages/registry/consul/test/{construction,registration,discovery,runtime,conformance}.test.ts`
- 修改/新增： `packages/registry/consul/test/{public-api,package-contract,source-policy}.test.ts`
- 修改： `packages/registry/consul/test/public-types.ts`
- 修改： `packages/registry/consul/test/coverage-contract.ts`
- 重写： `packages/registry/consul/test/integration/consul-docker.ts`
- 修改： `packages/registry/consul/test/integration/{published-behavior,published-runtime,ttl-crash-child}.ts`
- 修改： `packages/registry/consul/package.json`
- 修改： `packages/registry/consul/{capability.json,owner.json,README.md,tsconfig.json,tsconfig.test.json}`
- 修改： `e2e/suites.ts`

- [ ] **Step 1: 写新 constructor/token 契约红灯**

锁定唯一 `newConsulRegistry(options)`；common `init(addresses())` 只接受一个 HTTP(S) origin。测试每次 register
生成独立 `lr-` 256-bit token、远端 exact ID、secret-safe token、完整 payload/hash/chunk 校验。

- [ ] **Step 2: 写 generation/rollback/watch 红灯**

覆盖同 identity 两 handle 逆序 stop、最新 token 生效/旧 token 恢复、多 Node 排序 acquire 与逆序 rollback、
lost-response readback、passing get、catalog list、blocking index、coalesce/update/delete、overflow/terminal。

- [ ] **Step 3: 运行红灯**

执行：

```sh
bun test --isolate --no-orphans packages/registry/consul/test/*.test.ts
```

预期： 旧 ServiceInstance provider 不符合新 Registry conformance。

- [ ] **Step 4: 运行真实 Consul 协议红灯**

先把 `consul-docker.ts` 改为新 Registry/token/generation/watch 断言，再运行：
unit 红灯确认后，只做让新 test harness 可加载所需的 type/import 边界修正，不实现 provider 行为；重跑 unit 仍须
保持目标行为红灯。随后按 closure 构建已完成的依赖并执行真实协议红灯：

```sh
bun run --cwd packages/context build
bun run --cwd packages/core build
bun run --cwd packages/registry build
bun run --cwd packages/registry/consul test:docker
```

预期： Consul 容器真实启动，至少一个新协议/所有权 assertion failure，finally 清除双实例、ACL token、
registration、heartbeat child 与网络；镜像失败、端口冲突或残留资源不能充当红灯。

- [ ] **Step 5: 实现标准 Fetch provider**

不引入 Node Consul SDK；borrowed fetch/address/TLS owner 不被关闭。所有 mutation 前完成 common/provider validation，
heartbeat failure 与 handle `done` 真实绑定。

- [ ] **Step 6: 单元、发布和真实 Consul Docker**

执行：

```sh
bun run --cwd packages/context build
bun run --cwd packages/core build
bun run --cwd packages/registry build
bun run --cwd packages/registry/consul typecheck
bun run --cwd packages/registry/consul test:coverage
bun run --cwd packages/registry/consul build
bun run --cwd packages/registry/consul test:runtime
bun run --cwd packages/registry/consul test:docker
bun run test:e2e:inventory
bun e2e/run.ts --suite registry-consul-docker
```

预期： Consul 2.0.2 的 register/get/catalog/passing-watch/TTL/ACL/restart/partial rollback 全部真实通过，
容器、请求、timer、handle 清零。

### Task 9：实现 `@likego/registry-mdns` portable codec/provider

**文件：**
- 创建/修改： `packages/registry/mdns/src/types.ts`
- 创建/修改： `packages/registry/mdns/src/options.ts`
- 创建/修改： `packages/registry/mdns/src/errors.ts`
- 创建/修改： `packages/registry/mdns/src/base32.ts`
- 创建/修改： `packages/registry/mdns/src/canonical.ts`
- 创建/修改： `packages/registry/mdns/src/dns.ts`
- 创建/修改： `packages/registry/mdns/src/codec.ts`
- 创建/修改： `packages/registry/mdns/src/cache.ts`
- 创建/修改： `packages/registry/mdns/src/registration.ts`
- 创建/修改： `packages/registry/mdns/src/watcher.ts`
- 创建/修改： `packages/registry/mdns/src/registry.ts`
- 创建/修改： `packages/registry/mdns/src/testing.ts`
- 创建/修改： `packages/registry/mdns/src/index.ts`
- 创建/修改： `packages/registry/mdns/test/{options,dns,codec,cache,registration,watcher,conformance}.test.ts`
- 创建/修改： `packages/registry/mdns/test/{public-api,package-contract,source-policy}.test.ts`
- 创建/修改： `packages/registry/mdns/test/public-types.ts`
- 创建/修改： `packages/registry/mdns/test/coverage-contract.ts`
- 创建/修改： `packages/registry/mdns/test/runtime/portable-runtime.ts`
- 创建/修改： `packages/registry/mdns/test/smoke/package-smoke.ts`
- 创建/修改： `packages/registry/mdns/package.json`
- 创建/修改： `packages/registry/mdns/{capability.json,owner.json,README.md,tsconfig.json,tsconfig.test.json,bunfig.toml,LICENSE}`

- [ ] **Step 1: 先写 package-contract 存在性红灯，再写 host/options/DNS wire 红灯**

先对最终 source/export inventory 取得普通断言红灯；创建真实类型/入口文件后，再运行 DNS 与 option 行为红灯。

Run（existence 红灯）:

```sh
bun test --isolate --no-orphans packages/registry/mdns/test/package-contract.test.ts
```

预期： 仅因最终 mDNS portable source 或 export target 尚不存在而 assertion failure。

锁定批准规范中的 `MDNSHost`/datagram/membership/interface/options 与默认值。用 fixed vectors 覆盖 service/identity/
host label、owner/target、DNS 63/255 byte 边界、RR shared/unique cache-flush 和全套 `Likego-*` TXT。

- [ ] **Step 2: 写 codec 安全红灯**

覆盖 canonical UTF-8 JSON、deflate+base64url、255-byte TXT chunk、1,200-byte packet、65,536-byte decode ceiling、
缺/重 chunk、unknown version/encoding、hash mismatch、cycle、Value depth/node total 上限。

- [ ] **Step 3: 写 provider 状态机红灯**

fake host/clock 覆盖 register token stack、current restore、multi-node rollback、probe collision、announce/refresh、
TTL0/goodbye rescue、crash expiry、query cleanup、watch overflow、malformed foreign packet 忽略与 managed
conflict terminal。

- [ ] **Step 4: 运行红灯**

执行：

```sh
bun test --isolate --no-orphans packages/registry/mdns/test/*.test.ts
```

预期： codec/provider 未实现导致行为失败。

- [ ] **Step 5: 实现 portable provider**

production graph 只使用标准 Web API；不引入 `multicast-dns`、`dns-packet` 或 `node:`。一个 family/interface
一个 injected datagram socket，TTL/cache/watch/packet 逻辑只实现一次。

- [ ] **Step 6: 三 runtime portable 绿灯**

执行：

```sh
bun run --cwd packages/context build
bun run --cwd packages/core build
bun run --cwd packages/registry build
bun run --cwd packages/registry/mdns typecheck
bun run --cwd packages/registry/mdns test:coverage
bun run --cwd packages/registry/mdns build
bun run --cwd packages/registry/mdns smoke:bun
bun run --cwd packages/registry/mdns smoke:node
bun run --cwd packages/registry/mdns smoke:deno
```

预期： 根与 `./testing` portable graph 通过，line/function 100%。

### Task 10：实现 mDNS Node host 与双容器真实门禁

**文件：**
- 创建/修改： `packages/registry/mdns/src/node.ts`
- 创建/修改： `packages/registry/mdns/src/node-host.ts`
- 创建/修改： `packages/registry/mdns/test/node-host.test.ts`
- 创建/修改： `packages/registry/mdns/test/e2e/publisher.ts`
- 创建/修改： `packages/registry/mdns/test/e2e/observer.ts`
- 创建/修改： `packages/registry/mdns/test/e2e/docker-e2e.ts`
- 创建/修改： `packages/registry/mdns/test/e2e/packet-capture.ts`
- 创建/修改： `packages/registry/mdns/test/e2e/compose.ipv4.yaml`
- 创建/修改： `packages/registry/mdns/test/e2e/compose.ipv6.yaml`
- 修改： `packages/registry/mdns/test/{package-contract,public-api,source-policy}.test.ts`
- 修改： `packages/registry/mdns/test/public-types.ts`
- 修改： `packages/registry/mdns/package.json`
- 修改： `packages/registry/mdns/{capability.json,owner.json,README.md}`
- 创建： `e2e/cases/registry-mdns-register-discover.case.ts`
- 创建： `e2e/cases/registry-mdns-watch-update-delete.case.ts`
- 创建： `e2e/cases/registry-mdns-crash-expiry.case.ts`
- 创建： `e2e/cases/registry-mdns-collision-rescue.case.ts`
- 创建： `e2e/cases/registry-mdns-wire-cleanup.case.ts`
- 修改： `e2e/contracts.ts`
- 修改： `e2e/validate.ts`
- 修改： `e2e/e2e.test.ts`
- 修改： `e2e/suites.test.ts`
- 修改： `e2e/suites.ts`

- [ ] **Step 1: 先写 Node package-contract 存在性红灯**

先修改 package-contract，断言最终 `./node` export target、`src/node.ts` 与 `src/node-host.ts` 存在，运行该单测
并观察普通 assertion failure。随后只创建可加载的 Node host 类型/option/error 与模块边界，不绑定 socket、
不发送数据包，也不创建假成功 factory；后续行为测试使用 namespace import 先断言 factory/API 存在，保证
红灯不是 module-not-found、missing named export 或语法错误。

执行：

```sh
bun test --isolate --no-orphans packages/registry/mdns/test/package-contract.test.ts
```

预期： 仅因最终 Node 源文件或 export target 尚不存在而 assertion failure。

- [ ] **Step 2: 写 Node datagram conformance 红灯**

覆盖 interface enumeration、`0.0.0.0`/`::` wildcard bind、独立 interface address/id、`reuseAddr` 且不硬依赖
`reusePort`、multicast IP TTL 255、join/leave、loopback、send/receive、caller Context、passive socket error、
idempotent close/stable done 和 fd/`/proc/net/udp*` 清理。

- [ ] **Step 3: 写双容器场景红灯**

publisher/observer 使用自定义 Docker bridge 和独立进程，测试 register→get/list、完整 metadata/Endpoint/Value、
watch create/update、逆序 stop restore、delete、domain 隔离、collision、cooperating responder rescue。

- [ ] **Step 4: 写 crash/packet 红灯**

先观察 ttl=2s cache，再真实 `docker kill -KILL` publisher；断言 expiry delete。抓包断言 RR owner/target、
TTL/cache-flush/TTL0、`Likego-Wire-Version=1` 且不存在旧 namespace。

- [ ] **Step 5: 写 sourced E2E inventory/proof-contract 红灯**

增加 release-blocking `registry-mdns-docker` suite 与五个 sourced case，scenario ID 分别为
`register-discover`、`watch-update-delete`、`crash-expiry`、`collision-rescue`、`wire-cleanup`。来源使用
RFC 6762/6763 的 RFC Editor 页面与 Node dgram 官方文档；allowlist 只新增 `www.rfc-editor.org`，retrievedAt
使用已批准的 2026-07-19 新证据日期。

先加入 suite/cases 但不加入 proof contract，然后运行：

```sh
bun test --isolate --no-orphans e2e/e2e.test.ts e2e/suites.test.ts
```

预期： `registry-mdns-docker has no release evidence/service/cleanup contract` 的普通 assertion failure。随后加入
精确 proof contract，约束五个 scenario、mDNS IPv4 multicast/Docker/Node UDP 服务证据，以及 stopped observer、
fd、udp/udp6、container、network、process-tree cleanup；IPv6 unsupported 只能作为明确证据，不能冒充通过。

- [ ] **Step 6: 运行 Node/Docker 行为红灯**

执行：

```sh
bun test --isolate --no-orphans packages/registry/mdns/test/node-host.test.ts
bun run --cwd packages/registry/mdns test:docker
```

预期： namespace API 存在性、Node host 或真实双容器行为尚未实现，至少一个针对性 assertion failure；
Docker harness 必须能启动并在失败后清理，不能用 module-not-found、missing named export、镜像拉取失败或
残留容器充当红灯。

- [ ] **Step 7: 实现 `newNodeMDNSHost`**

只使用 `node:dgram` 和 `node:os`；Node host 不拥有 DNS codec、cache 或 watcher diff。socket 绑定 wildcard，
outbound interface 与 membership 使用独立的 interface address/id；设置 multicast IP TTL 255，且不得要求
macOS Node 不支持的 UDP `reusePort`。

- [ ] **Step 8: 运行真实门禁并清理**

执行：

```sh
bun run --cwd packages/context build
bun run --cwd packages/core build
bun run --cwd packages/registry build
bun run --cwd packages/registry/mdns typecheck
bun run --cwd packages/registry/mdns test:coverage
bun run --cwd packages/registry/mdns build
bun run --cwd packages/registry/mdns test:docker
bun run test:e2e:inventory
bun e2e/run.ts --suite registry-mdns-docker
docker ps -a --filter label=likego.suite=registry-mdns
docker network ls --filter label=likego.suite=registry-mdns
```

预期： IPv4 multicast 硬门禁通过，抓包确认 IP TTL 255 与 DNS RR TTL120/TTL0 分层正确；stopped observer 明确不再收包，`/proc/1/fd`、
`/proc/net/udp`/`udp6` 证明 socket 已关闭，最后两条无残留。IPv6 使用启用 IPv6 的独立 network；若宿主
不支持，必须输出明确 unsupported 证据，不得计入通过。

### Task 11：完成 `@likego/web`、health、Prometheus 与框架接缝

**文件：**
- 重写/修改： `packages/web/src/index.ts`
- 创建/修改： `packages/web/src/context.ts`
- 创建/修改： `packages/web/src/health.ts`
- 创建/修改： `packages/web/src/node.ts`
- 创建/修改： `packages/web/src/node-server.ts`
- 创建/修改： `packages/web/src/node-testing.ts`
- 创建/修改： `packages/web/test/runtime/portable-runtime.ts`
- 创建/修改： `packages/web/test/smoke/package-smoke.ts`
- 修改： `packages/web/test/context-handler-*.test.ts`（Task 3 已从旧 Fetch 测试迁入）
- 修改： `packages/web/test/node/*.test.ts`（Task 3 已从旧 fetch-node 测试迁入）
- 修改： `packages/web/test/e2e/native-e2e.ts`（Task 3 已迁入）
- 修改： `packages/health/src/index.ts`
- 迁移后删除： `packages/health/src/fetch.ts`
- 修改： `packages/health/test/*`
- 重写/修改： `packages/prometheus/src/index.ts`
- 修改： `packages/prometheus/test/*`
- 创建/修改： `packages/hono/src/index.ts`
- 创建/修改： `packages/hono/test/handler.test.ts`
- 创建/修改： `packages/h3/src/index.ts`
- 创建/修改： `packages/h3/test/handler.test.ts`
- 创建/修改： `packages/elysia/src/index.ts`
- 创建/修改： `packages/elysia/test/handler.test.ts`
- 创建/修改： `packages/{hono,h3,elysia}/test/{package-contract,public-api,source-policy}.test.ts`
- 创建/修改： `packages/{hono,h3,elysia}/test/public-types.ts`
- 创建/修改： `packages/{hono,h3,elysia}/test/coverage-contract.ts`
- 修改： `packages/{web,hono,h3,elysia,prometheus}/package.json`
- 修改： `packages/{web,hono,h3,elysia,prometheus}/{capability.json,owner.json,README.md,tsconfig.json,tsconfig.test.json}`
- 修改： `e2e/scripts/web-framework-native.ts`
- 修改： `e2e/cases/fetch-node-*.case.ts`（保留 53-case baseline ID，只迁 suite/表述）
- 修改： `e2e/contracts.ts`
- 修改： `e2e/suites.ts`

- [ ] **Step 1: 写 Web 根入口红灯**

锁定 `Handler`、`ContextHandler`、`ContextHandlerOptions`、`contextHandler`；保留 abort/timeout、同步/异步
Response identity、Error identity 和 cleanup，不导出旧 `FetchHandler/toFetchHandler`。

- [ ] **Step 2: 写 health/Prometheus 红灯**

`@likego/health` 不再导出 HTTP；`@likego/web/health` 保留 GET/HEAD、200/503、404、405/Allow、no-store、
脱敏和取消；`@likego/prometheus` 返回 Web `Handler`，不依赖 Node 子路径。

- [ ] **Step 3: 先写 framework package-contract 存在性红灯，再写 Node/framework 行为红灯**

Hono/H3/Elysia 的 package-contract 先断言各 `src/index.ts` 与最终 export target 存在并以 assertion failure
变红；先单独运行这些 package-contract，再创建仅含可加载类型/模块边界的真实入口。native app 行为测试使用
namespace import 先断言 factory 存在，保证第二次红灯是 API/行为 assertion failure，而不是 module-not-found、
missing named export 或语法错误。Web Node 使用 Task 3 已迁入的最终路径，不再引用已删除的 `packages/fetch` 或
`adapters/fetch-node`。

`newNodeServer` 继续真实 listener lifecycle；`newHonoHandler/newH3Handler/newElysiaHandler` 只做稳定绑定，
保持 this/Response/stream/Error identity，不重导出 router/middleware。Node ABI 精确锁定 `NodeAddress`、
`NodeServerOptions`、`hostname`、`port`、`hardDrainTimeout` 和三个 `NodeServer*Error`；health 精确锁定
`HealthHandlerOptions/createHealthHandler`，不发布旧 Fetch 名 alias。
原 `fetch-node-native` suite 原子改名为 `web-node-native`：迁入的 native E2E 使用 `@likego/web/node`、
`newNodeServer` 与 `LIKEGO_WEB_NODE_E2E_RESULT`；同步更新 suite parser、proof contract 和既有 sourced case 的
suite/中性表述，但保留 Task 1 已冻结的 case ID，不发布旧 API/marker/package alias。

Run（framework existence 红灯）:

```sh
bun test --isolate --no-orphans packages/hono/test/package-contract.test.ts packages/h3/test/package-contract.test.ts packages/elysia/test/package-contract.test.ts
```

预期： 仅因最终 framework 源文件或 export target 尚不存在而 assertion failure。

- [ ] **Step 4: 运行红灯**

执行：

```sh
bun test --isolate --no-orphans packages/web/test packages/health/test packages/hono/test packages/h3/test packages/elysia/test packages/prometheus/test
```

预期： 旧 fetch 名称、health 位置或框架 package 未实现导致失败。

- [ ] **Step 5: 实现与真实 listener 绿灯**

把 `e2e/scripts/web-framework-native.ts` 改为从本任务已构建的最终 `@likego/web`、`@likego/hono`、
`@likego/h3`、`@likego/elysia` package export 加载，并在 helper 内创建最小 native app 后启动真实 listener；
不得读取 `examples/*/dist`，因为 examples 属于 Task 14，不能成为本任务的隐式前置。

执行：

```sh
bun run --cwd packages/context build
bun run --cwd packages/core build
bun run --cwd packages/testing build
bun run --cwd packages/health typecheck
bun run --cwd packages/health test:coverage
bun run --cwd packages/health build
bun run --cwd packages/web typecheck
bun run --cwd packages/web test:coverage
bun run --cwd packages/web build
bun run --cwd packages/web smoke:bun
bun run --cwd packages/web smoke:node
bun run --cwd packages/web smoke:deno
bun run --cwd packages/hono typecheck
bun run --cwd packages/hono test:coverage
bun run --cwd packages/hono build
bun run --cwd packages/h3 typecheck
bun run --cwd packages/h3 test:coverage
bun run --cwd packages/h3 build
bun run --cwd packages/elysia typecheck
bun run --cwd packages/elysia test:coverage
bun run --cwd packages/elysia build
bun run --cwd packages/prometheus typecheck
bun run --cwd packages/prometheus test:coverage
bun run --cwd packages/prometheus build
node e2e/scripts/web-framework-native.ts vanilla
node e2e/scripts/web-framework-native.ts hono
node e2e/scripts/web-framework-native.ts h3
node e2e/scripts/web-framework-native.ts elysia
bun run test:e2e:inventory
bun e2e/run.ts --suite vanilla-node --suite hono-node --suite h3-node --suite elysia-node --suite web-node-native --suite prometheus-runtime
```

预期： 四种真实 listener 全部退出 0，根 portable export 在 Bun/Node/Deno 加载。

### Task 12：迁移 Config providers、Croner 与 BullMQ 原生生命周期包

**文件：**
- 修改： `packages/config/src/{index,env,file}.ts`
- 修改/新增： `packages/config/test/{env,file,package-contract,public-api,source-policy}.test.ts`
- 修改： `packages/config/test/public-types.ts`
- 修改： `packages/config/{package.json,capability.json,owner.json,README.md,tsconfig.json,tsconfig.test.json}`
- 修改： `packages/config/consul/src/index.ts`
- 修改： `packages/config/consul/test/*`
- 修改： `packages/config/consul/{package.json,capability.json,owner.json,README.md,tsconfig.json,tsconfig.test.json}`
- 仅审查/按已审计差异修改： `packages/croner/src/{types,errors,server,index}.ts`
- 仅审查/按已审计差异修改： `packages/croner/test/*`
- 修改： `packages/croner/{package.json,capability.json,owner.json,README.md,tsconfig.json,tsconfig.test.json}`
- 仅审查/按已审计差异修改： `packages/bullmq/src/{types,errors,server,testing,index}.ts`
- 仅审查/按已审计差异修改： `packages/bullmq/test/*`
- 修改： `packages/bullmq/{package.json,capability.json,owner.json,README.md,tsconfig.json,tsconfig.test.json}`
- 修改： `e2e/suites.ts`
- 修改： `test/published/cases/node-services.ts`

- [ ] **Step 1: 运行迁移后的 characterization baseline**

这些包的迁移前实现已经覆盖 Config env/file、Consul blocking watch、Croner native factory 与 BullMQ 官方
`Worker({ autorun: false })` 生命周期。Task 3 只允许 identity-preserving 移动，因此先构建 fresh closure 并运行
现有 unit/runtime/真实服务证据：

```sh
bun run --cwd packages/context build
bun run --cwd packages/core build
bun run --cwd packages/config build
bun run --cwd packages/config/consul build
bun run --cwd packages/croner build
bun run --cwd packages/bullmq build
bun test --isolate --no-orphans packages/config/test packages/config/consul/test packages/croner/test packages/bullmq/test
bun run --cwd packages/config/consul test:runtime
bun run --cwd packages/config/consul test:docker
bun run --cwd packages/croner e2e:node
bun run --cwd packages/bullmq e2e:docker
bun run test:e2e:inventory
bun e2e/run.ts --suite config-consul-docker --suite cron-native --suite bullmq-docker
```

预期： 所有迁移前已证明行为保持绿；若失败是路径、package name、dist 或 suite 接线错误，回到 Task 3 修复并
重新建立 baseline，不得把迁移破损误称为产品行为红灯。

- [ ] **Step 2: 审计剩余契约 delta，并只对真实 delta 写红灯**

逐项比对：`@likego/config` 的 `.`/`./env`/`./file`、`@likego/config-consul` borrowed Fetch 与 runtime matrix、
Croner native factory/resume/stop、BullMQ application-owned Worker/start factory、无 Queue/Job/processor facade，
以及最终 owner/exports/package identity。把每项标为 `already-covered` 或 `missing-delta`。

对 `already-covered` 保留 characterization 测试与实现；对每个 `missing-delta` 先增加最小 unit 或真实
Consul/Redis/native assertion，独立运行并观察目标 assertion failure，再实现。若全部 already-covered，记录
`no behavior delta`，不得为了 TDD 改坏实现或测试来制造失败。

- [ ] **Step 3: 只实现审计证明的最小 delta，并验证真实 Consul/Redis**

执行：

```sh
bun run --cwd packages/context build
bun run --cwd packages/core build
bun run --cwd packages/config typecheck
bun run --cwd packages/config test:coverage
bun run --cwd packages/config build
bun run --cwd packages/config/consul typecheck
bun run --cwd packages/config/consul test:coverage
bun run --cwd packages/config/consul build
bun run --cwd packages/config/consul test:runtime
bun run --cwd packages/config/consul test:docker
bun run --cwd packages/croner typecheck
bun run --cwd packages/croner test:coverage
bun run --cwd packages/croner build
bun run --cwd packages/croner e2e:node
bun run --cwd packages/bullmq typecheck
bun run --cwd packages/bullmq test:coverage
bun run --cwd packages/bullmq build
bun run --cwd packages/bullmq e2e:docker
bun run test:e2e:inventory
bun e2e/run.ts --suite config-consul-docker
bun e2e/run.ts --suite cron-native
bun e2e/run.ts --suite bullmq-docker
```

预期： Config env/file 与 Consul blocking watch 回归通过；Croner 原生能力不被复制；BullMQ Redis 8.8.0
的 run/readiness/pause/close/stalled/cancel signal 真实通过且无连接残留。

### Task 13：合并 NATS，并迁移日志与可观测性包

**文件：**
- 仅审查/按已审计差异修改： `packages/nats/src/{types,errors,server,index,jetstream}.ts`
- 仅审查/按已审计差异修改： `packages/nats/test/*`
- 修改： `packages/nats/{package.json,capability.json,owner.json,README.md,tsconfig.json,tsconfig.test.json}`
- 仅审查/按已审计差异修改： `packages/pino/src/*`
- 仅审查/按已审计差异修改： `packages/pino/test/*`
- 修改： `packages/pino/{package.json,capability.json,owner.json,README.md,tsconfig.json,tsconfig.test.json}`
- 仅审查/按已审计差异修改： `packages/winston/src/*`
- 仅审查/按已审计差异修改： `packages/winston/test/*`
- 修改： `packages/winston/{package.json,capability.json,owner.json,README.md,tsconfig.json,tsconfig.test.json}`
- 仅审查/按已审计差异修改： `packages/otel/src/*`
- 仅审查/按已审计差异修改： `packages/otel/test/*`
- 修改： `packages/otel/{package.json,capability.json,owner.json,README.md,tsconfig.json,tsconfig.test.json}`
- 修改： `e2e/scripts/winston-native.ts`
- 修改： `e2e/contracts.ts`
- 修改： `e2e/cases/pino-native-destination-lifecycle.case.ts`
- 修改： `e2e/suites.ts`
- 修改： `test/published/cases/node-services.ts`

#### Task 13 证据修订：Pino/SonicBoom 发布图与启动准入

独立 remediation 审查证明：把 SonicBoom 只作为 Pino 的传递依赖会随解析结果漂移；把它同时声明为普通 direct
dependency 又允许消费方合法形成两份实现，使 Pino destination 与 LikeGo 私有 ABI 校验来自不同副本。因此
本修订替代 Task 13 原有 Pino 依赖假设，并同步修订批准设计第 6 节：

- `pino` `10.3.1` 保持 exact production dependency；`sonic-boom` `4.2.1` 必须是 exact required
  `peerDependency`，并以同版本 exact `devDependency` 支撑本仓编译与测试，不得是 production direct dependency。
- 发布门禁必须打包真实 tarball，在不创建/继承 lockfile 的 npm 消费方中证明正常图只解析一份 SonicBoom
  `4.2.1`，且 Pino 与 LikeGo 使用同一原型；另建显式请求 `sonic-boom` `4.0.1` 的冲突消费方，要求安装以
  `ERESOLVE` 和精确 peer diagnostic 非零退出。
- `newPinoServer()` 构造成功不等于已经移交资源。`start(ctx)` 必须在监听器安装前以及同步 listener-registration
  re-entry 之后重新验证 destination 原型、`end`/`destroy` 方法身份、logger `symbols.streamSym` 绑定和终态；
  任一漂移都必须拒绝，撤销本次监听器，且不得 flush/end/destroy 或产生 owner。
- 第二次 admission 成功时必须捕获已验证的 Logger `flush`、destination `end`/`destroy` call target 和 force
  capability；owner drain/force 全程只能使用这些固定引用并保留正确的 native `this`。owner 期 logger stream
  binding 漂移必须在 flush 前显式 fail closed，同时仍用固定操作清理已转移的 destination A，不能成功报告一个
  已经写向未表示资源 B 的 Logger terminal。
- owner operation 捕获完成后、设置 owner stop 或发布 running handle 前必须执行第三次 admission，重新检查
  已观察 native failure/close、destination terminal、logger stream binding、已捕获方法 identity 与 force
  capability。capture 期间同步发生的 destroy/error/close 必须拒绝 start、撤销监听器、保留原始 failure
  identity，且 owner flush/end/destroy 调用数保持 0。
- 单元测试与真实 Node native E2E 必须覆盖构造到启动之间的原型方法篡改、own method 覆盖、logger stream
  binding 漂移，以及监听器注册同步重入篡改；published-install 门禁必须消费同一份 native evidence。
- 同一门禁还必须在 `start()` 成功后分别篡改 prototype `end`、own `end`/`destroy`、logger `flush` 与 logger
  stream binding，证明固定 owner 操作不被替换、stream 错配不会被报告为成功，且 stable `done()` 不会因 no-op
  替换永久 pending。
- 真实 Pino/SonicBoom unit、Node native 与 published-tarball 门禁还必须覆盖 operation capture 期间保持方法
  identity 不变但同步触发 destroy/error/close 的三类 re-entry，证明第三次 admission 拒绝 transfer、无 owner
  调用、listener 回滚，并在 error 场景保留原始 Error identity、close 场景保留仍开放资源的应用 ownership。

peer 自动安装与冲突解析行为以
[npm package.json peerDependencies](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#peerdependencies)
为依据，最终结论仍以本任务的真实无锁 npm 安装证据为准。

- [ ] **Step 1: 运行迁移后的 characterization baseline**

迁移前 NATS Core/JetStream 已把消息消费、ack/redelivery/DLQ 留给应用，Pino/Winston/OTel 也已是 native
object + lifecycle-only。Task 3 只合并/改名，不应让正确行为先坏一次。先 fresh build 完整 closure，并运行 unit、
native resource、Docker 与 selected suite：

```sh
bun run --cwd packages/context build
bun run --cwd packages/core build
bun run --cwd packages/nats build
bun run --cwd packages/pino build
bun run --cwd packages/winston build
bun run --cwd packages/otel build
bun test --isolate --no-orphans packages/nats/test packages/pino/test packages/winston/test packages/otel/test
bun run --cwd packages/nats e2e:docker:core
bun run --cwd packages/nats e2e:docker:jetstream
bun run --cwd packages/otel e2e:docker
bun run test:e2e:inventory
bun e2e/run.ts --suite nats-core-docker --suite nats-jetstream-docker --suite pino-runtime --suite winston-runtime --suite otel-docker
```

预期： 迁移前已证明的 native-first 与 cleanup 行为全部保持绿。identity/path/dist/suite 错误属于 Task 3
迁移回归，必须回修后重建 baseline，不能冒充新行为红灯。

- [ ] **Step 2: 审计合包与公开契约 delta，并只对真实 delta 写红灯**

逐项比对 `@likego/nats` 根 `Subscription`/factory、`./jetstream` `ConsumerMessages`/factory、两条 published
exception policy、共享代码冲突与 borrowed connection/durable；同时审计 Pino/Winston/OTel 最终 package identity、
owner resource、stable done、caller-scoped stop 和真实 close/shutdown。每项标记 `already-covered` 或
`missing-delta`。

对 `already-covered` 保留实现；对每个 `missing-delta` 先写最小 unit/native/Docker assertion 并观察目标行为红灯，
再实现。若全部 already-covered，记录 `no behavior delta`，不新建重复 source harness，不伪造旧数据面。

- [ ] **Step 3: 只实现审计证明的最小 delta，并运行真实门禁**

执行：

```sh
bun run --cwd packages/context build
bun run --cwd packages/core build
bun run --cwd packages/nats typecheck
bun run --cwd packages/nats test:coverage
bun run --cwd packages/nats build
bun run --cwd packages/nats e2e:docker:core
bun run --cwd packages/nats e2e:docker:jetstream
bun run --cwd packages/pino typecheck
bun run --cwd packages/pino test:coverage
bun run --cwd packages/pino build
bun run --cwd packages/winston typecheck
bun run --cwd packages/winston test:coverage
bun run --cwd packages/winston build
bun run --cwd packages/otel typecheck
bun run --cwd packages/otel test:coverage
bun run --cwd packages/otel build
bun run --cwd packages/otel e2e:docker
bun run test:e2e:inventory
bun e2e/run.ts --suite nats-core-docker
bun e2e/run.ts --suite nats-jetstream-docker
bun e2e/run.ts --suite pino-runtime
bun e2e/run.ts --suite winston-runtime
bun e2e/run.ts --suite otel-docker
```

预期： NATS 2.14.3 Core/JetStream、Pino destination/transport、Winston File、OTel Collector 0.156.0
真实通过，无 Docker/worker/listener 残留。

### Task 14：完成 examples、中文文档、发布包与全量真实验收

**文件：**
- 重写/修改： `examples/vanilla-web/**`
- 重写/修改： `examples/hono/**`
- 重写/修改： `examples/h3/**`
- 重写/修改： `examples/elysia/**`
- 修改： `README.md`
- 修改： `docs/adr/0001-kernel-public-api.md`
- 修改： `docs/adr/0002-build-runtime-and-coverage.md`
- 修改： `docs/adr/0003-resident-adapter-ownership.md`
- 修改： `docs/adr/0004-service-registry-and-selection.md`
- 修改： `docs/capability-comparison.md`
- 重新生成： `docs/file-inventory.md`
- 修改： `e2e/suites.ts`
- 修改/新增： `e2e/cases/*`
- 修改： `test/published/cases/{portable,integrations,node-services}.ts`
- 修改： `scripts/generate-file-inventory.cli.ts`（仅当 canonical discovery 接线需要）
- 创建： `test/repository-contract.test.ts`

- [ ] **Step 1: 写最终仓库契约红灯**

断言：

- 23 个 package 的 exports 与批准设计第 5 节逐项相等，27 个 workspace identity 精确；
- 第 6 节 23 行直接 workspace/external production+peer 依赖表逐项相等，不只验证版本格式；
- v2 `packageKind`、每个 export 的 kind/residency/ownerResources 与第 11 节清单一致；
- 迁移前 53 个业务 case ID 与 6 个 Docker suite ID 都仍是最终 inventory 的子集；
- 四个 example 只按正式 package name 消费；
- production source 不存在首字母大写的直接导出函数、factory、option、常量或普通运行时值；类型、接口、class
  与 Error 构造器继续使用 TypeScript 的 `PascalCase` 惯例；
- 可执行配置/源码不存在旧包名、`adapters/`、`@likego/fetch`、`@likego/http`、`Micro-`。

- [ ] **Step 2: 运行最终仓库契约红灯**

执行：

```sh
bun test --isolate --no-orphans test/repository-contract.test.ts
```

预期： 尚未完成的 examples/docs/inventory/dependency/legacy-reference 断言至少一个失败；测试本身可加载并
枚举真实仓库，不能以 module-not-found 充当红灯。

- [ ] **Step 3: 完成示例和中文文档**

README 以 `@likego/web` 对外、`@likego/transport-http` 内部 client/server、`@likego/registry` +
mDNS/Consul、用户自实现 `Server` 为主线。ADR/对比/文件清单与真实目录一致，不把未支持 stream/gRPC/Proto
写成已支持。

- [ ] **Step 4: frozen install 与静态/单元/覆盖率门禁**

执行：

```sh
bun install --frozen-lockfile
bun run verify:workspace
bun run verify:manifests
bun run verify:file-inventory
bun run typecheck
bun run test:coverage
bun run test:coverage:workspaces
```

预期： 全部退出 0，所有发布包 production line/function 100%。

- [ ] **Step 5: 构建、tarball、跨 runtime 与 examples**

执行：

```sh
bun run build
bun run test:examples:node
bun run test:published
```

预期： 23/23 tarball runtime/types gate 通过；config/registry/transport parent 包不含 child workspace；
四个 example 真实 Node listener 通过。

- [ ] **Step 6: 全量真实 E2E/Docker**

执行：

```sh
bun run test:e2e:inventory
bun run test:e2e:prepared
```

预期： 保留既有业务 E2E 覆盖并新增 transport-http 与 mDNS；Consul、Redis/BullMQ、NATS/JetStream、
OTel Collector 和 mDNS multicast 均使用真实服务，全部退出 0。

- [ ] **Step 7: 最终证据和 broad review**

先按 Preflight 的同一 hidden-aware reviewable 规则建立 `/tmp/likego-final.after-tree/`、排序 inventory 与
SHA-256，并生成从 `/tmp/likego-preflight.before-tree/` 到 final tree 的累计 `diff -ruN`。然后把：

- preflight before-tree/status/SHA/binary tracked patch；
- 14 个任务各自的 before-tree、after-tree、SHA、review diff、红绿命令日志与双重审查结论；
- final canonical inventory、累计 preflight→final diff、全量 gate/Docker 日志；

统一登记到仓库外 `/tmp/likego-final-review-package/manifest.txt`。manifest 必须能定位每件证据并记录 SHA-256；
缺任一任务 delta 或只引用 `git diff HEAD` 均不算可审查。独立 broad reviewer 使用这个 aggregate package，
不得把 Task 14 局部 diff 误当成全项目实施边界。

执行：

```sh
bun run verify
git diff --check
git status --short --untracked-files=all
! rg -n --hidden -g '!**/test/**' -g '!**/*.test.ts' -g '!**/fixtures/**' -g '!**/.omo/evidence/**' -g '!**/dist/**' -g '!**/node_modules/**' 'Micro-|@likego/(fetch|fetch-node|http|config-env|config-file|cron-croner|job-bullmq-node|nats-core-node|nats-jetstream-node|log-pino-node|log-winston-node|metrics-prom-client-node|otel-node)|adapters/' package.json tsconfig*.json packages examples e2e scripts README.md docs/adr docs/capability-comparison.md
```

预期： `bun run verify` 与 `git diff --check` 退出 0；最后的补充 `rg` 无命中且 `!` 使该状态成为退出 0，真正的
identity gate 仍由 `test/repository-contract.test.ts` 提供。独立 broad reviewer 对批准规范
1–14 节、Context/所有权、公开 exports、真实测试声称和 dirty-main 保护给出无阻断结论后，才能把计划标为完成。
