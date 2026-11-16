# 使用示例

本文的十个示例只使用设计的公开入口。它们与声明树一起通过 TypeScript 5.9.3 与 7.1.0-beta 的类型检查；它们是设计的演示，不能在当前的包上运行。`10-connect.ts` 导入的 `./generated` 是 `protoc-gen-like` 生成的代码，这里不重现。设计正文见[设计文档](README.md)，完整声明见 [Public API 参考](api-reference.md)，决定编号见[决策记录](decisions.md)。

## 1. 最小的 Web 服务与健康探针

这个示例展示最小可运行的 Web 服务：`newApp` 加 `signal()`、一个 `newProbeRegistry()`、`readyProbe(probes)`、`createHealthHandler(probes)`，以及挂在 `newNodeServer` 上的处理器。写法上的要点：必须显式传入 `signal()`，否则 SIGTERM 会在不排空的情况下杀死进程（core 不隐式安装信号处理）；必须用 `readyProbe(probes)` 把 App 的就绪窗口注册到同一个注册表，否则 `/readyz` 因为 fail-closed 永远返回 503；core 没有路由器，同一个宿主上同时提供业务接口与健康接口时，用一个按路径分派的普通函数组合两个 `Handler`；需要显式 Context 的处理器用 `contextHandler` 包装，它从 `requestContext(request)` 取得宿主为该请求创建的 Context（带 AppInfo 与 `http.server` span）。只用到 `@go-like/core` 的子路径，没有第三方依赖。

示例文件：`01-web.ts`

```ts
// 01 最小 web 服务：只依赖 @go-like/core，运行在 Node 上。
import { name, newApp, readyProbe, server, version } from "@go-like/core"
import { newProbeRegistry } from "@go-like/core/health"
import { signal } from "@go-like/core/node"
import { contextHandler, createHealthHandler, requestContext } from "@go-like/core/web"
import { newNodeServer, nodeShutdownTimeout, port } from "@go-like/core/web/node"

// 1. 探针注册表：存活/就绪探针与协议无关，由 web 处理器与 App 共享。
const probes = newProbeRegistry()

// 2. 业务就绪探针：返回即通过，抛出即失败（health 处理器会给出 503）。
probes.register("ready", "warmup", async () => {
  // 这里可以检查本进程私有的依赖，例如缓存是否已预热。
})

// 3. 健康处理器只处理 GET/HEAD，路径由我们自己分发。
const health = createHealthHandler(probes, { livePath: "/livez", readyPath: "/readyz" })

// 4. contextHandler 把 (ctx, request) 形式的业务处理器适配成 web Handler；
//    ctx 来自宿主创建的请求 Context，携带 AppInfo 与遥测，请求结束或中止时自动取消。
const handler = contextHandler(async (ctx, request) => {
  const { pathname } = new URL(request.url)
  if (pathname === "/livez" || pathname === "/readyz") return await health(request)
  // requestContext 也能直接从原始 Request 取回同一个 Context。
  return Response.json({
    path: pathname,
    hasContext: requestContext(request) !== null && ctx.err() === null
  })
})

// 5. web 宿主本身就是一个 Server，端口与优雅关闭超时用选项函数设置。
const web = newNodeServer(handler, port(3000), nodeShutdownTimeout(10_000))

// 6. App 把宿主放进 server 层级；readyProbe 让 App 自身进入就绪探针，
//    只在启动完成到停止请求之间通过；signal() 订阅 SIGTERM/SIGQUIT/SIGINT 触发优雅停止。
export const app = newApp(
  signal(),
  name("hello-web"),
  version("v1"),
  readyProbe(probes),
  server(web)
)

// 7. run() 在 App 停止后才 resolve。
await app.run()
```

## 2. 注册到 Consul 的 RPC 服务，配置来自 Consul，客户端经服务发现调用另一个服务

这个示例展示一个完整的内部 RPC 服务：一个 `newConsulClient({ fetch, address, token? })` 同时供给 `consulSource`（配置）与 `newConsulRegistry`（注册与发现），因为同一后端的各个插座共享一个协议客户端（[D26](decisions.md)，构造函数以客户端为第一个参数）；配置在 `newApp` 之前加载，因为监听地址要用来构建服务器（[D5](decisions.md)、[D10](decisions.md) 引导模式）；`defineService` 定义契约，`newServer(transport(newNodeHTTPTransport()), address(...))` 注册处理器；客户端 `newClient(withDiscovery(registry), withEndpoint("discovery:///other-service"), withTransport(newNodeHTTPTransport()))`，Node 服务在服务端与客户端都用 `newNodeHTTPTransport()`（[D24](decisions.md)）；重试必须用 `withRetry({ authorization: "idempotent", ... })` 显式授权（[ADR 0005](../../adr/0005-operation-resilience.md)），断路器用 `circuitBreakerMiddleware(...)`，每个操作一个、以操作名命名。注册中心传两次（`registrar(registry)` 与 `withDiscovery(registry)`）是“没有服务定位器”的直接结果。客户端与配置不是生命周期参与者，在 `afterStop` 中关闭，或按 D5 的做法以 `newResourceServer` 接入资源层。

示例文件：`02-rpc-service.ts`

