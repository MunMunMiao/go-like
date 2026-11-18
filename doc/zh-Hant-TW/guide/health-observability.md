# 健康檢查與可觀測性

健康探針與 telemetry 是組裝點。應用程式建立探針 registry、logger、OpenTelemetry SDK provider 與 Prometheus registry。Core 擁有工作單元的記錄。插頭填入 `LogHandler`、`TracerProvider`、`MeterProvider` 與 `Propagator`。這條路徑不會替你安裝全域的 logger、meter、tracer 或 propagator。

## 存活與就緒

`@go-like/core/health` 有兩種探針：

- `live`：這個程序應不應該被視為存活？
- `ready`：現在應不應該接納流量？

空白的存活檢查是健康的。空白的就緒檢查失敗即關閉。有就緒探針時，每一個都必須通過。

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

`register(kind, name, probe)` 回傳一個冪等的取消註冊函式。預設路由是 `/livez` 與 `/readyz`。Handler 接受 `GET` 與 `HEAD`，報告通過時回 200，不通過時回 503，其他路徑回 404，其他方法回 405。回應使用 `Cache-Control: no-store`。探針錯誤不會出現在公開的 body 上。

`readyProbe(probes)` 把 App 窗口註冊到同一個 registry，名稱是 `"app"`，除非你傳另一個名稱。探針只從啟動完成的那一刻到 `stop()` 開始之間通過，並與 `go_like.app.ready` gauge 一起翻轉。沒有它，或沒有別的就緒探針，`/readyz` 維持 503。這就是失敗即關閉。

從你自己的 router 委派健康檢查 `Handler`。Core 不會把它掛上去。`ProbeRegistry.check(...)` 在完全沒有 HTTP 表面時也能用。Unary 的 `newServer` listener 也會以空的 200 回答 `GET` 與 `HEAD` `/healthz`。那項檢查表示 listener 接受了請求。它不會執行探針 registry。

## 一個 telemetry 套組

自己建立原生 SDK 物件。用插頭的建構函式接上它們。把套組以 `telemetry(tel)` 傳給 `newApp`。Core 接著記錄 RPC、HTTP、訊息、工作、設定、服務註冊與生命週期單元。業務程式碼使用 `@go-like/core/log`、`inSpan` 與帶型別的指標 handle。

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

`newPinoHandler` 必須收到建立 logger 時用的同一個 `destination` 物件。`ignoreRequest` 會整段丟棄探針與 scrape 路徑的工作單元，讓 Kubernetes 探針不進完成日誌。用你傳給 `newApp` 的同一組 `name` 與 `version` 常數建立 OpenTelemetry `Resource`。

`completionLogs` 是 `"failures"` 或 `"all"`。Span 與指標的 attribute 鍵是一個封閉集合。Core 不會把錯誤訊息、stack 或 cause 放到 span、指標 label 或完成記錄上。診斷事件可以把本地的 `Error` 掛成 `LogField.exception`。插頭把那個欄位對到原生的槽位。

### 在 newApp 之前啟動

設定常常必須在 server 存在之前載入。套組可以在 App 擁有它之前觀察那段工作：

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

在 `start` 之前呼叫 `Telemetry.stop` 會 drain 每個 provider 而不接納它，而且這個套組之後不能再啟動。從不呼叫 `newApp` 的腳本直接使用 `withTelemetry`、`tel.start` 與 `tel.stop`。`@go-like/core/testing` 的 `newTelemetryRecorder` 在測試裡記錄 span、指標與日誌。

## OpenTelemetry

`@go-like/otel` 匯出 `newOtelTracerProvider`、`newOtelMeterProvider`、`newOtelLogHandler` 與 `newOtelPropagator`。同儕依賴是 `@opentelemetry/api`。應用程式建立 SDK provider、註冊 context manager，並讓全域 propagator 保持未設定。註冊一個可能會重複 `traceparent`。

每個 provider 只關閉一次。預設的關閉等待是 `defaultOtelShutdownTimeoutMs`（25 秒）。`shutdownTimeoutMs: 0` 會讓擁有者的等待立刻失敗。公開錯誤是 `OtelAlreadyStartedError`（`GO_LIKE_OTEL_ALREADY_STARTED`）、`OtelShutdownTimeoutError`（`GO_LIKE_OTEL_SHUTDOWN_TIMEOUT`）與 `OtelContextManagerMissingError`（`GO_LIKE_OTEL_CONTEXT_MANAGER_MISSING`）。

