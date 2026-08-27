# go-like Lifecycle, Readiness, and Error DX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 不扩张公共生命周期 API，修正 HTTP/worker/cron/job 的就绪心智模型，建立可操作的错误参考，并统一四个已确认会丢失非 `Error` 根因的边界。

**Architecture:** 保留一个 `App`/`Server` 生命周期；`Endpointer` 仅服务地址发现，`ProbeRegistry` 保持协议无关，HTTP health 继续是显式可选 adapter。错误按 sentinel、branded `ServiceError`、公开 `GO_LIKE_*` code、原生 Error 和 `AggregateError` 分层；只在已确认的 application/native 边界保留 non-Error cause，敏感边界继续脱敏。

**Tech Stack:** TypeScript、Bun、标准 Web API、VitePress、oxfmt。

**Spec:** [docs/superpowers/specs/2026-08-26-lifecycle-readiness-error-dx-design.md](../specs/2026-08-26-lifecycle-readiness-error-dx-design.md)

## 执行记录

- Tasks 1-2 的 lifecycle/readiness 文档已在 `2d81af6` 完成。
- Tasks 3-4 的测试驱动修复已在 `df7e166` 完成并通过独立审查。
- Task 5 的错误参考已在 `163cec5` 完成，并在 `fcc749b`、`cc0786a` 根据独立审查补齐错误分类；Task 6 以最终分支上的全量门禁与整分支独立审查为准。
- 下方未勾选项保留原始执行步骤和授权检查点，不表示对应实现仍未开始。

## Global Constraints

- 不新增或修改公共 API、export、package dependency、route default 或 provider SPI。
- 不自动启动 management server，不让 worker/cron/Store 实现虚假 `Endpointer`。
- 不新增通用 Error 基类、Error helper package、retry abstraction 或 docs 构建插件。
- English `doc/` 是本轮唯一 canonical public documentation；locale 翻译不在本轮范围。
- Lifecycle/readiness 文档是第一阶段；主人已要求的 Error DX 是第二阶段。两阶段分别授权、验证和提交，不能因执行第一阶段而自动修改 production error semantics。
- production source 修改必须先看到对应定向测试按预期失败，再做最小实现。
- 已经是 `Error` 的值必须保留 identity；新 wrapper 的 message 保持现有固定文本；raw cause 不进入 wire、completion logs 或 traces。
- Config/Registry 的显式 secret-safe normalizer 不在本轮修改范围。
- 当前执行已取得 commit 与 push 授权；仍不包含 release 或 deploy。
- 所有执行者共享工作区，必须保留并适配其他人的改动，不能重置或覆盖无关差异。

---

## Task 0: 固化已批准的设计与执行清单

**Files:**

- Create: `docs/superpowers/specs/2026-08-26-lifecycle-readiness-error-dx-design.md`
- Create: `docs/superpowers/plans/2026-08-26-lifecycle-readiness-error-dx.md`

- [ ] **Step 1: 验证两个 planning artifacts**

`docs/superpowers/**` 被 repository formatter 配置忽略，因此通过 stdin 使用同一 formatter，并单独检查尾随空白：

```sh
cmp -s docs/superpowers/plans/2026-08-26-lifecycle-readiness-error-dx.md \
  <(bunx oxfmt --stdin-filepath=plan.md < docs/superpowers/plans/2026-08-26-lifecycle-readiness-error-dx.md)
cmp -s docs/superpowers/specs/2026-08-26-lifecycle-readiness-error-dx-design.md \
  <(bunx oxfmt --stdin-filepath=spec.md < docs/superpowers/specs/2026-08-26-lifecycle-readiness-error-dx-design.md)
! rg -n '[[:blank:]]+$' \
  docs/superpowers/plans/2026-08-26-lifecycle-readiness-error-dx.md \
  docs/superpowers/specs/2026-08-26-lifecycle-readiness-error-dx-design.md
```

Expected: all exit 0；formatter comparison 和 trailing-blank search 均无输出。

- [ ] **Step 2: 授权门控的 planning commit**

仅在执行请求明确授权 commit 时运行：

```sh
git add docs/superpowers/plans/2026-08-26-lifecycle-readiness-error-dx.md docs/superpowers/specs/2026-08-26-lifecycle-readiness-error-dx-design.md
git commit -m "docs: record lifecycle readiness DX plan"
```

否则保留为未提交的方案交付物并明确报告。

## Task 1: 修正生命周期与 readiness 的 canonical 心智模型

**Files:**