```ts
// 02 RPC 服务：契约、服务端、Consul 注册与配置、带重试与熔断的发现客户端。
import {
  afterStart,
  name,
  newApp,
  registrar,
  resources,
  server,
  telemetry,
  version
} from "@go-like/core"
import { newConsulClient } from "@go-like/consul"
import { consulSource } from "@go-like/consul/config"
import { newConsulRegistry } from "@go-like/consul/registry"
import {
  circuitBreakerMiddleware,
  middleware as clientMiddleware,
  newClient,
  withBlock,
  withDiscovery,
  withEndpoint,
  withFilter,
  withRetry,
  withSelector,
  withTransport
} from "@go-like/core/client"
import {
  envSource,
  newConfig,
  objectSource,
  onReloadError,
  schema,
  source
} from "@go-like/core/config"
import { background, type Context } from "@go-like/core/context"
import { newResourceServer } from "@go-like/core/lifecycle"
import {
  filterVersion,
  newDiscoveryResolver,
  newP2CSelector,
  selectEndpoint
} from "@go-like/core/registry"
import { exponentialBackoff } from "@go-like/core/resilience"
import { address, advertise, newServer, transport as serverTransport } from "@go-like/core/server"
import { struct } from "@go-like/core/struct"
import { defineService, isServiceError, serviceError } from "@go-like/core/transport"
import { newHTTPTransport } from "@go-like/core/transport/http"
import { newNodeHTTPTransport } from "@go-like/core/transport/http/node"
import { signal } from "@go-like/core/node"
import type { Telemetry } from "@go-like/core/telemetry"

// 1. 契约：请求与响应都是 struct，既是类型来源也是 wire 校验器。
export const orders = defineService("orders.v1", {
  place: {
    request: struct.object({ sku: struct.string(), quantity: struct.number() }),
    response: struct.object({ orderId: struct.string(), accepted: struct.boolean() })
  }
})

// 被调用方的契约（通常由对方团队发布）。
export const inventory = defineService("inventory.v1", {
  reserve: {
    request: struct.object({ sku: struct.string(), quantity: struct.number() }),
    response: struct.object({ reserved: struct.boolean() })
  }
})

// 2. 配置的 struct schema：struct 的每个结果都是 Standard Schema，可直接交给 schema(...)。
const appConfigSchema = struct.object({
  listen: struct.string(),
  advertise: struct.string(),
  inventoryRetries: struct.number()
})

// 3. 一个共享的 Consul 客户端同时服务注册、配置与存储；fetch 由应用提供。
const consul = newConsulClient({
  fetch,
  address: process.env["CONSUL_HTTP_ADDR"] ?? "http://127.0.0.1:8500"
})

// 4. 配置：默认值 < Consul KV < 环境变量；重载失败只告警，保留上一份有效配置。
const config = newConfig(
  source(
    objectSource("defaults", {
      listen: "0.0.0.0:9000",
      advertise: "http://127.0.0.1:9000",
      inventoryRetries: 3
    }),
    consulSource(consul, { key: "services/orders/config", optional: true }),
    envSource(process.env, { prefix: "ORDERS__" })
  ),
  schema(appConfigSchema),
  onReloadError((error) => console.warn("config reload failed", error.name))
)

// 5. 注册中心：同一个 Consul 客户端，实例用 TTL 检查续约。
const registry = newConsulRegistry(consul, {
  ttlMs: 30_000,
  onRegistrationError: (error) => console.error(error.name)
})

// 6. 出站客户端：发现 + P2C 选择 + 熔断中间件；契约的 newClient 把它变成类型化的方法。
const inventoryClient = newClient(
  withDiscovery(registry),
  withEndpoint("discovery:///inventory.v1"),
  withBlock(),
  withSelector(newP2CSelector()),
  withTransport(newHTTPTransport()),
  clientMiddleware(
    circuitBreakerMiddleware({ failureThreshold: 5, resetTimeoutMs: 10_000, name: "inventory" })
  )
)
const inventoryApi = inventory.newClient(inventoryClient)

// 7. 业务服务端：处理器里直接用类型化客户端，ctx 一路向下传递（取消、超时、追踪）。
export async function placeOrder(
  ctx: Context,
  sku: string,
  quantity: number,
  retries: number
): Promise<boolean> {
  try {
    const reply = await inventoryApi.reserve(
      ctx,
      { sku, quantity },
      // 只有调用方显式授权才会重试；reserve 对同一 sku 幂等，所以声明 idempotent。
      withRetry({
        authorization: "idempotent",
        maxAttempts: retries,
        shouldRetry: (_ctx, failure) => isServiceError(failure) && failure.status >= 500,
        backoff: exponentialBackoff({ initialDelayMs: 50, maxDelayMs: 500 })
      }),
      withFilter(filterVersion("v1"))
    )
    return reply.reserved
  } catch (failure) {
    if (isServiceError(failure) && failure.code === "not_found")
      throw serviceError("failed_precondition", `unknown sku ${sku}`, 412)
    throw failure
  }
}

// 8. 需要手动选择实例的场景（例如非 RPC 的健康探测）：直接用解析器与 selectEndpoint。
export async function pickInventoryUrl(ctx: Context): Promise<string> {
  const resolver = newDiscoveryResolver(registry)
  try {
    const instances = await resolver.getService(ctx, "inventory.v1", true)
    const selection = selectEndpoint(ctx, newP2CSelector(), instances)
    selection.done(ctx, { error: null }) // 向选择器回报本次结果（只能调用一次）
    return selection.url
  } finally {
    await resolver.close(background())
  }
}

export async function main(tel: Telemetry): Promise<void> {
  // 先加载一次配置，因为服务端地址依赖它；关闭交给下面的 resource。
  await config.load(background())
  const settings = await config.scan(background(), appConfigSchema)

  const rpc = newServer(
    serverTransport(newNodeHTTPTransport()),
    address(settings.listen),
    advertise(settings.advertise)
  )
  orders.registerHandler(rpc, {
    async place(ctx, request) {
      const accepted = await placeOrder(
        ctx,
        request.sku,
        request.quantity,
        settings.inventoryRetries
      )
      return { orderId: `o-${request.sku}`, accepted }
    }
  })

  const app = newApp(
    signal(),
    name("orders.v1"),
    version("v1"),
    telemetry(tel),
    registrar(registry), // server 层级就绪后注册，停止时先注销
    // resources：依赖先于 server 启动、晚于 server 关闭——配置与出站客户端属于这一层。
    resources(
      newResourceServer({ close: async (ctx) => await config.close(ctx) }),
      newResourceServer({ close: async (ctx) => await inventoryClient.close(ctx) })
    ),
    server(rpc),
    afterStart(async (ctx) => {
      console.info("listening on", await rpc.endpoint(ctx))
    })
  )
  await app.run()
}
```

## 3. OTel 追踪与指标加 pino 日志

这个示例展示观测组合：应用自己构造 OTel SDK 的 `TracerProvider`、`MeterProvider`，注册 `AsyncLocalStorageContextManager`，**不注册全局 OTel 传播器**（go-like 拥有传播，见[设计文档](README.md)第 5.7 节）；SDK 的 `Resource` 用传给 `newApp` 的同一组 `name`/`version` 常量构建（[D39](decisions.md)）；`newTelemetry({ tracerProvider: newOtelTracerProvider(sdk, { requireContextManager: true }), meterProviders: [newOtelMeterProvider(...)], logHandlers: [newPinoHandler(logger, destination)], ignoreRequest })`，其中 `destination` 必须是构造 pino logger 时用的同一个对象；`telemetry(tel)` 安装到 App，它最先准入、最后排空。业务代码只依赖 core：`log.info(ctx, ...)` 自动带 `trace_id`/`span_id`，`inSpan(ctx, "place order", ...)` 让 `pg`、`fetch` 等第三方 span 正确嵌套，`newCounter(name, { attributeKeys: [...] })` 的标签键在编译期检查。服务器与客户端都不再挂观测中间件，core 在固定位置自动建立单元。

示例文件：`03-observability.ts`

```ts
// 03 可观测性：OTel 追踪与指标、pino 日志、业务代码里的 log / inSpan / 指标句柄。
import { afterStart, name, newApp, server, telemetry, version } from "@go-like/core"
import { newMemoryBroker } from "@go-like/core/broker/memory"
import { newBrokerServer } from "@go-like/core/broker"
import type { BrokerMessage } from "@go-like/core/broker"
import type { Context } from "@go-like/core/context"
import { newIntervalSchedule, newScheduleServer } from "@go-like/core/job"
import * as log from "@go-like/core/log"
import { newCounter, newHistogram } from "@go-like/core/metric"
import { signal } from "@go-like/core/node"
import { newTelemetry } from "@go-like/core/telemetry"
import { inSpan } from "@go-like/core/trace"
import { contextHandler, createHealthHandler } from "@go-like/core/web"
import { newNodeServer, port } from "@go-like/core/web/node"
import { newProbeRegistry } from "@go-like/core/health"
import { newOtelMeterProvider, newOtelTracerProvider } from "@go-like/otel"
import { newPinoHandler } from "@go-like/pino/log"
import { context } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace"
import pino from "pino"

// 1. SDK 对象由应用自己构建；go-like 只适配它们，并在接纳时接管 shutdown。
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
const sdkTracer = new TracerProvider({
  spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter() })]
})
const sdkMeter = new MeterProvider({
  readers: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })]
})
const destination = pino.destination({ dest: 1, sync: false })
const logger = pino({ base: null, level: "info" }, destination)

// 2. newTelemetry 把三类后端打成一个 Telemetry 包；日志可以有多个 handler，指标可以有多个 provider。
const tel = newTelemetry({
  tracerProvider: newOtelTracerProvider(sdkTracer),
  meterProviders: [newOtelMeterProvider(sdkMeter)],
  logHandlers: [newPinoHandler(logger, destination)],
  completionLogs: "failures", // 只为失败的单元写完成日志
  // 探针与抓取不产生任何单元（没有 span、没有指标、没有完成日志）。
  ignoreRequest: (request) => {
    const { pathname } = new URL(request.url)
    return pathname === "/livez" || pathname === "/readyz" || pathname === "/metrics"
  }
})

// 3. 类型化的指标句柄：模块级创建，不持有 provider，首次使用时绑定 ctx 里的 provider。
const checkouts = newCounter("shop.checkouts", {
  unit: "{checkout}",
  description: "结账次数",
  attributeKeys: ["channel", "result"]
})
const checkoutDuration = newHistogram("shop.checkout.duration", {
  unit: "ms",
  attributeKeys: ["channel"],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000]
})

// 4. 业务代码：log.info(ctx, ...) 自动带上 trace_id / span_id；inSpan 开一个子 span。
export async function checkout(
  ctx: Context,
  channel: "web" | "app",
  amountMinor: number
): Promise<void> {
  const startedAt = performance.now()
  await inSpan(ctx, "checkout", async (inner, span) => {
    span.setAttributes({ "shop.amount_minor": amountMinor })
    log.info(inner, "checkout started", { channel, amountMinor })
    await inSpan(
      inner,
      "charge-card",
      async (chargeCtx) => {
        log.debug(chargeCtx, "calling payment gateway")
      },
      { kind: "client" }
    )
    // attributes 的键受 attributeKeys 约束：拼错键或传入未声明的键是编译错误。
    checkouts.add(inner, 1, { channel, result: "ok" })
  })
  checkoutDuration.record(ctx, performance.now() - startedAt, { channel })
}

// 5. 定时与消息单元：下面两个处理器里没有任何追踪代码。
//    - newScheduleServer 的每次触发由 core 记录为 `job.run` 单元（span 与运行指标）；
//    - newBrokerServer 的每条投递由 core 记录为 `messaging.process` 单元，并以消息头里的 traceparent 为上游；
//    - 发布端的 broker.publish 由 core 记录为 `messaging.publish` 单元，并把 traceparent 写进消息头。
//    这些单元由 broker/job 的实现经 provider kit 建立，应用无需任何追踪代码。
const broker = newMemoryBroker()
const cleanup = newScheduleServer(
  newIntervalSchedule(60_000),
  "stale-cart-cleanup",
  async (ctx, tick) => {
    log.info(ctx, "cleaning stale carts", { scheduledAt: tick.scheduledAt })
  }
)
const consumer = newBrokerServer(broker, "orders.paid", async (ctx, event) => {
  log.info(ctx, "order paid", { bytes: event.message.body.byteLength })
})
export async function announcePaid(ctx: Context, body: Uint8Array): Promise<void> {
  const message: BrokerMessage = { headers: { "content-type": "application/octet-stream" }, body }
  await broker.publish(ctx, "orders.paid", message)
}

// 6. web 宿主：请求的 http.server 单元由 core 记录，处理器只写业务。
const probes = newProbeRegistry()
const health = createHealthHandler(probes)
const web = newNodeServer(
  contextHandler(async (ctx, request) => {
    const { pathname } = new URL(request.url)
    if (pathname === "/livez" || pathname === "/readyz") return await health(request)
    await checkout(ctx, "web", 1_299)
    return Response.json({ ok: true })
  }),
  port(8080)
)

// 7. telemetry(...) 是最外层：先于一切启动、后于一切排空，所以启动与关闭阶段的日志也不丢。
export const app = newApp(
  signal(),
  name("shop"),
  version("v1"),
  telemetry(tel),
  server(web, cleanup, consumer),
  afterStart(async (ctx) => log.info(ctx, "shop ready", { endpoint: await web.endpoint(ctx) }))
)
```

