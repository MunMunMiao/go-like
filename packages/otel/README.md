# `@go-like/otel`

面向应用自行配置的 OpenTelemetry `TracerProvider`、`MeterProvider` 与显式遥测插桩适配器。

本包不创建 exporter、processor、reader、provider 或 `Resource`，也不复制 endpoint、headers、batch、
interval、temporality、aggregation 等 OpenTelemetry 配置。应用继续使用官方 SDK 的完整原生 API；go-like
只在 `start(ctx)` 接纳后承接 provider 的一次性 `shutdown()` 生命周期。

## 显式链路插桩

本包提供四个彼此独立的显式接缝：

- `traceClient(client, tracer, propagator?)`：包装 unary Client，完整转发有序 `CallOption`；
- `traceUnaryMiddleware(tracer, propagator?)`：包装 unary Server handler；
- `traceWebHandler(handler, tracer, propagator?)`：包装标准单参数 Web Handler；
- `traceBroker(broker, tracer, propagator?)`：包装 Broker publish/consume。

它们使用官方 OpenTelemetry API 创建 span。raw Client 在 Message header 传播；类型化 Client 委托原
Client 完整调用，并通过 go-like Context metadata 传播，因此不会复制 codec、retry 或 middleware 语义。
Server 同时从已解码的 Context metadata 与 Message header 提取；Broker 与 Web 使用各自 header；
不会安装全局 provider、Context Manager、propagator 或自动 instrumentation。Web wrapper 只观测到
`Response` headers 到达，不读取、clone、tee、锁定或接管 request/response body。

失败 span 保留既有 outcome 与 Error status，但不调用 `recordException`，因此不会复制原始 Error、message、
stack 或 cause。插桩只可增加格式为 `^[A-Za-z][A-Za-z0-9_.-]{0,63}$` 的 `error.type`，以及格式为
`^[A-Z0-9_.-]{1,64}$` 的 `go-like.error.code`；非法、过长或读取失败的字段会被省略。需要记录原始错误时，
应用应在自己的原生 Tracer 边界显式处理。

```ts
import { traceBroker, traceClient, traceUnaryMiddleware, traceWebHandler } from "@go-like/otel"
import { middleware } from "@go-like/server"

const clientWithTrace = traceClient(client, tracer, propagator)
const serverTraceOption = middleware(traceUnaryMiddleware(tracer, propagator))
const webWithTrace = traceWebHandler(webHandler, tracer, propagator)
const brokerWithTrace = traceBroker(broker, tracer, propagator)
```

应用必须自行安装适合当前 runtime 的官方 Context Manager。若 runtime 无法在异步边界保持 active context，
不得用伪造 span 顶替；该 runtime 应明确标记为不支持当前链路传播方式。调用方原有 header 会被保留，只有
propagator 声明管理的字段会被替换。Web span 在没有稳定 route identity 时只使用 HTTP method 命名，不复制
原始 pathname 或 query。Broker 的原生 event、publish result、subscription 与连接所有权均保持不变，
ack/nak/term 仍由应用通过 provider 原生对象决定。

## 显式请求指标

`newRequestMetrics(meter)` 使用应用提供的官方 `Meter` 创建固定的
`go-like.request.completed` Counter（unit `{request}`）与 `go-like.request.duration` Histogram（unit `s`）。Client 与 unary
Server 共享低基数的 `component`、`operation`、`outcome` 属性；指标记录失败不会替换业务结果。
`measureClient(...)` 包住完整 raw 或 typed 调用，所以 typed response decode/validation 失败会记录为失败，
不会被提前标记成功。

```ts
import {
  middleware as clientMiddleware,
  newClient,
  withDiscovery,
  withTransport
} from "@go-like/client"
import {
  measureClient,
  measureClientMiddleware,
  measureUnaryMiddleware,
  newRequestMetrics
} from "@go-like/otel"
import { middleware } from "@go-like/server"

const requestMetrics = newRequestMetrics(meterProvider.getMeter("orders"))
const existingClientWithMetrics = measureClient(client, requestMetrics)
const clientWithMetrics = newClient(
  withDiscovery(discovery),
  withTransport(transport),
  clientMiddleware(measureClientMiddleware(requestMetrics))
)
const serverMetricsOption = middleware(measureUnaryMiddleware(requestMetrics))
```