- Modify: `doc/guide/health-observability.md`
- Modify: `doc/guide/architecture.md`
- Modify: `doc/guide/getting-started.md`

- [ ] **Step 1: 建立文档构建基线**

Run:

```sh
bun run doc:build
```

Expected: exit 0。若基线失败，先记录现有失败；不要把它混进本任务差异。

- [ ] **Step 2: 修正 early bind 的错误暗示**

在 `doc/guide/health-observability.md` 替换当前 Docker published port 段落的结论，写明：

```md
An HTTP response, including `503`, proves that the management endpoint is responding; it does not prove business admission. A separate management listener, or a health route on the application listener, may bind early and report `/livez` as `200` while `/readyz` remains `503` until required work-plane resources have admitted. When health and business routes share a listener, business routes must still fail closed before readiness.
```

保留“TCP connect 不是 HTTP/TLS listener ready”的现有边界。

- [ ] **Step 3: 加入五类信号与工作负载决策表**

在同一 Health guide 的 readiness 章节加入 Spec 第 3、4 节的两张表。第二张表必须置于以下精确标题下，以稳定后续链接：

```md
## Workload admission matrix
```

同时明确：

- `ProbeRegistry.check(...)` 可在没有 HTTP 的应用中直接调用；
- `/livez`、`/readyz` 只由 `@go-like/web/health` 显式投影；
- Kubernetes readiness 只影响 Service 路由，不暂停 broker consumer；
- Job/CronJob 以退出码和 Job condition 表达 completion。

- [ ] **Step 4: 收紧 `Endpointer` 与 `afterStart` 定义**

在 `doc/guide/architecture.md` 的 listener 和 App lifecycle 段落改成：

```md
`Endpointer.endpoint(ctx)` proves an address that can be advertised or registered. `afterStart` proves only that Core reached that hook; it becomes an admission marker only when the hook itself waits for a resource-specific admission signal.
```

删除把 `afterStart` 本身列为 readiness 替代品的措辞。

- [ ] **Step 5: 让 Web 入门示例只声称自己证明的事实**

在 `doc/guide/getting-started.md`：

- 将 `announceReady` 改名为 `announceWebEndpoint`；
- 保留 `await webServer.endpoint(ctx)`；
- 在示例后说明 marker 只证明该 Web endpoint 已取得地址，不代表任意 Store、broker、worker 或业务策略 ready；
- 链接 `/guide/health-observability`。

- [ ] **Step 6: 验证 Task 1**

Run:

```sh
bunx oxfmt --check doc/guide/health-observability.md doc/guide/architecture.md doc/guide/getting-started.md
bun run doc:build
git diff --check
```

Expected: all exit 0；页面无 dead link；没有改动公共源码。

- [ ] **Step 7: 授权门控的 commit checkpoint**

仅在执行请求明确授权 commit 时运行：

```sh
git add doc/guide/health-observability.md doc/guide/architecture.md doc/guide/getting-started.md
git commit -m "docs: clarify lifecycle and readiness semantics"
```

否则跳过并在交付中报告未提交。

## Task 2: 把 worker、cron 与 protocol-neutral probes 接回各自入口

**Files:**

- Modify: `doc/guide/broker-events.md`
- Modify: `packages/health/README.md`
- Modify: `packages/croner/README.md`
- Modify: `packages/bullmq/README.md`

- [ ] **Step 1: 在 Broker guide 加最短的 workload 指引**

在 “Jobs and schedules are separate models” 后加入三条，不复制 Health guide 的整张表：

- resident worker readiness 是“能否接收下一份工作”；
- readiness false 不会替代 App/Server stop；由 adapter 的 owner stop 链调用 native pause/unsubscribe/drain；
- one-shot Job/CronJob 的结果由退出状态表达。

链接 `/guide/health-observability#workload-admission-matrix`。

- [ ] **Step 2: 在 Health README 展示无 HTTP 用法**

加入只依赖 `@go-like/health` 的示例：

```ts
const report = await probes.check(ctx, "ready")
if (!report.ok) throw new Error("workload admission failed")
```

紧接着说明：应用可以把 report 提供给自己的 CLI、supervisor adapter、测试或 management route；Health package 不创建 HTTP listener。

- [ ] **Step 3: 给 Croner README 加一条健康边界**

在生命周期语义后写明：常驻 Croner Server 不实现 `Endpointer`；scheduler ready 只可表示 schedules/configuration 已接纳，单次 callback 成败属于 job outcome。Kubernetes CronJob 应每次创建新进程和新 App 实例。

