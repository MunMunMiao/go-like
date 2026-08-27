# 迁移与接入

最稳妥的迁移规则是：**保留数据面，接入你能解释清楚的边界**。这里的数据面，指真正处理请求、消息或任务的那部分系统。

保留现有的 Web 框架、worker、调度器、Broker、日志器或遥测 provider（具体实现方）。围绕一个真实的生命周期或服务调用问题，加上一条明确的 go-like 契约。确认这条边界成立后，再接入下一个 provider。

## 分阶段迁移

1. 保持现有启动流程以及路由/数据面代码不变。
2. 找出一个明确的所有者：监听器、worker、调度器、Broker 订阅、日志目标或遥测 provider。
3. 增加结构式 `Server` 适配器，或使用已有的 go-like 适配器。明确资源如何被接纳、如何停止、停止等待多久，以及最终状态在哪里观察。
4. 在真正发生取消或截止时间控制的边界接入 `@go-like/context`，它提供携带取消信号、截止时间和上下文值的 `Context`，并把它作为操作的第一个参数传下去。
5. 用 `@go-like/health` 和 `@go-like/web/health` 增加存活和就绪检查。
6. 在测试中先用 `@go-like/transport-memory` 加一条内部 typed unary call（带类型的单请求/单响应调用）。
7. 只有在确实需要网络线路或原生 Node 主机时，才把这条调用切到 `@go-like/transport-http` 或 `@go-like/transport-http/node`。
8. 一次只增加一个能力：Registry、Config、Store、Cache、Broker、日志、指标或 tracing。
9. 为每条新边界记录 provider、runtime、所有者和证据通道。

不要一上来重写整个服务。小契约的价值就在于迁移单元可以保持很小。

## 框架迁移矩阵

| 现有系统 | 保留原生部分                                                          | 优先接入                                                                   | 当前边界                                                                            |
| -------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| NestJS   | Modules、controllers、decorators、DI、interceptors、pipes、adapter    | 在现有应用外包一层自定义结构式 Server，或建立单独的内部 Client/Server 边界 | 当前仓库没有 go-like Nest bridge，也没有自动 DI 集成                                |
| Fastify  | Routes、plugins、hooks、request/reply、原生 listener                  | 自定义生命周期包装，或明确实现的 Fetch bridge                              | 当前没有证据证明 Fastify request/reply 可以自动转换为 go-like Handler               |
| Hono     | Routes、middleware、sub-apps、`app.fetch`                             | `newNodeServer(app.fetch, ...)`，再接入 `newApp(...)`                      | `examples/hono` 展示了直接使用原生 Fetch 的集成方式                                 |
| Elysia   | Route tree、schema、decorators、derives、hooks、Bun/Web Standard 行为 | 在合适的场景使用原生 `app.fetch` 加 Core host/lifecycle                    | 保留 Bun 专属的 `.listen()` 语义；不要把它说成跨 runtime 的 go-like API             |
| H3       | H3 router 和原生 handler 转换                                         | 当前 H3 示例中的 Fetch handler 路径                                        | 当前展示的是 H3 2.x 的 `app.fetch`；旧版 `toWebHandler` 指引需要单独固定版本的示例  |
| Koa      | Middleware 和外部 router                                              | 自定义所有者包装，或内部服务调用                                           | `@go-like/web` 不会直接接收 Koa 的 Node request/reply 对象，除非应用自己提供 bridge |
| tRPC     | Router、procedure middleware、输入/输出解析器、adapter                | 在 host 外围加 Core lifecycle，或使用单独的内部 transport 边界             | go-like Endpoint 不是 tRPC procedure router                                         |

### Hono 示例

这是仓库中已经展示的集成形态：

```ts
import { Hono } from "hono"
import { name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { newNodeServer, port } from "@go-like/web/node"

const web = new Hono().get("/users/:id", (c) => c.json({ id: c.req.param("id") }))

const app = newApp(name("users"), server(newNodeServer(web.fetch, port(3000))), signal())

await app.run()
```

当前 Hono 示例保留 Hono 的路由所有权，把原生 Fetch handler 交给 Node host。它没有新增 go-like 路由表，也没有 Hono 专用 bridge 包。

### Elysia 与 H3

对暴露标准 Fetch handler 的框架，可以采用同样的边界：

```text
framework route table
  -> framework native Fetch handler
  -> @go-like/web/node (when using the Node host)
  -> @go-like/core App
```

在导入 Node 子路径前，先检查框架使用的 runtime adapter。Elysia 的 Bun adapter 和 Web Standard adapter 的 listen 行为并不完全相同；H3 的版本和 handler 转换 API 也需要固定版本的示例。不要因为一个示例存在，就承诺所有框架版本或 runtime 组合都能工作。

## Go 服务迁移

如果你熟悉 Go 或 Kratos，迁移时应该迁移概念，而不是照抄拼写：

| Go 概念           | go-like 概念                                                                                                       | 重要差异                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `context.Context` | `@go-like/context` `Context`                                                                                       | `done()` 返回的是 `AbortSignal` 或 null，不是 Go channel            |
| Server lifecycle  | Core 结构式 `Server`                                                                                               | `start(ctx)` 可能长期不返回，它不等于 readiness                     |
| App runner        | `newApp`、`App.run`、`App.stop`                                                                                    | `App.stop()` 没有调用方 Context，并返回一个共享 Promise             |
| RPC client        | `@go-like/client`                                                                                                  | 内部调用是 unary `Message`；retry 默认关闭                          |
| Transport         | `@go-like/transport`                                                                                               | Provider 和 Message headers 都是 TypeScript/Web 契约                |
| Registry          | `@go-like/registry`                                                                                                | Watcher 返回完整替换后的 snapshot                                   |
| Selector          | `newRoundRobinSelector`、`newRandomSelector`、`newWeightedRoundRobinSelector`、`newP2CSelector`、`newEWMASelector` | feedback 是同步的，并且取决于具体策略                               |
| Protobuf/IDL      | go-like 没有对应能力                                                                                               | `Endpoint` + `Struct` 是 runtime validation，不是生成式 schema 代码 |
| gRPC stream       | go-like 当前没有对应能力                                                                                           | 对外 Web streaming 与内部 unary transport 是两回事                  |

