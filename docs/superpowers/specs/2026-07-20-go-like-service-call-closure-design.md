# go-like 服务调用闭环设计

日期：2026-07-20

状态：用户已批准，进入分阶段实施

## 1. 目标

go-like 已经具备独立的 Core 生命周期、Registry/Discovery/Selector、Transport/HTTP client+server、Web、
配置、韧性、任务、消息、日志生命周期与可观测性生命周期包，但尚未用一个真实场景证明：应用能够按服务名
发现实例、选择端点并通过内部 HTTP Transport 完成调用。

本设计补齐这条调用闭环，同时保持以下边界：

- Core 继续只编排任意结构式 `Server`，不暴露子句柄，不认识 endpoint；
- Registry 继续只提供服务事实，resolver 负责把 opaque address 转换为可调用 URL；
- Transport 继续只传输不可变 `Message`，不负责服务发现、路由、重试或业务编解码；
- Web 继续只承接标准 `Request -> Response` 公网入口；
- 不新增总管式 `Service`、RPC Router、reflection、codec registry、DI 或 middleware DSL；
- 所有 I/O、取消、清理和外部服务能力必须由真实运行证据验证，不能用 fake 证明网络协议或容器生命周期。

本文修订 ADR 0004 中“排除通用 RPC client”的范围：仍排除 go-micro 式厚 RPC client，但允许一个只组合
`Discovery + Selector + Transport` 的薄 unary client。

## 2. 最新上游与本仓证据

2026-07-20 通过 GitHub 官方 API fresh 核实：

- go-micro 最新 release 是 `v6.8.0`，tag commit
  `db4401d306039be2614e0e3657c6a5c6473feb3b`；默认分支 HEAD 为
  `9d306dcfc1a912a8a9493f31fee0bb983475258d`；
- go-kratos 最新 release 是 `v3.0.0`，release 与默认分支 commit 均为
  `668db92c2c001e9552594ba5a8aede8456af6d7e`；
- go-zlab/go-kratos 最新 release 是 `v1.0.0`，release commit 为
  `2a47dd8baf53b79023005781d456ef8e1e4abfb1`，默认分支 HEAD 为
  `ecd00dd24491d09642c76542f94e392c6d639336`。

当前本仓真实基线：

- `transport-http-node` 在 Node 26.5.0 的真实 listener/Fetch/TCP loopback 上通过 4 个场景；
- `registry-consul-docker` 在固定 digest 的 Consul 2.0.2 容器上通过 14 个场景；
- 两套门禁分别正确，但仓库没有任何生产或 E2E 路径同时组合 Registry 与 Transport；
- 当前 HTTP Server 的实际动态地址只存在于 `HTTPServerHandle.address()`；Core App 内部保存子句柄但不外露。

因此第一项交付不是新增抽象，而是用真实 Consul 和真实 HTTP 服务证明现有底层契约可以闭合。

## 3. 包与依赖

唯一新增发布包是：

```text
packages/client/              @go-like/client
```

生产依赖固定为：

```text
@go-like/context
@go-like/registry
@go-like/transport
```

`@go-like/client` 不依赖 `@go-like/core`、`@go-like/resilience`、`@go-like/transport-http`、`@go-like/web` 或任何
供应商包。应用 composition root 负责选择 Consul/mDNS、resolver 和具体 Transport。

现有包的依赖扩展分阶段处理：

- `@go-like/otel` 只有在真实传播实验通过后，才依赖 `@go-like/client` 与 `@go-like/transport`；
- `@go-like/prometheus` 只有在真实指标行为测试通过后，才依赖 `@go-like/client` 与 `@go-like/transport`；
- `@go-like/pino`、`@go-like/winston` 可以用各一个纯机械函数适配现有 `TransportLogger`，不定义 go-like 日志门面。

## 4. HTTP Server 动态地址

`@go-like/transport-http` 扩展现有接口：

```ts
export interface HTTPServer extends Server<HTTPServerHandle> {
  /** Returns null until start succeeds, then the stable actual bound address. */
  address(): string | null
}
```

精确语义：

- construction、idle、starting 和失败但从未成功绑定时返回 `null`；
- listener admission 成功后返回与对应 handle `address()` 完全相同的字符串；
- stopping、stopped 或后续 `done()` rejection 不清除已经发布的地址；
- getter 同步、无 I/O、无副作用且不抛错；
- 地址仍是 transport authority，不自动增加 scheme、path 或 Registry metadata。