## Prometheus

`@go-like/prometheus/metric` 匯出 `newPrometheusMeterProvider(registry)` 與 `createPrometheusHandler(registry, { path? })`。傳入你建立的 registry。插頭不會碰全域 registry。`start` 從 App resource 註冊 `target_info`，然後 resolve。Scrape handler 是普通的 Web `Handler`：把它掛到 core 的 Web host 上，放在 server 層級，這樣它會在 telemetry 層級之前停止。

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

`newPinoHandler(logger, destination, ...options)` 把 `LogField.exception` 對到 Pino 的 `err` 鍵。Pino 預設的 `err` serializer 已經會寫出 `name`、`message` 與 `stack`。`pinoDrainTimeout(ms)` 設定擁有者的 drain 邊界。生命週期會檢查 `destination` 是不是建立 logger 時用的那個 stream，然後 flush、end 並 close 它。錯誤：`GO_LIKE_PINO_ALREADY_STARTED`、`GO_LIKE_PINO_DRAIN_TIMEOUT`、`GO_LIKE_PINO_DESTINATION_CLOSED`。

## Winston

`newWinstonHandler(logger)` 把 `LogField.exception` 對到 Winston 原生的 `error` 鍵。只有 `winston.format.json()` 時，會把 `Error` 序列化成 `{}`，於是 message 與 stack 消失。在 JSON 之前放一個認得 Error 的 format。Pino 不需要這一步。

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

接納時會用 App resource 的 `child(...)` 重新綁定 logger。`stop` 呼叫 `logger.end()`，並等待 `finish` 或 `close`。沒有 Winston 的強制關閉，插頭也沒有自己的逾時；App 的 `stopTimeout` 是呼叫端等待，預設沒有上限。錯誤：`GO_LIKE_WINSTON_ALREADY_STARTED`、`GO_LIKE_WINSTON_LOGGER_FINISHED`、`GO_LIKE_WINSTON_LOGGER_CLOSED`。

業務日誌走 `@go-like/core/log`（`log.info(ctx, message, attrs)`）。有目前的 span 時，作用中的 handler 會收到 `trace_id`、`span_id` 與 `trace_flags`。應用程式欄位的脫敏留在原生 logger（`pino({ redact })`、Winston format）。

## 會記錄什麼

Core 單元包含 RPC server 與用戶端、HTTP server、訊息的發布與處理、工作的執行與入隊、設定的載入與重新載入、服務註冊的 register 與 watch、重試、斷路器轉換、速率限制拒絕，以及 App 的 start、ready、stopping、stopped 與參與者失敗。快取與儲存呼叫沒有 core 單元：應用程式直接呼叫插頭。`ignoreRequest` 這樣說時，健康檢查的 scrape 會被略過。

Attribute 鍵、指標名稱與日誌事件名稱是 `@go-like/core/telemetry` 上的常數（`SemconvVersion` 是 `"1.45.0"`）。指標 attribute 只來自 `newCounter`、`newHistogram`、`newUpDownCounter` 與 `newGauge` 上宣告的 `attributeKeys`。Topic、URL 或使用者 id 不屬於指標。

沒有安裝 `LogHandler` 時，error 等級的診斷事件會以一行 JSON 寫到 `console.error`，帶著 `event.name`、`error.type` 與 `go_like.operation`。那一行不含錯誤文字。沒有 console log 插頭。

## 營運檢查清單

- 應用程式建立了 SDK、logger 與 Prometheus registry。
- 全域的 OpenTelemetry propagator 未設定。
- `telemetry(tel)` 在 App 上，不在 `server(...)` 裡面。
- `/readyz` 有一個真正的就緒探針；程序要回報 App 窗口時，包含 `readyProbe`。
- 探針與 scrape 路徑的日誌會淹沒訊號時，把它們列進 `ignoreRequest`。
- Winston 在 `format.json()` 之前展開 `info.error`。
- Label 與日誌欄位在原生 logger 或 exporter 上有脫敏政策。
