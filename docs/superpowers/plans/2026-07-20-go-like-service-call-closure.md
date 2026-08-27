# go-like 服务调用闭环实施计划

> **面向执行代理：** 必须使用 `superpowers:subagent-driven-development`（推荐）或
> `superpowers:executing-plans` 按任务实施。所有行为步骤使用复选框（`- [ ]`）跟踪。

**目标：** 用真实 Consul 与真实 HTTP Transport 闭合按服务名调用链，并发布最小的
`@go-like/client` unary 组合包。

**架构：** HTTP Server 自身暴露启动后的稳定实际地址；应用通过 Registry resolver 把 opaque authority 转为
HTTP URL；薄 Client 只执行 discovery、selection、单次 transport exchange、feedback 与清理。Core、Registry、
Transport、Web 的现有职责不合并。

**技术栈：** TypeScript 7.0.2、Bun 1.3.14、Node 26.5.0、Deno 2.9.3、标准 Web API、
Consul 2.0.2 fixed-digest Docker、oxfmt 0.60.0、Changesets 2.31.1。

## 全局约束

- 规范源是 `docs/superpowers/specs/2026-07-20-go-like-service-call-closure-design.md`；若计划与规范冲突，以规范
  为准并先修订计划。
- 直接在 `/Users/munmunmiao/Documents/web/go-like` 的 dirty `main` 工作树实施；不创建 worktree、feature
  branch，不 reset，不覆盖无关修改。
- 当前基线是 119 条 tracked/untracked 状态；大量 `packages/` 与 `e2e/` 文件未被 Git 跟踪，不能用
  `git diff` 代替完整 before-tree。
- 未经用户另行授权，不执行 `git add`、`git commit`、push、PR、publish、release 或 deploy。该约束替代
  subagent-driven-development 默认的 per-task commit；审查使用精确 before/after tree、SHA-256、可见 diff 和
  测试日志。
- 每个任务首次编辑前把精确 scope 复制到 `/tmp/go-like-service-call-task-N.before/`；完成后复制到对应
  `.after/`，使用 `diff -ruN` 与 SHA-256 形成可审查证据，包含 untracked 文件。
- 所有行为变更严格 TDD：先写失败测试并确认因目标行为缺失而失败，再写最少实现。纯 E2E 证据任务若现有
  production 已满足行为，记录 characterization green，不篡改正确实现制造假红灯。
- Context 始终是阻塞/I/O 方法的独立首参；导出函数使用 lower camel case；公共 API 和有业务意义的函数写
  JSDoc；优先 factory、纯函数和冻结普通对象，不增加 class、decorator、反射或 DI。
- portable production source 只使用 ECMAScript 与标准 Web API，不静态 import `node:`、Bun、Deno 或供应商
  SDK；开发源码相对 import 不带 `.js` 扩展名。
- 不增加 retry、pool、codec、Router、Service 总门面、middleware DSL、远程业务错误协议或默认全局实例。
- Consul 使用固定镜像
  `hashicorp/consul:2.0.2@sha256:7dcf35d6b2682831094f1680aa58be214134969505acce0a9b280249581aa7d2`；
  网络协议、stale endpoint、watch 收敛与资源清理只能由真实 Docker/HTTP 证据通过，不能用 fake 替代。
- 每个发布包版本保持 `0.0.1`；新增包进入 Changesets、build、published runtime/types、coverage、manifest 与
  file inventory 门禁。
- 每项完成后先做规范符合性审查，再做代码质量审查；阻断意见修复并重跑覆盖 gate 后才标记完成。

---

### Task 1：HTTP Server 暴露稳定实际地址

**文件：**

- 修改：`packages/transport/http/src/server.ts`
- 修改：`packages/transport/http/test/server.test.ts`
- 修改：`packages/transport/http/test/public-types.ts`
- 修改：`packages/transport/http/README.md`

**接口：**