- [ ] **Step 4: 给 BullMQ README 加一条摘流边界**

在启动/停止章节写明：Kubernetes readiness false 不会停止 Worker 领取任务；需要摘流时，应用必须请求 go-like App/Server stop，由 adapter owner 调用已有 `pause(false)` / close shutdown 链，不能从旁调用 native lifecycle 方法。可选 management probe 只能报告这个 native 状态。

- [ ] **Step 5: 验证 Task 2**

Run:

```sh
bunx oxfmt --check doc/guide/broker-events.md packages/health/README.md packages/croner/README.md packages/bullmq/README.md
bun run doc:build
git diff --check
```

Expected: all exit 0；四处措辞均链接或服从同一 canonical 模型；没有新增 HTTP 或 lifecycle API。

- [ ] **Step 6: 授权门控的 commit checkpoint**

仅在明确授权 commit 时运行：

```sh
git add doc/guide/broker-events.md packages/health/README.md packages/croner/README.md packages/bullmq/README.md
git commit -m "docs: explain worker and job admission"
```

否则跳过。

## Task 3: 先用测试锁定 non-Error cause 一致性

**Files:**

- Modify: `packages/store/file/test/lifecycle.test.ts`
- Modify: `packages/store/file/test/node-host.test.ts`
- Modify: `packages/transport/http/test/wire.test.ts`
- Modify: `packages/transport/http/test/node-client-boundary.test.ts`
- Modify: `packages/transport/http/test/listener.test.ts`

- [ ] **Step 1: 锁定 File Store startup wrapper**

把 lifecycle test 的 string rejection 改为冻结 marker，并断言：

```ts
const marker = Object.freeze({ operation: "acquire" })
// host.acquire rejects marker
const failure = await store.start(background()).catch((value: unknown) => value)
if (!(failure instanceof Error)) throw new Error("expected startup Error")
expect(failure).toMatchObject({ message: "File Store startup failed" })
expect(failure.cause).toBe(marker)
```

- [ ] **Step 2: 锁定 Node File Store host wrapper**

扩展现有 “normalizes non-Error write failures and serial queue continues” 用例：第一份写入 rejection 使用 marker，断言固定 message 与 `cause === marker`，随后第二份写入和 close 仍成功。

- [ ] **Step 3: 锁定共享 HTTP normalizer**

在 `wire.test.ts` 对 `normalizeHTTPError` 使用 marker：

```ts
const marker = Object.freeze({ phase: "executor" })
const failure = normalizeHTTPError(marker, "normalized")
expect(failure).toMatchObject({ message: "normalized" })
expect(failure.cause).toBe(marker)
```

- [ ] **Step 4: 锁定 Node native client helper**

在 `node-client-boundary.test.ts` 增加一个 HTTP/1 admission 用例，让 injected `openRequest` 抛出 marker；使用 `.cause.toBe(marker)` 断言 identity，另断言 wrapper message 为 `Node HTTP/1 request failed`、socket 仍被销毁。一个共享 helper 的分支只保留这一份新测试，不为每个 caller 复制测试。

- [ ] **Step 5: 锁定 wire 脱敏与 TransportLogger 边界**

扩展 `listener.test.ts` 的 secret-safe 500 用例：handler 抛出带 secret 的非 Error marker；断言 response 仍为固定 500 且 body 不包含 secret，同时断言应用提供的 `TransportLogger` 收到 wrapper Error，且 `wrapper.cause === marker`。

- [ ] **Step 6: 运行红灯**

Run:

```sh
bun test --isolate --no-orphans packages/store/file/test/lifecycle.test.ts packages/store/file/test/node-host.test.ts packages/transport/http/test/wire.test.ts packages/transport/http/test/node-client-boundary.test.ts packages/transport/http/test/listener.test.ts
```

Expected: 五个新增/收紧断言因 `cause` 缺失而失败；wire 仍保持固定 500。若失败原因不是 cause 缺失，停止并先修正测试。

## Task 4: 用四个一行改动保留 cause

**Files:**

- Modify: `packages/store/file/src/store.ts`
- Modify: `packages/store/file/src/node-host.ts`
- Modify: `packages/transport/http/src/errors.ts`
- Modify: `packages/transport/http/src/node-client.ts`

- [ ] **Step 1: 修改两个 File Store normalizer**

只把 fallback 分支改为：

```ts
Object.freeze(new Error(message, { cause: value }))
```

不增加 helper，不改变现有 Error identity、freeze 或 fixed message。

