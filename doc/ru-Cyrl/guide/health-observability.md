# Проверки и наблюдаемость

Пробы health и телеметрия — точки композиции. Приложение создаёт registry проб, логгер, провайдеры OpenTelemetry SDK и registry Prometheus. Core владеет записями единиц работы. Plugs заполняют `LogHandler`, `TracerProvider`, `MeterProvider` и `Propagator`. Ничто на этом пути не устанавливает за вас глобальные логгер, meter, tracer или propagator.

## Liveness и readiness

У `@go-like/core/health` два вида проб:

- `live`: считать ли процесс живым?
- `ready`: допускать ли трафик сейчас?

Пустой liveness исправен. Пустой readiness закрыт в отказ. Когда пробы readiness есть, пройти должна каждая из них.

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

`register(kind, name, probe)` возвращает идемпотентную функцию снятия регистрации. Маршруты по умолчанию — `/livez` и `/readyz`. Handler принимает `GET` и `HEAD`, возвращает 200, когда отчёт проходит, 503, когда не проходит, 404 для любого другого пути и 405 для других методов. Ответы используют `Cache-Control: no-store`. Ошибки проб не попадают в публичное тело.

`readyProbe(probes)` регистрирует окно App в том же registry под именем `"app"`, если вы не передали другое имя. Проба проходит только с момента завершения запуска до начала `stop()`, вместе с gauge `go_like.app.ready`. Без неё или без какой-либо другой ready-пробы `/readyz` остаётся 503. Это правило закрытия в отказ.

Делегируйте health `Handler` из собственного роутера. Core его не монтирует. `ProbeRegistry.check(...)` работает совсем без HTTP-поверхности. Унарный listener `newServer` также отвечает на `GET` и `HEAD` `/healthz` пустым 200. Эта проверка означает, что listener принял запрос. Registry проб она не выполняет.

## Один набор телеметрии

Соберите нативные объекты SDK сами. Адаптируйте их конструкторами plug. Передайте набор в `telemetry(tel)` на `newApp`. Тогда core записывает единицы RPC, HTTP, сообщений, заданий, конфигурации, реестра и жизненного цикла. Бизнес-код использует `@go-like/core/log`, `inSpan` и типизированные дескрипторы метрик.

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

`newPinoHandler` должен получить тот же объект `destination`, которым построен логгер. `ignoreRequest` отбрасывает всю единицу для путей проб и scrape, и пробы Kubernetes не попадают в журналы завершения. Соберите OpenTelemetry `Resource` из тех же констант `name` и `version`, которые передаёте в `newApp`.

`completionLogs` равен `"failures"` или `"all"`. Ключи атрибутов span и метрик — закрытый набор. Core не помещает сообщения об ошибках, стеки и cause на span, метки метрик и записи завершения. Диагностические события могут приложить локальный `Error` как `LogField.exception`. Plug отображает это поле на нативный слот.

### Запуск до newApp

Конфигурацию часто нужно загрузить до того, как появятся серверы. Набор может наблюдать эту работу до того, как ею владеет App:

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

`Telemetry.stop` до `start` дренирует каждый провайдер, не допуская его, и набор после этого нельзя запустить. Скрипт, который никогда не вызывает `newApp`, использует `withTelemetry`, `tel.start` и `tel.stop` напрямую. `newTelemetryRecorder` из `@go-like/core/testing` записывает span, метрики и логи в тестах.

## OpenTelemetry

`@go-like/otel` экспортирует `newOtelTracerProvider`, `newOtelMeterProvider`, `newOtelLogHandler` и `newOtelPropagator`. Peer-зависимость — `@opentelemetry/api`. Приложение конструирует провайдеры SDK, регистрирует context manager и оставляет глобальный propagator неустановленным. Его регистрация может продублировать `traceparent`.

Каждый провайдер останавливается один раз. Ожидание остановки по умолчанию — `defaultOtelShutdownTimeoutMs` (25 секунд). `shutdownTimeoutMs: 0` сразу проваливает ожидание владельца. Публичные ошибки: `OtelAlreadyStartedError` (`GO_LIKE_OTEL_ALREADY_STARTED`), `OtelShutdownTimeoutError` (`GO_LIKE_OTEL_SHUTDOWN_TIMEOUT`) и `OtelContextManagerMissingError` (`GO_LIKE_OTEL_CONTEXT_MANAGER_MISSING`).