- 消费：现有 `HTTPServerHandle.address(): string`
- 产出：`HTTPServer.address(): string | null`

- [ ] **Step 1：保存四个文件的 before-tree 和 SHA-256**

复制存在的文件；缺失路径以空文件在 review manifest 中表示。保存 scope、状态与 SHA-256 到
`/tmp/go-like-service-call-task-1.*`，回读必须逐字节一致。

- [ ] **Step 2：写地址生命周期红灯**

在现有 server fixture 上增加以下断言，不新造 host framework：

```ts
const server = newHTTPServer(fixture.host, handler)
expect(server.address()).toBeNull()

const handle = await server.start(background())
expect(server.address()).toBe(handle.address())

await handle.stop(background())
await handle.done()
expect(server.address()).toBe(handle.address())
```

失败启动用例增加：

```ts
const server = newHTTPServer(failingHost, handler)
await expect(server.start(background())).rejects.toBe(failure)
expect(server.address()).toBeNull()
```

`public-types.ts` 增加：

```ts
const actualAddress: string | null = httpServer.address()
void actualAddress
```

- [ ] **Step 3：运行红灯**

```sh
bun test --isolate --no-orphans packages/transport/http/test/server.test.ts
bun run --filter @go-like/transport-http typecheck
```

预期：测试或类型检查因为 `HTTPServer.address` 尚不存在而失败；不得以 import、语法或 fixture 错误充当红灯。

- [ ] **Step 4：写最小实现**

在 `newHTTPServerFromOptions` 的 one-shot closure 中增加：

```ts
let publishedAddress: string | null = null
```

listener admission 和 `snapshotListenerAddress(listener)` 成功后、发布 handle 前赋值：

```ts
publishedAddress = actualAddress
```

返回的 `HTTPServer` 对象增加：

```ts
/** Returns null before admission and the stable actual bound address afterwards. */
address(): string | null {
  return publishedAddress
}
```

不得修改 Core 或清空 stopped address。

- [ ] **Step 5：运行绿灯和 package gate**

```sh
bun test --isolate --no-orphans packages/transport/http/test/server.test.ts
bun run --filter @go-like/transport-http typecheck
bun run --filter @go-like/transport-http test:coverage
git diff --check
```

预期全部退出 0，package production line/function coverage 仍为 100%。

- [ ] **Step 6：更新 README 并形成 after review package**

README 只增加 bind-then-register 示例；复制 after-tree，生成 `diff -ruN`、SHA-256 和测试日志，交给独立规范与
质量审查。

---

### Task 2：先用现有契约跑通真实联合 Docker recipe

**文件：**

- 创建：`e2e/scripts/registry-transport-consul-docker.ts`
- 创建：`e2e/cases/registry-transport-consul-call.case.ts`
- 修改：`e2e/suites.ts`
- 修改：`e2e/contracts.ts`
- 修改：`e2e/e2e.test.ts`
- 修改：`e2e/suites.test.ts`
- 修改：`e2e/validate.ts`

**接口：**

- 消费：Task 1 `HTTPServer.address()`、Registry `discovery/newRoundRobinSelector`、Transport
  `dial/send/recv/close`
- 产出：release-blocking suite `registry-transport-consul-docker`

- [ ] **Step 1：保存七个文件的 before-tree**

保存到 `/tmp/go-like-service-call-task-2.*`。同时 fresh 记录 Docker 的 `go-like-*` container/network/volume
清单；测试前已有资源必须保留，不能由本 suite 删除。

- [ ] **Step 2：写 suite inventory 红灯**

新增 sourced case：