- [ ] **Step 2: 修改两个 HTTP normalizer**

只把 fallback 分支改为：

```ts
new Error(message, { cause: value })
```

继续复用各文件已有的 cross-realm `isError`；不改变任何 structural error 或 HTTP wire envelope。

- [ ] **Step 3: 运行定向绿灯**

Run:

```sh
bun test --isolate --no-orphans packages/store/file/test/lifecycle.test.ts packages/store/file/test/node-host.test.ts packages/transport/http/test/wire.test.ts packages/transport/http/test/node-client-boundary.test.ts packages/transport/http/test/listener.test.ts
```

Expected: all pass；无 unhandled rejection；原有 queue continuation 和 resource destruction 断言保持通过。

- [ ] **Step 4: 运行受影响 package 门禁**

Run:

```sh
bun run --filter @go-like/store-file typecheck
bun run --filter @go-like/store-file test:unit
bun run --filter @go-like/store-file build
bun run --filter @go-like/transport-http typecheck
bun run --filter @go-like/transport-http test:unit
bun run --filter @go-like/transport-http build
```

Expected: all exit 0。

- [ ] **Step 5: 审查安全边界**

确认 diff 只给本地 Error 增加标准 `cause`；没有把 raw cause 加入 ServiceError envelope、health response、Pino/Winston/OTel completion fields 或 HTTP response body。`TransportLogger` 会收到 wrapper Error，这是应用拥有的诊断边界；文档和测试必须如实说明应用负责递归 cause 的脱敏。

- [ ] **Step 6: 授权门控的 commit checkpoint**

仅在明确授权 commit 时运行：

```sh
git add packages/store/file/src/store.ts packages/store/file/src/node-host.ts packages/store/file/test/lifecycle.test.ts packages/store/file/test/node-host.test.ts packages/transport/http/src/errors.ts packages/transport/http/src/node-client.ts packages/transport/http/test/wire.test.ts packages/transport/http/test/node-client-boundary.test.ts packages/transport/http/test/listener.test.ts
git commit -m "fix: preserve non-error rejection causes"
```

否则跳过。

## Task 5: 建立一份可查、可操作的错误参考

**Files:**

- Create: `doc/reference/errors.md`
- Modify: `doc/.vitepress/config.ts`
- Modify: `doc/guide/service-call.md`
- Modify: `doc/guide/config-registry-store.md`
- Modify: `doc/guide/broker-events.md`

- [ ] **Step 1: 写错误判断顺序**

`doc/reference/errors.md` 先给出以下可复制的顺序：

```ts
if (error === canceled || error === deadlineExceeded) {
  // Context termination
} else if (isServiceError(error)) {
  // Application service failure
} else if (error instanceof AggregateError) {
  // Inspect error.errors in order
} else if (typeof error === "object" && error !== null && "code" in error) {
  // Match one documented GO_LIKE_* code
}
```

明确禁止按 `message` 分支，且不能用 `instanceof` 判断 structural provider errors。

- [ ] **Step 2: 建立完整 code catalog**

按 Context、Transport/HTTP/Web、Config、Registry、Store/Cache、Broker/worker、Observability 分组，逐个列出当前公开结构类型声明的 `GO_LIKE_*` code。每行填写：source package、code、meaning、retry policy、caller action、security/observability note；人工核对对应类型是否从 package export 暴露，不能把 inventory 命令当作公开可达性的证明。

另建 “Non-contract runtime diagnostics” 小节，列出存在于 runtime source、但没有公开结构类型承诺的 code。当前唯一已确认项是 `GO_LIKE_CACHE_REDIS_STATE`；明确禁止调用方把它当作稳定分支条件。本轮不通过新增导出把它升级成公共 API。

至少写清：

- state/closed/already-started/unsupported/validation 类错误不自动重试；
- transport/HTTP/provider failure 只有在操作可重放且策略授权时才能重试；
- uncertain/lease-lost/cleanup 类写操作先 reconcile，不能盲目重放；
- `ServiceError` 的业务 code 不属于 `GO_LIKE_*` catalog，必须通过 `isServiceError` 识别；
- `AggregateError` 必须遍历全部 errors；只有 package 明确声明时才解释 primary/cause 顺序；
- `cause` 仅用于本地诊断，不写入 wire 或 framework-owned completion/trace fields；应用 `TransportLogger` 可读取 wrapper Error，并负责自己的脱敏。

- [ ] **Step 3: 校验 catalog 没漏公开 code**