## 4. 后台 worker：NATS JetStream、croner 调度与 BullMQ 队列

这个示例展示没有 HTTP 流量的工作进程如何组织：应用 `connect()` 得到 NATS 连接并用 `newResourceServer({ terminal: connection.closed(), close: () => connection.drain() })` 接入资源层（[D4](decisions.md)）；`newBullMqJobQueue(queue)` 既是 `JobQueue` 又是队列资源，放在 `resources(...)` 中，它的 `worker(handlers)` 放在 `server(...)` 中，等待准入保证 worker 只在队列就绪后启动、在队列关闭前停止（[D3](decisions.md)）；`newBrokerServer(newNatsJetStreamBroker(js, messagesFactory), "telemetry.raw.v1.*", handler)` 订阅 JetStream，其中 topic 是用作 span 名的订阅标签，真正选择消息的是消息工厂（[D35](decisions.md)），消息确认仍在 `event.native` 上原生完成（[ADR 0007](../../adr/0007-broker-event-native-semantics.md)）；`newScheduleServer(newCronerSchedule("*/10 * * * * *"), "report", tick)` 负责计时、不重叠与排空，在 tick 中用 `queue.enqueue(ctx, name, payload, { id, attempts, backoff })` 向队列投递幂等任务。每次投递、每次 tick、每次任务运行都自动成为工作单元，生产者与消费者经消息头和任务元数据串成一条 trace。

示例文件：`04-worker.ts`

```ts
// 04 Worker：NATS JetStream 消息、croner 定时任务、BullMQ 队列，全部由一个 App 管理。
import { name, newApp, resources, server, telemetry } from "@go-like/core"
import { newBrokerServer, type BrokerEvent } from "@go-like/core/broker"
import type { Context } from "@go-like/core/context"
import { newPermanentJobError, newScheduleServer, type Job } from "@go-like/core/job"
import * as log from "@go-like/core/log"
import { newResourceServer } from "@go-like/core/lifecycle"
import { signal } from "@go-like/core/node"
import type { Telemetry } from "@go-like/core/telemetry"
import { newBullMqJobQueue } from "@go-like/bullmq/job"
import { newCronerSchedule } from "@go-like/croner/job"
import { natsJetStreamCloseTimeout, newNatsJetStreamBroker } from "@go-like/nats/jetstream"
import { jetstream, type JsMsg } from "@nats-io/jetstream"
import { connect } from "@nats-io/transport-node"
import { Queue } from "bullmq"

declare const tel: Telemetry

interface ReceiptJob {
  readonly orderId: string
  readonly email: string
}

// 1. 原生对象由应用构造并拥有；go-like 只通过 resources(...) 接管它们的准入与排空。
const connection = await connect({ servers: "nats://127.0.0.1:4222" })
const js = jetstream(connection)
const receiptQueue = new Queue<ReceiptJob>("receipts", {
  connection: { host: "127.0.0.1", port: 6379 }
})

// 2. NATS 连接作为 resource：停止时在所有 server 停止之后才 drain；意外关闭会让 App 失败。
const natsResource = newResourceServer({
  terminal: connection.closed(),
  close: async () => {
    if (!connection.isClosed()) await connection.drain()
  }
})

// 3. BullMQ 队列：newBullMqJobQueue 同时是 JobQueue 与 Server，放进 resources 保证先于 worker 启动。
const receipts = newBullMqJobQueue<ReceiptJob>(receiptQueue)

// 4. JetStream 代理：消息工厂返回消费者的消息流；topic 只是订阅标签（建议用 filter subject）。
const broker = newNatsJetStreamBroker(
  js,
  async () =>
    await (await js.consumers.get("ORDERS", "order-worker")).consume({ max_messages: 32 }),
  natsJetStreamCloseTimeout(10_000)
)

// 5. 每次投递有自己的 ctx；ack/nak/term 留在 event.native（JsMsg）上，由处理函数决定。
//    注意：处理函数抛出会以同一个错误终止整个订阅，所以可恢复的失败要自己 nak。
async function onOrderPaid(ctx: Context, event: BrokerEvent<JsMsg>): Promise<void> {
  try {
    const order = JSON.parse(new TextDecoder().decode(event.message.body)) as {
      id: string
      email: string
    }
    log.info(ctx, "order paid", { orderId: order.id })
    // 6. 在处理函数里入队：入队本身是一个可观测单元，作业会带上当前的 trace 上下文。
    await receipts.enqueue(
      ctx,
      "send-receipt",
      { orderId: order.id, email: order.email },
      {
        id: `receipt:${order.id}`, // 幂等键：重复投递不会产生第二个作业
        attempts: 5,
        backoff: { type: "exponential", delayMs: 1_000 }
      }
    )
    if (!(await event.native.ackAck({ timeout: 500 }))) event.native.nak(250)
  } catch (failure) {
    log.error(ctx, "order handling failed", {
      error: failure instanceof Error ? failure : new Error(String(failure))
    })
    event.native.nak(5_000) // 5 秒后重投
  }
}
const orders = newBrokerServer(broker, "orders.paid.*", onOrderPaid)

// 7. croner 只给出时刻表（纯函数）；定时器、不重叠与排空都归核心的 newScheduleServer。
const nightly = newScheduleServer(
  newCronerSchedule("0 3 * * *", { timezone: "Asia/Shanghai" }),
  "nightly-report",
  async (ctx, tick) => {
    log.info(ctx, "building nightly report", { manual: tick.manual })
  }
)

// 8. 队列的 worker 是另一个 Server；抛 newPermanentJobError 表示不要再重试。
async function sendReceipt(ctx: Context, job: Job<ReceiptJob>): Promise<void> {
  if (!job.payload.email.includes("@")) throw newPermanentJobError(new Error("invalid email"))
  log.info(ctx, "sending receipt", { orderId: job.payload.orderId, attempt: job.attempt })
}
const receiptWorker = receipts.worker({ "send-receipt": sendReceipt }, { concurrency: 4 })

// 9. 分层：telemetry 最外层，resources 先启后停，所有常驻参与者放在 server 层级。
export const app = newApp(
  signal(),
  name("order-worker"),
  telemetry(tel),
  resources(natsResource, receipts),
  server(orders, nightly, receiptWorker)
)

await app.run()
```

## 5. 不使用 `newApp` 的脚本与测试

