# ADR 0003：常驻适配器所有权与强制边界

日期：2026-07-18

状态：生命周期部分已被替代

> 本 ADR 保留第三方原生资源所有权和真实服务验证的历史决策；其中
> `ServerHandle`、`done()`、owner drain 与 orphan 诊断已不再属于公共契约。
> 当前公共生命周期见
> [`../developer-experience-alignment.md`](../developer-experience-alignment.md)。
>
> 更新（2026-08-05）：`@go-like/web/node` 的 Node Fetch 协议转换已内置在 `@go-like/web` 包内，
> 不再通过 `@hono/node-server` 进入供应链；该子路径仍只接收标准单参数 Web Handler，并继续独立于
> transport HTTP host。

## 背景

第一批常驻适配器暴露了单元测试替身无法模拟的故障模式：如果从未消费异步迭代器，官方 NATS 订阅可能
让 `closed` 永久保持 pending；如果 SonicBoom 在打开路径前失败，Pino 可能保留进程退出 hook；BullMQ 会
缓存第一次 `close()` 返回的 Promise，导致之后的强制调用无法升级先前的优雅关闭。Config 接纳 source
watcher 后同样拥有常驻资源，但它遵循自己的 `load / close` 契约，不实现 Server。

这些差异要求各包制定专属的生命周期策略，同时保留共同的 `Server` 与 `ServerHandle` 契约。

## 决策

### 共享常驻策略

- App supervisor 的默认边界为 30,000 ms。只有具备安全公开 force 原语的 go-like-owned adapter，才默认在
  25,000 ms 尝试强制收敛；无可信 force 的 adapter 不得伪造内部终态。
- 第一次 `stop(ctx)` 创建一个后台所有者排空过程。每个调用方 Context 只限制该调用方自身的等待时间。
- 原生业务对象可以由应用通过官方 API 创建；`start(ctx)` 成功接纳后，其生命周期控制权移交给 go-like。
  应用仍可使用原生业务 API，但不得同时直接调用由 adapter 接管的 stop/close/drain 方法。需要另一种生命周期
  组合时，应用应自行实现结构式 `Server`，并成为唯一生命周期所有者。
- `done()` 保持稳定。所有者排空成功时 resolve；被动退出、已确认的强制终态或清理失败时 reject。timeout
  本身不等于终态；底层仍未结束时 `done()` 保持 pending，供 App 报告 orphan。
- 启动接纳是一个线性化点。接纳前创建的每个原生对象都是临时对象，必须在不丢失主要启动失败的前提下
  回滚。
- 原生 `Error` 对象保留标识。独立的清理失败按顺序排在主要失败之后，并聚合返回。非 `Error` 失败可以
  规范化。
- 外部协议声明必须使用官方 SDK 与真实 Docker 服务验证。测试替身只覆盖确定性的状态机路径。

### 第三方原生能力边界

常驻适配器不是第三方库的第二套业务 API。Cron pattern、timezone、overlap、trigger 和 callback 归 Croner；
Request/Response 协议转换、路由和 middleware 归 Fetch host 与 Web 框架；日志级别、序列化、redaction、
transport 和 child logger 归 Pino/Winston。go-like 只负责把这些对象已有的启动、停止和终态能力映射到
`Server`/`ServerHandle`。

原生库缺少某项终态原语时，适配器必须在 capability manifest 中如实声明，而不是以轮询、猜测或另一套
业务 wrapper 伪装能力。应用若需要官方 adapter 未提供的生命周期组合，可以直接实现 structural Server；
该对象与官方 adapter 在 Core 中地位完全相同。

### Web Node host 与内部 HTTP transport

`@go-like/web/node` 使用包内 Node Fetch bridge 将标准单参数 Web Handler 托管到 Node listener。go-like
不重新实现外部 Web router，也不决定框架 handler error 如何映射响应；该入口只等待 listener ready，观察
原生 error/close，保存地址，并在 stop 时执行有界 graceful/force 关闭。Vanilla、Hono、Elysia 和 H3
共用这一 Web host。Hono、Elysia 与 H3 2.x 直接提供原生 `app.fetch`，H3 1.x 使用官方
`toWebHandler(app)`；go-like 不再发布只做 Fetch 转发的框架专用桥接包。

内部微服务通信由独立的 `@go-like/transport-http` 承担。根入口使用标准 Fetch 实现 portable unary
`Transport.dial(...)`；`@go-like/transport-http/node` 同时提供真实 Node listener 与原生 HTTP/1.1、HTTP/2
client，并把 socket/session 的终态归还给同一个 Transport 生命周期。内部 handler 与生命周期由
`@go-like/server` 组合。两个域不共享 handler ABI，也不互相依赖。

### Croner

`@go-like/croner` 接收在 `start(ctx)` factory 中创建的初始 paused 原生 `Cron`。adapter 只负责启动时
resume、失败回滚、停止未来调度和取消 runtime Context。应用继续使用 Croner 官方 constructor options、
callback 参数与实例方法。

