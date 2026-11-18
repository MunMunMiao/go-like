# `@go-like/otel`

Adapts application-owned OpenTelemetry SDK providers to the core trace, metric, log, and propagation sockets. The only public entry is `@go-like/otel`. It fills `TracerProvider` (including `enter`), `Span`, `MeterProvider`, `Instrument`, `LogHandler`, `Propagator`, and `TelemetryLifecycle`. The plug does not construct exporters, processors, readers, providers, or a `Resource`.

## Dependencies

`@go-like/core` is an exact lockstep peer. The workspace dev dependency is `workspace:*`. `@opentelemetry/api` is a peer because the plug calls into objects the application constructed. There is no optional peer and no regular runtime dependency. The verified dev pin of the API package is `1.10.0`. SDK packages such as `@opentelemetry/sdk-trace` stay application dependencies.

| Kind | Package              | Range     |
| ---- | -------------------- | --------- |
| peer | `@go-like/core`      | `0.0.1`   |
| peer | `@opentelemetry/api` | `^1.10.0` |

```ts
import { newApp, name, telemetry, version } from "@go-like/core"
import { newTelemetry } from "@go-like/core/telemetry"
import {
  newOtelLogHandler,
  newOtelMeterProvider,
  newOtelPropagator,
  newOtelTracerProvider
} from "@go-like/otel"
import { context } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import { resourceFromAttributes } from "@opentelemetry/resources"

declare const sdkTracerProvider: Parameters<typeof newOtelTracerProvider>[0]
declare const sdkMeterProvider: Parameters<typeof newOtelMeterProvider>[0]
declare const sdkLoggerProvider: Parameters<typeof newOtelLogHandler>[0]

const serviceName = "orders"
const serviceVersion = "v1"
context.setGlobalContextManager(new AsyncLocalStorageContextManager())
const resource = resourceFromAttributes({
  "service.name": serviceName,
  "service.version": serviceVersion
})
const tel = newTelemetry({
  tracerProvider: newOtelTracerProvider(sdkTracerProvider),
  meterProviders: [newOtelMeterProvider(sdkMeterProvider)],
  logHandlers: [newOtelLogHandler(sdkLoggerProvider)],
  propagator: newOtelPropagator(new W3CTraceContextPropagator())
})
const app = newApp(name(serviceName), version(serviceVersion), telemetry(tel))
```

Pass the same `service.name` and `service.version` constants to `newApp` and to the SDK `Resource`. The application owns that `Resource`.

## Lifecycle

Each adapter has its own `lifecycle`. After `telemetry(tel)` admits it, that lifecycle owns the SDK provider: `stop` calls `shutdown()` once and never calls `forceFlush`. `shutdownTimeoutMs` defaults to `defaultOtelShutdownTimeoutMs` (25000). `0` fails the owner wait immediately and leaves the native shutdown running. `stop` before `start` still shuts the provider down.

## Context bridge

go-like keeps the current span on its explicit `Context`. OTel automatic instrumentation reads `context.active()`. `enter` runs `context.with` so the two agree inside a unit. That requires the application to register a ContextManager such as `AsyncLocalStorageContextManager`. Without one, go-like spans still nest through the explicit Context, and third-party spans do not. `requireContextManager: true` throws `OtelContextManagerMissingError` at construction; otherwise `start` writes one `go_like.otel.context_manager_missing` warning.

`implicitParent` defaults to false. A unit with no go-like span does not attach to `context.active()`. Set it only when framework code outside the go-like web host must parent those units under an already-active OTel span. `root: true` never consults `context.active()`.

Do not register a global OTel propagator. go-like owns `traceparent`. If `propagation.fields()` already contains `traceparent` at `start`, the plug writes one `go_like.otel.global_propagator` warning. `requireContextManager` does not fail that case.

`newOtelPropagator` adapts any `TextMapPropagator`. `extract` returns the original context when the carrier has no valid span context. A baggage-only carrier does not enter the implicit context. The extracted OTel context is stored on the remote span object, so dropping that span drops the baggage too.

## Error codes

| Code                                   | Type                             | When                                                          |
| -------------------------------------- | -------------------------------- | ------------------------------------------------------------- |
| `GO_LIKE_OTEL_ALREADY_STARTED`         | `OtelAlreadyStartedError`        | `start` is called again on the same lifecycle                 |
| `GO_LIKE_OTEL_SHUTDOWN_TIMEOUT`        | `OtelShutdownTimeoutError`       | the owner wait exceeds `shutdownTimeoutMs`                    |
| `GO_LIKE_OTEL_CONTEXT_MANAGER_MISSING` | `OtelContextManagerMissingError` | `requireContextManager: true` and no ContextManager is active |

A non-integer timeout, or one outside `0..2147483647`, throws `RangeError` at construction. `0` fails the owner wait immediately and leaves the native `shutdown()` running.