这个示例展示 App 之外的代码如何使用 core：脚本用 `withTelemetry(background(), tel)` 借用观测组合，`const running = tel.start(ctx)` 把所有权交给组合，在 `finally` 中 `await tel.stop(ctx)` 后再 `await running`；加载配置失败时可以在 `start` 之前直接 `tel.stop(ctx)`，它会排空未准入的提供者（[D10](decisions.md)）。测试从 `@go-like/core/testing` 取得 `newTelemetryRecorder()`，用 `withTelemetry(background(), recorder.telemetry)` 运行被测代码，再断言 `recorder.spans()`、`measurements()`、`logs()`。这样写是因为没有全局注册：不把组合放进 Context，core 就什么也不记录。

示例文件：`05-script-no-app.ts`

```ts
// 05 脚本与测试：不使用 newApp，由脚本自己持有 Telemetry 的生命周期。
import assert from "node:assert/strict"
import {
  envSource,
  fileSource,
  newConfig,
  objectSource,
  schema,
  source
} from "@go-like/core/config"
import { newNodeFileCapability } from "@go-like/core/config/node"
import { background, withTimeout, type Context } from "@go-like/core/context"
import * as log from "@go-like/core/log"
import { newCounter } from "@go-like/core/metric"
import { newTelemetry, withTelemetry, type Telemetry } from "@go-like/core/telemetry"
import { newTelemetryRecorder } from "@go-like/core/testing"
import { inSpan } from "@go-like/core/trace"
import { struct } from "@go-like/core/struct"
import { newPinoHandler } from "@go-like/pino/log"
import pino from "pino"

// 1. 配置：文件 < 环境变量；schema 用 struct，输出类型随之推导。
const settingsSchema = struct.object({ batchSize: struct.number(), dryRun: struct.boolean() })
const migrated = newCounter("migrate.rows", { unit: "{row}", attributeKeys: ["table"] })

// 2. 业务函数只依赖 ctx：遥测从 ctx 里取，脚本与服务里的代码完全一样。
export async function migrate(ctx: Context): Promise<number> {
  const config = newConfig(
    source(
      objectSource("defaults", { batchSize: 100, dryRun: false }),
      fileSource(newNodeFileCapability(), "./migrate.json"),
      envSource(process.env, { prefix: "MIGRATE__" })
    ),
    schema(settingsSchema)
  )
  await config.load(ctx) // config.load 本身也是一个被观测的单元
  try {
    const settings = await config.scan(ctx, settingsSchema)
    return await inSpan(ctx, "migrate", async (inner, span) => {
      span.setAttributes({ "migrate.batch_size": settings.batchSize })
      log.info(inner, "migration started", { dryRun: settings.dryRun })
      migrated.add(inner, settings.batchSize, { table: "orders" })
      log.info(inner, "migration finished")
      return settings.batchSize
    })
  } finally {
    await config.close(ctx)
  }
}

// 3. 脚本入口：自己构建 Telemetry，withTelemetry 把它放进根 ctx，结束时自己 stop 排空。
export async function runScript(): Promise<void> {
  const destination = pino.destination({ dest: 2, sync: false })
  const logger = pino({ base: null }, destination)
  const tel: Telemetry = newTelemetry({ logHandlers: [newPinoHandler(logger, destination)] })
  const root = background()
  await tel.start(root)
  try {
    const ctx = withTelemetry(root, tel)
    const [timed, cancel] = withTimeout(ctx, 60_000)
    try {
      await migrate(timed)
    } finally {
      cancel()
    }
  } finally {
    await tel.stop(root)
  }
}

// 4. 测试：newTelemetryRecorder 提供内存 provider，不需要真实的 OTel 或 pino。
//    这里用 node:assert，换成任意测试框架都一样。
export async function testMigrate(): Promise<void> {
  const recorder = newTelemetryRecorder()
  const root = background()
  await recorder.telemetry.start(root)
  try {
    const ctx = withTelemetry(root, recorder.telemetry)
    const rows = await migrate(ctx)
    assert.equal(rows, 100)

    const span = recorder.spans().find((candidate) => candidate.name === "migrate")
    assert.ok(span !== undefined && span.ended)
    assert.equal(span.status, "unset")
    assert.equal(span.attributes["migrate.batch_size"], 100)

    // 日志带着记录时的 span 身份，可以直接断言关联。
    const finished = recorder.logs().find((entry) => entry.record.message === "migration finished")
    assert.equal(finished?.spanContext?.spanId, span.context.spanId)

    const measurement = recorder
      .measurements()
      .find((entry) => entry.descriptor.name === "migrate.rows")
    assert.equal(measurement?.value, 100)
    assert.equal(measurement?.attributes["table"], "orders")
  } finally {
    await recorder.telemetry.stop(root)
  }
}
```

## 6. 插头作者：实现一个 Registry

这个示例展示注册中心插头的标准写法：根入口导出 `newXClient(options)`，内部用 `newFetchClient({ fetch, origin: parseOrigin(address, "address"), errors, ... })` 访问后端，缺失文档用 `FetchRequest.allow: [404]` 作为类型化结果而不是错误；`Discovery.watch` 返回 `newSnapshotWatcher(ctx, { initial, bufferSize, poll, backoff: exponentialBackoff(...), retryable })` 的 `watcher`；`Registrar.register` 用实例级的 `newIdentityLocks()`（不放在模块作用域，[D29](decisions.md)）与 `startHeartbeat(registerCtx, { renew, lost, ... })` 维持 TTL；稳定的实例身份用 `sha256Base32`。这样写的原因：常驻循环与心跳在 core 中运行并自动满足观测规则 R4b，插头不需要也不可以调用 core 内部的 `enterRoot`；错误统一为后端自己的错误族，`operation` 带上插座前缀。最后用 `registryConformance` 验证。

示例文件：`06-plug-registry.ts`