指标 provider、reader、exporter、aggregation 与 shutdown 所有权保持不变；本包不会安装全局
`MeterProvider`，也不会为 Web 或 Broker 猜测 route/topic 基数策略。

```ts
import { newApp, server } from "@go-like/core"
import { otelShutdownTimeout, newOtelServer } from "@go-like/otel"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace"

const resource = resourceFromAttributes({ "service.name": "orders" })
const tracerProvider = new TracerProvider({
  resource,
  spanProcessors: [
    new BatchSpanProcessor({
      exporter: new OTLPTraceExporter({
        url: "http://127.0.0.1:4318/v1/traces"
      })
    })
  ]
})
const meterProvider = new MeterProvider({
  resource,
  readers: [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: "http://127.0.0.1:4318/v1/metrics"
      })
    })
  ]
})

const telemetry = newOtelServer({ tracerProvider, meterProvider }, otelShutdownTimeout(25_000))
const app = newApp(server(telemetry))
const running = app.run()

const tracer = tracerProvider.getTracer("orders")
const meter = meterProvider.getMeter("orders")
tracer.startSpan("create-order").end()
meter.createCounter("orders.created").add(1)

await app.stop()
await running
```

## 所有权

- provider 始终是应用创建并直接使用的官方对象。
- 构造 `newOtelServer(...)` 不转移所有权，也不调用 provider。
- `start(ctx)` 接纳前取消时，go-like 不调用 `shutdown()`，provider 仍完全归应用。
- `start(ctx)` 成功后，provider 的 stop contract 转移给 go-like。应用不得再自行调用同一 provider 的
  `shutdown()`。
- 可以只传 `tracerProvider` 或只传 `meterProvider`；如果同时传入，两者不得是同一 shutdown identity。
- go-like 不安装全局 provider、context manager、propagator 或自动 instrumentation。

## 终态与超时

第一次 `stop(ctx)` 并发调用所有已接纳 provider 的官方 `shutdown()`。每个调用方 Context 只限制该调用
方的等待，不会取消共享 shutdown。

`otelShutdownTimeout(ms)` 默认是 25 秒，只限制适配器的 owner waiter。OpenTelemetry provider 没有统一、
公开的强制终止原语，因此 timeout 不会冒充 native terminal：

- owner waiter 到期时以 `OtelShutdownTimeoutError` 失败；
- `start(ctx)` 返回的运行期 Promise 在全部 provider 的 `shutdown()` Promise 真正 settle 前继续 pending；
- provider 最终 settle 后，运行期 Promise 才按 trace failure、metric failure、timeout 的确定顺序结算；
- 原生 `Error` 保留 identity，非 `Error` rejection 只在生命周期边界归一化；
- Core 的 `stopTimeout` 负责限制 App 的整体停止等待，适配器不会伪造 provider 终态。

timeout 接受 `0..2_147_483_647` 的整数毫秒值。计时在调用任何 provider 前开始，单调时钟复核会把上游
同步阻塞也计入 owner boundary。

## 原生配置与诊断

exporter failure、重试、header、TLS、temporality、aggregation 与诊断 hook 全部由应用通过官方 API 配置。
go-like 不拦截 exporter，也不自动记录 Collector 响应体。应用若记录上游 OTLP Error，应先净化可能来自远端
响应的非可信字段。

真实服务测试使用固定 digest 的 OpenTelemetry Collector Contrib 0.157.0：
`otel/opentelemetry-collector-contrib:0.157.0@sha256:f2f01157055a9b2aab9df7118e1f1c9abf345e99b23bc7a2bc791db374a7d0f6`。
`otel-docker` 验证 OTLP/HTTP
trace 与 metric、Collector 中断期间业务继续运行、重启后新遥测恢复、shutdown flush 与无重复 shutdown
span；`otel-instrumentation-docker` 验证 unary Client 到 HTTP Server，以及标准 Web Handler 的 W3C
父子链路。两个 suite 都要求 Collector 真正收到遥测数据，且终态无残留容器。