Croner 10.0.1 没有可信的被动终态 Promise/event，`stop()` 也不会等待已经运行的 callback；`isBusy()`
无法为并发 `trigger()` 提供可靠排空计数。因此该 adapter 不声明 unexpected-exit 可观察或 active callback
graceful drain，并明确作为 terminal-unobservable 生命周期 adapter 发布。需要严格 callback drain 的
应用必须在业务 callback 内自行计数，或选择拥有相应原生契约的 scheduler adapter。

### Config

`@go-like/config` 是可移植的常驻 Config，不是 Core Server。`load(ctx)` 加载完整 source、接纳 watcher 并在
首个配置可读后返回；`close(ctx)` 停止并等待所有已接纳 watcher。应用需要与 HTTP、Cron 等 Server 编排时，
通过 Core `beforeStart / afterStop` hook 调用这两个方法，`server(...)` 中不包含 Config。

Config 拥有自己的运行时 Context、监视循环、串行化重载队列和已接纳的 source watcher。因此，其 capability
manifest 声明常驻终态可观测性，owner manifest 声明 watcher 的私有所有权。每个已接纳 watcher 先进入临时
记录；形态校验、getter 或接纳失败会停止临时 watcher，并保留原始失败为主错误。后台 watcher 终止错误通过
`close(ctx)` 返回；可恢复重载错误可以由 `onReloadError` 观察。

Config 文件 watcher 在消费保留的 dirty 状态前先检查调用方 Context。Consul 将 Fetch reject 与响应体读取
失败都视为传输失败。对于非成功响应，HTTP 状态仍具有权威性；响应体清理失败不能把可重试状态转变为终态
原始流错误。

### Pino

`@go-like/pino` 不创建 logger、不解析 logger options、不打开文件，也不选择 destination 或
transport。应用通过 Pino 官方 API 创建并直接使用 `pino.Logger`，再把对应 destination 的生命周期明确
交给 adapter。未移交的 destination 完全归应用，不能由 go-like 关闭。

destination 的 error listener 在整个关闭过程保持安装。不同的原生错误都会保留；同一 `Error` 标识重复
触发时只记录一次。关闭顺序为 logger flush、destination end、native close。25,000 ms owner deadline 可以
结算共享 stop waiter，并且只在 destination 公开 `destroy()` 时进行一次尽力 force；`destroy()` 缺失、抛错
或调用后没有 `close` 都不能结算 `done()`。Pino 的 level、custom levels、formatter、redaction、bindings、
child logger 与 transport worker 行为保持官方语义，不在 go-like 中重新定义。

应用仍拥有 logger 的业务 API；adapter 只借用 logger 来执行 flush，并在 `start(ctx)` 成功后接管对应
destination。构造或未接纳状态不会安装原生 observer，也不会提前关闭应用资源。owner manifest 因此分别
声明 application-owned logger 与 go-like-owned destination，而不是把二者含糊合并为一个资源。

### Winston

`@go-like/winston` 不创建 logger、不解析 logger options，也不枚举 transports。应用通过 Winston
官方 API 创建并直接使用 `Logger`。constructor 只做接口校验；`start(ctx)` 先检查取消并原子安装终态监听，
只有成功 accepted 后才把该 logger 的 stop 契约移交给 adapter。go-like 的 stop 只调用一次 Node Writable
的 `logger.end()`，并等待 Winston 在所有 transport 完成后发出的 `finish`。

Winston 的 `close` 不等同于排空：它用于关闭 transport 并移除异常处理器，不能冒充 `finish`。因此 adapter
不会调用 `logger.close()`，也不会假设所有 transport 存在统一 force 原语。原生 `error` 保留标识并触发
owner stop；stop 前的 `finish` 或排空前的 `close` 都是意外终态。Core supervisor 对无界 transport 如实
报告 orphan，而不是伪造资源已关闭。启用 `handleExceptions`/`handleRejections` 的进程级所有权必须由应用
单独管理。

### NATS Core

应用使用 NATS 官方 API 创建、配置并开始消费原生 `Subscription`，或者提供只负责创建该对象的 start
factory。go-like 不订阅 subject、不选择 queue、不迭代消息，也不接收 handler；这些行为和 at-most-once
交付语义全部留在官方 API 与应用。

成功接纳后，adapter 只拥有该 Subscription 的 drain/unsubscribe/closed 生命周期。正常 stop 优先使用原生
`drain()` 并等待真实 `closed`；有界 owner boundary 只能调用上游公开的 unsubscribe，不能关闭借用的
`NatsConnection`。接纳前失败必须清理临时 Subscription，且不会让永久 pending 的 `closed` 阻塞启动失败。

### NATS JetStream

应用使用 JetStream 官方 API 创建并配置 durable consumer、`ConsumerMessages`、消息循环、ack、MaxDeliver、
重投与 DLQ 策略，或者提供只负责创建 `ConsumerMessages` 的 start factory。go-like 不读取 `JsMsg`、不发布
死信、不调用 ack/nak/term，也不校验 consumer 的数据面配置。