```ts
// 06 插件作者：为一个假想的 HTTP 目录服务（Acme Directory）实现 Registry。
// 只用 core 的 Fetch 机器与 registry/provider 工具包：协议细节归插件，续约、快照流、串行化都由 core 提供。
import { withTimeout, type Context } from "@go-like/core/context"
import {
  isRetryableStatus,
  newFetchClient,
  parseOrigin,
  type Fetch,
  type FetchClient,
  type FetchErrors
} from "@go-like/core/fetch"
import {
  snapshotServiceInstances,
  type Registry,
  type ServiceInstance,
  type Watcher
} from "@go-like/core/registry"
import {
  newIdentityLocks,
  newRegistryProtocolError,
  newRegistryStateError,
  newSnapshotWatcher,
  providerOptions,
  startHeartbeat,
  type Heartbeat,
  type ProviderOptionInput
} from "@go-like/core/registry/provider"
import { exponentialBackoff } from "@go-like/core/resilience"

// 1. 后端的有界操作名：会被复制进每个错误，永远不要放入动态内容。
type AcmeOperation = "register" | "renew" | "deregister" | "get"

// 2. 每个插件保留自己的错误名与错误码（GO_LIKE_<BACKEND>_*）。
class AcmeHttpError extends Error {
  override readonly name = "AcmeHttpError"
  readonly code = "GO_LIKE_ACME_HTTP"
  constructor(
    readonly operation: AcmeOperation,
    readonly status: number
  ) {
    super(`acme ${operation} failed with HTTP ${status}`)
  }
}
class AcmeTransportError extends Error {
  override readonly name = "AcmeTransportError"
  readonly code = "GO_LIKE_ACME_TRANSPORT"
  constructor(
    readonly operation: AcmeOperation,
    cause: Error
  ) {
    super(`acme ${operation} transport failure`, { cause })
  }
}

const errors: FetchErrors<AcmeOperation> = {
  http: (operation, status) => new AcmeHttpError(operation, status),
  transport: (operation, cause) => new AcmeTransportError(operation, cause),
  protocol: () => newRegistryProtocolError("acme returned a malformed response")
}

/** 网络失败与 408/429/5xx 值得重试；其余失败对本世代是终结性的。 */
function retryable(failure: unknown): boolean {
  return (
    failure instanceof AcmeTransportError ||
    (failure instanceof AcmeHttpError && isRetryableStatus(failure.status))
  )
}

export interface AcmeRegistryOptions extends ProviderOptionInput {
  readonly fetch: Fetch
  /** 目录服务的 HTTP(S) origin，不含路径与凭据。 */
  readonly address: string
  readonly token?: string
  /** 实例租约，默认 30 秒，每 ttlMs/2 续约一次。 */
  readonly ttlMs?: number
}

/**
 * Acme Directory 的 Registry：同时是 Registrar 与 Discovery。
 * @status new
 * @fills @go-like/core/registry#Registry
 * @fills @go-like/core/registry#Registrar
 * @fills @go-like/core/registry#Discovery
 * @fills @go-like/core/registry#Watcher
 */
export interface AcmeRegistry extends Registry {}

/** 把后端的 JSON 解析成 ServiceInstance[]；任何不符都是协议错误，从不回显原文。 */
function toInstances(name: string, value: unknown): readonly ServiceInstance[] {
  if (!Array.isArray(value)) throw newRegistryProtocolError("acme service list must be an array")
  const parsed = value.map((item): ServiceInstance => {
    if (typeof item !== "object" || item === null)
      throw newRegistryProtocolError("acme instance must be an object")
    const record = item as Record<string, unknown>
    if (
      typeof record["id"] !== "string" ||
      typeof record["version"] !== "string" ||
      !Array.isArray(record["endpoints"])
    ) {
      throw newRegistryProtocolError("acme instance is missing id, version or endpoints")
    }
    return {
      id: record["id"],
      name,
      version: record["version"],
      metadata: (record["metadata"] ?? {}) as Readonly<Record<string, string>>,
      endpoints: record["endpoints"] as readonly string[]
    }
  })
  return snapshotServiceInstances(parsed) // 校验端点并冻结，之后传给 core 的都是不可变快照
}

export function newAcmeRegistry(options: AcmeRegistryOptions): AcmeRegistry {
  // 3. 共享控制项一次校验并冻结（timeoutMs、onRegistrationError）。
  const shared = providerOptions({
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.onRegistrationError === undefined
      ? {}
      : { onRegistrationError: options.onRegistrationError })
  })
  const ttlMs = options.ttlMs ?? 30_000
  const token = options.token

  // 4. core 的 Fetch 机器：redirect 拒绝、ctx 取消、状态码与错误分类都由它处理。
  const client: FetchClient<AcmeOperation> = newFetchClient({
    fetch: options.fetch,
    origin: parseOrigin(options.address, "acme address"),
    ...(token === undefined
      ? {}
      : { authorize: (headers: Headers) => headers.set("Authorization", `Bearer ${token}`) }),
    secret: token !== undefined, // 携带密钥时，传输层原因会被替换成固定的无密钥错误
    errors
  })

  const locks = newIdentityLocks() // 同一注册身份的 register/续约/deregister 串行
  const heartbeats = new Map<string, Heartbeat>()
  const path = (name: string, id?: string): string =>
    `/v1/services/${encodeURIComponent(name)}${id === undefined ? "" : `/${encodeURIComponent(id)}`}`

  // 非阻塞请求都受 timeoutMs 约束。
  async function bounded<T>(ctx: Context, run: (ctx: Context) => Promise<T>): Promise<T> {
    const [timed, cancel] = withTimeout(ctx, shared.timeoutMs)
    try {
      return await run(timed)
    } finally {
      cancel()
    }
  }

  async function getService(ctx: Context, name: string): Promise<readonly ServiceInstance[]> {
    const reply = await bounded(ctx, (c) =>
      client.json(c, { operation: "get", method: "GET", path: path(name), allow: [404] })
    )
    return reply.status === 404 ? [] : toInstances(name, reply.value)
  }

  return Object.freeze({
    async register(ctx: Context, service: ServiceInstance): Promise<void> {
      const identity = `${service.name}/${service.id}`
      const release = await locks.acquire(ctx, identity)
      try {
        if (heartbeats.has(identity)) throw newRegistryStateError("register", "registered")
        await bounded(ctx, (c) =>
          client.send(c, {
            operation: "register",
            method: "PUT",
            path: path(service.name, service.id),
            json: {
              version: service.version,
              metadata: service.metadata,
              endpoints: service.endpoints,
              ttlMs
            }
          })
        )
        // 5. 续约循环归插件私有；core 保证每次续约持有身份锁、在根 span 下运行、失败时通知 onRegistrationError。
        heartbeats.set(
          identity,
          startHeartbeat(ctx, {
            instance: service,
            identity,
            locks,
            intervalMs: Math.floor(ttlMs / 2),
            retryInitialMs: 250,
            retryMaximumMs: 30_000,
            retryable,
            renew: async (c) => {
              await bounded(c, (inner) =>
                client.send(inner, {
                  operation: "renew",
                  method: "POST",
                  path: `${path(service.name, service.id)}/renew`
                })
              )
            },
            lost: () => void heartbeats.delete(identity),
            onRegistrationError: shared.onRegistrationError,
            message: "acme heartbeat failed" // 固定消息，绝不放错误文本
          })
        )
      } finally {
        release()
      }
    },

    async deregister(ctx: Context, service: ServiceInstance): Promise<void> {
      const identity = `${service.name}/${service.id}`
      const release = await locks.acquire(ctx, identity)
      try {
        const heartbeat = heartbeats.get(identity)
        heartbeats.delete(identity)
        await heartbeat?.stop(ctx) // 先停续约，再删除租约
        await bounded(ctx, (c) =>
          client.send(c, {
            operation: "deregister",
            method: "DELETE",
            path: path(service.name, service.id),
            allow: [404]
          })
        )
      } finally {
        release()
      }
    },

    getService,

    // 6. watch：共享的“完整替换快照流”。初始快照在接纳时建立，之后由 core 的循环轮询。
    async watch(ctx: Context, name: string): Promise<Watcher> {
      const initial = await getService(ctx, name)
      const watching = newSnapshotWatcher(ctx, {
        initial,
        bufferSize: 128,
        poll: async (loopCtx) => await getService(loopCtx, name), // 相等的相邻快照会被自动丢弃
        backoff: exponentialBackoff({ initialDelayMs: 250, maxDelayMs: 30_000 }),
        retryable,
        intervalMs: 1_000
      })
      return watching.watcher // 所有权交给调用方，由它 stop
    }
  })
}

// 7. 用法：交给 App 的 registrar(...)，或交给客户端的 withDiscovery(...)。
export function acmeRegistryFromEnv(): AcmeRegistry {
  const token = process.env["ACME_TOKEN"]
  return newAcmeRegistry({
    fetch,
    address: process.env["ACME_ADDR"] ?? "http://directory.internal:8700",
    ...(token === undefined ? {} : { token })
  })
}
```

## 7. 插头作者：用 deliver/publish 工具包实现 Broker

这个示例展示 broker 插头的契约：`publish(ctx, topic, message, options)` 先检查 `ctx.err()`，再用 `brokerTopic` 与 `snapshotBrokerMessage` 校验（校验失败不产生单元、不做 I/O），然后调用工具包 `publish(ctx, system, topic, message, send)`，在 `send` 中把带 `traceparent` 的副本写到原生客户端；投递循环对每条原生消息构造 `newBrokerEvent(...)` 并调用工具包 `deliver(subscriptionCtx, system, subscription, event, handler)`，而不是直接调用处理器；订阅的被动终态用 `registerSubscriberTerminal` 登记，供 `newBrokerServer` 观察。工具包契约是插座契约的一部分（[D33](decisions.md)）：不调用它，处理器就拿不到每次投递的 Context，trace 也会断开，`brokerTelemetryConformance` 会失败。

示例文件：`07-plug-broker.ts`

