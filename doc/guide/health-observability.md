# Health and observability

Health probes and telemetry are composition points. The application creates the probe registry, the logger, the OpenTelemetry SDK providers, and the Prometheus registry. Core owns the work-unit records. Plugs fill `LogHandler`, `TracerProvider`, `MeterProvider`, and `Propagator`. Nothing in this path installs a global logger, meter, tracer, or propagator for you.

## Liveness and readiness

`@go-like/core/health` has two probe kinds:

- `live`: should the process be considered alive?
- `ready`: should traffic be admitted now?

Empty liveness is healthy. Empty readiness fails closed. When readiness probes exist, every one of them must pass.

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

`register(kind, name, probe)` returns an idempotent unregister function. The default routes are `/livez` and `/readyz`. The handler accepts `GET` and `HEAD`, returns 200 when the report passes, 503 when it does not, 404 for any other path, and 405 for other methods. Responses use `Cache-Control: no-store`. Probe errors stay off the public body.

`readyProbe(probes)` registers the App window on that same registry under the name `"app"` unless you pass another name. The probe passes only from the moment startup completes until `stop()` begins, together with the `go_like.app.ready` gauge. Without it, or without some other ready probe, `/readyz` stays 503. That is the fail-closed rule.

Delegate the health `Handler` from your own router. Core does not mount it. `ProbeRegistry.check(...)` works with no HTTP surface at all. A unary `newServer` listener also answers `GET` and `HEAD` `/healthz` with an empty 200. That check means the listener accepted the request. It does not run the probe registry.

## One telemetry bundle

Build the native SDK objects yourself. Adapt them with the plug constructors. Pass the bundle to `telemetry(tel)` on `newApp`. Core then records RPC, HTTP, messaging, job, config, registry, and lifecycle units. Business code uses `@go-like/core/log`, `inSpan`, and the typed metric handles.

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

`newPinoHandler` must receive the same `destination` object that constructed the logger. `ignoreRequest` drops the whole unit for probe and scrape paths, which keeps Kubernetes probes out of completion logs. Build the OpenTelemetry `Resource` from the same `name` and `version` constants you pass to `newApp`.

`completionLogs` is `"failures"` or `"all"`. Span and metric attribute keys are a closed set. Core does not put error messages, stacks, or causes on spans, metric labels, or completion records. Diagnostic events may attach the local `Error` as `LogField.exception`. The plug maps that field onto the native slot.

### Bootstrapping before newApp

Configuration often has to load before the servers exist. The bundle can observe that work before the App owns it:

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

`Telemetry.stop` before `start` drains each provider without admitting it, and the bundle cannot be started afterwards. A script that never calls `newApp` uses `withTelemetry`, `tel.start`, and `tel.stop` directly. `newTelemetryRecorder` from `@go-like/core/testing` records spans, metrics, and logs in tests.

## OpenTelemetry

`@go-like/otel` exports `newOtelTracerProvider`, `newOtelMeterProvider`, `newOtelLogHandler`, and `newOtelPropagator`. The peer dependency is `@opentelemetry/api`. The application constructs the SDK providers, registers a context manager, and leaves the global propagator unset. Registering one can duplicate `traceparent`.

Each provider is shut down once. The default shutdown wait is `defaultOtelShutdownTimeoutMs` (25 seconds). `shutdownTimeoutMs: 0` fails the owner wait immediately. Public errors are `OtelAlreadyStartedError` (`GO_LIKE_OTEL_ALREADY_STARTED`), `OtelShutdownTimeoutError` (`GO_LIKE_OTEL_SHUTDOWN_TIMEOUT`), and `OtelContextManagerMissingError` (`GO_LIKE_OTEL_CONTEXT_MANAGER_MISSING`).

## Prometheus

`@go-like/prometheus/metric` exports `newPrometheusMeterProvider(registry)` and `createPrometheusHandler(registry, { path? })`. Pass the registry you created. The plug does not touch the global registry. `start` registers `target_info` from the App resource and then resolves. The scrape handler is an ordinary Web `Handler`: mount it on the core Web host, in the server tier, so it stops before the telemetry tier.

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

`newPinoHandler(logger, destination, ...options)` maps `LogField.exception` to Pino's `err` key. Pino's default `err` serializer already writes `name`, `message`, and `stack`. `pinoDrainTimeout(ms)` sets the owner drain boundary. The lifecycle checks that `destination` is the stream the logger was built with, then flushes, ends, and closes it. Errors: `GO_LIKE_PINO_ALREADY_STARTED`, `GO_LIKE_PINO_DRAIN_TIMEOUT`, `GO_LIKE_PINO_DESTINATION_CLOSED`.

## Winston

`newWinstonHandler(logger)` maps `LogField.exception` to Winston's native `error` key. `winston.format.json()` alone serializes an `Error` as `{}`, so the message and stack disappear. Put an Error-aware format in front of JSON. Pino does not need this step.

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

Admission rebinds the logger with `child(...)` from the App resource. `stop` calls `logger.end()` and waits for `finish` or `close`. There is no Winston force-close and no plug timeout; the App `stopTimeout` is the caller wait, and the default is unlimited. Errors: `GO_LIKE_WINSTON_ALREADY_STARTED`, `GO_LIKE_WINSTON_LOGGER_FINISHED`, `GO_LIKE_WINSTON_LOGGER_CLOSED`.

Business logs go through `@go-like/core/log` (`log.info(ctx, message, attrs)`). The active handlers receive `trace_id`, `span_id`, and `trace_flags` when a span is current. Redaction of application fields stays on the native logger (`pino({ redact })`, Winston formats).

## What is recorded

Core units include RPC server and client, HTTP server, messaging publish and process, job run and enqueue, config load and reload, registry register and watch, retry, circuit transitions, rate-limit rejections, and App start, ready, stopping, stopped, and participant failure. Cache and store calls are not given a core unit: the application calls the plug directly. Health scrapes are omitted when `ignoreRequest` says so.

Attribute keys, metric names, and log event names are the constants on `@go-like/core/telemetry` (`SemconvVersion` is `"1.45.0"`). Metric attributes come only from the `attributeKeys` declared on `newCounter`, `newHistogram`, `newUpDownCounter`, and `newGauge`. A topic, URL, or user id does not belong on a metric.

When no `LogHandler` is installed, error-level diagnostic events are written as one JSON line to `console.error` with `event.name`, `error.type`, and `go_like.operation`. The line does not include the error text. There is no console log plug.

## Operations checklist

- The application constructed the SDK, logger, and Prometheus registry.
- The global OpenTelemetry propagator is unset.
- `telemetry(tel)` is on the App, not inside `server(...)`.
- `/readyz` has a real ready probe, including `readyProbe` when the process should report the App window.
- Probe and scrape paths are listed in `ignoreRequest` when their logs would drown the signal.
- Winston expands `info.error` before `format.json()`.
- Labels and log fields have a redaction policy on the native logger or exporter.