```ts
export const sourcedCase = newSourcedCase({
  id: "registry-transport-consul-call",
  domain: "registry",
  source: {
    url: "https://github.com/micro/go-micro/blob/v6.8.0/client/client.go",
    retrievedAt: "2026-07-20",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "Two real HTTP nodes registered in Consul are discovered, selected and called without implicit retry.",
  runtimes: ["Bun 1.3.14"],
  services: ["Consul 2.0.2 Docker", "go-like HTTP Transport", "standard Fetch"],
  assertions: [
    "Dynamic addresses are registered after bind.",
    "Four real calls select nodes in a,b,a,b order.",
    "A stale endpoint fails without retrying another node.",
    "Discovery converges after deregistration."
  ],
  cleanupEvidence: ["Registrations, ports and Docker resources return to baseline."],
  suite: "registry-transport-consul-docker",
  scenario: "consul-discovery-http-call-lifecycle"
})
```

`suites.test.ts` 先期待：

```ts
"registry-transport-consul-docker": {
  cwd: ".",
  command: ["bun", "e2e/scripts/registry-transport-consul-docker.ts"]
}
```

- [ ] **Step 3：运行 inventory 红灯**

```sh
bun test --isolate --no-orphans e2e/e2e.test.ts e2e/suites.test.ts
```

预期因为 suite definition 尚未加入而出现精确断言失败；不得执行缺失脚本来制造 module-not-found。

- [ ] **Step 4：加入最小 suite definition 和 proof contract**

定义固定为：

```ts
{
  id: "registry-transport-consul-docker",
  cwd: ".",
  command: ["bun", "e2e/scripts/registry-transport-consul-docker.ts"],
  marker: "GO_LIKE_REGISTRY_TRANSPORT_CONSUL_E2E_RESULT=",
  runtime: "bun",
  services: ["Consul 2.0.2 Docker", "go-like HTTP Transport", "standard Fetch"],
  docker: true,
  releaseBlocking: true,
  timeoutMs: 180_000,
  expectations: []
}
```

中央 contract 必须逐字段验证 dynamic address、`a,b,a,b`、取消 identity、真实 500/no-retry、stale failure、watch
收敛和下列 cleanup：

```text
remainingContainers=0
remainingProviderRegistrations=0
registrationHandlesTerminal=true
discoveryWatcherTerminal=true
appStatus=stopped
appOrphans=0
httpPortsReleased=true
activeHandlers=0
unhandledRejections=0
runner.processTreeClean=true
runner.dockerResourcesRestored=true
```

- [ ] **Step 5：实现真实 recipe 脚本**

脚本只保留 `docker`、`mappedPort`、`ready`、`managedRemoteIds` 四个私有 Docker helper，不抽共享 harness。
调用 helper 在测试文件内保持普通函数：

```ts
async function call(
  ctx: Context,
  service: string,
  message: Message
): Promise<Message> {
  const instances = await discovered.getService(ctx, service)
  const [selected, done] = selector.select(ctx, instances)
  let client: TransportClient | null = null
  let failure: Error | null = null
  try {
    client = await transport.dial(ctx, selected.url)
    await client.send(ctx, message)
    return await client.recv(ctx)
  } catch (error) {
    failure = error instanceof Error ? error : new Error("transport call rejected", { cause: error })
    throw failure
  } finally {
    done(withoutCancel(ctx), { error: failure, status: null })
    if (client !== null) await client.close(background())
  }
}
```

它只作为提取 `@go-like/client` 前的真实 recipe，Task 4 必须删除。

服务拓扑：一个 fixed-digest Consul、两个 `127.0.0.1:0` HTTP Server、两个 registration、一个 discovery
watcher。真实故障顺序是停止 HTTP A、保留 registration A、命中 A 得到网络失败，再停止 registration A 并等待
watch 收敛。另建单节点 App 场景用 `HTTPServer.address()` 证明 bind-then-register 和逆序 drain。

- [ ] **Step 6：运行真实 Docker characterization**

```sh
bun run typecheck:e2e
bun run build
bun run test:e2e:inventory
bun run test:e2e:prepared -- --suite registry-transport-consul-docker
```

