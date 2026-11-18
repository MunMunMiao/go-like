# 健康檢查與可觀測性

健康 probe 同遙測係組合點。應用建立 probe registry、logger、OpenTelemetry SDK provider 同 Prometheus registry。Core 擁有工作單元記錄。插頭填 `LogHandler`、`TracerProvider`、`MeterProvider` 同 `Propagator`。呢條路徑冇任何東西幫你安裝全域 logger、meter、tracer 或 propagator。

## Liveness 同 readiness

`@go-like/core/health` 有兩種 probe：

- `live`：程序應唔應該被視為仍然存活？
- `ready`：而家應唔應該接納流量？

空 liveness 係健康。空 readiness fail closed。有 readiness probe 時，每一個都要通過。

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

`register(kind, name, probe)` 返回一個冪等嘅取消註冊函式。預設路由係 `/livez` 同 `/readyz`。Handler 接受 `GET` 同 `HEAD`，報告通過時回 200，唔通過時回 503，任何其他路徑回 404，其他 method 回 405。回應用 `Cache-Control: no-store`。Probe 錯誤唔出現喺公開 body。

`readyProbe(probes)` 喺同一個 registry 註冊 App 窗口，名稱係 `"app"`，除非你傳另一個名稱。Probe 只由啟動完成嗰刻到 `stop()` 開始通過，同 `go_like.app.ready` gauge 一齊。冇佢，或者冇其他 ready probe，`/readyz` 保持 503。呢個就係 fail closed 規則。

由你自己嘅 router 委派健康 `Handler`。Core 唔會掛上佢。`ProbeRegistry.check(...)` 完全冇 HTTP 表面都可以用。Unary `newServer` listener 亦會以空 200 回應 `GET` 同 `HEAD` `/healthz`。呢個檢查代表 listener 接受咗請求。佢唔行 probe registry。

## 一個遙測 bundle

自己建立原生 SDK 物件。用插頭建構函式適配佢哋。將 bundle 傳畀 `newApp` 上嘅 `telemetry(tel)`。Core 然後記錄 RPC、HTTP、訊息、作業、設定、註冊中心同生命週期單元。業務程式碼用 `@go-like/core/log`、`inSpan` 同有型別指標 handle。

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

`newPinoHandler` 必須收到建立 logger 嗰同一個 `destination` 物件。`ignoreRequest` 整段丟棄 probe 同 scrape 路徑嘅單元，令 Kubernetes probe 唔入完成日誌。用你傳畀 `newApp` 嘅同一組 `name` 同 `version` 常數建立 OpenTelemetry `Resource`。

`completionLogs` 係 `"failures"` 或 `"all"`。Span 同指標屬性鍵係封閉集合。Core 唔將錯誤訊息、stack 或 cause 放上 span、指標 label 或完成記錄。診斷事件可以將本地 `Error` 附為 `LogField.exception`。插頭將該欄映射到原生槽。

### newApp 之前嘅 bootstrap

設定往往要喺 server 存在之前載入。Bundle 可以喺 App 擁有該工作之前觀察佢：

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

`start` 之前嘅 `Telemetry.stop` 會 drain 每個 provider 而唔接納佢，之後 bundle 亦唔可以再啟動。從不呼叫 `newApp` 嘅 script 直接用 `withTelemetry`、`tel.start` 同 `tel.stop`。`@go-like/core/testing` 嘅 `newTelemetryRecorder` 喺測試記錄 span、指標同日誌。

## OpenTelemetry

`@go-like/otel` 匯出 `newOtelTracerProvider`、`newOtelMeterProvider`、`newOtelLogHandler` 同 `newOtelPropagator`。Peer 依賴係 `@opentelemetry/api`。應用建立 SDK provider、註冊 context manager，並留低全域 propagator 唔設置。註冊一個可以重複 `traceparent`。

每個 provider 只關閉一次。預設關閉等待係 `defaultOtelShutdownTimeoutMs`（25 秒）。`shutdownTimeoutMs: 0` 令持有者等待即時失敗。公開錯誤係 `OtelAlreadyStartedError`（`GO_LIKE_OTEL_ALREADY_STARTED`）、`OtelShutdownTimeoutError`（`GO_LIKE_OTEL_SHUTDOWN_TIMEOUT`）同 `OtelContextManagerMissingError`（`GO_LIKE_OTEL_CONTEXT_MANAGER_MISSING`）。

