# 健康与可观测性

健康探针和观测是组合点。应用创建探针 registry、日志器、OpenTelemetry SDK provider 和 Prometheus registry。Core 拥有工作单元记录。插头填入 `LogHandler`、`TracerProvider`、`MeterProvider` 和 `Propagator`。这条路径上没有任何东西替你安装全局日志器、meter、tracer 或 propagator。

## 存活与就绪

`@go-like/core/health` 有两种探针：

- `live`：进程是否应被视为存活？
- `ready`：现在是否应接纳流量？

空的存活检查是健康的。空的就绪检查 fail closed。存在就绪探针时，每一个都必须通过。

```ts
import { readyProbe } from "@go-like/core"
import { newProbeRegistry } from "@go-like/core/health"
import { createHealthHandler } from "@go-like/core/web"

const probes = newProbeRegistry()
probes.register("ready", "policy", async (ctx) => {
  if (ctx.err() !== null) throw ctx.err() as Error
  await policyServer.endpoint(ctx)
})

const health = createHealthHandler(probes)
const app = newApp(readyProbe(probes))
void health
void app
```

`register(kind, name, probe)` 返回一个幂等的注销函数。默认路由是 `/livez` 和 `/readyz`。Handler 接受 `GET` 和 `HEAD`，报告通过时返回 200，不通过时返回 503，任何其他路径返回 404，其他方法返回 405。响应使用 `Cache-Control: no-store`。探针错误不出现在公开 body 上。

`readyProbe(probes)` 把 App 窗口注册到同一个 registry 上，名称是 `"app"`，除非传入另一个名称。该探针只从启动完成的那一刻到 `stop()` 开始通过，并与 `go_like.app.ready` 仪表一起。没有它，或没有其他就绪探针时，`/readyz` 保持 503。这就是 fail closed 规则。

从自己的路由器委托健康检查 `Handler`。Core 不会替你挂载它。`ProbeRegistry.check(...)` 在完全没有 HTTP 表面时也能工作。Unary `newServer` 监听器也对 `GET` 和 `HEAD` `/healthz` 回答空的 200。该检查表示监听器接纳了请求。它不运行探针 registry。

## 一份观测 bundle

自己构造原生 SDK 对象。用插头构造函数适配它们。把 bundle 传给 `newApp` 上的 `telemetry(tel)`。Core 随后记录 RPC、HTTP、消息、任务、配置、注册中心和生命周期单元。业务代码使用 `@go-like/core/log`、`inSpan` 和带类型的指标句柄。

```ts
import { name, newApp, server, telemetry, version } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { newTelemetry } from "@go-like/core/telemetry"
import { contextHandler } from "@go-like/core/web"
import { newNodeServer, port } from "@go-like/core/web/node"
import { newOtelMeterProvider, newOtelTracerProvider } from "@go-like/otel"
import { newPinoHandler } from "@go-like/pino/log"
import { context } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace"
import pino from "pino"

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())

const sdkTracer = new TracerProvider({
  spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter() })]
})
const sdkMeter = new MeterProvider({
  readers: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })]
})
const destination = pino.destination({ dest: 1, sync: false })
const logger = pino({ base: null, level: "info" }, destination)
const tel = newTelemetry({
  tracerProvider: newOtelTracerProvider(sdkTracer, { requireContextManager: true }),
  meterProviders: [newOtelMeterProvider(sdkMeter)],
  logHandlers: [newPinoHandler(logger, destination)],
  completionLogs: "failures",
  ignoreRequest: (request) => {
    const { pathname } = new URL(request.url)
    return pathname === "/livez" || pathname === "/readyz" || pathname === "/metrics"
  }
})

const web = newNodeServer(
  contextHandler(async () => Response.json({ ok: true })),
  port(8080)
)
export const app = newApp(signal(), name("shop"), version("v1"), telemetry(tel), server(web))
```

`newPinoHandler` 必须收到构造该日志器的同一个 `destination` 对象。`ignoreRequest` 丢掉探针和抓取路径的整个单元，从而使 Kubernetes 探针不进入完成日志。用传给 `newApp` 的同一组 `name` 和 `version` 常量构造 OpenTelemetry `Resource`。

`completionLogs` 是 `"failures"` 或 `"all"`。Span 和指标属性键是一个封闭集合。Core 不把错误消息、栈或 cause 放到 span、指标标签或完成记录上。诊断事件可以把本地 `Error` 作为 `LogField.exception` 附上。插头把该字段映射到原生槽位。

### 在 newApp 之前启动

配置常常必须在 server 存在之前加载。Bundle 可以在 App 拥有它之前观察这段工作：

```ts
import { background, withTimeout } from "@go-like/core/context"
import { newTelemetry, withTelemetry } from "@go-like/core/telemetry"

const tel = newTelemetry({ logHandlers: [handler] })
const bootCtx = withTelemetry(background(), tel)
try {
  await config.load(bootCtx)
} catch (error) {
  const [ctx, cancel] = withTimeout(background(), 5_000)
  try {
    await tel.stop(ctx)
  } finally {
    cancel()
  }
  throw error
}
const app = newApp(telemetry(tel))
void app
```

在 `start` 之前调用 `Telemetry.stop` 会排空每个 provider 而不接纳它，并且该 bundle 之后不能再启动。从不调用 `newApp` 的脚本直接使用 `withTelemetry`、`tel.start` 和 `tel.stop`。`@go-like/core/testing` 的 `newTelemetryRecorder` 在测试里记录 span、指标和日志。