预期 inventory 为 `63 cases / 20 suites / 8 Docker suites`，联合 suite 退出 0。若失败，保留容器日志与真实错误，
修复根因；禁止替换为 mock。

- [ ] **Step 7：fresh 清理回读与审查**

测试前后分别执行 container/network/volume filter；确认两个端口可重新 bind。生成 after review package 与完整
Docker 输出，独立审查不应要求重跑相同 suite。

---

### Task 3：收敛 SelectionOutcome 并实现 `@go-like/client`

**文件：**

- 修改：`packages/registry/src/types.ts`
- 修改：`packages/registry/test/selector.test.ts`
- 修改：`packages/registry/test/public-types.ts`
- 修改：`packages/registry/test/runtime/cases.ts`
- 修改：`packages/registry/test/smoke/package-smoke.ts`
- 修改：`test/published/cases/integrations.ts`
- 创建：`packages/client/LICENSE`
- 创建：`packages/client/README.md`
- 创建：`packages/client/bunfig.toml`
- 创建：`packages/client/capability.json`
- 创建：`packages/client/owner.json`
- 创建：`packages/client/package.json`
- 创建：`packages/client/tsconfig.json`
- 创建：`packages/client/tsconfig.test.json`
- 创建：`packages/client/src/index.ts`
- 创建：`packages/client/test/client.test.ts`
- 创建：`packages/client/test/coverage-contract.ts`
- 创建：`packages/client/test/public-types.ts`
- 修改：`schemas/capability-manifest.schema.json`
- 修改：`tools/manifests/capability-vocabulary.ts`

**接口：**

- 消费：Task 2 已证明的局部 `call` recipe
- 产出：规范第 5 节的 `CallRequest`、`Client`、`newClient`

- [ ] **Step 1：保存精确 before-tree**

新文件以不存在记录；现有文件完整复制。保存到 `/tmp/go-like-service-call-task-3.*`。

- [ ] **Step 2：写 SelectionOutcome 类型红灯**

所有公开类型消费者改成：

```ts
const outcome: SelectionOutcome = { error: null }
done(background(), outcome)
```

运行：

```sh
bun run --filter @go-like/registry typecheck
```

预期因为当前 `status` 必填而失败。

- [ ] **Step 3：删除 HTTP-specific status 并运行 Registry 绿灯**

公共类型收敛为：

```ts
export interface SelectionOutcome {
  readonly error: Error | null
}
```

同步删除 Registry 自身及 published type/runtime 消费者的 `status`。运行：

```sh
bun run --filter @go-like/registry typecheck
bun run --filter @go-like/registry test:coverage
```

- [ ] **Step 4：先写 Client 行为测试，再补足可解析的 skeleton**

`package.json` 只依赖三个内部包，版本均为 `0.0.1`；capability 是 portable/non-resident/release-blocking 的
`client`，owner resources 为空。先创建 package 配置和 `test/client.test.ts`，不创建 production source；第一次
运行只用于确认测试入口确实指向缺失实现，该 module-not-found 不是合格红灯。随后创建只定义已批准类型、并让
`call` 拒绝 `not implemented` 的最小 `src/index.ts`，再次运行直到测试因目标行为缺失而失败。任何正式实现都必须
等这个行为红灯被观察后再写。

测试用结构式 Discovery、Selector、Transport 记录顺序，至少覆盖：

```ts
expect(events).toEqual([
  "discover:orders",
  "select",
  "dial:http://127.0.0.1:8080/",
  "send",
  "recv",
  "done:ok",
  "close"
])
```

以及：保留头大小写冲突在 I/O 前失败、无 Client 编排层 retry、每条 select 后路径恰好一次 done、dial 后必
close、原始 Error identity、Context cause、响应 snapshot、防御性 body copy、成功 response 不被 post-call
feedback/close failure 覆盖，以及主调用已失败时多失败 `AggregateError.errors` 顺序。

- [ ] **Step 5：运行并确认 Client 行为红灯**

