# go-like 包拓扑、Transport 与 Web 边界设计

日期：2026-07-19

状态：部分被后续决策取代；保留为历史实施依据

> 更新（2026-08-03）：本文关于 `@go-like/hono`、`@go-like/h3`、`@go-like/elysia` 的设计已被原生 Fetch 边界取代。Hono、Elysia 与 H3 2.x 直接提供 `app.fetch`，H3 1.x 使用官方 `toWebHandler(app)`；当前边界见 [ADR 0003](../../adr/0003-resident-adapter-ownership.md)。

## 1. 文档效力

本文档收敛 go-like v1 的包拓扑，以及内部微服务传输、注册发现与外部 Web 服务的边界。它覆盖并替代现有
设计中关于 `adapters/`、`@go-like/fetch`、Fetch 作为 transport、框架适配器位置、transport 缺失和 Consul
跨能力域聚合的描述；Context、App/Server 生命周期、配置、韧性、日志、任务、消息和可观测性的既有行为
约束继续有效。

本轮只形成设计和后续实施依据，不保留尚未发布包的兼容壳。实施直接在当前 `main` 工作树进行，不创建
feature 分支或 worktree；除非用户单独授权，不提交、不推送、不发布。

## 2. 已确认的产品决策

1. 所有可发布包统一位于 `packages/`；删除 `adapters/` 这一产品层级。
2. 单一能力域的供应商或框架包使用短包名，例如 `@go-like/hono`、`@go-like/pino`；当实现必须归属公共
   能力域并与父契约形成对称结构时，使用 `@go-like/<domain>-<implementation>`，例如
   `@go-like/transport-http`、`@go-like/registry-mdns` 和 `@go-like/registry-consul`。
3. `@go-like/transport` 只定义内部微服务同步通信的公共契约，不依赖任何具体传输实现。
4. HTTP 传输实现名为 `@go-like/transport-http`，物理路径固定为 `packages/transport/http`。它同时提供
   client 与 server：`dial` 是 client 入口，`listen/accept` 是底层 server 入口，`newHTTPServer` 是可交给
   Core 编排的生命周期入口。不存在 `@go-like/http`。
5. 对外 HTTP/Web 服务属于 `@go-like/web`，物理路径为 `packages/web`。Web 框架不进入 transport 域。
6. 删除 `@go-like/fetch`。标准 `Request -> Response` handler 与 request-to-Context 桥接进入
   `@go-like/web`；Fetch 在 `@go-like/transport-http` 中仅作为内部 HTTP wire 的可移植执行能力。
7. Hono、H3、Elysia 等产品包在 `packages/` 下平铺，不放入 `packages/web/*`。
8. 第三方能力继续遵守 native-first：go-like 只提供公共契约、必要的机械适配和 Server 生命周期，不复制
   框架路由、Broker 业务 API、日志配置或供应商 SDK。
9. gRPC、Protobuf、IDL 生成不进入 v1。
10. Registry 与 transport 使用相同的“公共契约父包 + 实现子 workspace”结构：
    `packages/registry`、`packages/registry/mdns`、`packages/registry/consul`。配置域的 Consul 实现独立位于
    `packages/config/consul`，不再用一个 `@go-like/consul` 聚合两个能力域。
11. mDNS 是第一版 Registry 实现，并使用 go-like 自有 wire namespace；标准 Web API 没有 UDP multicast，
    因此 portable 根入口必须注入 host SPI，首个真实实现由 `./node` 子路径提供。
12. “Go style”只对齐显式 Context、functional options、小接口与生命周期，不复制 Go 依赖首字母控制可见性的
    命名规则。TypeScript 的函数、工厂、option、常量和普通运行时值统一使用 `camelCase` 并通过 `export`
    显式导出；`type`、`interface`、class 与 Error 构造器按 TypeScript 惯例使用 `PascalCase`。

## 3. 最新上游基线

本设计在 2026-07-19 通过 Git 默认分支 HEAD 重新核实，所有源码链接均固定到提交，避免默认分支后续漂移。