## OpenTelemetry

`@go-like/otel` 导出 `newOtelTracerProvider`、`newOtelMeterProvider`、`newOtelLogHandler` 和 `newOtelPropagator`。Peer 依赖是 `@opentelemetry/api`。应用构造 SDK provider，注册一个 context manager，并让全局 propagator 保持未设置。注册一个可能会重复 `traceparent`。

每个 provider 只停机一次。默认停机等待是 `defaultOtelShutdownTimeoutMs`（25 秒）。`shutdownTimeoutMs: 0` 使所有者等待立即失败。公共错误是 `OtelAlreadyStartedError`（`GO_LIKE_OTEL_ALREADY_STARTED`）、`OtelShutdownTimeoutError`（`GO_LIKE_OTEL_SHUTDOWN_TIMEOUT`）和 `OtelContextManagerMissingError`（`GO_LIKE_OTEL_CONTEXT_MANAGER_MISSING`）。

## Prometheus

`@go-like/prometheus/metric` 导出 `newPrometheusMeterProvider(registry)` 和 `createPrometheusHandler(registry, { path? })`。传入自己创建的 registry。插头不碰全局 registry。`start` 从 App 资源注册 `target_info`，然后 resolve。抓取 handler 是普通的 Web `Handler`：把它挂到 core Web 宿主上，放在 server 层，这样它会在 telemetry 层之前停止。

```ts
import { createPrometheusHandler, newPrometheusMeterProvider } from "@go-like/prometheus/metric"
import { Registry } from "prom-client"

const registry = new Registry()
const meters = newPrometheusMeterProvider(registry)
const metrics = createPrometheusHandler(registry)
void meters
void metrics
```

## Pino

`newPinoHandler(logger, destination, ...options)` 把 `LogField.exception` 映射到 Pino 的 `err` 键。Pino 默认的 `err` 序列化器已经写出 `name`、`message` 和 `stack`。`pinoDrainTimeout(ms)` 设置所有者排空边界。生命周期检查 `destination` 是构造该日志器所用的那条流，然后 flush、结束并关闭它。错误：`GO_LIKE_PINO_ALREADY_STARTED`、`GO_LIKE_PINO_DRAIN_TIMEOUT`、`GO_LIKE_PINO_DESTINATION_CLOSED`。

## Winston

`newWinstonHandler(logger)` 把 `LogField.exception` 映射到 Winston 的原生 `error` 键。单独的 `winston.format.json()` 会把 `Error` 序列化成 `{}`，于是 message 和 stack 消失。在 JSON 之前放一个能识别 Error 的 format。Pino 不需要这一步。

```ts
import { LogField, newTelemetry } from "@go-like/core/telemetry"
import { newWinstonHandler } from "@go-like/winston/log"
import winston from "winston"

const expandError = winston.format((info) => {
  const error: unknown = info.error
  if (error instanceof Error) {
    info.error = { name: error.name, message: error.message, stack: error.stack }
  }
  return info
})

const logger = winston.createLogger({
  format: winston.format.combine(expandError(), winston.format.json()),
  transports: [new winston.transports.Console()]
})

export const tel = newTelemetry({ logHandlers: [newWinstonHandler(logger)] })
void LogField
```

接纳时用 App 资源的 `child(...)` 重新绑定日志器。`stop` 调用 `logger.end()`，并等待 `finish` 或 `close`。没有 Winston 强制关闭，也没有插头超时；App 的 `stopTimeout` 是调用方等待，默认没有限制。错误：`GO_LIKE_WINSTON_ALREADY_STARTED`、`GO_LIKE_WINSTON_LOGGER_FINISHED`、`GO_LIKE_WINSTON_LOGGER_CLOSED`。

业务日志走 `@go-like/core/log`（`log.info(ctx, message, attrs)`）。当前有 span 时，活动的 handler 会收到 `trace_id`、`span_id` 和 `trace_flags`。应用字段的脱敏留在原生日志器上（`pino({ redact })`、Winston format）。

## 记录了什么

Core 单元包括 RPC 服务端和客户端、HTTP 服务端、消息发布和处理、任务运行和入队、配置加载和重载、注册中心的注册和监视、重试、断路器转换、限流拒绝，以及 App 的 start、ready、stopping、stopped 和参与者失败。缓存和存储调用没有 core 单元：应用直接调用插头。当 `ignoreRequest` 这样说时，健康检查抓取会被略去。

属性键、指标名和日志事件名是 `@go-like/core/telemetry` 上的常量（`SemconvVersion` 是 `"1.45.0"`）。指标属性只来自 `newCounter`、`newHistogram`、`newUpDownCounter` 和 `newGauge` 上声明的 `attributeKeys`。主题、URL 或用户 id 不属于指标。

没有安装 `LogHandler` 时，error 级别的诊断事件作为一行 JSON 写到 `console.error`，带 `event.name`、`error.type` 和 `go_like.operation`。这一行不包含错误文本。没有控制台日志插头。

## 运维清单

- 应用构造了 SDK、日志器和 Prometheus registry。
- 全局 OpenTelemetry propagator 未设置。
- `telemetry(tel)` 在 App 上，不在 `server(...)` 里面。
- `/readyz` 有真实的就绪探针；当进程应报告 App 窗口时，包括 `readyProbe`。
- 当探针和抓取路径的日志会淹没信号时，把它们列进 `ignoreRequest`。
- Winston 在 `format.json()` 之前展开 `info.error`。
- 标签和日志字段在原生日志器或 exporter 上有脱敏策略。