## Prometheus

`@go-like/prometheus/metric` экспортирует `newPrometheusMeterProvider(registry)` и `createPrometheusHandler(registry, { path? })`. Передайте registry, который создали вы. Plug не трогает глобальный registry. `start` регистрирует `target_info` из ресурса App и затем завершается. Handler scrape — обычный Web `Handler`: смонтируйте его на Web-host core, в ярусе серверов, чтобы он остановился раньше яруса телеметрии.

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

`newPinoHandler(logger, destination, ...options)` отображает `LogField.exception` на ключ `err` в Pino. Сериализатор `err` по умолчанию уже пишет `name`, `message` и `stack`. `pinoDrainTimeout(ms)` задаёт границу drain владельца. Жизненный цикл проверяет, что `destination` — тот поток, с которым построен логгер, затем сбрасывает, завершает и закрывает его. Ошибки: `GO_LIKE_PINO_ALREADY_STARTED`, `GO_LIKE_PINO_DRAIN_TIMEOUT`, `GO_LIKE_PINO_DESTINATION_CLOSED`.

## Winston

`newWinstonHandler(logger)` отображает `LogField.exception` на нативный ключ `error` в Winston. Один `winston.format.json()` сериализует `Error` как `{}`, поэтому сообщение и стек исчезают. Поставьте формат, который понимает `Error`, перед JSON. Pino этот шаг не нужен.

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

Допуск заново связывает логгер через `child(...)` из ресурса App. `stop` вызывает `logger.end()` и ждёт `finish` или `close`. Принудительного закрытия Winston и timeout plug нет; `stopTimeout` App — это ожидание вызывающей стороны, а значение по умолчанию не ограничено. Ошибки: `GO_LIKE_WINSTON_ALREADY_STARTED`, `GO_LIKE_WINSTON_LOGGER_FINISHED`, `GO_LIKE_WINSTON_LOGGER_CLOSED`.

Бизнес-логи идут через `@go-like/core/log` (`log.info(ctx, message, attrs)`). Активные обработчики получают `trace_id`, `span_id` и `trace_flags`, когда span текущий. Маскирование полей приложения остаётся на нативном логгере (`pino({ redact })`, форматы Winston).

## Что записывается

Единицы core включают сервер и клиент RPC, HTTP-сервер, публикацию и обработку сообщений, запуск и постановку задания, загрузку и перезагрузку конфигурации, регистрацию и наблюдение реестра, retry, переходы circuit, отклонения rate-limit, а также start, ready, stopping, stopped App и сбой участника. Вызовам cache и store единица core не назначается: приложение вызывает plug напрямую. Scrape health опускается, когда так говорит `ignoreRequest`.

Ключи атрибутов, имена метрик и имена событий лога — константы `@go-like/core/telemetry` (`SemconvVersion` равен `"1.45.0"`). Атрибуты метрик берутся только из `attributeKeys`, объявленных на `newCounter`, `newHistogram`, `newUpDownCounter` и `newGauge`. Тема, URL или идентификатор пользователя на метрику не принадлежат.

Когда `LogHandler` не установлен, диагностические события уровня error пишутся одной JSON-строкой в `console.error` с `event.name`, `error.type` и `go_like.operation`. Строка не включает текст ошибки. Plug консольного лога нет.

## Операционный перечень

- Приложение сконструировало SDK, логгер и registry Prometheus.
- Глобальный propagator OpenTelemetry не установлен.
- `telemetry(tel)` стоит на App, а не внутри `server(...)`.
- У `/readyz` есть настоящая ready-проба, включая `readyProbe`, когда процесс должен сообщать окно App.
- Пути проб и scrape перечислены в `ignoreRequest`, когда их логи заглушили бы сигнал.
- Winston раскрывает `info.error` до `format.json()`.
- У меток и полей лога есть политика маскирования на нативном логгере или экспортёре.