| 项目                                                                                                    | 默认分支与提交                                        | 本设计采用的事实                                                            |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------- |
| [micro/go-micro](https://github.com/micro/go-micro/tree/db4401d306039be2614e0e3657c6a5c6473feb3b)       | `master` / `db4401d306039be2614e0e3657c6a5c6473feb3b` | 根级能力域、`transport` 公共 SPI、HTTP/memory/NATS 实现、独立 `web.Service` |
| [go-kratos/kratos](https://github.com/go-kratos/kratos/tree/668db92c2c001e9552594ba5a8aede8456af6d7e)   | `main` / `668db92c2c001e9552594ba5a8aede8456af6d7e`   | 小接口、结构式 Server、核心包与 contrib/provider 分离                       |
| [go-zlab/go-kratos](https://github.com/go-zlab/go-kratos/tree/ecd00dd24491d09642c76542f94e392c6d639336) | `main` / `ecd00dd24491d09642c76542f94e392c6d639336`   | 应用可自行组合任意 Server，Cron/Gin/Asynq 等只适配生命周期                  |

go-micro 当前公共 transport 契约以
[transport.go](https://github.com/micro/go-micro/blob/db4401d306039be2614e0e3657c6a5c6473feb3b/transport/transport.go)、
[options.go](https://github.com/micro/go-micro/blob/db4401d306039be2614e0e3657c6a5c6473feb3b/transport/options.go) 和
[headers](https://github.com/micro/go-micro/blob/db4401d306039be2614e0e3657c6a5c6473feb3b/transport/headers/headers.go)
为准。默认 HTTP 实现并非普通 Fetch handler：HTTP/1 会 hijack 原始连接，HTTP/2/H2C 会把 request body
和 response writer 当双向流，并直接控制 TCP deadline、TLS、ALPN 与连接复用。相关事实见
[HTTP listener](https://github.com/micro/go-micro/blob/db4401d306039be2614e0e3657c6a5c6473feb3b/transport/http_listener.go)、
[HTTP client](https://github.com/micro/go-micro/blob/db4401d306039be2614e0e3657c6a5c6473feb3b/transport/http_client.go) 和
[HTTP socket](https://github.com/micro/go-micro/blob/db4401d306039be2614e0e3657c6a5c6473feb3b/transport/http_socket.go)。

go-micro 的 Registry 公共面以
[registry.go](https://github.com/micro/go-micro/blob/db4401d306039be2614e0e3657c6a5c6473feb3b/registry/registry.go)、
[options.go](https://github.com/micro/go-micro/blob/db4401d306039be2614e0e3657c6a5c6473feb3b/registry/options.go)、
[watcher.go](https://github.com/micro/go-micro/blob/db4401d306039be2614e0e3657c6a5c6473feb3b/registry/watcher.go) 和
[mDNS implementation](https://github.com/micro/go-micro/blob/db4401d306039be2614e0e3657c6a5c6473feb3b/registry/mdns_registry.go)
为准。其默认 mDNS 实现存在 TTL option 未兑现、watch 丢事件、崩溃后不产生 delete、Service metadata
未上 wire 等行为；go-like 对齐公共角色，不把这些缺陷升级成自身契约。

go-kratos 当前 HTTP transport 同时具有
[HTTP Server](https://github.com/go-kratos/kratos/blob/668db92c2c001e9552594ba5a8aede8456af6d7e/transport/http/server.go)
与
[HTTP Client](https://github.com/go-kratos/kratos/blob/668db92c2c001e9552594ba5a8aede8456af6d7e/transport/http/client.go)，
其 Server 实现公共 transport lifecycle。go-like 因此同时保留 go-micro 的 `dial/listen/accept` 低层形状与
go-kratos 的可编排 HTTP Server 角色，不复制 Kratos router、middleware、codec 或 Protobuf 调用层。

实施时使用当日 npm `latest` 快照并精确锁定。设计核实时的直接依赖版本为：Standard Schema `1.1.0`、
Hono `4.12.31`、H3 `2.0.1-rc.25`、Elysia `1.4.29`、Croner
`10.0.1`、BullMQ `5.81.1`、`@nats-io/transport-node` 与 `@nats-io/jetstream` `3.4.0`、Pino
`10.3.1`、Winston `3.19.0`、Prom Client `15.1.3`、OpenTelemetry API `1.9.1`、SDK Metrics 与
SDK Trace `2.10.0`。mDNS 候选调研到 `multicast-dns` `7.2.5` 与 `dns-packet` `5.6.1`；v1 不把它们放入 portable
production graph：前者同时拥有 Node socket/packet lifecycle，后者声明 Node engine，都会破坏本文固定的
host ownership 或标准 Web graph。portable packet/TXT codec 按第 9 节受限 wire 实现，Node host 只用
`node:dgram`/`node:os`。版本只在重新生成 lockfile 时更新，不在源码中散落动态版本判断。

可实施性探针也在 2026-07-19 实际执行：Bun `1.3.14`、Node `26.5.0` 与 Deno `2.9.3` 均完成标准
`CompressionStream("deflate")` round-trip，且 Bun/Node 产物可由 Deno 解压、Deno 产物可由 Bun/Node 解压。
Docker `29.6.1` 上使用 `node:26.5.0-alpine@sha256:e88a35be04478413b7c71c455cd9865de9b9360e1f43456be5951032d7ac1a66`
和自定义 bridge 启动两个独立容器，observer 加入 `224.0.0.251:5353` 后真实收到 publisher 的 UDP multicast；
测试容器和网络已清理。该结果只证明 codec 与 IPv4 host SPI 路径可实施，不替代最终 DNS packet、TTL、watch、
crash expiry 和完整 provider E2E。

## 4. 方案比较

### 4.1 采用：能力域公共包 + 实现 workspace

公共能力由 `@go-like/transport`、`@go-like/web`、`@go-like/registry` 等包定义。框架包保持 `packages/` 平铺；
transport 与 registry 的具体实现放在对应父目录下，并仍作为独立 npm workspace 发布。该方案最接近
go-micro 的能力域组织，同时保留 npm 独立发布、按需依赖和清晰依赖方向。

### 4.2 不采用：保留 `adapters/`，只重命名 npm 包

该方案修改量较小，但目录仍把第三方能力视为二等实现，并且同一产品概念会同时由目录和 npm 名表达两套
分类。它不满足已经确认的 `packages/` 平铺要求。

### 4.3 不采用：单一 `@go-like/core` 或 `@go-like/micro` 总管门面

该方案会把 Web、transport、registry、日志和框架生命周期聚合到一个对象，形成隐式依赖、默认实现环和
难以独立发布的 API。它也会重复第三方框架已有的 router、client、middleware 与配置能力。

## 5. 最终包拓扑

v1 固定为 23 个 release-blocking 包和 4 个 private example workspace。目录树如下：

```text
packages/
  context/                 @go-like/context
  core/                    @go-like/core
  config/                  @go-like/config
    consul/                @go-like/config-consul
  health/                  @go-like/health
  registry/                @go-like/registry
    consul/                @go-like/registry-consul
    mdns/                  @go-like/registry-mdns
  resilience/              @go-like/resilience
  testing/                 @go-like/testing
  transport/               @go-like/transport
    http/                   @go-like/transport-http
  web/                     @go-like/web
  hono/                    @go-like/hono
  h3/                      @go-like/h3
  elysia/                  @go-like/elysia
  croner/                  @go-like/croner
  bullmq/                  @go-like/bullmq
  nats/                    @go-like/nats
  pino/                    @go-like/pino
  winston/                 @go-like/winston
  otel/                    @go-like/otel
  prometheus/              @go-like/prometheus
```

发布包与旧实现的精确映射如下：

| 新包                       | 公开子路径                                  | 旧来源与处理                                                                           |
| -------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------- |
| `@go-like/context`         | `.`                                         | 保留                                                                                   |
| `@go-like/core`            | `.`, `./lifecycle`                          | 保留 App、Server、ServerHandle 与现有 Context wait helper；不聚合 transport 或 Web     |
| `@go-like/config`          | `.`, `./env`, `./file`                      | 合并 `@go-like/config-env` 与 `@go-like/config-file`                                   |
| `@go-like/config-consul`   | `.`                                         | 从 `@go-like/config-consul` 迁入 `packages/config/consul`；继续使用标准 Fetch          |
| `@go-like/health`          | `.`                                         | 只保留 probe 域；HTTP handler 迁到 `@go-like/web/health`                               |
| `@go-like/registry`        | `.`, `./testing`                            | 对齐 Registry/Service/Node/Endpoint/Value/Watcher，并保留便利层与 provider conformance |
| `@go-like/registry-consul` | `.`                                         | 从 `@go-like/registry-consul` 迁入 `packages/registry/consul`；继续使用标准 Fetch      |
| `@go-like/registry-mdns`   | `.`, `./node`, `./testing`                  | 新增 portable mDNS provider、host SPI、首个真实 Node UDP multicast host                |
| `@go-like/resilience`      | `.`                                         | 保留 retry、backoff、breaker、limiter                                                  |
| `@go-like/testing`         | `.`, `./server`, `./listener`               | 保留 Server 契约并新增仅供测试使用的 listener conformance                              |
| `@go-like/transport`       | `.`, `./headers`, `./testing`               | 新增内部通信 SPI、go-like headers 与 transport conformance suite                       |
| `@go-like/transport-http`  | `.`, `./node`, `./testing`                  | 新增 Fetch unary client、底层 listener server、Core lifecycle server 与首个 Node host  |
| `@go-like/web`             | `.`, `./health`, `./node`, `./node/testing` | 吸收 `@go-like/fetch` 与 `@go-like/fetch-node` 的正确职责                              |
| `@go-like/hono`            | `.`                                         | Hono native app 到 `@go-like/web` Handler 的薄接缝                                     |
| `@go-like/h3`              | `.`                                         | H3 native app 到 `@go-like/web` Handler 的薄接缝                                       |
| `@go-like/elysia`          | `.`                                         | Elysia native app 到 `@go-like/web` Handler 的薄接缝                                   |
| `@go-like/croner`          | `.`                                         | 重命名 `@go-like/cron-croner`，继续只适配 Cron 生命周期                                |
| `@go-like/bullmq`          | `.`, `./testing`                            | 重命名 `@go-like/job-bullmq-node`                                                      |
| `@go-like/nats`            | `.`, `./jetstream`                          | 合并两个 NATS 包；根入口是 core transport，子路径保留 JetStream                        |
| `@go-like/pino`            | `.`                                         | 重命名 `@go-like/log-pino-node`                                                        |
| `@go-like/winston`         | `.`                                         | 重命名 `@go-like/log-winston-node`                                                     |
| `@go-like/otel`            | `.`, `./testing`                            | 重命名 `@go-like/otel-node`                                                            |
| `@go-like/prometheus`      | `.`                                         | 重命名 `@go-like/metrics-prom-client-node`，handler 类型改用 `@go-like/web`            |

`@go-like/consule` 是拼写错误，不创建该包；`@go-like/consul` 聚合包也不创建。所有旧 adapter 包名、
`@go-like/fetch`、`@go-like/fetch-node`、候选名 `@go-like/http` 和 `adapters/` 目录在迁移完成后均不存在。

四个 private workspace 的最终 identity 同样固定，不使用过渡名：

| 目录                   | package name                   |
| ---------------------- | ------------------------------ |
| `examples/vanilla-web` | `@go-like/example-vanilla-web` |
| `examples/hono`        | `@go-like/example-hono`        |
| `examples/h3`          | `@go-like/example-h3`          |
| `examples/elysia`      | `@go-like/example-elysia`      |

## 6. 依赖方向

下表是 v1 workspace 的完整直接 production/peer 依赖，不包含 `@types/*`、测试工具和同包内部子路径；它同时
用于校验 package manifests 与 build order，不能只当示意图。

| 包                         | 直接 workspace 依赖      | 外部 production/peer 依赖                                                      |
| -------------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| `@go-like/context`         | 无                       | 无                                                                             |
| `@go-like/core`            | context                  | 无                                                                             |
| `@go-like/config`          | context、core            | `@standard-schema/spec`                                                        |
| `@go-like/config-consul`   | config、context、core    | 无；Fetch 由应用注入                                                           |
| `@go-like/health`          | context、core            | 无                                                                             |
| `@go-like/registry`        | context、core            | 无                                                                             |
| `@go-like/registry-consul` | registry、context、core  | 无；Fetch 由应用注入                                                           |
| `@go-like/registry-mdns`   | registry、context、core  | portable codec 不依赖 Node SDK                                                 |
| `@go-like/resilience`      | context                  | 无                                                                             |
| `@go-like/testing`         | context、core            | 无；只能作为 devDependency 使用                                                |
| `@go-like/transport`       | context                  | 无                                                                             |
| `@go-like/transport-http`  | transport、context、core | Node host 依赖在同包条件子路径隔离                                             |
| `@go-like/web`             | context、core、health    | 无；Node Fetch bridge 内置且只由 `./node` 使用                                 |
| `@go-like/hono`            | web                      | `hono` peer                                                                    |
| `@go-like/h3`              | web                      | `h3` peer                                                                      |
| `@go-like/elysia`          | web                      | `elysia` peer                                                                  |
| `@go-like/croner`          | context、core            | `croner`                                                                       |
| `@go-like/bullmq`          | context、core            | `bullmq`                                                                       |
| `@go-like/nats`            | context、core            | `@nats-io/transport-node`、`@nats-io/jetstream`                                |
| `@go-like/pino`            | context、core            | `pino` production；Pino 自行拥有其 `sonic-boom` implementation dependency      |
| `@go-like/winston`         | context、core            | `winston`                                                                      |
| `@go-like/otel`            | context、core            | `@opentelemetry/api`、`@opentelemetry/sdk-metrics`、`@opentelemetry/sdk-trace` |
| `@go-like/prometheus`      | web                      | `prom-client`                                                                  |

`@go-like/testing/listener` 只通过 devDependency 进入 transport-http 与 Web 的测试图，绝不成为两者的 production
依赖。`@go-like/web/node`、`@go-like/web/health` 等子路径已经计入所属 workspace 的依赖行，不是额外包。

`@go-like/pino` 不得把 `sonic-boom` 声明为 production、dev 或 peer direct dependency，也不得 import 其实现。
Pino `10.3.1` 自己声明 `sonic-boom ^4.0.1`，该范围及实际解析版本由 Pino 的 dependency graph 管理；go-like
不得 override 到不受 Pino 支持的 `5.x`。消费应用可以显式依赖 SonicBoom `5.0.0`，npm 应让应用的 `5.x` 与
Pino 自己解析的 `4.x` 共存。真实 tarball 安装门禁必须用这一 isolated consumer 图运行完整生命周期，证明
`@go-like/pino` 没有隐藏的 direct/peer coupling。

运行时接纳 Pino file destination 或 ThreadStream 的生命周期与终态结构，不再声称 exact implementation package
provenance。Pino file destination 仍需暴露布尔 `_ending`、`destroyed`、`writable` 与 `destroy()`；ThreadStream
仍需暴露完整 terminal state 且不具有 force operation。`_ending` 是 Pino 当前 file destination 的私有
end-in-progress 状态，因此结构变化必须 fail closed，但构造前已经存在的稳定方法包装会成为 first-seen baseline。

Pino lifecycle owner 必须在 `newPinoServer()` 同步构造时捕获已验证的 Logger `flush`、destination
`end`/`destroy` call target 与 force capability。`start()` 在安装 listener 前、注册后和发布 owner 前都必须
重新验证当前 operation 与构造快照完全相同，并在整个 owner 生命周期只用这些固定引用和正确的原生
`this`。应用在 transfer 后仍可正常写 Logger，但不得改变 logger stream binding；若 binding 漂移，adapter
必须跳过错配 flush、用固定 destination 操作完成原 owner A 的清理并显式 fail closed，不能把成功 terminal
发布给已经写向资源 B 的 Logger。每次 start revalidation 后、发布 owner 前必须复核已观察的 native
failure/close、destination terminal、logger binding、方法 identity 与 force capability；revalidation 期间的
同步 lifecycle re-entry 必须拒绝 start、撤销 adapter listener、保留原始 failure
identity，且不得执行 owner flush/end/destroy。

硬边界：

1. `@go-like/transport` 不依赖 `@go-like/transport-http`、Web、core、registry 或供应商包。
2. `@go-like/transport-http` 不依赖 `@go-like/web`，也不承接 Web router、middleware、健康页或对外静态资源。
3. `@go-like/web` 不依赖 transport；它可以独立托管普通 Web 应用。
4. `@go-like/core` 继续只管理结构式 Server 生命周期，不知道 transport、Web 或供应商类型。
5. Framework package 只依赖 `@go-like/web` 和对应 peer framework，不重导出框架、不代理路由 API。
6. `@go-like/health` 不依赖 Web；`@go-like/web/health` 依赖 `@go-like/health`。
7. `@go-like/web` 与 `@go-like/transport-http` 的根入口保持 portable；其 Node-only 代码只能从明确的
   `./node` 子路径进入依赖图。其他 runtime/vendor 包的根入口按真实能力声明，不能伪装 portable。
8. `@go-like/registry` 不依赖任何 provider；`@go-like/registry-mdns` 与 `@go-like/registry-consul` 都只依赖
   公共 Registry 契约，不互相依赖。
9. `@go-like/registry-mdns` 根入口不静态 import `node:`；UDP socket、multicast membership 与网卡枚举只从
   明确的 runtime host 进入。

## 7. `@go-like/transport` 公共契约

### 7.1 公共类型

公共角色与 go-micro 一一对应：阻塞调用变为 Promise，`error` 变为 throw/rejection，`[]byte` 变为
`Uint8Array`，输出参数变为返回值。语言映射之外，go-like 还明确强化资源所有权、终态、defensive copy 与
稳定错误；这些强化不是对上游未定义行为的逐字复制。

```ts
import type { Context } from "@go-like/context";

export interface Transport {
  init(...options: readonly Option[]): void;
  options(): Options;
  dial(
    ctx: Context,
    address: string,
    ...options: readonly DialOption[]
  ): Promise<Client>;
  listen(
    ctx: Context,
    address: string,
    ...options: readonly ListenOption[]
  ): Promise<Listener>;
  string(): string;
}

export interface Message {
  readonly header: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface Socket {
  recv(ctx: Context): Promise<Message>;
  send(ctx: Context, message: Message): Promise<void>;
  close(ctx: Context): Promise<void>;
  local(): string;
  remote(): string;
}

export interface Client extends Socket {}

export type AcceptHandler = (
  ctx: Context,
  socket: Socket,
) => void | PromiseLike<void>;

export interface Listener {
  addr(): string;
  close(ctx: Context): Promise<void>;
  accept(ctx: Context, handler: AcceptHandler): Promise<void>;
}
```

`Message` 在 send、receive 和实现边界执行 header 与 body 防御性复制；冻结属性不代表冻结调用方传入的
`Uint8Array`，实现不得持有其可变引用。`local()` 与 `remote()` 保持 go-micro 的不透明字符串语义；宿主无法
获得真实地址时返回空字符串，不得伪造 URL、IP 或端口。

### 7.2 Context 与生命周期

1. `dial`、`listen`、`send`、`recv`、`close`、`accept` 在执行任何副作用前检查 Context。
2. `dial` 与 `listen` 的 Context 拥有对应创建操作；取消必须终止尚未接纳的连接或监听创建，并释放部分资源。
3. `send`、`recv` 的 Context 只限制当前调用，不隐式关闭共享 Socket。
4. `accept` 是一次性长期运行调用。Context 取消会停止接纳、取消派生的 per-socket Context 并收敛本次 accept；
   之后 Listener 不能再次 accept，但仍允许 once-safe `close`。
5. Listener 正常 `close` 使 `accept` 正常 resolve；accept Context 取消使其以 `canceled` 或
   `deadlineExceeded` reject；host/dispatcher 故障使其 reject 并保留原始 cause。
6. 每个 socket handler 获得由 accept Context 派生的 Context；socket、listener 或 accept 任一终止都会取消它。
7. 单个 socket handler reject 只关闭该 socket，并由具体 wire 映射为该请求的协议错误；它不得终止其他
   socket 或整个 accept loop。
8. `close` 幂等。关闭后的 `send`、`recv` 和第二次 `accept` 返回稳定、可识别的状态错误。
9. `init` 只按顺序应用配置，不执行 I/O、不启动或重启 transport；后一个 option 覆盖前一个 option。
10. `options()` 返回深度防御性复制的不可变快照，不泄漏 transport 内部配置。
11. `init`、`options`、`string` 是纯配置/纯读取调用，是“阻塞或 I/O 调用必须使用 Context 首参”的唯一豁免；
    `init` 只影响之后创建的 client/listener，已有资源继续使用创建时的 option snapshot。
12. 首次 close 启动唯一 owner cleanup；每个 close Context 只约束该 caller 的等待，取消不放弃后台回收，
    后续 close 加入同一 cleanup。`done`/accept terminal 只能在底层资源真实结束后 settle。

### 7.3 Options 与默认值

保留 go-micro 的 `Option`、`DialOption`、`ListenOption` 三组 functional option 概念。公共 options 使用
ECMAScript/Web 可表达的结构，不在公共包中 import Node `tls`、`net` 或供应商 Logger。

| go-micro                 | go-like                           | v1 语义                                                                          |
| ------------------------ | --------------------------------- | -------------------------------------------------------------------------------- |
| `Addrs`                  | `addrs(...addresses)`             | 中介地址不可变快照                                                               |
| `Codec`                  | `codec(value)`                    | 最小结构式 `MessageCodec`；仅供不原生支持 header 的实现使用                      |
| `Logger`                 | `logger(value)`                   | 最小结构式 `TransportLogger` 诊断 sink，不替代 Pino/Winston                      |
| `Timeout`                | `timeout(timeoutMs)`              | `send`/`recv` 默认超时；有限非负整数毫秒                                         |
| `Secure`                 | `secure(enabled)`                 | 要求安全传输；不自动生成自签名证书                                               |
| `TLSConfig`              | `tlsConfig(value)`                | 使用可移植证书材料结构；不接受 Node 专属类型                                     |
| `BuffSizeH2`             | `http2BufferSize(bytes)`          | HTTP/2 buffer 大小；非 HTTP 实现可明确拒绝                                       |
| `WithStream`             | `withStream()`                    | 请求可重复收发的流式 socket 能力                                                 |
| `WithTimeout`            | `withTimeout(timeoutMs)`          | 原始角色是 dial timeout；Fetch client 映射为每次 send 的连接/响应头阶段上限      |
| `WithConnClose`          | `withConnClose()`                 | 请求关闭 HTTP 连接；不支持时明确拒绝                                             |
| `WithInsecureSkipVerify` | `withInsecureSkipVerify(enabled)` | 保留能力名；默认 false；Fetch 实现无法兑现时明确拒绝                             |
| `NetListener`            | HTTP 包 `host(value)`             | HTTP-specific listen option；改为结构式 runtime host，不泄漏 Node `net.Listener` |

`Options` 包含 `addrs`、`codec`、`logger`、`timeoutMs`、`secure`、`tlsConfig`、
`http2BufferSizeBytes`；`DialOptions` 包含 `timeoutMs`、`stream`、`connectionClose`、
`insecureSkipVerify`。go-like Context 不放入 Options，因为它已经是独立首参；实现私有配置由具体包的 typed
option 承载，不复用 Context 作为隐式 option bag。

实施前冻结的精确公共声明如下，避免 provider 各自猜测 codec、logger、TLS 或 reducer 形状：

```ts
export type TransportLogLevel = "debug" | "info" | "warn" | "error";

export interface TransportLogger {
  log(
    level: TransportLogLevel,
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void;
}

export interface MessageCodec {
  marshal(message: Message): Uint8Array;
  unmarshal(bytes: Uint8Array): Message;
}

export type TLSEncoding = "pem" | "der";

export interface TLSEncodedBytes {
  readonly encoding: TLSEncoding;
  readonly bytes: Uint8Array;
}

export interface TLSConfig {
  readonly serverName: string | null;
  readonly caCertificate: TLSEncodedBytes | null;
  readonly certificateChain: TLSEncodedBytes | null;
  readonly privateKey: TLSEncodedBytes | null;
}

export interface Options {
  readonly addrs: readonly string[];
  readonly codec: MessageCodec | null;
  readonly logger: TransportLogger | null;
  readonly timeoutMs: number;
  readonly secure: boolean;
  readonly tlsConfig: TLSConfig | null;
  readonly http2BufferSizeBytes: number;
}

export interface DialOptions {
  readonly timeoutMs: number;
  readonly stream: boolean;
  readonly connectionClose: boolean;
  readonly insecureSkipVerify: boolean;
}

export interface ListenOptions {}

export type Option = (options: Options) => Options;
export type DialOption = (options: DialOptions) => DialOptions;
export type ListenOption = <T extends ListenOptions>(options: T) => T;

export function addrs(...addresses: readonly string[]): Option;
export function codec(value: MessageCodec | null): Option;
export function logger(value: TransportLogger | null): Option;
export function timeout(timeoutMs: number): Option;
export function secure(enabled: boolean): Option;
export function tlsConfig(value: TLSConfig | null): Option;
export function http2BufferSize(bytes: number): Option;
export function withStream(): DialOption;
export function withTimeout(timeoutMs: number): DialOption;
export function withConnClose(): DialOption;
export function withInsecureSkipVerify(enabled: boolean): DialOption;
```

三组 option 都是 immutable reducer，不得原地修改输入。`MessageCodec` 是同步纯计算边界，因此不接收
Context；codec 输入/输出与 `TLSEncodedBytes.bytes` 在 option application、implementation boundary 和
`options()` readback 时防御性复制。`TransportLogger.log` 是诊断旁路，抛错不得改变 transport 协议结果。

默认 dial timeout 为 `5_000ms`。对没有真实 connect API 的 Fetch client，该值明确近似为从 fetch 发起到收到
response headers 的阶段上限，不声称已经建立持久连接。HTTP/2 默认 buffer 常量为
`4 * 1024 * 1024` bytes；标准 Fetch 无法控制该 buffer，显式设置必须在网络副作用前报 unsupported。公共包不导出可变
`defaultTransport`：否则 `@go-like/transport` 必须反向依赖 `@go-like/transport-http` 并形成包环。应用在
composition root 显式调用 `newHTTPTransport()`；这是模块拆分造成的唯一默认值差异。

`TLSConfig` 只表达 server name、CA certificate、certificate chain 和 private key 的标准字节材料及其
PEM/DER 编码，不承诺所有 implementation 都支持全部字段。implementation 必须在创建连接或 listener 前
完成 capability validation；不能兑现时抛 `UnsupportedTransportCapabilityError`，不得静默忽略。

### 7.4 Headers 子路径

`@go-like/transport/headers` 保留 go-micro 当前的常量角色，但使用 go-like 自有 namespace，导出
lowerCamelCase 值。所有项目自有 header 固定使用用户确认的 `Go-Like-` 前缀，不发布旧前缀 alias；标准
HTTP header `Content-Type` 保持标准名称。

| 导出          | 值                  |
| ------------- | ------------------- |
| `message`     | `Go-Like-Topic`     |
| `request`     | `Go-Like-Service`   |
| `error`       | `Go-Like-Error`     |
| `endpoint`    | `Go-Like-Endpoint`  |
| `method`      | `Go-Like-Method`    |
| `id`          | `Go-Like-ID`        |
| `prefix`      | `Go-Like-`          |
| `namespace`   | `Go-Like-Namespace` |
| `protocol`    | `Go-Like-Protocol`  |
| `target`      | `Go-Like-Target`    |
| `contentType` | `Content-Type`      |
| `spanId`      | `Go-Like-Span-ID`   |
| `traceId`     | `Go-Like-Trace-ID`  |
| `stream`      | `Go-Like-Stream`    |

### 7.5 稳定错误

公共包至少提供以下结构式错误，实例冻结并保留 `cause`：

| 错误                                  | code                                       | 用途                                     |
| ------------------------------------- | ------------------------------------------ | ---------------------------------------- |
| `TransportClosedError`                | `GO_LIKE_TRANSPORT_CLOSED`                 | 已关闭的 socket/listener 上继续操作      |
| `TransportStateError`                 | `GO_LIKE_TRANSPORT_STATE`                  | recv-before-send、重复 accept 等非法状态 |
| `UnsupportedTransportCapabilityError` | `GO_LIKE_TRANSPORT_UNSUPPORTED_CAPABILITY` | implementation 无法兑现已请求能力        |
| `TransportProtocolError`              | `GO_LIKE_TRANSPORT_PROTOCOL`               | wire 格式、响应或协议约束无效            |

Context 取消继续使用 `@go-like/context` 的 `canceled` 或 `deadlineExceeded`，不重写成 transport 错误。

## 8. `@go-like/transport-http`

### 8.1 职责

该包实现内部同步 Message transport，并且 client 与 server 都是 v1 硬门槛，不是 Web 框架 host。它负责：

- 通过 `Transport.dial` 创建 HTTP client，用标准 Fetch POST 将 `Message.header` 与 `Message.body` 映射到
  HTTP request；
- 将成功 HTTP response 映射回 `Message`；
- 通过 `Transport.listen`、`Listener.accept` 和结构式 `HTTPHost` 提供低层 HTTP server；
- 通过 `newHTTPServer` 把 listener/accept 组合为可由 `@go-like/core` 编排的结构式 Server；
- 实现 `Transport`、`Client`、`Listener`、unary `Socket` 和 lifecycle Server 的状态机；
- 明确报告标准 Web API 无法兑现的 raw transport 能力。

它不提供 router、middleware、静态文件、健康页、浏览器客户端、registry 自动注册或业务 RPC client。

公开构造面固定为：

```ts
import type { Context } from "@go-like/context";
import type { Server, ServerHandle } from "@go-like/core";
import type {
  AcceptHandler,
  Listener,
  TLSConfig,
  Transport,
} from "@go-like/transport";

export interface HTTPTransport extends Transport {
  listen(
    ctx: Context,
    address: string,
    ...options: readonly HTTPListenOption[]
  ): Promise<HTTPListener>;
}

export interface HTTPListener extends Listener {
  accepted(): Promise<void>;
}

export interface HTTPServer extends Server<HTTPServerHandle> {}

export interface HTTPServerHandle extends ServerHandle {
  address(): string;
}

export interface HTTPServerDrainTimeoutError extends Error {
  readonly name: "HTTPServerDrainTimeoutError";
  readonly code: "GO_LIKE_HTTP_SERVER_DRAIN_TIMEOUT";
  readonly operation: "stop" | "rollback";
  readonly timeoutMs: number;
  readonly orphaned: true;
  readonly failures: readonly Error[];
}

export interface HTTPTransportUnexpectedExitError extends Error {
  readonly name: "HTTPTransportUnexpectedExitError";
  readonly code: "GO_LIKE_HTTP_TRANSPORT_UNEXPECTED_EXIT";
  readonly source: "serve" | "host";
  readonly phase: "before-ready" | "running";
}

export function newHTTPTransport(
  ...options: readonly HTTPTransportOption[]
): HTTPTransport;

export function newHTTPServer(
  httpHost: HTTPHost,
  handler: AcceptHandler,
  ...options: readonly HTTPServerOption[]
): HTTPServer;
```

HTTP-specific options 与 Fetch executor 的精确声明固定为：

```ts
import type { ListenOptions } from "@go-like/transport";

export type HTTPExecutor = typeof globalThis.fetch;

export interface HTTPTransportOptions {
  readonly executor: HTTPExecutor;
}

export type HTTPTransportOption = (
  options: HTTPTransportOptions,
) => HTTPTransportOptions;

export function executor(value: HTTPExecutor): HTTPTransportOption;

export interface HTTPListenOptions extends ListenOptions {
  readonly host: HTTPHost | null;
}

export type HTTPListenOption = (
  options: HTTPListenOptions,
) => HTTPListenOptions;

export function host(value: HTTPHost): HTTPListenOption;

export interface HTTPServerOptions {
  readonly address: string;
  readonly transport: HTTPTransport;
  readonly hardDrainTimeoutMs: number;
}

export type HTTPServerOption = (
  options: HTTPServerOptions,
) => HTTPServerOptions;

export function address(value: string): HTTPServerOption;
export function transport(value: HTTPTransport): HTTPServerOption;
export function hardDrainTimeout(timeoutMs: number): HTTPServerOption;
```

`executor(value)` 与注入的 transport 都是 borrowed。`newHTTPTransport()` 捕获 construction 当时的
`globalThis.fetch` 函数引用，不在每次 send 时重新读取或替换全局值；取消只作用于该 send 的私有
AbortController。executor 返回的 Response 被 client slot 接纳后，其 body 消费/取消权归该 slot。
`newHTTPTransport` 的 construction options 只承载 HTTP-specific executor；公共 `Option` 统一通过返回对象的
`init(...options)` 应用，不为同一 common option 再造 HTTP overload。

`HTTPListenOption` 使用扩展后的 HTTP listen config，因此所有公共 `ListenOption` 都可直接传入；
`host(value)` 只返回 `HTTPListenOption`，不进入 transport construction options。`HTTPServerOption` 精确包含
`address(value)`、`transport(value)` 与 `hardDrainTimeout(value)`；默认地址为 `127.0.0.1:0`，默认 transport
为同包 `newHTTPTransport()`，hard drain 默认 25,000ms 且只接受 0..2,147,483,647 的整数。应用把该 Server
交给 Core 时，Core 外层 `server(..., hardDrainTimeout(...))` 的总预算必须严格大于此 owner force boundary；
默认 30,000ms 满足该约束。传入的 HTTPHost factory、HTTPTransport、Fetch executor 和 handler 都是 borrowed；
Server 只拥有本次 start 创建的 Listener、host handle、accept owner Context 和 active sockets。

Node 子路径另提供 `newNodeHTTPServer(handler, ...options)` 便利入口，由它创建 Node host 后调用同一
`newHTTPServer`，不复制状态机。应用若不需要 Core lifecycle，可只使用
`transport.listen(ctx, address, host(httpHost))`、`accept/close`；两种入口共享同一 wire conformance。

对齐关系如下：

| go-like 入口                     | 角色                                | 对齐来源                                                                 |
| -------------------------------- | ----------------------------------- | ------------------------------------------------------------------------ |
| `newHTTPTransport().dial(...)`   | Client 创建与 `send/recv/close`     | go-micro `Transport.Dial`；对齐 go-kratos HTTP client 角色，不复制其 API |
| `newHTTPTransport().listen(...)` | 低层 Server bind                    | go-micro `Transport.Listen`                                              |
| `listener.accept(...)`           | 低层 Server request/socket dispatch | go-micro `Listener.Accept`                                               |
| `newHTTPServer(...).start(...)`  | 应用可组合 lifecycle Server         | go-kratos HTTP Server、go-like Core Server                               |

### 8.2 Runtime host SPI

标准 Web API 提供 `Request`、`Response` 和 `fetch`，但没有 server-side `listen`。因此 HTTP transport 使用
可由任意 runtime 实现的两阶段 host；`bind` 与 `serve/ready` 分离，避免“端口已绑定”被错误报告为“请求已可
接纳”：

```ts
export type HTTPHandler = (
  input: HTTPHostRequest,
) => Response | Promise<Response>;

export interface HTTPHostRequest {
  readonly request: Request;
  readonly localAddress: string;
  readonly remoteAddress: string;
}

export interface HTTPHostCapabilities {
  readonly tls: boolean;
  readonly forceClose: boolean;
  readonly connectionMetadata: boolean;
  readonly http2BufferSize: boolean;
}

export interface HTTPHostListenOptions {
  readonly secure: boolean;
  readonly tlsConfig: TLSConfig | null;
  readonly http2BufferSizeBytes: number | null;
}

export interface HTTPHost {
  capabilities(): HTTPHostCapabilities;
  bind(
    ctx: Context,
    address: string,
    options: HTTPHostListenOptions,
  ): Promise<HTTPHostHandle>;
}

export interface HTTPHostHandle {
  address(): string;
  serve(ctx: Context, handler: HTTPHandler): HTTPServeHandle;
  done(): Promise<void>;
  close(ctx: Context): Promise<void>;
  forceClose?(reason: Error): Promise<void>;
}

export interface HTTPServeHandle {
  ready(): Promise<void>;
  done(): Promise<void>;
}
```

`HTTPHandler` 接收带连接 metadata 的 host envelope，`@go-like/web` Handler 只接收标准 Request；两者既不
共享语义，也不追求同一函数签名。transport wire dispatcher 只把 envelope 内的 Request 映射为 Message，
Web 包承载对外 application。两个包不 alias、import 或 re-export。

`newHTTPTransport(...options)` 默认捕获标准 `globalThis.fetch` 作为 client executor；每次 `listen` 必须通过
HTTP-specific `host(value)` 注入 borrowed host。host capability snapshot 在 bind 前完成校验；只有调用方明确
请求 TLS 或自定义 HTTP/2 buffer 等能力且 host 无法兑现时，才必须在网络副作用前失败。其中
`requiresTLS = secure === true || tlsConfig !== null`，requiresTLS 为 true 时必须在 bind 前验证
`capabilities.tls === true`；H2 buffer 仍只检查调用方是否显式设置。
`forceClose: false` 与 `connectionMetadata: false` 均为合法 baseline；后者使 envelope 的 local/remote address
固定为空字符串。host 若声明 `forceClose: true`，bind 返回的 handle 必须实际提供可调用的 `forceClose`，否则
以 admission failure 结束并回滚。`http2BufferSize` 在内部保留 `{ value, explicit }`；未显式设置时传给 host 的
`http2BufferSizeBytes` 为 `null`，不得把 transport 默认常量误判为调用方能力请求。`@go-like/transport-http/node`
提供首个真实 Node host；Bun、Deno 或其他后端可结构式实现同一 SPI。根入口不静态 import `node:`。Web 的
Node Fetch bridge 留在 `@go-like/web/node` 依赖图内，不进入 portable 根入口。

`dial` 在 unary Fetch 模式下只校验和冻结远端地址、options 与 executor，不伪造一个 Fetch 不具备的持久
TCP connect；实际网络失败在 `send` 发起请求时暴露。`listen` 则必须完成真实 bind 后才 resolve。两种差异
写入 API 文档和测试，不能把“构造了 client”报告为“已经连通远端”。

`@go-like/transport-http/node` 与 `@go-like/web/node` 独立实现各自的 owner state machine，不跨包共享源码或
互相依赖：前者返回 transport `HTTPHostHandle`，后者返回 Core `ServerHandle`，终态和所有权并不相同。两者
只在测试图通过 `@go-like/testing/listener` 共享 bind、address、close、terminal、force 和端口释放 conformance。

`Transport.listen` 调用 host bind 并返回已绑定 HTTPListener；`addr()` 在 listen resolve 后返回实际地址，包括
随机端口。`accept` 是 one-shot 长期 terminal Promise：它启动 `serve`，在 host `ready()` 成功时令
`listener.accepted()` resolve，随后持续到真实 terminal。accept 前到达的请求不进入业务 handler；host 只可
有界等待或返回 503，不能缓存 request body。start 成功返回后不得再存在 deferred 503 admission 窗口。

`accepted()` 是 listen 时创建且 identity 稳定的 Promise。`ready()`、`serve.done()`、`host.done()` 与 close/cancel
进入一个 single-settlement terminal arbiter，四类信号使用以下唯一联动规则：

- `serve()` 同步抛错在同一同步窗口没有更早 Context 取消或 Listener close 时成为 admission 主错误。每次
  borrowed `serve` 调用、serve handle getter、`done()` 与 `ready()` 调用返回或抛出后，必须先同步复核 accept
  Context 与当前 arbiter mode，再发布 admission failure 或继续下一边界；更早的 Context 取消使 `accept()` 与
  `accepted()` 以同一个 Context Error identity 失败，后到的 serve/handle failure 只进入既定 secondary cleanup。
  serve handle 接纳后必须先同步观察 serve/host 两个 done，再调用和观察 ready；Promise 竞态的线性化点是
  arbiter 首个收到的 settlement job，后到信号不能改写主错误；
- ready 前任一 Promise reject 时，Error rejection 保留原始 identity，非 Error rejection 只规范化一次；
  serve 或 host 在 ready 前正常 resolve 时不存在上游 Error，因此分别创建一次稳定的
  `HTTPTransportUnexpectedExitError`（source 为 `serve`/`host`，phase 为 `before-ready`）。`accepted()` 以该
  admission 主错误 reject；
- Listener close 若先认领 closing 状态且 ready 尚未成功，`accepted()` 以稳定 `TransportClosedError` reject。
  ready 成功后 `accepted()` 永久保持 resolved，后续 terminal 不得改写；close 与 terminal 同 turn 竞态由谁先
  同步/settlement-job 认领 arbiter 决定；
- `ready()` 内部同步取消 accept Context 或重入关闭 Listener 后再同步抛错时，已认领的 canceled/closed 仍是
  admission 主语义；该 ready failure 必须在离开同步调用栈前登记为 terminal secondary，随后只驱动一次底层
  close，并令 terminal owner Promise identity 永久稳定。实现不得依赖晚一个 microtask 才观察 ready failure；
- ready 后 serve/host 非预期先 terminal 时，reject 保留原始 Error identity，正常 resolve 则创建 phase 为
  `running` 的 `HTTPTransportUnexpectedExitError`；serve-first 启动 host close，host-first 取消 serve owner
  Context。`accept()` 等待两侧真实 terminal：无 secondary failure 时以主错误原 identity reject；有 secondary
  failure 时以不可变 AggregateError reject，errors[0] 固定为主错误，其余按被观察顺序排列；
- 正常 Listener close 先认领 closing 时驱动两侧 terminal；两侧都正常则 `accept()` resolve，任一 cleanup reject
  则以单一原始 Error 或按观察顺序构造的不可变 AggregateError reject。外部 accept Context 取消是唯一的及时
  返回例外：`accept()` 以对应 Context error reject，后台 cleanup 继续；
- HTTPServer 内部 force 引发的 accept Context cancellation 只作为 drain 实现信号，不重复暴露为 stop/done 主错误。
  HTTPServer 在启动 accept 的同一 turn 立即观察其 Promise，再等待 `accepted()`，避免 admission 期间产生未处理
  rejection。

`HTTPServer.start` 在任何异步工作前同步认领 one-shot 状态，然后执行 capability validation → bind → 以独立
owner Context 启动 accept → await `accepted()`。startup Context 只约束上述 admission；Core 在 child start
完成后取消 startup Context，不得影响长期 owner Context。admission 前取消或失败时，原始 start failure 为主，
Server 取消 owner、关闭 listener并启动 rollback。若在 owner force boundary 前真实 terminal：没有 cleanup
failure 时 reject 原始 start Error identity；存在 cleanup failure 时创建不可变 AggregateError，errors[0] 是原始
start error，其余按观察顺序排列。若边界到达而底层仍未 terminal，则在该时点冻结 operation=`rollback` 的
`HTTPServerDrainTimeoutError` 及此前 failures，并以不可变 AggregateError `[originalStartError,
rollbackTimeoutError]` reject；后台继续观察和回收，deadline 后错误只进入 secret-safe diagnostics，不修改已
返回的 Error，不得谎报端口已经释放。

handle `address()` 返回与 listener `addr()` 相同且停止后仍可读的地址，`done()` 是稳定 terminal Promise。
host 在 handle 返回前终止属于 start failure；运行期意外终止使 done 保留原始 cause。handler rejection 只关闭
对应 unary socket；只有 host/listener failure 才终止 accept。stop 与被动终止竞态只能结算一次，Server 停止
不得关闭同一 borrowed Transport 创建的其他 client 或 listener。

`stop(ctx)` 是单一 owner drain：首次调用关闭 admission gate，要求 host graceful close，等待已接纳 handler、
accept 与 host done；不会立即取消 per-socket Context。每个 caller 只执行 `waitForContext(ctx, ownerDrain)`，
caller 取消不终止后台清理，后续 stop 加入同一 drain。只有 host 明确声明并公开 `forceClose` 时，Server 才能在
自身 hard drain deadline 到达后取消仍存活的 socket Context 并 force close；没有 force 能力时不得伪造 done，
Core 可以如实把未收敛资源报告为 orphan。

owner hard deadline 到达时创建一次 identity 稳定、不可变的 `HTTPServerDrainTimeoutError`；其 `failures` 只
冻结 deadline 前已经观察到的 cleanup failures。所有正在等待 owner drain 的 `stop(ctx)` 都以该同一 timeout
identity 失败，即使随后 force 成功；deadline 后发生的 force/host/terminal failure 不追加到 timeout，而在底层
真实 terminal 时进入 `done()` 的单一 Error/AggregateError。`done()` 仍只在 serve、host 和全部 socket 真实终止
后结算，调用 `forceClose` 返回不等于 terminal。内部 force 取消 accept owner Context 时产生的 `canceled`
只属于清理机制，不得覆盖 stop 的 drain timeout 主错误。`forceClose` 抛错或返回后底层未终止时，`done()` 保持
真实 pending；若以后 terminal，再按观察顺序结算已收集的 late failures。没有 force capability 的 host 在 deadline
后同样令 stop 以 drain timeout 失败并继续后台观察，最终由 Core 外层预算如实标记 orphan。

HTTP status 错误的公共 ABI 固定为：

```ts
export interface HTTPStatusError extends Error {
  readonly name: "HTTPStatusError";
  readonly code: "GO_LIKE_HTTP_STATUS";
  readonly status: number;
  readonly statusText: string;
  readonly body: Uint8Array;
  readonly bodyTruncated: boolean;
}
```

它只用于非 200 response；wire/header/body 结构错误仍使用 `TransportProtocolError`。实现最多读取
65,536 bytes，存在更多字节时 `bodyTruncated` 为 true。Error 冻结、不保留原始 Response/reader；内部保存
bounded defensive snapshot，`body` 每次访问都返回新的 Uint8Array，调用方修改不会污染错误内部状态。

### 8.3 Unary Fetch wire

1. Client dial 接受绝对 `http:`/`https:` URL，或不含 path 的 `host:port`/`[ipv6]:port`；后者按 secure option
   规范化。拒绝 credentials、fragment、空 host 与 scheme/secure 冲突；`secure(false)` 表示没有额外要求 TLS，
   不是禁止绝对 `https:` URL，只有 `secure(true)` 与显式 `http:` 冲突时拒绝。绝对 URL 的 path/query 原样作为
   内部 endpoint。listen address 只接受 host:port，不接受 path/query/fragment。
2. 每次 `send` 创建私有 AbortController、POST Request，并防御性复制 Message headers/body。Fetch 从发起到
   response headers 受 send Context、transport operation timeout、`withTimeout` 三者的最早 deadline 约束；
   send invocation 立即创建一个 provisional FIFO slot；收到 headers 后 send 才 resolve，并把 Response
   ownership 转移给该 slot。网络失败同时使 send 和已经认领该 slot 的 recv 以同一个 Error identity reject，
   然后永久删除该 slot。
3. 同一 Client 的 send 按调用顺序串行执行，因此响应入队顺序确定；不靠网络完成顺序猜配对。`recv` 同时只
   允许一个 active call，并在开始时原子认领最早 prior send slot；已有 send 尚未收到 headers 时等待该 slot，
   没有任何 prior send invocation 时抛 `TransportStateError`。send failure、recv cancel 与 Client close 对 slot
   执行 once-safe 删除；被取消的 recv 不允许后续 recv 重读同一 Response，前一 send 网络失败也不得永久阻塞
   串行队列中的后续 send。
4. `recv` 读取并防御性复制 response body。Client 200 response、非 200 status body 与 server POST request
   的每个 Web Streams chunk 都必须在实现边界显式验证为 `Uint8Array`；错误 chunk、read/result getter 异常统一
   转为 `TransportProtocolError`，原值为 Error 时保留其 cause identity；对 detached ArrayBuffer 或因可变
   ArrayBuffer resize 而越界的 `Uint8Array` 做防御性复制时若运行时抛出 `TypeError`，也必须统一包装并把该
   `TypeError` 以 exact identity 作为 cause，不得静默转换为空 Message。只有 200
   response 转为 Message；非 200 抛 `HTTPStatusError`，包含 status、statusText 和最多 64 KiB 的 body，超过
   上限截断。recv Context 取消会取消/消费该 response body，slot 永久移除，不留下可被再次读取的半消费 Response。
5. `Client.close` abort 所有在途 Fetch，取消未消费 response body，清空 slots，并使 pending/future send/recv
   以稳定 closed error 结束；close 幂等，不能影响同一 Transport 创建的其他 client/listener。非 200 status
   reader 截断或 200 response active reader cleanup 时，若标准 underlying-source `cancel()` 同步重入
   `Client.close` 并返回该唯一 owner Promise，标准 Promise assimilation 即使产生不等同于 owner 的包装 Promise，
   reader、slot 与 owner 也不得形成等待环；只切断该同步 owner-reentry 依赖边，reader/body cancellation 仍
   at-most-once，非重入 pending cleanup 仍由 owner 真实等待。
6. server 侧每个 HTTPHostRequest 创建一个 unary logical Socket：允许一次 recv 与一次 send。handler 正常
   返回但未 send 时返回 500 协议错误；重复 recv/send 产生稳定 state error；handler rejection 保留内部 cause，
   对外 500 body 不含 stack、credential 或原始错误文本。
7. 外部 Request.signal、显式操作 Context 与 socket owner Context 只作为输入，单向汇合到私有派生 Context
   和 AbortController；任一输入终止都会取消内部操作，实现绝不反向取消或修改调用方的 Request、signal、
   Context，也不影响其他并发 request。
8. HTTP Headers 使用标准 `Headers` 的大小写和重复值合并结果，不声称保留原始多值顺序。无效 header 以及
   `Host`、`Content-Length`、`Transfer-Encoding`、`Connection` 等 Fetch 管理的 hop-by-hop/长度 header 在
   网络副作用前以 protocol error 拒绝。
9. server Socket 的 `local()`、`remote()` 使用 host envelope metadata；host 不支持时返回空字符串。Fetch
   client 的 local 为空，remote 使用已规范化 target origin，不伪造底层 socket 地址。
10. Client 与 Server 必须可由同一 HTTPTransport 完成真实 loopback；client send/recv 与 server
    AcceptHandler 的消息边界、Context、状态错误和 close 语义使用同一套 conformance case。

### 8.4 Streaming 与 TLS 能力边界

v1 的标准 Fetch 实现只承诺 unary socket。以下 go-micro HTTP 线级行为无法仅由标准 Web API 可移植实现：

- HTTP/1 TCP hijack；
- H2C server；
- 一条物理连接上的任意次数双向 send/recv；
- TCP deadline、ALPN、proxy CONNECT；
- client local address；
- mTLS client certificate、跳过证书校验和强制 `Connection: close`；
- 在所有目标 runtime 上一致的 full-duplex streaming request。

因此 `withStream()`、Fetch host 上的自定义 TLS material、`withInsecureSkipVerify(true)` 和无法兑现的
`withConnClose()` 必须在 dial/listen 产生任何网络副作用前抛
`UnsupportedTransportCapabilityError`。不得把多次独立 Fetch 偷换成同一 Socket stream，也不得静默降级。

未来若增加 raw Node/Bun/Deno host，它可以在同一个 `@go-like/transport-http` 包内声明对应 capability 并通过
相同公共 conformance suite；在真实全双工 E2E 通过前，v1 不发布 stream 支持声明。

## 9. `@go-like/registry`、mDNS 与 Consul

> 本节记录早期 go-micro 式 Registry 方案，已被当前 Kratos 风格
> `Registrar` / `Discovery` / `Registry` / `Watcher` / `ServiceInstance` 契约替代。当前实例不再暴露
> `init/options/string`、registration handle 或 capability snapshot；以
> [`../../developer-experience-alignment.md`](../../developer-experience-alignment.md) 和各 Registry 包
> README 为准。

### 9.1 公共 Registry 契约

`@go-like/registry` 对齐 go-micro 当前 Registry 的公共角色，同时采用 go-like 的显式资源所有权：Context
始终是独立首参，阻塞调用变成 Promise，输出是不可变防御性快照；go-micro 的 `Deregister` 被 owning
RegistrationHandle 的 `stop` 取代，不导出可变 `defaultRegistry`。

```ts
import type { Context } from "@go-like/context";
import type { Server, ServerHandle } from "@go-like/core";

export interface Value {
  readonly name: string;
  readonly type: string;
  readonly values: readonly Value[];
}

export interface Endpoint {
  readonly name: string;
  readonly request: Value | null;
  readonly response: Value | null;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface Node {
  readonly id: string;
  readonly addresses: readonly string[];
  readonly metadata: Readonly<Record<string, string>>;
}

export interface Service {
  readonly name: string;
  readonly version: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly endpoints: readonly Endpoint[];
  readonly nodes: readonly Node[];
}

export interface Result {
  readonly action: "create" | "update" | "delete";
  readonly service: Service;
}

export interface Watcher extends ServerHandle {
  next(ctx: Context): Promise<Result>;
}

export interface RegistrationHandle extends ServerHandle {}

export type RegistryLogLevel = "debug" | "info" | "warn" | "error";

export interface RegistryLogger {
  log(
    level: RegistryLogLevel,
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void;
}

export interface RegistryOptions {
  readonly addresses: readonly string[];
  readonly logger: RegistryLogger | null;
  readonly timeoutMs: number;
}

export interface RegistryCapabilities {
  readonly registrationTtl: {
    readonly minimumMs: number;
    readonly maximumMs: number;
  } | null;
  readonly maximumServicePayloadBytes: number;
  readonly addressKinds: readonly (
    | "opaque"
    | "hostname-port"
    | "ipv4-port"
    | "ipv6-port"
  )[];
  readonly watchUpdates: boolean;
  readonly watchOverflow: "error";
}

export interface RegisterOptions {
  readonly ttlMs: number;
}
export interface GetOptions {
  readonly timeoutMs: number;
}
export interface ListOptions {
  readonly timeoutMs: number;
}
export interface WatchOptions {
  readonly service: string | null;
  readonly bufferSize: number;
}
export interface DiscoveryOptions {
  readonly resyncIntervalMs: number;
  readonly resyncRetries: number;
}

export type RegistryOption = (options: RegistryOptions) => RegistryOptions;
export type RegisterOption = (options: RegisterOptions) => RegisterOptions;
export type GetOption = (options: GetOptions) => GetOptions;
export type ListOption = (options: ListOptions) => ListOptions;
export type WatchOption = (options: WatchOptions) => WatchOptions;
export type DiscoveryOption = (options: DiscoveryOptions) => DiscoveryOptions;

export interface Registrar {
  register(
    ctx: Context,
    service: Service,
    ...options: readonly RegisterOption[]
  ): Promise<RegistrationHandle>;
}

export type ServiceSource =
  | Service
  | ((ctx: Context) => Service | PromiseLike<Service>);

export interface RegistrationServer extends Server<RegistrationHandle> {}

export function registration(
  registrar: Registrar,
  source: ServiceSource,
  ...options: readonly RegisterOption[]
): RegistrationServer;

export interface Registry extends Registrar {
  init(...options: readonly RegistryOption[]): void;
  options(): RegistryOptions;
  capabilities(): RegistryCapabilities;
  register(
    ctx: Context,
    service: Service,
    ...options: readonly RegisterOption[]
  ): Promise<RegistrationHandle>;
  getService(
    ctx: Context,
    name: string,
    ...options: readonly GetOption[]
  ): Promise<readonly Service[]>;
  listServices(
    ctx: Context,
    ...options: readonly ListOption[]
  ): Promise<readonly Service[]>;
  watch(ctx: Context, ...options: readonly WatchOption[]): Promise<Watcher>;
  string(): string;
}
```

`listServices` 保持 go-micro 的“只列服务名称”语义：每项只保证 `name` 有值，其余字段使用规范化空值；调用方
要读取完整 version/node/endpoint 必须再调用 `getService`。Node `addresses` 至少一个，元素是 transport-opaque
地址；多地址用于诚实保留 IPv4/IPv6 或多网卡，Registry 不猜测 URL scheme 或可达性。
register input 要求非空 name/version、至少一个 Node、同一 Service 内 node id 唯一、address 无重复、Endpoint
name 唯一、metadata key/value 为 well-formed Unicode；所有 provider 先做公共验证，再做自身 address/payload
capability validation，任何失败都发生在外部副作用前。

v1 option 集合精确固定：

| 类型             | helper                   | 字段、默认与约束                               |
| ---------------- | ------------------------ | ---------------------------------------------- |
| `RegistryOption` | `addresses(...values)`   | 默认空；非空字符串、防御性复制、后一次整体覆盖 |
| `RegistryOption` | `logger(value)`          | 默认 null；最小结构式诊断 sink                 |
| `RegistryOption` | `timeout(valueMs)`       | 默认 5,000；1..2,147,483,647 的整数毫秒        |
| `RegisterOption` | `ttl(valueMs)`           | 默认 120,000；2,000..86,400,000 的整数毫秒     |
| `GetOption`      | `getTimeout(valueMs)`    | 默认继承 Registry timeout；相同整数边界        |
| `ListOption`     | `listTimeout(valueMs)`   | 默认继承 Registry timeout；相同整数边界        |
| `WatchOption`    | `watchService(name)`     | 默认 null 表示全部；非空字符串                 |
| `WatchOption`    | `watchBufferSize(count)` | 默认 128；1..4,096 的整数                      |

所有 option 都是上面公开的 immutable reducer type：constructor 从规范默认 snapshot 建立首个配置；每次
`init(...options)` 则从当前 effective snapshot（包含 provider constructor 预置值）复制 candidate，按顺序应用
reducers，并在任何副作用前执行 common + provider validation。只有全部成功才原子替换当前 snapshot；任一
reducer throw、返回非法结构或 provider validation 失败都不提交，`options()` 仍返回调用前的同一值快照。
后一个 reducer 覆盖前一个对应字段。第三方结构式 Registry
可以使用同一 type 和默认值，不依赖私有 symbol、class 或 mutable builder。`RegistryLogger.log` 是唯一日志 ABI；
fields 必须先做 secret-safe 快照，logger 抛错不得改变 Registry 协议结果。

Registry 不提供 generic TLS material：Consul 的 HTTPS trust、client certificate 或自定义 CA 完全属于应用注入的
Fetch executor；mDNS 不使用 TLS。`init/options/string` 是纯配置/读取调用，豁免 Context 首参；init 可在任意
时刻 last-wins，但只影响之后创建的 registration/query/watcher，active handle 使用创建时 snapshot。

register/watch 的 Context 只约束资源 admission；handle 返回后使用独立 owner Context，不再观察创建 Context。
admission 前取消必须 rollback 已接受的远端/本地资源后保留原始 Context error。get/list/next 的 Context 只
约束当前 wait；stop caller Context 只允许调用方放弃等待，owner cleanup 继续，后续 stop 可加入同一 cleanup。

每个 RegistrationHandle 独占本次 registration token 与 stop 权，start accepted 后才返回；provider 可让相同
identity 的 non-current token 只驻留为可恢复 snapshot，也可按引用计数共享 socket/responder，但任何 handle 都
不能停止或 deregister 另一 token。`stop` 只回收自身 token 当前拥有的 responder/heartbeat/remote record，并等待
真实资源终态；`done` 保留会使该 token 无法继续发布或恢复的 heartbeat/socket 被动失败。Registry 本身
不持有无法枚举的全局驻留资源，也没有虚假的 global close：一次性 get/list socket 必须在 Promise settle 前
关闭，watch socket 归 Watcher，registration resource 归 RegistrationHandle。

raw Result 的粒度固定为单个 `(service.name, service.version, node.id)` identity：Result.service 恰有一个 Node，
create/delete 分别表示该 identity 加入/离开 passing discovery，update 表示同 identity 的任一公开内容变化。
每个 payload 同时携带不含 `nodes` 的 canonical service-content hash（name、version、metadata、endpoints）。
`getService` 只把同 name/version 且 service-content hash 相同的多个 Node 聚合为完整 Service snapshot；发现
两个有效 identity 发布不同 hash 时，整个 get 操作以 `RegistryProtocolError` 失败，不选择 winner、不丢弃节点。
raw Watcher 对相同 name/version 维护同一约束，冲突使 Watcher terminal；本地 provider admission 能发现的冲突
在写 wire 前拒绝，跨进程冲突在 get/watch 解码时 fail closed。Watcher buffer 满时以稳定
`WatcherOverflowError` 终止，pending/future next reject，调用方必须重新 get/watch；Result union 不承载
类型不匹配的 replacement snapshot，也不静默丢事件。

同一 canonical identity 可由 rolling restart/fault-tolerant responder 暂时重复发布：若完整 single-node canonical
payload 的 identity-content hash 相同，接收方按一个逻辑 Node 去重并对 publisher records 引用计数，首个 passing
record 产生 create、最后一个离开才产生 delete；若 hash 不同则是可观察的 identity collision，get 失败且 Watcher
terminal。完全相同的 wire record 不要求 observer 推断不可观察的进程数量。

service-content hash 的算法固定为：构造 JSON tuple
`["go-like.service-content.v1", name, version, sortedServiceMetadata, canonicalEndpoints]`，其中 metadata 转成按
Unicode code point 排序的 `[key,value]` 数组；每个 Endpoint 固定为
`[name, requestOrNull, responseOrNull, sortedMetadata]`，每个 Value 固定为 `[name,type,canonicalValues]`，两个
数组及递归 values 都保持声明顺序，且完全不包含 nodes；使用无额外空白的 JSON UTF-8 bytes，经 Web Crypto SHA-256 后编码为 RFC 4648 lowercase、
no-padding Base32，并加字面量前缀 `sha256-`。mDNS 与 Consul 在压缩前计算并验证该值；压缩器输出字节可以因
runtime 实现不同而变化，只要解压后 canonical bytes 与 semantic hash 完全一致。
这一边界与 [WHATWG Compression Standard](https://compression.spec.whatwg.org/#infrastructure) 将 compression
context 定义为依赖 format、algorithm 和 implementation 的 opaque state 一致。

identity-content hash 使用同一 SHA-256/Base32 编码，preimage 精确为无空白 UTF-8 JSON tuple：
`["go-like.identity-content.v1", name, version, sortedServiceMetadata, canonicalEndpoints,
[node.id, addresses, sortedNodeMetadata]]`；addresses 保持声明顺序，其余 canonical 子结构完全复用上一段定义。
两个 content hash 都在压缩前计算，分别写入 `Go-Like-Service-Content-Hash` 与
`Go-Like-Identity-Content-Hash`。`Go-Like-Identity-Hash` 的值精确等于
`li-` + lowercase/no-padding Base32(SHA-256(UTF8(JSON([name,version,node.id]))))；Consul
`Go-Like-Registration-Token` 的值包含完整 `lr-` 前缀与 256-bit token Base32，不存裸 token 或另作编码。

现有 registrar/discovery/selector 保留角色，但 registrar 的旧输入契约由 `ServiceInstance` 原子迁移为上面完整
声明的 `Service` 契约：删除旧 `RegistrationOptions` 与 `ServiceInstanceSource` 导出，分别由 Go-style
`RegisterOption[]` 与 `ServiceSource` 取代。`ServiceInstance` 只保留给 discovery/selector 便利层，不再作为
Registrar 的 wire input。便利层固定建立在 Registry 上：

```ts
export interface ServiceInstance {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly endpoints: readonly string[];
  readonly metadata: Readonly<Record<string, string>>;
}

export interface DiscoveryWatcher extends ServerHandle {
  next(ctx: Context): Promise<readonly ServiceInstance[]>;
}

export interface Discovery {
  getService(ctx: Context, name: string): Promise<readonly ServiceInstance[]>;
  watch(ctx: Context, name: string): Promise<DiscoveryWatcher>;
}

export interface ServiceInstanceResolver {
  resolve(
    ctx: Context,
    service: Service,
    node: Node,
  ): ServiceInstance | PromiseLike<ServiceInstance>;
}

export function discovery(
  registry: Registry,
  resolver: ServiceInstanceResolver,
  ...options: readonly DiscoveryOption[]
): Discovery;
```

`ServiceInstance` 保留现有 `{ id, name, version, endpoints: string[], metadata }` 便利形状；resolver 对每个 Node
负责产生完整且已验证的实例，Registry 不替它合并 metadata 或补 scheme。
`DiscoveryOption` 精确包含 `resyncInterval(valueMs)`（默认 5,000，100..60,000 整数）和
`resyncRetries(count)`（默认 3，0..100 整数），后一次 option 覆盖前一次。

- Registry 直接满足 `Registrar`，`Registrar.register` 与 Registry.register 返回同一个 owning handle；
- `discovery(registry, resolver, ...options)` 必须显式接收 `ServiceInstanceResolver`，由 resolver 把
  Service + Node 转为旧 selector 所需的 URL-based ServiceInstance；没有默认 resolver，不猜 HTTP scheme、
  metadata key 或 transport；
- DiscoveryWatcher.next 返回完整 replacement snapshot，包括空 snapshot。它采用 watch-first、缓冲 raw events、
  get、按 identity/content hash reconcile，并默认每 5 秒 resync；mDNS 没有全局 revision，因此该便利层承诺
  eventual convergence，不虚构 linearizable“无间隙”快照。Consul 可以使用 blocking index 提供更强内部游标，
  但不抬高跨 provider 公共保证；
- raw watcher overflow 时 convenience 关闭旧 watcher并重新执行 watch-first/get；超过 retry policy 才令自身
  terminal；内部 snapshot cache 不作为 `./cache` 公共 export；
- `registration(registrar, source, ...registerOptions)` 使用上面唯一公开签名，把任意 Registrar 包装为 Core
  Server；start 时解析 ServiceSource，调用 Registrar 并 owning 返回的 RegistrationHandle，允许先启动 listener、
  再解析实际地址、最后注册；
- selector 只消费 resolver 产出的 ServiceInstance snapshot，不知道 mDNS、Consul 或 transport metadata。

公共稳定错误固定包含 `RegistryStateError`、`RegistrationStoppedError`、`WatcherStoppedError`、
`WatcherOverflowError`、`RegistryProtocolError` 与 `UnsupportedRegistryCapabilityError`，code 全部使用
`GO_LIKE_*`。未找到服务返回空数组，不把正常空结果重写成异常。

### 9.2 Provider 拓扑与一致性

```text
packages/registry/          @go-like/registry
packages/registry/mdns/     @go-like/registry-mdns
packages/registry/consul/   @go-like/registry-consul
```

provider-neutral conformance 仅作为 workspace 内部测试资产；mDNS 与 Consul 必须通过同一组 register/handle
stop、get、list、watch、duplicate/update、Context cancel、immutable snapshot 与 terminal 测试。snapshot
convenience cache 保持 registry 内部模块，mDNS DNS RR/TTL cache 保持 provider 内部模块；v1 不发布悬空的
`@go-like/registry/cache` 子路径。

公共 conformance 把数据模型/ownership/event 语义与 provider capability bounds 分层：common `ttl()` 可表达的
范围不代表每个后端都能兑现每个值；provider 必须公开 immutable capability snapshot，超出其真实 TTL、metadata、
address family 或 watch 能力时在外部副作用前抛 `UnsupportedRegistryCapabilityError`。测试用 capability snapshot
参数化相同语义用例，不把 provider-specific 限制伪装成随机失败。
`maximumServicePayloadBytes` 是 canonical JSON 解码后的 hard ceiling，不是“该大小必然可注册”的承诺；provider
仍须按压缩率、wire/chunk overhead 和 configured packet/request 上限验证每个实际 payload，并可在副作用前拒绝。

`@go-like/registry-consul` 迁移现有标准 Fetch 实现，不引入 Node-only Consul SDK。其 TTL health、watch、
崩溃过期和 deregister 必须继续使用真实 Consul Docker 容器验证。`@go-like/config-consul` 独立归属配置域；
两者可以共享协议事实和测试容器，但不能通过一个 `@go-like/consul` 根包重新耦合。

### 9.3 `@go-like/registry-mdns` 公共面与 host SPI

标准 Web API 没有 UDP socket、multicast membership、网卡枚举或 `SO_REUSEADDR`，因此不能声称只靠 Fetch、
Streams 与 AbortSignal 就能完成 mDNS。mDNS 根入口保持 portable，并显式注入以下 runtime host：

```ts
export interface MDNSHost {
  networkInterfaces(ctx: Context): Promise<readonly MDNSNetworkInterface[]>;
  bindDatagram(
    ctx: Context,
    options: MDNSBindOptions,
  ): Promise<MDNSDatagramSocket>;
}

export interface MDNSDatagramSocket {
  done(): Promise<void>;
  joinMulticast(
    ctx: Context,
    group: string,
    interfaceId: string | number,
  ): Promise<MDNSMembership>;
  setMulticastLoopback(ctx: Context, enabled: boolean): Promise<void>;
  setMulticastInterface(
    ctx: Context,
    interfaceId: string | number,
  ): Promise<void>;
  send(ctx: Context, data: Uint8Array, target: MDNSAddress): Promise<void>;
  receive(ctx: Context): Promise<MDNSDatagram>;
  close(ctx: Context): Promise<void>;
}

export interface MDNSMembership {
  leave(ctx: Context): Promise<void>;
}

export type MDNSFamily = "ipv4" | "ipv6";

export interface MDNSNetworkInterface {
  readonly id: string | number;
  readonly name: string;
  readonly family: MDNSFamily;
  readonly address: string;
  readonly internal: boolean;
}

export interface MDNSBindOptions {
  readonly family: MDNSFamily;
  readonly bindAddress: string;
  readonly port: number;
  readonly interfaceId: string | number;
  readonly interfaceAddress: string;
  readonly reuseAddress: boolean;
  readonly multicastTTL: number;
}

export interface MDNSAddress {
  readonly family: MDNSFamily;
  readonly address: string;
  readonly port: number;
}

export interface MDNSDatagram {
  readonly data: Uint8Array;
  readonly remote: MDNSAddress;
  readonly interfaceId?: string | number;
}

export interface MDNSOptions {
  readonly domain: string;
  readonly interfaceIds: readonly (string | number)[];
  readonly families: readonly MDNSFamily[];
  readonly queryTimeoutMs: number;
  readonly port: number;
  readonly maxPacketBytes: number;
  readonly maxDecodedPayloadBytes: number;
}

export type MDNSOption = (options: MDNSOptions) => MDNSOptions;

export declare function domain(value: string): MDNSOption;
export declare function interfaces(
  ...ids: readonly (string | number)[]
): MDNSOption;
export declare function families(...values: readonly MDNSFamily[]): MDNSOption;
export declare function queryTimeout(valueMs: number): MDNSOption;
export declare function port(value: number): MDNSOption;
export declare function maxPacketBytes(value: number): MDNSOption;
export declare function maxDecodedPayloadBytes(value: number): MDNSOption;

export function newMDNSRegistry(
  host: MDNSHost,
  ...options: readonly MDNSOption[]
): Registry;
```

Node host 按“一个 family/interface 一个 socket”绑定，接收 interface 优先从 socket identity 推导；平台能提供
packet interface metadata 时再填可选 `MDNSDatagram.interfaceId`。host 不拥有 DNS packet、TXT codec、TTL
clock/cache 或 watcher diff，这些协议行为只在 portable provider 实现一次。`@go-like/registry-mdns/node` 使用
`node:dgram` 与 `node:os` 只提供 `newNodeMDNSHost()`；根入口不静态解析 `node:`。Bun 可以在真实验证后复用
Node host；Deno multicast 仍为 unstable 时不得进入稳定 runtime 声明。

`MDNSOption` 的 v1 helper/字段不留扩展空白：

| helper                          | 默认                  | 校验与语义                                                                                     |
| ------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| `domain(value)`                 | `go-like`             | 一个或多个 DNS-safe label；规范化为小写 FQDN，并对所有最终 owner/target 执行 DNS wire 长度校验 |
| `interfaces(...ids)`            | 空表示全部非 internal | 后一次整体覆盖；未知或 family 不匹配时 bind 前失败                                             |
| `families(...values)`           | `ipv4`                | 去重后的 `ipv4`/`ipv6` 非空集合；IPv6 必须显式启用                                             |
| `queryTimeout(valueMs)`         | 1,000                 | 1..60,000 整数毫秒                                                                             |
| `port(value)`                   | 5353                  | 1..65,535；非 5353 仅用于隔离测试/高级网络                                                     |
| `maxPacketBytes(value)`         | 1,200                 | 512..1,200；禁止通过调大来依赖 IP fragmentation                                                |
| `maxDecodedPayloadBytes(value)` | 65,536                | 1,024..65,536，解压和 JSON parse 前执行上限                                                    |

`MDNSOption` 只在 `newMDNSRegistry(host, ...options)` construction 时按顺序 last-wins；`Registry.init` 只接受
公共 `RegistryOption`，不通过 overload 偷渡 provider option。mDNS 不使用远端 registry endpoint，因此公共
`addresses()` 的非空结果在 init 时同步抛 `UnsupportedRegistryCapabilityError`，空 addresses 是唯一合法值。
每个 RegistrationHandle、query 和 Watcher 捕获 common + provider immutable snapshot，active operation 不受之后
init 影响。mDNS get/list 的有效等待上限是调用 Context、`getTimeout`/`listTimeout`（默认 common timeout）与
construction-time `queryTimeout` 三者最早者。testing 子路径可以注入 fake clock/packet sink，但它们不是
production export。

### 9.4 mDNS wire 与可靠性语义

go-like 参考 go-micro 的节点级 PTR/SRV/TXT/A/AAAA 角色，但不宣称与 go-micro 默认 `.micro` wire 兼容：

1. 默认 domain 为 `go-like.`，所有自有 TXT key 使用 `Go-Like-` 前缀；wire 包含
   `Go-Like-Wire-Version=1`，不读写旧 namespace alias。
2. canonical identity 是 UTF-8 JSON tuple `[service.name, service.version, node.id]`。`serviceLabel` 为
   `ls-` + RFC 4648 lowercase/no-padding Base32(SHA-256(service.name))，`identityLabel` 为
   `li-` + Base32(SHA-256(identity))，`hostLabel` 的 preimage 精确为无空白 UTF-8 JSON tuple
   `["go-like.host.v1", [service.name, service.version, node.id], sortedAddresses]`，addresses 按 ASCII code point
   升序；其值为 `lh-` + Base32(SHA-256(preimage))。每个 label 不超过 63 bytes。
   host owner 因而是 identity-scoped，不会仅因两个进程或服务恰好使用相同 addresses 而碰撞。TXT 携带原值，
   接收方重新计算 hash；任意 Unicode/长名称不直接污染 DNS label，同 name/node 的不同 version 也不会冲突。
3. RR owner/target 固定如下，不能由实现自行发挥：list owner 是 `_services.<domain>.`；它的 PTR target 是
   `<serviceLabel>.<domain>.`。该 service owner 的 TXT 保存原 service name，同时其 PTR target 是
   `<identityLabel>.<serviceLabel>.<domain>.`。instance owner 同时持有 SRV/TXT，SRV target 为
   `<hostLabel>.<domain>.`；host owner 持有 A/AAAA。listServices 只查询 list owner PTR，getService(name)
   计算 serviceLabel 后查询 service owner PTR，并验证所有 additional records 的 owner/target/hash。
   `domain()` 不能只校验 domain 自身：构造时必须用统一 `validateDNSName(labels)` 分别验证 list、service、
   instance 和 host 的最坏 owner/target；每个 label 的 wire octet 不超过 63，包含根标签和每段 length octet 的
   完整 encoded DNS name 不超过 255。边界测试直接构造最长合法/首个非法最终 FQDN，不维护容易漂移的近似常数。
4. Node addresses 必须是 IP-literal host:port，至少一个，且同一 Node 的所有地址共享一个 SRV port；注册时每个
   地址必须属于所选本机 interface。IPv4/IPv6 分别进入 A/AAAA，discovery 完整重建 addresses 数组。
5. 每节点 TXT payload 是 canonical UTF-8 JSON：对象字段顺序固定，metadata key 以 Unicode code point 排序，
   addresses 与 Endpoint/Value 数组保持声明顺序（第一 address 可作为 provider primary）。输入拒绝重复 address、
   object cycle，Value 深度上限 32、总节点上限
   1,024。payload 使用标准 `CompressionStream("deflate")` 后作 base64url 编码，encoding 字面量固定为
   `deflate+base64url`，TXT 依次写入
   `Go-Like-Wire-Version`、`Go-Like-Encoding`、`Go-Like-Service-Content-Hash`、
   `Go-Like-Identity-Content-Hash`、`Go-Like-Chunk-Count` 与连续零填充
   `Go-Like-Chunk-NNN`；缺段、重复、unknown encoding、hash 不符或解压超限都报 protocol error。
6. TXT 单项不超过 255 bytes，完整 DNS response 不超过 configured 512..1,200 bytes；超限在发包前失败，
   不静默删字段或依赖 IP fragmentation。
7. 一个 register 调用为每个 Node 创建 registration token，并返回拥有整组 token 的单一 RegistrationHandle；
   provider 通过 per-identity serializer 保存存活 token stack，multi-node register 总按 identity hash 排序进入、
   逆序 rollback，最新 accepted token
   的 content 生效。相同 content 可引用计数共享 responder/timer，但每个 handle stop 权独立；停止非当前 token
   不改变 wire，停止当前 token 时恢复上一存活 content并产生 update，最后 token stop 才发 TTL=0 goodbye。
   announce/refresh owner 已启动且 token 压入 stack 后是 register acceptance linearization point；stop 在 wire
   恢复/goodbye 成功且 token 移出 stack 时线性化，失败前 token 仍保持 live。并发 register/stop/rollback 不得
   以最后一个异步 send 完成顺序选择 winner。
   common ttlMs 向上取整为 DNS 整数秒，refresh interval 为 `max(1_000, floor(ttlMs / 2))`。进程硬崩溃无
   goodbye 时 observer cache 到期产生 delete；timer/socket 被动失败使相关 handle done reject。TTL 由 provider
   实现，不是 datagram host capability。service list PTR 在该 service 仍有任一 live identity 时保留，最后一个
   identity 停止时才发送其 TTL=0。单 provider 内对相同 service-list PTR 与 service-owner name TXT 做引用计数；
   只有本地最后引用离开才发送 shared goodbye。
8. RR classification 固定为：所有 PTR 以及 service-owner name TXT 是 shared records，绝不设置 cache-flush；
   identity-scoped instance SRV/TXT 与 host A/AAAA 是 unique records 并设置 cache-flush。registration admission
   必须在 announce 前按 [RFC 6762 §8.1](https://www.rfc-editor.org/rfc/rfc6762.html#section-8.1) probe unique
   owner；相同 rdata 可作为 cooperating responders，通过探测
   发现不同 rdata 则以 identity collision 回滚。之后同 identity 内容变化先
   announce 新 identity-scoped host A/AAAA，再替换 SRV/TXT，最后对旧 unique RRset 发 TTL=0。不同进程仍持有
   完全相同 shared RR 时，收到另一 responder 的 TTL=0 goodbye 必须立即重新 announce 正 TTL 记录以 rescue；
   observer 用 reannounce 抵消 goodbye，不删除仍被发布的 service。该分类与 rescue 遵守
   [RFC 6762 §10.1–10.2](https://www.rfc-editor.org/rfc/rfc6762.html#section-10.1)：shared record 不得设置
   cache-flush，goodbye 先进入一秒宽限供其他 responder rescue。跨进程重复发布同一 canonical identity 且
   identity-content hash 相同时按 cooperating responders 合并；任一 responder 收到自己仍发布的 shared 或 unique
   RR goodbye 都必须在一秒宽限内 reannounce 正 TTL 以 rescue。相同 identity 但 identity-content hash 不同才是
   collision，接收方以 RegistryProtocolError fail closed。raw Watcher 只交付建立后的单 identity
   create/update/delete，buffer overflow 以稳定错误 terminal；不承诺 mDNS 全局 revision 或线性 snapshot。
9. get/list 的 query socket 在 timeout/Context/成功后关闭；watchers 可引用计数共享 listener，最后 watcher
   stop 必须 leave memberships、close socket、清空 remote RR cache 及其 TTL timers，并等待 socket done。
   与查询无关的 DNS packet、未知 go-like wire version、malformed/foreign packet 只做 rate-limited secret-safe log
   后忽略，不得让共享 multicast 网络中的任意坏包终止 Watcher；通过 owner/hash/version 初筛且属于目标服务的
   v1 record 若形成前述 service-content conflict，则 get 失败或 Watcher terminal。Context 取消中断 bind/query/
   send/receive/next wait，但不反向取消调用方 Context。
10. IPv4 使用 UDP/5353 与 `224.0.0.251`，IPv6 使用 `ff02::fb`。每个 socket 必须绑定 family 对应的
    wildcard 地址（`0.0.0.0` 或 `::`），再使用独立的 `interfaceAddress/interfaceId` 设置 outbound interface
    与 membership；不得把网卡单播地址误作 bind address。`reuseAddress` 是跨平台硬要求，`reusePort` 不属于
    portable SPI 或启动前置，因为 macOS Node 对 UDP `reusePort` 可返回 `ENOTSUP`，而真实双进程验证证明
    `reuseAddr` 已足以让同组成员收包。mDNS 响应的 IP multicast TTL 固定为 255；DNS RR 的 TTL120 与 TTL0
    goodbye 是另一协议层，不能混为同一 TTL。只承诺链路本地发现，不承诺跨子网、路由器、
    Docker/Kubernetes overlay 或被策略禁止的 multicast 网络。

### 9.5 Consul provider 映射

```ts
export interface ConsulRegistryOptions {
  readonly fetch: typeof globalThis.fetch;
  readonly address: string;
  readonly token?: string;
  readonly datacenter?: string;
  readonly namespace?: string;
  readonly waitMs?: number;
  readonly minimumQueryIntervalMs?: number;
  readonly retryInitialMs?: number;
  readonly retryMaximumMs?: number;
  readonly hardDrainTimeoutMs?: number;
  readonly deregisterCriticalServiceAfterMs?: number;
}

export declare function newConsulRegistry(
  options: ConsulRegistryOptions,
): Registry;
```

`@go-like/registry-consul` 导出 `newConsulRegistry(options)`；provider options 精确沿用已验证实现：必填 borrowed
`fetch` 与 Consul HTTP(S) origin `address`，可选 token/datacenter/namespace，以及 `waitMs`、
`minimumQueryIntervalMs`、`retryInitialMs`、`retryMaximumMs`、`hardDrainTimeoutMs` 和
`deregisterCriticalServiceAfterMs`。TLS trust/client certificate/custom CA 不进入 options，由注入 Fetch 的 owner
负责。ACL token 不得出现在 URL、Error message、cause、diagnostic 或 snapshot。

Consul provider options 也只在 construction 使用；constructor `address` 建立初始 common
`RegistryOptions.addresses=[address]`。后续公共 `init(addresses(...))` 可以整体覆盖，但 Consul 只接受恰好一个
合法 HTTP(S) origin，零个或多个都同步失败；`options()` 始终返回当前有效 origin。common timeout 限制
register/get/list 的单次 Fetch（调用级 get/list timeout 可进一步缩短），watch blocking request 则由 Watcher
Context、provider `waitMs` 和 Consul 返回共同控制，不被 5 秒 common timeout 截成 busy poll。

默认值固定为 wait 300,000ms、minimum query interval 1,000ms、retry initial 250ms、retry maximum 30,000ms、
hard drain 25,000ms、critical auto-deregister 60,000ms；数值均为有限整数，retry maximum 不小于 initial，
wait 最大 600,000ms，hard drain 最大 2,147,483,647ms，critical auto-deregister 范围 60,000..86,400,000ms。
address 必须是无 credential/path/query/fragment 的 HTTP(S) origin；datacenter/namespace 非空且按 URL query 编码，
token 只进入 header。

映射与所有权固定如下：

1. 每次 register 调用用 Web Crypto `getRandomValues` 生成 256-bit token，编码为
   `lr-` + lowercase/no-padding Base32；它不是 credential，也不接受调用方覆盖。每个 Service Node 注册为一个
   Consul Agent Service，远端 ID 精确为 `<identityLabel>.<registrationToken>`，Name 使用原 service.name。
   canonical identity 与 hash 存在 Meta，不从 remote ID 反推。Node.addresses 第一项是 Consul Address/Port 与
   health target，其余地址仍保存在 payload；provider 在任何 mutation 前验证全部 node 与 payload。
   该 tokenization 直接满足 [Consul Agent Service API](https://developer.hashicorp.com/consul/api-docs/agent/service#json-request-body-schema)
   对 ID “per agent unique”的要求，并避免旧 handle 用 identity-only ID 删除新 owner。
2. Agent Service 添加精确 marker tag `Go-Like-Wire-Version=1`，供 catalog list 排除非 go-like service；tag 不承载
   payload。Meta 按 key 字典序写入 `Go-Like-Wire-Version=1`、`Go-Like-Encoding=deflate+base64url`、
   `Go-Like-Identity-Hash`、`Go-Like-Registration-Token`、`Go-Like-Service-Content-Hash`、
   `Go-Like-Identity-Content-Hash`、`Go-Like-Chunk-Count` 和连续零填充 `Go-Like-Chunk-NNN`。payload 使用与
   mDNS 完全相同的 canonical UTF-8 JSON、deflate 与 base64url；chunk 只切 ASCII encoded string，每段最多
   480 bytes，因而不会切断 UTF-8 code point。v1 自限最多 32 个 chunk、encoded payload 最多 15,360 bytes，
   解压后仍受 capability 的 decoded hard ceiling；remote ID/token/identity/hash 不一致、missing/duplicate chunk、
   unknown encoding 或 decode 上限失败均为 protocol error。
3. 一个 register 调用可包含多个 Node；先完整 validate，再按 identity hash 排序，通过 provider 内部 per-identity
   serializer 取得相同顺序的 mutation ownership。对每个 identity，candidate token 先以 critical TTL check 注册，
   previous local-current record 此时仍 passing；随后 deregister previous remote ID、pass candidate，最后把 token
   压入 local stack，形成 acceptance linearization point。non-current token 只保留 immutable local snapshot，
   不伪装仍有 remote record。任何 response 丢失/超时的 mutation 都按 exact remote ID readback 后判定，不能猜测。
   部分失败按 acceptance 逆序回滚：删除 candidate exact ID，并用 previous 自有 token/ID 重新 register + pass；
   此前没有 previous 才只删除 candidate。原始失败为主，rollback failure 按顺序聚合。返回的单一
   RegistrationHandle 拥有本次生成的全部 token/remote ID 与当前 heartbeat；任一 terminal heartbeat failure
   使 handle done reject 并清理整个组。
4. common ttlMs 映射为每节点 Consul TTL check，heartbeat interval 为 `floor(ttlMs/2)`。显式 handle stop 立即
   停止或恢复它精确拥有的 token/ID，不以 identity-only ID deregister。进程崩溃后 passing-only health 在 TTL
   到期时移除节点并产生 watcher delete。
   `deregisterCriticalServiceAfterMs` 默认 60,000 且遵守 Consul 实际最小值；它控制 catalog 最终清理，不改变
   passing discovery 的 delete 时点。
5. getService 使用 `/v1/health/service/:name?passing=true`，解码 Meta/payload 后按 canonical identity 聚合；同
   identity 的多个 passing remote records 只有 identity-content hash 相同才合并为一个 Node，否则整个操作以
   RegistryProtocolError 失败。按 identity 去重后再按 name/version 与 service-content hash 聚合。
   listServices 使用 `/v1/catalog/services`，因此 critical record 在 Agent 自动 deregister 前仍可能只以 name
   出现在 list；公共 conformance 明确区分 catalog list 与 passing get/watch。
6. watch 使用 passing health blocking query 与 `X-Consul-Index`，先按 remote ID 解码、再按 canonical identity/
   identity-content hash 去重，对相邻逻辑 snapshots 产生单 Node create/update/delete；同一 identity 的最后一个
   cooperating record 离开才 delete。provider-controlled current-token swap 的短暂空窗在
   `minimumQueryIntervalMs` 内被 coalesce：同 identity 恢复为相同内容不发事件，内容改变发一个 update；超过窗口
   才 delete。index 回退执行 reset/full diff，availability retry 有最小间隔，非 retryable schema/protocol conflict
   令 Watcher terminal。
7. 同 identity 的多个 RegistrationHandle 使用与 mDNS 相同的 token/generation 规则：每次调用独立拥有 token，
   最新存活 token 的内容生效；停止非当前 token 不影响 wire，停止当前 token 时恢复上一存活 snapshot并产生
   update，最后 token 停止才 deregister/delete。恢复 previous 使用其原 token 的 exact remote ID；旧 handle 永远
   无权删除另一个 token 的 record。register/stop/rollback 都经过同一 per-identity serializer；stop 的线性化点是
   remote current 恢复或 exact-ID deregister 成功且 token 从 live stack 移除之时，失败前 token 保持 live。
   多 identity 操作始终采用排序 acquire、逆序 release/rollback，并发 register/stop 不得由最后完成的 HTTP
   request 猜测 winner。不同 Registry 实例/进程的同 identity records 可以并存：identity-content 相同按 cooperating
   publishers 去重，不同则按 collision fail closed；任何 handle 都只回收自己的 registration token。
8. catalog 中无精确 marker tag、health 中未知 wire version 的 foreign service 均忽略并做 rate-limited log；带 v1
   marker 但 Meta schema/hash/chunk 非法的目标 service 使 get 失败或 Watcher terminal，不把受管数据损坏伪装为空。

### 9.6 Registry 真实验证

- mDNS 单元测试只允许 fake host 验证 codec、packet、TTL clock、状态机和错误分支；它不能作为协议验收证据。
- Docker Compose 使用自定义 bridge，publisher 与 observer 是两个独立容器/进程。IPv4 multicast 是硬门禁，
  必测 register→get/list、多 service/version/node、完整 metadata/Endpoint/Value、watch create/update、显式
  handle stop delete、duplicate/update、domain 隔离与 Context cancel。
- 使用 `docker kill -KILL` 杀死 publisher，证明无 goodbye 时 observer 会在 TTL 到期后产生 delete；不得把正常
  stop 冒充 crash test。
- IPv6 使用启用 IPv6 的独立 Docker network；若执行环境确实不具备 IPv6 multicast，结果必须明确标记
  unsupported，不能跳过后仍计入通过。
- Node host 是 v1 硬门禁。Bun/Deno 只有在各自 host 通过同一 conformance 与双容器套件后才能进入支持矩阵。
- watcher stop 不只检查“端口可重绑”：还要证明 stopped observer 不再收包，并在 Linux 容器读取进程 fd 与
  `/proc/net/udp*` 作为 socket close evidence；rebind 只作辅助断言，因为 reuseAddress 可能掩盖泄漏。
- crash suite 使用测试 ttl 2 秒、refresh 1 秒、expiry 容差与固定 hard timeout；observer 先确认缓存，再
  `docker kill -KILL` publisher，不能用默认 120 秒拖慢 gate。
- Consul 使用真实容器验证 register/get/catalog-list/passing-watch/handle-stop、TTL critical、自动 deregister、
  Agent restart/re-register、blocking index reset、多节点 partial rollback 与 ACL token 脱敏；fake 仅覆盖状态机。
- 真实 mDNS 容器必须抓取 packet，断言 IP multicast TTL 255、RR owner/target、go-like TXT、DNS RR
  TTL/cache-flush/TTL0 和不存在旧 namespace，不能只以高层 get/watch 成功替代 wire 证据。
- 公共与 provider 套件必须覆盖：同 name/version 的 service-content conflict、同 identity 两个 handle 逆序 stop
  恢复、并发 register/stop、identity-scoped hostLabel、两个 identical responder 的 shared/unique goodbye rescue、
  不同 identity-content collision、最终 FQDN 最长合法/首个非法边界，以及 malformed/foreign packet 不终止
  Watcher。
- Consul fault injection 必须覆盖“覆盖旧 live token 后多节点部分失败”，并证明 rollback 恢复旧 payload/check/
  heartbeat，而不是误 deregister；codec vector 固定 canonical 未压缩 bytes 与 service-content hash，压缩部分只要求
  Bun/Node/Deno 产物互解和相同 decode ceiling，不要求不同 CompressionStream 产生逐字节相同的 deflate 输出。
- 两个独立 Consul Registry 实例指向同一 Agent 时，remote IDs 必须不同；旧 handle stop 只能删除自己的 token，
  identical identity-content 仍保留一个逻辑 Node，different content 必须稳定 protocol conflict。

## 10. `@go-like/web` 与框架包

### 10.1 Portable 根入口

```ts
export type Handler = (request: Request) => Response | Promise<Response>;

export type ContextHandler = (
  ctx: Context,
  request: Request,
) => Response | Promise<Response>;

export interface ContextHandlerOptions {
  readonly timeoutMs?: number;
}

export function contextHandler(
  handler: ContextHandler,
  options?: ContextHandlerOptions,
): Handler;
```

旧 API 精确迁移：`FetchHandler -> Handler`，`toFetchHandler -> contextHandler`；`ContextHandler` 与
`ContextHandlerOptions` 保留。bridge 继续保证 abort cause、timeout、同步/异步 Response identity、Error
identity 和 listener/timer cleanup，不使用 AsyncLocalStorage、Request mutation 或 body buffering。

### 10.2 Web lifecycle host

`@go-like/web/node` 吸收原 `@go-like/fetch-node`：

```ts
export interface NodeAddress {
  readonly address: string;
  readonly family: "IPv4" | "IPv6";
  readonly port: number;
}

export interface NodeServer extends Server<NodeServerHandle> {}

export interface NodeServerHandle extends ServerHandle {
  address(): NodeAddress;
}

export interface NodeServerOptions {
  readonly hostname: string;
  readonly port: number;
  readonly hardDrainTimeoutMs: number;
}

export type NodeServerOption = (
  options: NodeServerOptions,
) => NodeServerOptions;

export interface NodeServerAlreadyStartedError extends Error {
  readonly name: "NodeServerAlreadyStartedError";
  readonly code: "GO_LIKE_NODE_SERVER_ALREADY_STARTED";
  readonly status: "starting" | "running" | "stopping" | "stopped" | "failed";
}

export interface NodeServerForceCloseError extends Error {
  readonly name: "NodeServerForceCloseError";
  readonly code: "GO_LIKE_NODE_SERVER_FORCE_CLOSE";
  readonly timeoutMs: number;
  readonly activeConnections: number;
}

export interface NodeServerUnexpectedCloseError extends Error {
  readonly name: "NodeServerUnexpectedCloseError";
  readonly code: "GO_LIKE_NODE_SERVER_UNEXPECTED_CLOSE";
}

export function hostname(value: string): NodeServerOption;
export function port(value: number): NodeServerOption;
export function hardDrainTimeout(timeoutMs: number): NodeServerOption;

export function newNodeServer(
  handler: Handler,
  ...options: readonly NodeServerOption[]
): NodeServer;
```

它继续结构式实现 `@go-like/core` 的 `Server<NodeServerHandle>`，并只负责 listen accepted、实际地址、稳定
`done()`、graceful drain、hard force 与真实 terminal；协议转换由包内 Node Fetch bridge 提供。其他 runtime
可以自行实现接收 Handler 的结构式 Server，go-like 不要求继承或 decorator。

旧 `NodeFetch*` 类型和 `newNodeFetchServer*` 不发布 alias；地址快照字段与 TCP family 语义保持不变，
成功 start 后的同一地址在 stop 后仍可读取。`./node/testing` 只把旧 factory injection 精确迁为
`newNodeServerWithFactory`。

`@go-like/web/health` 的精确公共面为：

```ts
export interface HealthHandlerOptions {
  readonly livePath?: string;
  readonly readyPath?: string;
}

export function createHealthHandler(
  registry: ProbeRegistry,
  options?: HealthHandlerOptions,
): Handler;
```

`@go-like/health` 仅保留 probe registry 和检查语义。`HealthFetchOptions` 与 `createHealthFetch` 不发布 alias。
`@go-like/prometheus` 返回 `@go-like/web` 的 Handler，不依赖 Node 子路径。

### 10.3 框架接缝

`@go-like/hono`、`@go-like/h3`、`@go-like/elysia` 各自只把 native app 变成稳定绑定的 Handler：

```ts
import type { Elysia } from "elysia";
import type { H3 } from "h3";
import type { Hono } from "hono";

export declare function newHonoHandler(app: Hono): Handler;
export declare function newH3Handler(app: H3): Handler;
export declare function newElysiaHandler(app: Elysia): Handler;
```

适配器保持 native `this`、Response、stream 和异常 identity，不创建 router，不导出 `get`、`post`、`use`、
middleware，不重导出框架。应用使用 `newNodeServer(newHonoHandler(app))` 等显式组合后得到受 Core 管理的
Server；也可以把 Handler 交给任意自实现 runtime Server。

## 11. Workspace、Manifest 与发布门禁

根 workspace glob 固定为：

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

禁止使用宽泛的 `packages/**`，避免把测试 fixture、源码子目录或普通子路径误识别成 workspace。迁移前先建立
一个 canonical workspace discovery，供以下全部门禁复用：workspace 校验、manifest、build reference 校验、
coverage 源码清单、clean-generated、dist 校验、build stamp、published runtime/types 和 E2E inventory。

目录位置不再决定 `packageKind`。`packages/` 中可以同时存在 portable 与 runtime/vendor 包；manifest 根据
实际 import、runtime、resident ownership 和 capability 声明 fail closed。发布门禁使用字面量 23 包集合，
而不是只检查数量；还需证明父包 `@go-like/transport`、`@go-like/config`、`@go-like/registry` 的 tarball 均不包含
子 workspace 的 package metadata、源码或 dist。

### 11.1 Capability manifest v2

现有 package-level manifest 升级为 `schemaVersion: 2`，顶层固定为：

```json
{
  "schemaVersion": 2,
  "package": "@go-like/web",
  "packageKind": "hybrid",
  "stability": "provisional",
  "releaseBlocking": true,
  "exports": {
    ".": {
      "kind": "portable",
      "residency": "non-resident",
      "ownerResources": [],
      "capabilities": ["web"],
      "runtimes": [
        {
          "runtime": "bun",
          "lane": "exact",
          "minimumVersion": "1.3.14",
          "testedVersions": ["1.3.14"],
          "terminalObservability": "not-applicable"
        }
      ]
    },
    "./health": {
      "kind": "portable",
      "residency": "non-resident",
      "ownerResources": [],
      "capabilities": ["health", "web"],
      "runtimes": [
        {
          "runtime": "bun",
          "lane": "exact",
          "minimumVersion": "1.3.14",
          "testedVersions": ["1.3.14"],
          "terminalObservability": "not-applicable"
        }
      ]
    },
    "./node": {
      "kind": "integration",
      "residency": "resident",
      "ownerResources": ["node-server"],
      "capabilities": ["server", "web"],
      "runtimes": [
        {
          "runtime": "node",
          "lane": "lts",
          "minimumVersion": "24.18.0",
          "testedVersions": ["24.18.0"],
          "terminalObservability": "observable"
        }
      ]
    },
    "./node/testing": {
      "kind": "integration",
      "residency": "non-resident",
      "ownerResources": [],
      "capabilities": ["server", "testing"],
      "runtimes": [
        {
          "runtime": "node",
          "lane": "lts",
          "minimumVersion": "24.18.0",
          "testedVersions": ["24.18.0"],
          "terminalObservability": "not-applicable"
        }
      ]
    }
  }
}
```

示例为缩短篇幅只列一个 portable lane 和一个 Node lane；真实 manifest 必须列出该 export 声明支持的全部
固定验证 lane。v2 规则如下：

1. `exports` key 必须与 `package.json#exports` 的公开业务子路径精确一致；只允许额外忽略
   `./package.json`，根 `.` 必须存在。
2. export `kind` 只有 `portable` 或 `integration`。portable export 的 production graph 只能使用项目允许的
   ECMAScript/Web API；integration export 可以使用 runtime 或 vendor SDK，但必须在 runtimes 中如实声明。
3. 顶层 `packageKind` 是派生且被 gate 校验的值：全部 export portable 为 `portable`，全部 integration 为
   `integration`，混合时为 `hybrid`。目录名不参与推导。
4. 顶层不再重复 `residency`、`capabilities` 或 `runtimes`。inventory 需要摘要时，residency 取 export 的并集
   （任一 resident 则 package resident），capabilities 取集合并集；runtime gate 始终按具体 export 执行，
   不生成会丢失信息的 package-level runtime 结论。
5. `(package, export, capability)` 必须在官方 capability vocabulary 中有非空 code/test evidence；路径相对
   package 根目录，纳入 hash snapshot。未登记 capability、缺 evidence 或 evidence 文件不存在均失败。
6. 每个 export 必须声明唯一的 `ownerResources` 数组。resident export 的数组非空，所有 id 必须存在于同包
   owner manifest，且 owner resource id 在整个 package 内唯一；其每个 runtime entry 的
   `terminalObservability` 不能是 `not-applicable`。non-resident export 的数组必须为空，所有 runtime entry
   使用 `not-applicable`。owner manifest 中每个 resource 必须被至少一个 resident export 引用。
7. Runtime lane 按包精确固定：`@go-like/transport-http` 的 `.`、`./testing` 在 Bun、Node、Deno lanes
   验证，`./node` 只进入 Node lanes；`@go-like/web` 的 `.`、`./health` 在 Bun、Node、Deno lanes 验证，
   `./node`、`./node/testing` 只进入 Node lanes。portable 子路径不得因同包存在 Node 子路径而退化为
   Node-only，Node 子路径也不得进入 Bun/Deno lane。`@go-like/registry-mdns` 的 `.`、`./testing` 在 Bun、
   Node、Deno lanes 验证 portable graph，`./node` 只进入 Node lanes；这只证明 portable API/codec 可加载，
   不代表 Bun/Deno 已具备 mDNS host。`@go-like/registry-consul` 与 `@go-like/config-consul` 根入口使用标准
   Fetch，进入 Bun、Node、Deno lanes。

schema、fixture、validator、runtime manifest、published gate 和文档生成器必须在同一个变更中切到 v2；仓库
模式不接受 v1/v2 混用。fixture 模式可以保留只用于证明 v1 会被拒绝的 legacy case。

### 11.2 Registry residency 清单

Registry 相关 exports 的 v2 residency/ownership 固定如下，不能只写“portable graph”后省略 resident 事实：

| package/export                       | kind        | residency    | ownerResources                              | terminal evidence                                   |
| ------------------------------------ | ----------- | ------------ | ------------------------------------------- | --------------------------------------------------- |
| `@go-like/registry` `.`              | portable    | resident     | `service-registration`、`discovery-watcher` | 返回的 RegistrationHandle/DiscoveryWatcher `done()` |
| `@go-like/registry` `./testing`      | portable    | non-resident | 空                                          | not-applicable                                      |
| `@go-like/registry-consul` `.`       | portable    | resident     | `consul-registration`、`consul-watcher`     | RegistrationHandle/Watcher `done()`                 |
| `@go-like/registry-mdns` `.`         | portable    | resident     | `mdns-registration`、`mdns-watcher`         | RegistrationHandle/Watcher `done()`                 |
| `@go-like/registry-mdns` `./node`    | integration | resident     | `node-mdns-datagram`                        | MDNSDatagramSocket `done()`                         |
| `@go-like/registry-mdns` `./testing` | portable    | non-resident | 空                                          | not-applicable                                      |

Registry/MDNS/Consul object construction 本身不启动资源；表中 resident 表示 export 可以创建显式 owner handle。
每个 owner resource 都必须在 owner manifest 唯一登记，并有正常 stop、被动 failure、Context-abandoned wait 与
真实 terminal 测试。borrowed Fetch、HTTP Consul process、MDNSHost factory 不计入 go-like-owned resource。

### 11.3 Transport 与 Web residency 清单

| package/export                        | kind        | residency    | ownerResources                                | terminal evidence                                                    |
| ------------------------------------- | ----------- | ------------ | --------------------------------------------- | -------------------------------------------------------------------- |
| `@go-like/transport` `.`              | portable    | non-resident | 空                                            | not-applicable                                                       |
| `@go-like/transport` `./headers`      | portable    | non-resident | 空                                            | not-applicable                                                       |
| `@go-like/transport` `./testing`      | portable    | non-resident | 空                                            | not-applicable                                                       |
| `@go-like/transport-http` `.`         | portable    | resident     | `http-client`、`http-listener`、`http-server` | Client `close()`、Listener `accept()/close()`、ServerHandle `done()` |
| `@go-like/transport-http` `./node`    | integration | resident     | `http-server`、`node-http-host`               | ServerHandle 与 HTTPHostHandle `done()`                              |
| `@go-like/transport-http` `./testing` | portable    | non-resident | 空                                            | not-applicable                                                       |
| `@go-like/web` `.`                    | portable    | non-resident | 空                                            | not-applicable                                                       |
| `@go-like/web` `./health`             | portable    | non-resident | 空                                            | not-applicable                                                       |
| `@go-like/web` `./node`               | integration | resident     | `node-server`                                 | NodeServerHandle `done()`                                            |
| `@go-like/web` `./node/testing`       | integration | non-resident | 空                                            | not-applicable                                                       |

`@go-like/transport-http/owner.json` 精确登记 `http-client`、`http-listener`、`http-server`、
`node-http-host` 四项；每项都使用 `owner:"go-like-owned"`、`exposure:"managed-private"` 和
`stopContract:"go-like-owned"`。`@go-like/web` 只登记 `node-server`，使用相同三个 ownership 值。
borrowed executor、HTTPHost factory、注入的 HTTPTransport 与 handler 不登记为 go-like-owned resource；
包内 Node Fetch bridge 是实现细节，不单独登记为 resident resource。

最终 workspace 数为 27：23 个发布包和 4 个 private examples。`tsconfig.base.json` paths、
`tsconfig.build.json` references、每包相对 build 路径、E2E cwd、coverage glob 和 `bun.lock` 必须全部识别
`packages/transport/http`、`packages/config/consul`、`packages/registry/consul` 与 `packages/registry/mdns`。
静态 `tsconfig.build.json` 不在运行期调用 discovery；gate 读取其 references 并与 canonical inventory 精确
比对，或由显式生成命令重建后再比对。lockfile 只能由仓库固定的 Bun `1.3.14` 重新生成，不手工编辑。

## 12. 迁移顺序

1. 记录当前 dirty main 工作树基线，识别用户已有改动；不 reset、不覆盖、不创建 worktree。
2. 先让 canonical workspace discovery 与全部 gate 同时识别单层包以及 config/registry/transport 嵌套
   workspace fixture，保持迁移前现有行为通过；在真实移动前证明 Bun 发现嵌套 workspace，且三个 parent
   fixture tarball 不含 child package。
3. 原子完成 package identity 切换：移动所有现有 adapter、创建本文 23 个最终 package identity、切换 root
   workspaces/TS paths/references/imports/manifests/examples，删除旧 identity；不维护同时包含旧/新的临时 workspace。
   精确读取当日 npm latest 后立即固定版本、用 Bun `1.3.14` 生成 lockfile并执行首次 install。此步骤结束前，
   full build/release gate 预期不可用，不得把中间状态标为通过。
4. 以测试先行新增 `@go-like/transport` 契约、headers、错误与 conformance suite，先锁定 transport address 与
   metadata 角色，供 Registry resolver 显式消费。
5. 以测试先行实现 `@go-like/transport-http` unary Fetch client、低层 listener server、Core lifecycle server、
   host SPI 和真实 Node host；不提前声明 stream。
6. 以测试先行扩展 `@go-like/registry` 公共契约、owner handles、显式 ServiceInstanceResolver 与 conformance。
7. 迁移 Consul，随后实现 mDNS portable codec/provider、Node host、packet capture 与真实双容器测试。
8. 把 Fetch handler/Context bridge 移入 `@go-like/web`，把 Node host 移入 `@go-like/web/node`，迁移 health 和
   Prometheus handler，删除 `@go-like/fetch` 与 `@go-like/fetch-node`。
9. 完成 Croner/BullMQ/NATS/Pino/Winston/OpenTelemetry 等已移动 package 的 native lifecycle 回归，不保留旧包壳。
10. 将四个 private examples 改为只通过正式包名消费；Vanilla、Hono、H3、Elysia 均经过真实 listener。
11. 更新 README、ADR、能力对比和 file inventory；执行 frozen install readback，不在收尾阶段无理由刷新版本。
12. 完成全量单元、类型、构建、发布包、跨 runtime 与真实 Docker E2E，再检查 diff 与工作树状态。

步骤 3 是不可拆分发布的 identity 切换；其后精确 23 包 inventory 和 workspace link 必须保持成立，但 full
behavior/release gate 只在步骤 12 验收。不得提交、发布或把中间功能状态标记为可发布。

## 13. 验证方案

### 13.1 Transport conformance

- 任意用户自实现 Transport、Listener、Socket 均可纯结构式接入，不需要 class、brand、decorator 或 DI。
- option 顺序与 last-wins、默认值、非法 duration、不可变 options snapshot。
- Message header/body 防御性复制。
- listen resolve 后真实 `addr()`、accept pending、正常 close、意外 host failure、单 socket handler failure 隔离。
- socket 顺序、并发 handler、send/recv Context 取消、close 幂等、关闭后稳定错误。
- Context 必须是 I/O callable 的独立首参；负向 type fixture 阻止遗漏或隐藏 Context。

### 13.2 HTTP transport

- 真实 Node listener 上的 POST、headers、二进制 body、空 body、200 response、非 200 bounded error body。
- send/recv invocation-order FIFO、recv-before-send、并发 recv、网络失败归属、取消后的 body/slot cleanup、
  client close abort 与重复 unary recv/send；provisional slot 失败时 send/已认领 recv 使用同一 Error identity，
  后续串行 send 仍继续。
- `dial -> Client -> send/recv` 与 `listen -> accept` 的真实 loopback，证明 HTTP transport 两端互通。
- bind 后/ready 前取消 start 会完整 rollback；start 返回后的第一条请求不进入 deferred 503。Core 取消已完成
  child 的 startup Context 后，HTTP server 仍真实响应。
- graceful stop 允许 in-flight handler 完成；只有 owner deadline + force capability 才取消。caller deadline 先到时
  owner drain 继续，第二个 stop 可加入；25 秒 owner timeout 先于 30 秒 Core budget，stop timeout 与 done terminal
  分离；无 force host 保持真实 pending 并由 Core 报 orphan。
- borrowed HTTPHost/HTTPTransport 不被关闭；Server stop 后同 Transport 的其他 client/listener 仍可使用。
- passive host failure、并发 stop、one-shot、稳定 done/address 与端口释放；start/rollback 多错误顺序稳定。
- `accepted/accept/serve.done/host.done` 真值表覆盖 ready failure、close-before-accept、host-first、serve-first 和
  accept Context cancellation；clean early-exit 必须生成稳定 UnexpectedExitError，reject 保留原 Error identity，
  secondary failure 只进入不可变 AggregateError；启动回滚超时必须保留原 start error 为首项、报告
  `orphaned: true` 并继续后台清理。
- Request signal/Context 单向汇合、send headers timeout、recv body timeout、listen bind failure 与被动 close。
- host 缺失、TLS/H2 buffer/stream/insecure verify/connection-close unsupported、非法地址与禁止 header 都在网络
  副作用前稳定失败；未显式 H2 buffer、无 force 与无 connection metadata 是合法 baseline，声明 force 的 host
  必须返回真实可调用 `forceClose`；`secure(true)` 与非空 tlsConfig 都会触发 TLS capability admission。
- 根入口在 Bun、Node、Deno 可加载且不解析 Node-only 模块；Node 子路径执行真实 listener E2E。

### 13.3 Registry

- 公共 Registry/Registrar/ServiceSource/registration/Service/Node/Endpoint/Value/Watcher 的导出 allowlist、结构实现
  与不可变快照；旧 ServiceInstance Registrar 负向 type fixture 必须编译失败。
- RegistryLogger 与六组 immutable option reducer 验证默认值、顺序、last-wins、第三方结构实现和最终 snapshot
  复验；mDNS provider option 只允许 construction，Consul common address override 只接受单 origin。
- mDNS 与 Consul provider 运行 capability-parameterized conformance，包含 register/handle-stop/get/catalog-list/
  passing-watch/update/overflow/Context/terminal 与 token generation ownership。
- Node 多地址、显式 ServiceInstanceResolver、eventual snapshot resync、单 Node Result event、service-content conflict
  fail-closed 与 overflow terminal。
- mDNS portable codec/state 使用 fake；真实行为必须经过 Node 双进程与双 Docker 容器 multicast 套件。
- Consul registration、TTL、watch 与 crash expiry 使用真实 Consul Docker 容器。

### 13.4 Web 与框架

- Context bridge 的同步/异步 identity、abort cause、timeout 和 cleanup 全部保留。
- Node host 的 listen/address、one-shot start、启动回滚、并发 stop、graceful/hard drain、socket terminal。
- Hono、H3、Elysia 使用当前 latest 原生 app 和真实 route 验证 header、body、stream、异常 identity。
- Framework export allowlist 不出现 router 或 middleware API。
- Health 保留 GET/HEAD、200/503、404、405/Allow、`no-store`、脱敏与取消语义。

### 13.5 仓库与外部系统

- 23/23 发布包 runtime 与 types tarball gate；4/4 private examples 真实 Node E2E。
- 最终 package.json exports 与第 5 节逐项相等；core/testing/nats 等子路径不得遗漏，所有包根 `.` 必须存在。
- config/registry/transport 三个 parent tarball 都不包含 nested child workspace metadata、源码或 dist。
- 保留当前 53 个业务 E2E case 与 6 个 Docker suite，不因合包减少协议覆盖。
- Consul、Redis/BullMQ、NATS/JetStream、OpenTelemetry exporter 等外部事实继续使用真实 Docker 服务；fake
  只测试状态机，不能替代协议验证。
- `bun install --frozen-lockfile`、typecheck、100% package line/function coverage、build、dist、manifest、
  file inventory、published gates、完整 E2E、`git diff --check` 全部通过。
- 最终扫描不得存在可执行配置或源码对旧包名、`adapters/`、`@go-like/fetch`、`@go-like/http` 的引用。

## 14. 完成标准

只有同时满足以下条件才可声明迁移完成：

1. 真实目录、package name、exports 与本文 23 包拓扑一致。
2. `@go-like/transport` 公共角色与 go-micro 的 Transport、Message、Socket、Client、Listener 和三组 options
   一一对应，并通过结构式 conformance suite。
3. `@go-like/transport-http` 真实完成 unary Fetch client、低层 listener server 和 Core lifecycle server E2E；
   未支持的 raw/stream 能力显式失败。
4. 对外入站 Web application hosting 只通过 `@go-like/web`；Consul/transport 的标准 Fetch client 不属于入站
   Web hosting。transport-http 不包含 Web 框架职责，两者无循环依赖。
5. 任意用户自实现 Server 或 runtime Web Server 可以结构式接入 Core；任意 HTTPHost 可以结构式注入
   `@go-like/transport-http`。HTTPHost 本身不是 Core Server；同包 `newHTTPServer` 负责把
   `listen/accept/close` 正确组合成 Core Server，但应用仍可自行实现等价结构式 Server。
6. `@go-like/registry` 完整覆盖 Registry/Service/Node/Endpoint/Value/Watcher 与 owning handles；mDNS 与
   Consul 均通过 capability-parameterized 公共 conformance，mDNS 通过真实双容器 multicast、Consul 通过
   真实 Consul 容器。
7. mDNS wire 只使用 go-like namespace，TTL、crash expiry、update、watch overflow 和 socket cleanup 均有
   可执行测试；没有复制 go-micro 已确认的静默缺陷。
8. 23 个 package export allowlist、27 个 workspace identity、直接依赖表与 v2 manifest/owner 清单逐项一致。
9. 所有第三方依赖使用实施时的 npm latest 精确版本，lockfile frozen 回读成功。
10. 所有本地、跨 runtime、发布包和 Docker 门禁真实执行并通过；没有把未执行项写成成功。
11. 用户原有 dirty main 修改未被覆盖；没有未经授权的 commit、push、release 或部署。
