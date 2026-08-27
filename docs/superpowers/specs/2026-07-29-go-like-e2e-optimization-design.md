# go-like E2E 优化设计

日期：2026-07-29

范围更正：2026-08-02

状态：**Implemented**

本文是 go-like E2E 实施与验收的规范性来源。调研事实、上游证据和曾评估的宿主机 containment 方案保留在 [`2026-07-29-go-like-e2e-evidence-architecture.md`](./2026-07-29-go-like-e2e-evidence-architecture.md)，仅作为历史研究。

## 1. 支持边界

go-like 是 runtime-neutral TypeScript toolkit：

- portable public contracts 使用标准 Web API；
- runtime-specific adapter 只对自己的显式 subpath 和 runtime contract 负责；
- 操作系统支持由所选 JavaScript runtime 对相应 API 的支持决定；
- E2E runner 的进程启动、Docker、临时文件与 cleanup 是仓库测试基础设施，不构成发布包的平台支持合同。

go-like 不承诺或要求操作系统级进程沙箱、fork-complete containment 或跨平台相同的宿主机隔离语义。这些能力不是 PR、release、tag 或平台兼容性的门禁。

## 2. 目标与非目标

### 2.1 目标

1. 根 E2E 只构建一次 package dist，并按 typed execution plan 执行。
2. `scope`、显式 suite、registered runtime 与 examples input 都不得静默跳过。
3. package/provider 场景持有业务和协议断言；root 只负责选择、编排、超时、清理和汇总。
4. Docker 场景使用 invocation-scoped ownership，只清理当前测试创建的资源。
5. published 检查使用真实 tarball 和隔离 consumer，验证类型、解析与实际运行。
6. Bun、Node、Deno、k6 workload 和所有 committed E2E TypeScript 都有明确 typecheck owner。
7. primary failure 与 cleanup failure 都必须可见；不得以 retry、skip、force-exit 或空测试换取绿色。

### 2.2 非目标

- 不改变任何产品 package 的 public API 或运行语义。
- 不把 scope、目录或脚本名称包装成新的测试等级；go-like 只有 unit 与 E2E。
- 不把 E2E runner 设计成宿主机安全边界或恶意进程沙箱。
- 不要求 hosted CI 运行 Docker、published、examples、k6 或长时间 soak。
- 不维护 committed inventory、source scanner、evidence overlay 或长期生成的测试 manifest。

## 3. 执行架构

### 3.1 公共入口

```sh
bun run test:e2e
bun run test:e2e:suites
bun run test:e2e:providers
bun run test:e2e:runtimes
bun run test:e2e:examples
bun run test:e2e:published
bun run test:e2e:soak
```

有限时长公共 lane 先执行一次 `bun run build`，再调用 `e2e/run.ts`。内部 CLI 不隐式 build；直接调用前必须准备 package dist。

`--scope` 与 `--suite` 互斥。未知参数、缺值、重复 scope、未知 suite 或空选择都失败。显式 suite 按首次出现顺序去重；`all` 按 `suites → runtimes → examples → published` 运行。

### 3.2 断言所有权

- `packages/**/test/e2e`：provider、runtime、bridge 和 package contract。
- `examples/**`：可执行应用行为与 specialized Docker 场景。
- `e2e/published.ts`：真实 tarball、隔离安装、类型解析和 runtime consumer。
- `e2e/soak.ts` 与 `e2e/load/**`：短生命周期负载与独立长时间稳定性运行。
- root executor：selection、version preflight、timeout/abort、cleanup、sanitized diagnostics 和 summary。

Root 不复制 package 或 example 的业务断言，也不通过解析任意 stdout 建立第二套通过协议。

### 3.3 进程与 Docker

测试命令由 runner 以 argv-safe 方式启动，保留超时、abort、stdout/stderr drain、known-secret redaction 和 cleanup failure。结果中的 termination 与 residual 只描述本次测试观察，不产生产品平台或宿主机 containment 声明。