```sh
bun test --isolate --no-orphans packages/client/test/client.test.ts
```

最终接受的红灯必须因 `not implemented` 出现行为断言失败；最初的 module-not-found 只算 setup probe，不能作为
TDD 证据。不得保留该字符串进入绿灯实现。

- [ ] **Step 6：实现单文件 Client**

公共面固定为：

```ts
export interface CallRequest {
  readonly service: string
  readonly endpoint: string
  readonly message: Message
}

export interface Client {
  call(ctx: Context, request: CallRequest): Promise<Message>
}

export function newClient(
  discovery: Discovery,
  selector: Selector,
  transport: Transport
): Client
```

实现只包含：结构式依赖方法捕获、well-formed non-empty string 校验、`snapshotMessage`、大小写不敏感保留头检查、
`Go-Like-Service/Go-Like-Endpoint` 合并、单次 get/select/dial/send/recv、`done(withoutCancel(ctx), outcome)`、
`close(background())`、成功 response 优先和主调用失败后的确定性错误聚合。不得拆
`types.ts/errors.ts/internal.ts`。

- [ ] **Step 7：运行 Client package 绿灯**

```sh
bun test --isolate --no-orphans packages/client/test/client.test.ts
bun run --filter @go-like/client typecheck
bun run --filter @go-like/client test:coverage
bun run --filter @go-like/registry test:coverage
bun tools/manifests/check.cli.ts --mode repository --root .
```

预期 package 与 Registry production line/function coverage 均为 100%，manifest vocabulary 接受 `client`。

- [ ] **Step 8：形成 after review package并独立双审**

检查没有 Client 编排层 retry、Client 私有 timeout、pool、codec、middleware、router、service error 或
transport-http import。

---

### Task 4：让真实 suite 消费发布 Client，并接入仓库门禁

**文件：**

- 修改：`e2e/scripts/registry-transport-consul-docker.ts`
- 修改：`e2e/contracts.ts`
- 修改：`tsconfig.base.json`
- 修改：`tsconfig.build.json`
- 修改：`bun.lock`
- 修改：`scripts/verify-workspace.test.ts`
- 修改：`scripts/release-config.test.ts`
- 修改：`scripts/published/cli.ts`
- 修改：`test/repository-contract.test.ts`
- 修改：`test/published/cases/portable.ts`
- 修改：`test/published/published.test.ts`
- 修改：`test/published/cases/integrations.ts`
- 修改：`README.md`
- 修改：`docs/adr/0002-build-runtime-and-coverage.md`
- 修改：`docs/adr/0004-service-registry-and-selection.md`
- 修改：`docs/capability-comparison.md`
- 创建：`.changeset/<generated-service-call-name>.md`
- 重新生成：`docs/file-inventory.md`

**接口：**

- 消费：Task 3 `newClient`
- 产出：24 个发布包、28 个 workspaces、42 个 public exports、46 个 TS path aliases 的一致仓库事实

- [ ] **Step 1：保存门禁文件 before-tree**

保存到 `/tmp/go-like-service-call-task-4.*`。先运行现有 workspace/release/repository/published tests 记录基线，
不得把已有失败归因于本任务。

- [ ] **Step 2：把联合 suite 的局部 helper 替换为 `@go-like/client`**

删除 Task 2 私有 `call` 函数，改为：

```ts
const client = newClient(discovered, selector, transport)
const response = await client.call(ctx, {
  service: "orders",
  endpoint: "Orders.Get",
  message: requestMessage
})
```

更新 proof contract，使 feedback 只断言 `{ error }`。运行真实 suite；输出必须与 Task 2 recipe 完全相同。

- [ ] **Step 3：更新唯一仓库事实表**

增加 `@go-like/client` path/reference/identity/dependencies/capability/export；数量精确变为：