成功接纳后，adapter 只拥有该 `ConsumerMessages` 的 close/stop/closed 生命周期，永不删除服务端 durable
consumer，也不关闭借用的 client 或 connection。正常 stop 调用原生 `close()` 并等待真实 `closed`；所有者
边界可以调用上游公开的 `stop()`，但不能把 timer 到期冒充 native terminal。接纳前失败必须关闭临时消息
迭代器并隔离晚到的 `closed` settlement。

### BullMQ

应用使用 BullMQ 官方 API 创建 `autorun:false` 的原生 `Worker`，完整配置 WorkerOptions，并直接提供官方
三参数 processor `(job, token, signal)`；或者提供只负责创建该 Worker 的 start factory。go-like 不接收
Queue、不复制 WorkerOptions、不包装 Job/processor，也不实现 retry、backoff、stalled recovery 或业务错误
分类。

adapter 先安装 error/closed observer，再等待 `waitUntilReady()`；只有 readiness 成功并完成接纳后才调用
`run()`，其 settlement 作为被动终态。优雅 stop 调用官方 `pause(false)` 等待在途 job，再调用一次
`close(true)`；owner boundary
到期会以 `BullMqDrainTimeoutError` 结束 owner stop waiter，并调用官方 `cancelAllJobs(reason)` 请求原生
processor `AbortSignal` 收敛，再调用 `close(true)`；它不能伪造 Worker 已关闭，稳定 `done()` 仍等待真实终态。
应用仍拥有 processor 的业务行为，但不得与 adapter 竞争调用 run/pause/close。processor 失败仍是 BullMQ
job 结果，而不是 Server 终态失败。

### OpenTelemetry

应用使用 OpenTelemetry 官方 API 创建并配置 trace provider、metric provider、processor、reader、exporter、
Resource、全局注册和自动插桩。`@go-like/otel` 不复制这些配置 API，也不创建私有 telemetry 栈；它只
接收应用已经配置好的官方 provider，并把两者的 `shutdown()` 承接为一次性结构化 `Server` 生命周期。
应用继续直接使用 provider 的 `getTracer()`、`getMeter()` 与其他官方能力。

启动成功后，provider 的 shutdown 调用权移交给 go-like。stop 并行调用 trace provider 与 meter provider
的原生 `shutdown()`，保留每个原生 `Error` identity 和确定性顺序。适配器不会额外调用 `forceFlush()`，
不会注册全局 provider，也不安装 Context manager、propagator 或 instrumentation。

25,000 ms owner 边界只结束 stop waiter，并产生 `OtelShutdownTimeoutError`；OpenTelemetry 没有统一可移植
force 原语，因此超时不会伪造 provider terminal。稳定 `done()` 继续等待所有已经发出的原生 shutdown
Promise settlement；晚到失败仍进入最终终态。Collector 故障、export 重试、批处理和恢复行为完全由
应用选择的官方 processor/exporter 配置负责，并通过真实 Collector E2E 验证，而不是由 go-like facade 重写。

### Prometheus

`@go-like/prometheus` 是基于应用自有官方原始 Registry 的非常驻 Web Handler 适配器。它使用结构化
scrape 契约，因此来自另一份物理 prom-client 安装的 Registry 仍可使用。适配器永不访问全局 registry，
不拥有任何 collector 生命周期，也无法强制应用标签基数；有界标签 schema 是显式的应用契约。

适配器不包装 `collectDefaultMetrics()`。prom-client 15.1.3 会启用原生 event-loop histogram 和 GC
`PerformanceObserver`，但不返回清理 handle，且 `Registry.clear()` 不会禁用或断开它们。应用只有在明确
接受进程生命周期所有权时才可使用该 helper。

## 真实服务 E2E

- NATS 2.14.4：应用通过官方 SDK 创建 Core Subscription 与 JetStream ConsumerMessages，适配器的
  start/rollback/drain/close/stop/closed、重连后的原生消费，以及借用 connection/durable consumer 存活。
  ack、PubAck、MaxDeliver 和 DLQ 若出现在场景中，只验证应用使用官方数据面 API 的集成行为。
- Redis 8.10.0：应用创建的官方 Worker 能完成 readiness、故障/恢复、pause/close、稳定 terminal，并让连接数
  回到基线。attempts/backoff、stalled recovery 和 processor AbortSignal 只作为 BullMQ 原生业务能力场景。
- OpenTelemetry Collector：OTLP/HTTP JSON trace 与 metric、resource 标识、Collector 故障但业务不中止、
  新 telemetry 的恢复、shutdown flush，以及零残留容器或客户端资源。
- 每个运行器使用唯一标签，并在 `finally` 中清理容器、网络、卷、listener、timer、subscription、Worker
  和连接。

## 后果

这些适配器共享生命周期语义，但不会假装各自的原生 shutdown 原语可以互换。公共 API 保持精简并以原生
对象优先，同时由各包专属测试锁定决定安全所有权与清理方式的上游行为。