```ts
// 07 插件作者：用 broker/provider 的 deliver 与 publish 两个 kit 写一个最小的进程内 Broker。
// 可观测性（publish 与 process 单元、traceparent 传播、每次投递的 ctx）全部由 kit 完成，插件只写队列。
import type { Broker, BrokerHandler, BrokerMessage, Subscriber } from "@go-like/core/broker"
import {
  deliver,
  publish,
  brokerTopic,
  newBrokerEvent,
  registerSubscriberTerminal,
  snapshotBrokerMessage
} from "@go-like/core/broker/provider"
import { afterFunc, waitForContext, type Context } from "@go-like/core/context"

/** 原生事件：这个 Broker 的投递序号，应用可在 `event.native` 上读取。 */
export interface InProcDelivery {
  readonly sequence: number
}

/**
 * 进程内的队列式 Broker：发布立即入队，每个订阅有自己的邮箱并串行投递。
 * @status new
 * @fills @go-like/core/broker#Broker
 * @fills @go-like/core/broker#Subscriber
 */
export interface InProcBroker extends Broker<void, void, void, InProcDelivery> {
  string(): "inproc"
}

interface Subscription {
  readonly ctx: Context
  readonly topic: string
  readonly handler: BrokerHandler<InProcDelivery>
  readonly mailbox: { readonly message: BrokerMessage; readonly sequence: number }[]
  accepting: boolean
  wake: (() => void) | null
}

export function newInProcBroker(): InProcBroker {
  const subscriptions = new Map<string, Set<Subscription>>()
  let sequence = 0

  // 1. 每个订阅一个投递循环：串行取出邮箱里的消息，交给 deliver。
  async function pump(
    subscription: Subscription,
    terminal: PromiseWithResolvers<void>
  ): Promise<void> {
    try {
      while (subscription.accepting && subscription.ctx.err() === null) {
        const next = subscription.mailbox.shift()
        if (next === undefined) {
          await new Promise<void>((resolve) => (subscription.wake = resolve))
          subscription.wake = null
          continue
        }
        const event = newBrokerEvent(subscription.topic, next.message.headers, next.message.body, {
          sequence: next.sequence
        })
        // deliver：派生每次投递的 ctx，开始 `process {subscription}` 单元（以消息头里的 traceparent 为上游），
        // handler 结算后释放 ctx，失败原样重抛。
        await deliver(subscription.ctx, "inproc", subscription.topic, event, subscription.handler)
      }
      terminal.resolve()
    } catch (value) {
      // Broker 语义：处理函数失败以同一个 Error 终止该订阅，newBrokerServer 据此让 App 失败。
      subscription.accepting = false
      subscriptions.get(subscription.topic)?.delete(subscription)
      terminal.reject(
        value instanceof Error ? value : new Error("handler rejected", { cause: value })
      )
    }
  }

  return Object.freeze({
    // 2. publish：先校验再进入 kit；kit 开始 `publish {topic}` 单元，并让 send 收到带 traceparent 的分离副本。
    async publish(
      ctx: Context,
      topic: string,
      message: BrokerMessage,
      options?: void
    ): Promise<void> {
      const failure = ctx.err()
      if (failure !== null) throw failure
      if (options !== undefined)
        throw new TypeError("InProc Broker publish options are not supported")
      const selected = brokerTopic(topic)
      const prepared = snapshotBrokerMessage(message)
      await publish(ctx, "inproc", selected, prepared, async (_sendCtx, traced) => {
        for (const subscription of subscriptions.get(selected) ?? []) {
          subscription.mailbox.push({ message: traced, sequence: ++sequence })
          subscription.wake?.()
        }
      })
    },

    // 3. subscribe：返回的 Subscriber 绑定一个终止 Promise，newBrokerServer 靠它感知提供者终止。
    async subscribe(
      ctx: Context,
      topic: string,
      handler: BrokerHandler<InProcDelivery>,
      options?: void
    ): Promise<Subscriber> {
      const failure = ctx.err()
      if (failure !== null) throw failure
      if (options !== undefined)
        throw new TypeError("InProc Broker subscribe options are not supported")
      const selected = brokerTopic(topic)
      if (typeof handler !== "function")
        throw new TypeError("InProc Broker handler must be callable")

      const subscription: Subscription = {
        ctx,
        topic: selected,
        handler,
        mailbox: [],
        accepting: true,
        wake: null
      }
      const members = subscriptions.get(selected) ?? new Set<Subscription>()
      members.add(subscription)
      subscriptions.set(selected, members)

      const terminal = Promise.withResolvers<void>()
      void terminal.promise.catch(() => {}) // 终止错误由 newBrokerServer 观察，这里避免未处理拒绝
      const loop = pump(subscription, terminal)
      afterFunc(ctx, () => subscription.wake?.()) // 订阅 ctx 结束时唤醒空闲的循环，让它退出

      return registerSubscriberTerminal(
        Object.freeze({
          topic: selected,
          // unsubscribe：停止接纳，等已接纳的处理函数结束；ctx 只约束调用者自己的等待。
          async unsubscribe(stopCtx: Context): Promise<void> {
            subscription.accepting = false
            members.delete(subscription)
            subscription.wake?.()
            await waitForContext(stopCtx, loop)
          }
        }),
        terminal.promise
      )
    },

    string(): "inproc" {
      return "inproc"
    }
  })
}
```

## 8. 插头作者：实现一个 LogHandler

这个示例展示最小的日志处理器：`enabled(ctx, level)` 是廉价的级别比较，`handle(ctx, record)` 从不抛出也不阻塞，用 `logCorrelation(ctx)` 写入 `trace_id`、`span_id`、`trace_flags`，`record.event` 非空时写 `event.name`，`LogField.exception` 下的 `Error` 映射到原生错误槽而不复制其消息；没有实现 `withAttrs` 时，core 已经把 `withLogAttrs` 的绑定属性合并进 `record.attrs`；需要把原生资源的关闭交给 App 时，提供 `lifecycle: TelemetryLifecycle`，并且它必须接受“启动前停止”（[D10](decisions.md)）。插头只导入 `/log`、`/telemetry`、`/telemetry/provider`。

示例文件：`08-plug-loghandler.ts`

```ts
// 08 插件作者：一个 JSON-lines LogHandler，写出 trace 关联字段，并带可选的生命周期。
import type { Context } from "@go-like/core/context"
import type { LogAttrs, LogHandler, LogLevel, LogRecord, LogValue } from "@go-like/core/log"
import type { TelemetryLifecycle } from "@go-like/core/telemetry"
import { LogField } from "@go-like/core/telemetry"
import { LogSeverityNumber, logCorrelation } from "@go-like/core/telemetry/provider"

/** 目标：任何接收一行文本的地方（文件、socket、标准错误）。`end` 刷新并关闭。 */
export interface JsonLinesSink {
  write(line: string): void
  end(): Promise<void>
}

const order: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 }

/**
 * JSON-lines 日志后端：带 `withAttrs` 快速路径，生命周期拥有 sink 的关闭。
 * @status new
 * @fills @go-like/core/log#LogHandler
 * @fills @go-like/core/telemetry#TelemetryLifecycle
 */
export interface JsonLinesHandler extends LogHandler {
  readonly lifecycle: TelemetryLifecycle
}

// 1. LogValue 可以是 Error 或嵌套映射：序列化成纯 JSON，Error 只保留名称与消息，不写 stack。
function plain(value: LogValue): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [key, plain(inner as LogValue)])
  )
}

export function newJsonLinesHandler(
  sink: JsonLinesSink,
  minimum: LogLevel = "info"
): JsonLinesHandler {
  // 2. 生命周期：start 接纳；stop 只排空一次，且必须允许在 start 之前调用（此时直接关闭 sink）。
  let state: "idle" | "running" | "stopped" = "idle"
  let drained: Promise<void> | null = null
  const lifecycle: TelemetryLifecycle = {
    async start(ctx: Context): Promise<void> {
      const failure = ctx.err()
      if (failure !== null) throw failure
      if (state !== "idle") throw new Error(`json-lines handler is ${state}`)
      state = "running"
    },
    stop(): Promise<void> {
      state = "stopped"
      drained ??= sink.end() // 重复 stop 加入同一次排空
      return drained
    }
  }

  function build(bound: LogAttrs): JsonLinesHandler {
    return Object.freeze({
      lifecycle,
      // 3. 廉价的级别门：core 在构造任何属性之前先问它。
      enabled(_ctx: Context, level: LogLevel): boolean {
        return state !== "stopped" && order[level] >= order[minimum]
      },
      // 4. handle 不能阻塞也不能抛出：序列化失败就丢弃这一条。
      handle(ctx: Context, record: LogRecord): void {
        if (state === "stopped") return
        try {
          const line: Record<string, unknown> = {
            time: new Date(record.time).toISOString(),
            level: record.level,
            severity_number: LogSeverityNumber[record.level],
            msg: record.message,
            ...(record.event === "" ? {} : { [LogField.event]: record.event }),
            ...(plain({ ...bound, ...record.attrs }) as Record<string, unknown>),
            // 5. logCorrelation：活动 span 的 trace_id / span_id / trace_flags，没有 span 时为 null。
            ...(logCorrelation(ctx) ?? {})
          }
          sink.write(JSON.stringify(line))
        } catch {
          // 日志后端永远不影响业务
        }
      },
      // 6. 可选快速路径：返回绑定了属性的子 handler，共用同一个生命周期。
      withAttrs(attrs: LogAttrs): JsonLinesHandler {
        return build({ ...bound, ...attrs })
      }
    })
  }
  return build({})
}
```

## 9. 运行 `./testing` 的一致性用例