Docker 使用 exact `io.go-like.e2e.owner` 与 invocation ownership。Scenario 正常清理自己的 container、network 和 volume；root backstop 只处理当前 invocation 与已注册 child owner 的交集。Foreign、unknown-owner 或 label collision 资源保持 untouched，并使测试失败。

### 3.4 Examples completeness

Examples lane 每次从 immediate `examples/*/package.json` 动态生成 execution input：

1. 每个 workspace 必须有非空 `test:e2e` wrapper；
2. root 为每个 input 分配 child owner；
3. worker durable registration 获得 authenticated ACK 后才能启动 scenario；
4. 完成时比较 inputs、participants、results 与 completed commands；
5. missing、duplicate、unexpected、timeout、abort 或 cleanup failure 都使 aggregate 非零。

不提交固定 example 数量；summary 记录当次动态数量。

### 3.5 Runtime 与 published contract

Registered runtime plan 对登记项 fail-closed，但不推断未登记能力。当前验证版本为：

- Bun `1.3.14`
- Node.js `26.5.0`
- Deno `2.9.4`
- TypeScript `7.0.2`
- k6 image 内部版本 `2.1.0`

Published lane 动态发现 non-private publishable packages 并生成真实 npm tarball。Node consumer 执行 NodeNext emit，Bun consumer 使用 `--no-install`，Deno consumer 先 `check` 再以 `--no-prompt` 和最小权限运行。所有 consumer 只通过安装后的 package name 导入。

### 3.6 k6 与 soak

k6 workload 是 committed、独立 typecheck、未 bundle 的 TypeScript，并由 fixed-digest image 直接执行。10 秒运行只证明 short lifecycle、result marker 与 cleanup path；只有实际完成至少 60 分钟的独立运行才支持 long-duration claim。k6/soak 不属于默认有限时长 `test:e2e`。

## 4. Typecheck 与 CI

Committed E2E TypeScript 必须属于明确 tsconfig：root tests、ordinary E2E、k6、published authoring、package 或 example workspace 各自维护 owner。新增 runtime、example 或 package E2E 时，必须在同一变更中补齐注册、脚本、fixture、文档和 typecheck owner。

Hosted Verify/Release 只运行：

```sh
bun install --frozen-lockfile
bun run fmt:check
bun run typecheck
bun run build
bun run test:unit
```

Hosted CI green 不等于 full E2E green。真实 provider、runtime、examples、published、Docker 与 soak 结果只能由实际完成的对应命令证明。

## 5. 完成验证

候选提交的完整有限时长验证为：

```sh
bun install --frozen-lockfile
bun run fmt:check
bun run typecheck
bun run build
bun run test:unit
bun run test:e2e
git diff --check
git status --short --untracked-files=all
```

每条命令必须等待结束并记录 exit code；只报告实际环境、动态数量和本次观察结果。未运行宿主机 containment 实验不影响 go-like 平台支持与 release readiness，因为它们不属于产品合同。

## 6. Implementation closure

PR0–PR9 已按线性顺序提交；Redis Sentinel follow-up 为 `3fb895bd41daebd48cf37765aeb51892fabdaca2`，tree 为 `7185fe57e1854c9e34de516397dbfd9fa842e0db`。

该提交已在 macOS `26.5.2` arm64、Bun `1.3.14`、Node `26.5.0`、Deno `2.9.4`、TypeScript `7.0.2` 和 Docker `29.6.2` 环境完成完整命令集：

- full E2E：`selected=53`、`passed=53`、`failed=0`、`notRun=0`；
- examples：`selected=44`、`participants=44`、`results=44`、`passed=44`；
- Redis Sentinel：`29.564s`，正常退出；
- runner summary：无 timeout/abort/supervisor error，`residual=zero-observed`；
- `git diff --check` 通过，候选工作树仅保留未纳入提交的外部 `plan.md`。

上述结果不构成 60 分钟 soak 或宿主机 containment 声明。go-like 的实现状态与 release 不受已撤销的宿主机门禁阻塞。