```text
release packages: 24
all workspaces: 28
public exports: 42
TypeScript paths: 46
E2E cases/suites/Docker suites: 63/20/8
```

执行 `bun install --lockfile-only --ignore-scripts` fresh 更新 lock；不得手写 lockfile。

- [ ] **Step 4：写真实 published runtime/type consumer**

runtime consumer 必须构造结构式 Discovery/Selector/Transport 并完成一次 `newClient().call()`，检查 headers、body、
feedback 和 close；type consumer必须把 `CallRequest`、`Client`、`newClient` 赋给精确声明类型。不得只 import identity。

`transport-http` published consumer同时锁定 `HTTPServer.address(): string | null`。

- [ ] **Step 5：更新中文文档与 Changeset**

README、ADR 0004、能力矩阵写清薄 Client、无隐式 retry 和 Web/Transport 边界；ADR 0002 的发布包数量改为 24。
Changeset 只包含：

```md
---
"@go-like/client": patch
"@go-like/registry": patch
"@go-like/transport-http": patch
---

补齐基于服务发现和内部 HTTP Transport 的单次调用闭环，并公开启动后的实际监听地址。
```

- [ ] **Step 6：运行 repository/package 绿灯**

```sh
bun run fmt
bun run verify:workspace
bun run verify:manifests
bun test --isolate --no-orphans \
  scripts/verify-workspace.test.ts \
  scripts/release-config.test.ts \
  test/repository-contract.test.ts \
  test/published/published.test.ts
bun scripts/generate-file-inventory.cli.ts
bun run verify:file-inventory
bun run typecheck
bun run build
```

预期全部退出 0。

- [ ] **Step 7：运行发布包与真实 Docker 绿灯**

```sh
bun scripts/published/cli.ts --gate runtime --package @go-like/client
bun scripts/published/cli.ts --gate types --package @go-like/client
bun scripts/published/cli.ts --gate runtime --package @go-like/transport-http
bun scripts/published/cli.ts --gate types --package @go-like/transport-http
bun run test:e2e:prepared -- --suite registry-transport-consul-docker
```

published gate 必须使用新构建 tarball，Docker suite 必须留下零资源。

- [ ] **Step 8：形成 after review package 并独立双审**

审查重点：唯一 package facts、published consumer 真实性、无临时 helper、无 implicit retry、Changeset scope 和中文
文档与 API 一致。

---

### Task 5：阶段级 fresh 验证与 broad review

**文件：**

- 修改：`.superpowers/sdd/progress.md`（仅追加证据）
- 不新增 production 文件

- [ ] **Step 1：逐条回读规范与四项任务 scope**

确认每个 MUST 都能指向实现文件和 fresh 测试；确认 OTel/Prometheus/log/health 属于下一独立计划，未被本阶段
假报完成。

- [ ] **Step 2：运行完整阶段门禁**

```sh
bun run fmt:check
bun run verify:workspace
bun run verify:manifests
bun run verify:file-inventory
bun run clean:generated
bun run typecheck
bun run build
bun run test:coverage
bun run test:coverage:workspaces
bun run test:examples:node
bun run test:published
bun run test:e2e:prepared
git diff --check
```

不得用 Task 1-4 的旧输出代替本次 fresh 全量输出。Docker suite 任一失败即按真实失败报告。

- [ ] **Step 3：fresh Docker 与文件状态回读**

验证没有新增 `go-like-*` container/network/volume、没有监听端口或子进程残留；保存完整 `git status --short`，确认
无计划外文件被改动。

- [ ] **Step 4：执行 broad final review**

review package 必须包含设计、计划、四项 before/after diff、测试日志、Docker inventory 和当前完整工作树状态。
Critical/Important finding 由一个 fix agent 集中修复并重跑覆盖 tests，再复审。

- [ ] **Step 5：追加 progress ledger**

只在所有 fresh gate 与 broad review 通过后，追加完成证据；不得改写原有 ledger prefix，也不得 commit。