这个示例展示插头作者如何在自己的测试运行器中运行公开的用例集：每个 `<concept>Conformance(subject)` 返回运行器中立的 `ConformanceCase[]`（`{ name, run() }`），把它们逐个注册为 `bun test` 的测试即可；主体对象由插头提供后端连接、资源启动与清理（例如 `BrokerConformanceSubject.newBroker`/`close`、`StoreConformanceSubject.prepareStore`/`releaseStore`）。一方 broker 与任务插头必须在 CI 中同时运行行为用例与观测用例（`brokerConformance` 加 `brokerTelemetryConformance`、`jobQueueConformance` 加 `jobTelemetryConformance`，[D33](decisions.md)）；观测插头运行 `logHandlerConformance`、`tracerProviderConformance`、`meterProviderConformance`、`propagatorConformance`。用例集标注为“测试 API：minor 版本可能增加用例”（待维护者确认，OQ10）。

示例文件：`09-conformance-test.ts`

```ts
// 09 一致性测试：对 Registry、Broker 与 LogHandler 运行 @go-like/core/testing 的套件。
// 套件返回 ConformanceCase[]，与测试运行器无关：逐条 await run() 即可，也可以映射到 bun:test / node:test 的 test(name, run)。
import {
  logHandlerConformance,
  registryConformance,
  brokerConformance,
  brokerTelemetryConformance,
  type ConformanceCase
} from "@go-like/core/testing"
import type { Fetch } from "@go-like/core/fetch"
import type { ServiceInstance } from "@go-like/core/registry"
import { newAcmeRegistry } from "./06-plug-registry.ts"
import { newInProcBroker } from "./07-plug-broker.ts"
import { newJsonLinesHandler } from "./08-plug-loghandler.ts"

// 1. 一个最小的假后端：Acme 的四个端点放在一个 Map 里，newAcmeRegistry 的两个实例共享它，
//    这样既能测隔离实例，也能测“两个 provider 对象共享一个后端”的跨客户端场景。
function newFakeAcme(): Fetch {
  const services = new Map<
    string,
    Map<string, { version: string; metadata: unknown; endpoints: unknown }>
  >()
  const noContent = (): Response => new Response(null, { status: 204 })
  const notFound = (): Response => new Response(null, { status: 404 })
  return async (request) => {
    const [, , , rawName, rawId, action] = new URL(request.url).pathname.split("/")
    const name = decodeURIComponent(rawName ?? "")
    const members = services.get(name)
    if (rawId === undefined) {
      if (members === undefined || members.size === 0) return notFound()
      return Response.json([...members].map(([id, body]) => ({ id, ...body })))
    }
    const id = decodeURIComponent(rawId)
    if (request.method === "PUT") {
      const body = (await request.json()) as {
        version: string
        metadata: unknown
        endpoints: unknown
      }
      services.set(name, (members ?? new Map()).set(id, body))
      return noContent()
    }
    if (request.method === "POST" && action === "renew")
      return members?.has(id) === true ? noContent() : notFound()
    if (request.method === "DELETE") {
      members?.delete(id)
      return noContent()
    }
    return new Response(null, { status: 405 })
  }
}

const service = (revision: "initial" | "updated"): ServiceInstance => ({
  id: "conformance-1",
  name: "conformance",
  version: revision === "initial" ? "1.0.0" : "1.1.0",
  metadata: { revision },
  endpoints: ["http://127.0.0.1:9000"]
})

// 2. 每个概念一个套件：subject 描述“如何构造被测对象”，套件负责全部断言。
const registryCases = registryConformance({
  createRegistry: () => newAcmeRegistry({ fetch: newFakeAcme(), address: "http://acme.test" }),
  createSharedRegistries: () => {
    const backend = newFakeAcme() // 两个 provider 对象，一个后端
    return [
      newAcmeRegistry({ fetch: backend, address: "http://acme.test" }),
      newAcmeRegistry({ fetch: backend, address: "http://acme.test" })
    ]
  },
  service,
  convergenceTimeoutMs: 10_000
})

const brokerSubject = {
  newBroker: async () => newInProcBroker(),
  topic: "conformance.orders",
  close: async () => {} // 进程内没有外部资源可释放
}
const brokerCases = [
  ...brokerConformance(brokerSubject),
  ...brokerTelemetryConformance(brokerSubject)
]

const lines: string[] = []
const logCases = logHandlerConformance({
  newHandler: () => {
    lines.length = 0 // 每个 handler 从空输出开始，written() 只读它自己的输出
    return newJsonLinesHandler(
      { write: (line) => void lines.push(line), end: async () => {} },
      "debug"
    )
  },
  written: async () => lines.map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>)
})

// 3. 与运行器无关的执行器：逐条 await，收集失败。
async function runSuite(suite: string, cases: readonly ConformanceCase[]): Promise<number> {
  let failed = 0
  for (const entry of cases) {
    try {
      await entry.run()
      console.info(`ok   ${suite} / ${entry.name}`)
    } catch (failure) {
      failed++
      console.error(`FAIL ${suite} / ${entry.name}`, failure)
    }
  }
  return failed
}

export async function main(): Promise<void> {
  const failed =
    (await runSuite("registry", registryCases)) +
    (await runSuite("broker", brokerCases)) +
    (await runSuite("log", logCases))
  if (failed > 0) throw new Error(`${failed} conformance case(s) failed`)
}
```

## 10. Connect/gRPC 插头

这个示例展示 Connect 插头的两种部署：`newHandler(routes)`（`@go-like/connectrpc`）返回可移植的 Connect 与 gRPC-Web Fetch 处理器，挂在 core 的 Web 宿主上；`newServer(address(...))`（`@go-like/connectrpc/node`）是托管的标准 gRPC 服务器，作为服务器层参与者注册，协议为 `"grpc"`，可以配合 `registrar(...)` 注册；`newClient(withDiscovery(registry), withEndpoint(...))` 是带 go-like 解析器、`Selector` 与 `close(ctx)` 的 Connect `Transport`。处理器与客户端代码由 `protoc-gen-like` 生成，生成代码只导入 `@go-like/core/context` 与 `@go-like/connectrpc`。需要注意：core 的 `Middleware`、限流与断路器策略、`ServiceError` 映射都不作用于 Connect 处理器（[D23](decisions.md)，OQ11）；应用自建的 Connect 传输需要加 `telemetryInterceptor()` 才会建立 `rpc.client` 单元并注入 `traceparent`；挂在 core Web 宿主上的 Connect 请求会有两个 SERVER span（Web 与 RPC，[D18](decisions.md)）。

示例文件：`10-connect.ts`