## Prometheus

`@go-like/prometheus/metric` 匯出 `newPrometheusMeterProvider(registry)` 同 `createPrometheusHandler(registry, { path? })`。傳你建立嘅 registry。插頭唔掂全域 registry。`start` 由 App resource 註冊 `target_info`，然後 resolve。Scrape Handler 係普通 Web `Handler`：將佢掛上 core Web host，放喺 Server 層，令佢喺遙測層之前停止。

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

`newPinoHandler(logger, destination, ...options)` 將 `LogField.exception` 映射到 Pino 嘅 `err` 鍵。Pino 預設 `err` serializer 已經寫 `name`、`message` 同 `stack`。`pinoDrainTimeout(ms)` 設定持有者 drain 邊界。生命週期檢查 `destination` 係建立 logger 嗰條 stream，然後 flush、end 同 close 佢。錯誤：`GO_LIKE_PINO_ALREADY_STARTED`、`GO_LIKE_PINO_DRAIN_TIMEOUT`、`GO_LIKE_PINO_DESTINATION_CLOSED`。

## Winston

`newWinstonHandler(logger)` 將 `LogField.exception` 映射到 Winston 原生 `error` 鍵。單靠 `winston.format.json()` 會將 `Error` 序列化成 `{}`，所以 message 同 stack 會消失。喺 JSON 之前放一個識 `Error` 嘅 format。Pino 唔需要呢一步。

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

接納時用 App resource 嘅 `child(...)` 重新綁定 logger。`stop` 呼叫 `logger.end()` 並等 `finish` 或 `close`。冇 Winston 強制關閉，亦冇插頭逾時；App `stopTimeout` 係呼叫方等待，預設冇上限。錯誤：`GO_LIKE_WINSTON_ALREADY_STARTED`、`GO_LIKE_WINSTON_LOGGER_FINISHED`、`GO_LIKE_WINSTON_LOGGER_CLOSED`。

業務日誌經 `@go-like/core/log`（`log.info(ctx, message, attrs)`）。有 span 當前時，活動 handler 收到 `trace_id`、`span_id` 同 `trace_flags`。應用欄位嘅脫敏留喺原生 logger（`pino({ redact })`、Winston format）。

## 記錄咗咩

Core 單元包括 RPC server 同 client、HTTP server、訊息發布同處理、作業運行同入隊、設定載入同重新載入、註冊中心註冊同監看、重試、circuit 轉換、限速拒絕，以及 App 嘅 start、ready、stopping、stopped 同參與者失敗。快取同儲存呼叫冇 core 單元：應用直接呼叫插頭。`ignoreRequest` 咁講時，健康 scrape 會被省略。

屬性鍵、指標名稱同日誌事件名稱係 `@go-like/core/telemetry` 上嘅常數（`SemconvVersion` 係 `"1.45.0"`）。指標屬性只嚟自 `newCounter`、`newHistogram`、`newUpDownCounter` 同 `newGauge` 上宣告嘅 `attributeKeys`。Topic、URL 或 user id 唔屬於指標。

冇安裝 `LogHandler` 時，error 級診斷事件會以一行 JSON 寫去 `console.error`，帶 `event.name`、`error.type` 同 `go_like.operation`。呢行唔包括錯誤文字。冇 console log 插頭。

## 營運清單

- 應用建立咗 SDK、logger 同 Prometheus registry。
- 全域 OpenTelemetry propagator 未設置。
- `telemetry(tel)` 喺 App 上，唔係喺 `server(...)` 入面。
- `/readyz` 有真實 ready probe；程序要報告 App 窗口時包括 `readyProbe`。
- Probe 同 scrape 路徑嘅日誌會淹沒信號時，將佢哋列入 `ignoreRequest`。
- Winston 喺 `format.json()` 之前展開 `info.error`。
- Label 同日誌欄位喺原生 logger 或 exporter 上有脫敏政策。