应用按顺序把 HTTP Server 和 `registration(...)` 交给 Core App。后者的 `ServiceSource` 在启动时读取
`httpServer.address()`；Core 继续使用现有顺序启动、失败回滚和逆序停止。

不修改 `Server`、`ServerHandle`、`AppHandle`，不增加通用 `Endpointer`、capture combinator 或 registered
composite server。

## 5. `@go-like/client` 公共 API

```ts
import type { Context } from "@go-like/context"
import type { Discovery, Selector } from "@go-like/registry"
import type { Message, Transport } from "@go-like/transport"

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

不提供 functional options、默认 timeout、泛型 body、JSON helper、`close()`、watch cache、连接池、retry 或
全局默认实例。

### 5.1 输入与 header

- `service`、`endpoint` 必须是非空且 UTF-16 well-formed 的字符串；
- `message` 在任何 I/O 前通过现有 `snapshotMessage` 防御性复制；
- client 独占大小写不敏感的 `Go-Like-Service` 与 `Go-Like-Endpoint`；调用方预置任一保留头时，在 discovery
  之前以 `TypeError` 拒绝；
- client 不写 `Go-Like-Method`、trace、ID、namespace、target 或 error header；
- body 保持 opaque `Uint8Array`，序列化由应用拥有。

### 5.2 调用顺序

一次 `call` 固定执行：

```text
snapshot/validate
→ discovery.getService(ctx, service)
→ selector.select(ctx, instances)
→ transport.dial(ctx, selected.url)
→ client.send(ctx, message)
→ client.recv(ctx)
→ SelectionDone exactly once
→ transport client close exactly once
```

- 没有 Client 编排层的隐式 retry；一次 `call` 最多选择一个 endpoint、创建一个 transport client、执行一次 send 和一次 recv；
- 调用方若使用 `@go-like/resilience.retry`，必须在每次 attempt 内重新调用 `Client.call`；
- `SelectionDone` 只在 selection 已成功后调用一次，outcome 只包含 dial/send/recv 的主结果；
- feedback 使用 `withoutCancel(ctx)`，保留 Context values 但不让已经终止的调用阻止 selector bookkeeping；
- dial 成功后，client close 使用 `background()`，确保调用取消不会阻止 owner cleanup；
- close failure 不反馈为节点健康失败；注入的 Transport 必须让 owner close 终态，provider 自己拥有必要的 cleanup
  budget 与诊断；
- `withoutCancel(ctx)` 不再暴露原调用的取消状态，caller cancellation 的 identity 只由 outcome error 携带；v1
  round-robin 不解释 feedback，自定义健康策略不得把所有 Error 都直接判为坏节点。

### 5.3 错误

- 原生 `Error` rejection 保持 identity；非 `Error` boundary rejection 转换为带 `cause` 的普通 `Error`；
- 单一失败直接返回该 Error；
- 主调用已经失败且 feedback、close 又独立失败时，按“主调用、feedback、close”顺序返回标准
  `AggregateError`；
- 一旦成功取得并快照 response，后置 feedback 或 close failure 不得抹掉成功 Message，避免上层把已完成请求当成
  普通调用失败而重放；provider 对这类 post-call cleanup failure 负责自身诊断；
- `@go-like/client` 自身不创建 timer 或默认 timeout，并把调用 Context 原样交给依赖；注入的 Transport 可以拥有
  provider-specific timeout 策略，例如当前 HTTP Transport 的 5 秒响应头 admission timeout；
- client 不识别 HTTP status，也不依赖 `HTTPStatusError`。

`SelectionOutcome.status` 从 provider-neutral Registry 类型中删除，只保留：

```ts
export interface SelectionOutcome {
  readonly error: Error | null
}
```

如果该字段在实施时已存在外部发布兼容承诺，则保留并固定为 `null`；当前仓库版本仍为 `0.0.1`，优先在首次
稳定发布前删除错误的 HTTP 泄漏。

## 6. 服务端边界

服务端继续使用现有 `AcceptHandler` 与 `Socket`：

```text
recv Message
→ 读取 Go-Like-Service / Go-Like-Endpoint
→ 应用自行分派
→ send Message
```

go-like 不新增通用 RPC Router 或 handler registry。应用可以直接 switch、调用自己的 router，或自行实现任意
`Server` 并交给 Core。

handler 抛出的异常继续由 HTTP Transport 转为不泄露服务端细节的 500，客户端得到现有
`HTTPStatusError`。本轮不新增跨 Transport 业务错误 envelope；该协议只有在至少两个 transport 或两个真实
业务调用方需要相同错误语义时再设计。

## 7. 运行能力连接

服务调用闭环通过后，再独立实施和验真以下薄连接：

1. Pino/Winston：各导出一个 `transportLogger(nativeLogger): TransportLogger`，只映射四个已有 level 和 fields；
   不包装 logger、不复制 format/child/transport API。
2. OpenTelemetry：先在临时目录以真实 OTel SDK/Context Manager 验证 W3C inject/extract 和异步 active context；
   只有实验能保持 parent/child 关系，才实现 Client 与 unary `AcceptHandler` 包装。若现有 `AcceptHandler` 形状无法
   无损提取 inbound carrier，则记录证据并不发布有缺陷的 wrapper。
3. Prometheus：只在 `Client.call` 或可以无损观察的 unary handler 边界记录 duration/outcome；labels 固定为
   service、endpoint、outcome，不使用节点 URL、错误文本、trace ID 等高基数字段。
4. Health：空 `ready` probe snapshot 返回 `ok:false`，空 `live` 继续返回 `ok:true`；应用启动期间因此 fail
   closed，注册运行中的 App probe 后才 ready。

这些能力不引入公共 middleware 类型。具体 wrapper 是接收并返回相同结构式接口的普通函数。

## 8. 真实联合 E2E

新增 `registry-transport-consul-docker` suite，使用固定 digest 的 Consul 2.0.2 容器、Node 26.5.0 的真实 HTTP
listener 与标准 Fetch。HTTP 服务绑定 `127.0.0.1:0`，不使用 fake Registry、fake Transport 或硬编码端口。

必须覆盖：

1. HTTP A/B 的实际端口非零且不同，注册后 discovery snapshot 精确包含两个节点；
2. resolver 显式生成 `http://<authority>`，四次真实调用结果严格为 `a,b,a,b`；
3. 阻塞调用被自定义 Context cause 取消，返回同一 Error identity，transport client 完成关闭；
4. 一个节点的 handler 拒绝并由现有 HTTP Transport 真实映射为 HTTP 500，调用失败且不自动重试另一节点，
   `SelectionDone` 恰好收到一次同一 Error；