一个适合渐进迁移的第一步，是用 Memory Transport 做一次直连地址的 typed call：

```ts
const transport = newMemoryTransport()
const server = newServer(
  serverTransport(transport),
  address("memory://pricing"),
  handler(pricingEndpoint, pricingHandler)
)
const client = newClient(withTransport(transport))

const result = await client.call(ctx, pricingEndpoint, request, withAddress("memory://pricing"))
```

先把这条边界测通，再引入 Discovery、真正的 Registry provider 或 HTTP transport。这样替换的是目的地和所有权接线，领域契约仍然保持稳定。

## Kubernetes 接入

Kubernetes 原生能力继续由 Kubernetes 负责：

- Deployment、Service、DNS、Ingress、RBAC、探针、发布策略、HPA 和 network policy 仍是平台职责；
- `@go-like/config-kubernetes` 通过注入的 Fetch capability，从一个命名空间内的 ConfigMap 或 Secret 读取一个 key；
- `@go-like/registry-kubernetes` 在确实需要直接发现时使用 EndpointSlice 记录；
- EndpointSlice 不是 Kubernetes Service DNS，也不会提供通用的注册 TTL；
- 可选的 Pod owner reference 和显式注销具有不同的故障语义。

先接入 health 和 configuration，再做直接的 EndpointSlice selection。如果应用已有稳定的 Service DNS 名称，那么 `withAddress(...)` 加 HTTP transport 可能比引入 Registry provider 更简单，也更符合实际。

## Broker 与任务接入

保留原生的结算语义和任务策略：

| 现有数据面     | 保留                                                             | 用 go-like 增加                                                      |
| -------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| NATS Core      | Connection、subscription、queue group、`Msg`、drain              | `newNatsCoreServer`、`newNatsCoreBroker`、生命周期和字节边界         |
| NATS JetStream | Stream、durable consumer、`JsMsg`、ack/nak/term、redelivery、DLQ | `newNatsJetStreamServer`、`newNatsJetStreamBroker`、生命周期         |
| RabbitMQ       | Connection、topology、confirm policy、channel                    | 借用或恢复中的 subscriber lifecycle，以及 generation-safe 的原生结算 |
| BullMQ         | Queue、Worker、processor、retry/backoff、Redis                   | 围绕官方 dormant Worker 使用 `newBullMqWorkerServer`                 |
| Croner         | Cron expression、time zone、callback、overlap policy             | 围绕暂停状态的原生 Cron jobs 使用 `newCronerServer`                  |
| Memory Broker  | 进程内 topic map 和测试语义                                      | `newBrokerServer` 和可选的 event codec                               |

不要把 NATS ack/nak/term、JetStream durable settlement、RabbitMQ confirmations 或 BullMQ retries 搬进一个通用 go-like Broker 抽象。正因为这些语义重要，provider 的原生对象才应该继续可见。

## 状态迁移

一次只迁移一个状态域：

- Config 用于不可变的进程配置快照和 reload；
- Registry 用于临时的服务可达性；
- Store 用于权威记录、revision、CAS、TTL 和分页；
- Cache 用于可以重新计算的临时值。

一个实用的迁移测试，是写下进程重启、读到过期数据、provider 故障、watcher compaction、CAS 冲突和 cache miss 后会发生什么。如果答案不一样，它们就不应该共用一个通用 repository interface。

## 增加可观测性

先创建原生 provider，再包装边界：

```text
application creates logger / Registry / MeterProvider / TracerProvider
  -> go-like wrapper records bounded operation facts
  -> application-owned exporter or destination
  -> explicit Core lifecycle adapter closes the admitted resource
```

`@go-like/prometheus` 不使用 global registry。`@go-like/otel` 不会安装 global providers 或 exporters。Pino 和 Winston adapter 不会替换原生 logger 配置。保持 labels 和 attributes 有界，并另外为应用自有日志制定脱敏策略。

## 迁移验收清单

合并一条边界前，确认：

- 存在一个命名清楚的所有者；
- 所有者拿到正确的 Context，并且不会用 `background()` 替换它；
- 启动接纳和 readiness 是两个不同概念；
- stop timeout 的行为已经按等待边界写清楚；
- 原生终态观察能力仍然保留（如果 provider 提供）；
- 外部 Web handler 和内部 unary handler 没有混用；
- retry 授权与业务操作匹配；
- credentials、metadata、日志和 trace attributes 有脱敏策略；
- provider 专属语义仍然可见；
- 目标 checkout 中的 focused unit/typecheck 命令已通过；
- 相关 runtime、provider、published 或 example E2E 命令要么已执行并记录，要么明确标记为未执行。

## 当前支持边界

仓库目前有 vanilla Fetch、Hono、Elysia、H3、Memory Transport、typed internal calls、health、brokers、workers 和 observability adapter 的直接示例。它没有证明 NestJS 或 Fastify 的自动 bridge、gRPC/Protobuf/IDL 兼容性、全双工内部 stream、通用认证或部署编排能力。这些都需要单独的 adapter、测试和产品承诺。