```ts
// 10 Connect / gRPC：可移植的 Connect 处理器挂在 core 的 web 宿主上，托管 gRPC 客户端通过发现访问另一个服务。
// 生成代码来自 protoc-gen-like（见 ./generated），业务只实现 OrderServiceHandler。
import { name, newApp, registrar, resources, server, telemetry } from "@go-like/core"
import { newConsulClient } from "@go-like/consul"
import { newConsulRegistry } from "@go-like/consul/registry"
import { newHandler, telemetryInterceptor } from "@go-like/connectrpc"
import {
  address,
  newClient,
  newServer,
  withBlock,
  withDiscovery,
  withSelector
} from "@go-like/connectrpc/node"
import type { Context } from "@go-like/core/context"
import { newResourceServer } from "@go-like/core/lifecycle"
import { signal } from "@go-like/core/node"
import { newP2CSelector } from "@go-like/core/registry"
import type { Telemetry } from "@go-like/core/telemetry"
import { contextHandler } from "@go-like/core/web"
import { newNodeServer, port } from "@go-like/core/web/node"
import { createConnectTransport } from "@connectrpc/connect-web-standin" // 真实代码里是 @connectrpc/connect-web
import {
  newOrderServiceClient,
  registerOrderServiceHandler,
  type OrderServiceHandler
} from "./generated/order_like.ts"

declare const tel: Telemetry

// 1. 业务实现：处理器的第一个参数是 go-like 的 Context（取消、截止时间、遥测都在里面）。
const orders: OrderServiceHandler = {
  getOrder: (_ctx, request) => ({ id: request.id, state: "paid" }),
  delete$: (_ctx, request) => ({ id: request.id, state: "deleted" }),
  async *watchOrders(_ctx, request) {
    yield { orderId: request.customerId, type: "created", sequence: 1 }
  },
  async uploadEvents(_ctx, request) {
    let count = 0
    for await (const _event of request) count++
    return { count }
  },
  async *syncOrders(_ctx, request) {
    for await (const command of request)
      yield { orderId: command.orderId, type: command.action, sequence: 1 }
  }
}

// 2. 浏览器友好的 Connect 与 gRPC-Web：newHandler 返回 core 的 web Handler，直接放进 core 的 web 宿主。
//    宿主记录 http.server 单元，connectrpc 在里面嵌套 rpc.server 单元，业务代码不用写追踪。
const web = newNodeServer(
  newHandler((router) => registerOrderServiceHandler(router, orders)),
  port(8080)
)
export const webApp = newApp(signal(), name("orders-http"), telemetry(tel), server(web))

// 3. 标准 gRPC over HTTP/2：托管服务端同时是 Server 与 Endpointer（协议 "grpc"），App 据此注册。
//    注册名默认是 proto 的服务全名，所以客户端按 "order.v1.OrderService" 发现它。
const consul = newConsulClient({ fetch, address: "http://127.0.0.1:8500" })
const registry = newConsulRegistry(consul)
const grpc = newServer(address("0.0.0.0:50051"))
registerOrderServiceHandler(grpc, orders)
export const grpcApp = newApp(
  signal(),
  name("order.v1.OrderService"),
  telemetry(tel),
  registrar(registry),
  server(grpc)
)

// 4. 浏览器风格的客户端：拦截器负责 rpc.client 单元并注入 traceparent。
const browser = newOrderServiceClient(
  createConnectTransport({
    baseUrl: "http://127.0.0.1:8080",
    interceptors: [telemetryInterceptor()]
  })
)

// 5. 托管 gRPC 客户端：解析器与选择器在 plug 里，实例来自 core 的 Discovery；close(ctx) 由应用在退出时调用。
const backend = newClient(withDiscovery(registry), withSelector(newP2CSelector()), withBlock())
const orderClient = newOrderServiceClient(backend)

// 6. 网关：一个普通的 web 处理器通过托管客户端调用后端；客户端属于 resource，先于网关启动、晚于网关关闭。
const gateway = newNodeServer(
  contextHandler(async (ctx, request) => {
    const order = await orderClient.getOrder(ctx, {
      id: new URL(request.url).searchParams.get("id") ?? ""
    })
    return Response.json({ state: order.state })
  }),
  port(8081)
)
export const gatewayApp = newApp(
  signal(),
  name("order-gateway"),
  telemetry(tel),
  resources(newResourceServer({ close: async (ctx) => await backend.close(ctx) })),
  server(gateway)
)

export async function lookup(ctx: Context, id: string): Promise<readonly [string, string]> {
  const viaWeb = await browser.getOrder(ctx, { id })
  const viaGrpc = await orderClient.getOrder(ctx, { id })
  return [viaWeb.state, viaGrpc.state]
}
```

## 常见错误与约定

**常见错误**（标注各问题在设计决定中的处理状态）：

| #   | 错误                                                                             | 后果                                                              | 状态与正确做法                                                                                                                          |
| --- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `resources(queue)` 加 `server(queue.worker(...))`                                | 发起顺序规则下 worker 启动即失败                                  | 已由 [D3](decisions.md) 解决：资源层等待准入                                                                                            |
| 2   | 手写资源适配器且 `start` 一直挂起                                                | 资源层永远等不到准入                                              | 资源用 `newResourceServer`（[D4](decisions.md)）；长期运行的参与者放 `server(...)`                                                      |
| 3   | 以为 JetStream 的 `subscribe` topic 选择消息                                     | 订阅到错误的消息集合                                              | topic 是订阅标签；消息由消息工厂选择，传入消费者的过滤主题（[D35](decisions.md)）                                                       |
| 4   | `newServer(transport(newHTTPTransport()))`                                       | 类型检查通过，监听时以 `UnsupportedTransportCapabilityError` 失败 | Node 服务两端都用 `newNodeHTTPTransport()`；`newHTTPTransport()` 只用于可移植客户端（[D24](decisions.md)）                              |
| 5   | 只在 `schema(...)` 中传 schema                                                   | `config.scan` 仍需要 schema 才有类型                              | schema 传两次：`schema(settings)` 负责校验，`config.scan(ctx, settings)` 负责类型（已知取舍，见[设计文档](README.md)第 13.4 节第 1 项） |
| 6   | 忘记关闭客户端与配置                                                             | 进程退出前连接与 watcher 未释放                                   | 在 `afterStop` 中 `close(ctx)`，或用 [D5](decisions.md) 的 `newResourceServer` 做法                                                     |
| 7   | 同时从 `/server` 与 `/client` 导入 `middleware`、`use`                           | 名称冲突                                                          | 使用命名空间导入（`import * as server from "@go-like/core/server"`），[D50](decisions.md)                                               |
| 8   | 把任意函数当作按调用选项                                                         | 以前能通过类型检查                                                | 已由 [D22](decisions.md) 解决：只有 `withFilter`、`withRetry` 可用                                                                      |
| 9   | 后端客户端不传 `fetch`                                                           | 构造时 `TypeError`                                                | 后端客户端要求显式 `fetch`（与 core HTTP 传输默认 `globalThis.fetch` 不同，[D25](decisions.md)）                                        |
| 10  | OTel `Resource` 与 `newApp` 的名称、版本不一致                                   | 后端看到两套服务身份                                              | 用同一组常量构建两者（[D39](decisions.md)）                                                                                             |
| 11  | 在 `newApp` 之前加载配置却想让 App 观测它                                        | 没有组合可用                                                      | 用 [D10](decisions.md) 的引导模式：`withTelemetry(background(), tel)`，失败时 `tel.stop(ctx)`                                           |
| 12  | 根入口的 `context`、`endpoint`、`server`、`telemetry`、`metadata` 与其他名称冲突 | 遮蔽 `@opentelemetry/api` 的 `context`、契约 DSL 的 `endpoint` 等 | `import * as app from "@go-like/core"`（D50）                                                                                           |
| 13  | 注册全局 OTel 传播器                                                             | 可能出现重复 `traceparent`，跨服务 trace 断开                     | 不注册；OTel 插头会发出警告；发布前端到端关卡（[D37](decisions.md)，OQ6）                                                               |
| 14  | `newPinoHandler(logger, otherDestination)`                                       | 准入时抛错                                                        | 传入构造 logger 时用的同一个 destination                                                                                                |
| 15  | 期待 core 提供路由                                                               | 无                                                                | 用一个按路径分派的函数组合多个 `Handler`；或用 hono/elysia/h3                                                                           |
| 16  | `createHealthHandler(probes)` 但没有任何就绪探针                                 | `/readyz` 永远 503                                                | 加 `readyProbe(probes)`                                                                                                                 |
| 17  | 不传 `signal()`                                                                  | SIGTERM 不排空                                                    | 总是传入 `signal()`                                                                                                                     |
| 18  | `server(tel)`                                                                    | 以前运行时才报错                                                  | 已由 [D11](decisions.md) 解决：编译错误                                                                                                 |
| 19  | 运行处理器的 Server 有三种构造方式                                               | 容易混淆                                                          | 订阅用 `newBrokerServer`，定时用 `newScheduleServer`，队列用 `queue.worker`                                                             |

**约定：**

- 每个 I/O 函数第一个参数是 `ctx: Context`；在工作单元里派生子 Context，不要在里面新建 `background()`，否则观测与取消都会静默丢失。
- 处理器收到的每次投递 ctx 在处理器结算后被取消，不要把它留给超出处理器的工作。
- 调用方的 ctx 只约束调用方自己的等待；`stop` 幂等，重复调用汇合同一次排空；超时不是终态。
- 错误是接口加稳定的字符串 `code`（`GO_LIKE_*`）；用 `code` 或 `isXxx` 判断，不用 `instanceof`。RPC 错误用 `ServiceError`。
- 没有全局默认实例，没有全局注册；所有实现由应用构造并显式传入。
- 指标标签只用声明的 `attributeKeys`，取值必须有界；span 名不含具体 topic、id 或路径；不把错误文本写入标签。
- 推荐的导入方式：`import * as log from "@go-like/core/log"`；有冲突时用命名空间导入，插头作者文档中使用别名。
- 选项风格在各子路径内部保持一致：函数式选项或普通选项对象，沿用该领域今天的风格；`ConfigOption`、`PinoHandlerOption`、`NatsCoreOption` 这样的可变选项风格保留（D50）。
- 插头只导入公开子路径；不导入另一个插头；不包装 core 调用点。