Run:

```sh
comm -23 \
  <(rg -o --no-filename 'readonly code: "GO_LIKE_[A-Z0-9_]+"' packages -g '**/src/**/*.ts' | sed -E 's/readonly code: "([A-Z0-9_]+)"/\1/' | sort -u) \
  <(rg -o --no-filename 'GO_LIKE_[A-Z0-9_]+' doc/reference/errors.md | sort -u)
```

Expected: no output。若出现 code，补齐对应 catalog row；不要加忽略名单。

- [ ] **Step 4: 锁定 source-only diagnostic 差异**

Run:

```sh
diff -u \
  <(printf '%s\n' GO_LIKE_CACHE_REDIS_STATE) \
  <(comm -23 \
    <(rg -o --no-filename 'GO_LIKE_[A-Z0-9_]+' packages -g '**/src/**/*.ts' | sort -u) \
    <(rg -o --no-filename 'readonly code: "GO_LIKE_[A-Z0-9_]+"' packages -g '**/src/**/*.ts' | sed -E 's/readonly code: "([A-Z0-9_]+)"/\1/' | sort -u))
rg -n 'GO_LIKE_CACHE_REDIS_STATE' doc/reference/errors.md
```

Expected: `diff` exit 0；reference 命中该 code，并将它标为 non-contract。未来差异集合改变时必须人工审查，不能静默把新 literal 当成稳定 public code。

- [ ] **Step 5: 只加入 English canonical 导航**

在 `doc/.vitepress/config.ts` 的 `includeCanonicalEnglishPages` 分支中，把下项追加到现有 `referenceItems.push(...)`：

```ts
{ text: "Errors", link: route(prefix, "reference/errors") }
```

不修改 `Labels`，不修改任何 locale route 或翻译页。

- [ ] **Step 6: 加三条就地入口**

在 `service-call.md`、`config-registry-store.md` 和 `broker-events.md` 各加入一条指向 `/reference/errors` 的链接；不在三页复制 error catalog。

- [ ] **Step 7: 验证错误参考与导航**

Run:

```sh
bunx oxfmt --check doc/reference/errors.md doc/.vitepress/config.ts doc/guide/service-call.md doc/guide/config-registry-store.md doc/guide/broker-events.md
bun run doc:build
git diff --check
```

Expected: all exit 0；English reference sidebar 有 Errors；所有 locale 无新死链；catalog source diff 为空。

- [ ] **Step 8: 授权门控的 commit checkpoint**

仅在明确授权 commit 时运行：

```sh
git add doc/reference/errors.md doc/.vitepress/config.ts doc/guide/service-call.md doc/guide/config-registry-store.md doc/guide/broker-events.md
git commit -m "docs: add canonical error handling reference"
```

否则跳过。

## Task 6: 全量验证与交付审查

**Files:**

- Review: all files modified by Tasks 1-5

- [ ] **Step 1: 检查方案覆盖与范围**

逐项对照 Spec 第 9 节；确认没有公共 API、dependency、locale、example、deployment manifest、systemd adapter 或 unrelated refactor 差异。

- [ ] **Step 2: 运行全量 repository gates**

Run:

```sh
bun run fmt:check
bun run typecheck
bun run build
bun run test:unit
bun run doc:build
git diff --check
```

Expected: every command exits 0。若任何命令失败，不得声明完成；报告命令、exit status、失败范围和是否为基线问题。

- [ ] **Step 3: 检查最终工作区**

Run:

```sh
git status --short
git diff --stat
git diff --check
```

Expected: only planned files are present；no whitespace errors；没有生成的 `doc/.vitepress/dist` 或 cache 被纳入差异。

- [ ] **Step 4: 独立 review**

请一个未参与实现的 reviewer 检查：

- 五类信号和四类工作负载是否仍有概念混用；
- Error catalog 是否与源码一致；
- non-Error cause 是否只停留在本地诊断边界；
- 是否出现可删除的新 abstraction 或重复文档。

修复所有 Important/Critical finding 后重跑受影响门禁。

- [ ] **Step 5: 关闭 commit authorization gate**

若主人从一开始授权 commit，Task 0、1、2、4、5 的 checkpoint 完成后，`git status --short` 应为空。若主人只在实现完成后授权 commit，按 Task 0、1、2、4、5 的 checkpoint 顺序分别提交；不要把 source fix 混入 `docs:` catch-all commit。

无 commit 授权时保持未提交并交付精确 diff 与验证结果；无 push 授权时绝不推送。