5. 先停止 HTTP A、保留 registration A，下一次命中 A 时产生真实网络失败；
6. 停止 registration A 后 discovery watch 最终收敛为仅 B，后续调用只到 B；
7. 独立 App 场景证明 HTTP 先启动、动态地址注册后启动、停止时先撤注册再释放 HTTP 端口；
8. watcher、registration、HTTP handle、client 全部 terminal；Consul readback 为零，端口可重新 bind；
9. pending timer、active request、unhandled rejection 为零，runner 证明 process tree 和 Docker inventory 恢复。

真实故障注入需要直接持有单项 handles；不为测试扩展 Core App 子句柄 API。

## 9. 实施分解

本设计拆成三个独立计划，每个都产生可运行软件：

1. 服务调用闭环：HTTP Server address、SelectionOutcome 收敛、联合 Docker E2E、`@go-like/client`；
2. 运行连接：Health fail-closed、日志适配、OTel 真实传播实验与可实施 wrapper、Prometheus wrapper；
3. 文档与发布门禁：示例、ADR/README/能力矩阵、24 包 inventory、Changeset、published gates 和全量真实 E2E。

不在一个任务中并行修改同一文件。每项行为遵守 TDD 红—绿；Docker 服务失败、镜像不可用或网络环境不满足
时报告真实阻塞，不替换成 mock 并宣称通过。

## 10. 完成条件

只有以下证据全部 fresh 通过，才可以宣称完整落地：

- package targeted tests、100% line/function coverage、typecheck 和 build；
- published runtime/types 对 24 个发布包及全部 exports 的真实 tarball 安装验证；
- 新联合 Docker suite 以及原有 Consul、mDNS、HTTP、NATS、Redis、OTel Collector suites；
- `fmt:check`、workspace、manifest、file inventory、root/e2e/workspace typecheck；
- 完整 `bun run verify` 退出 0；
- Docker 容器、网络、卷、端口、进程树和 timer 无残留；
- 独立规范审查、代码质量审查和最终 broad review 无阻断意见。

实施直接发生在当前真实路径的 dirty `main` 工作树；不创建 worktree 或 feature branch，不 reset 或覆盖用户
已有改动。未经用户另行授权，不 commit、push、PR、publish 或 deploy。
