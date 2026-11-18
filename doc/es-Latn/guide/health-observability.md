# Salud y observabilidad

Las sondas de salud y la telemetría son puntos de composición. La aplicación crea el registro de sondas, el logger, los proveedores del SDK de OpenTelemetry y el registro de Prometheus. Core posee los registros de unidades de trabajo. Los plugs rellenan `LogHandler`, `TracerProvider`, `MeterProvider` y `Propagator`. Nada en este camino instala por ti un logger, un meter, un tracer ni un propagator globales.

## Liveness y readiness

`@go-like/core/health` tiene dos clases de sonda:

- `live`: ¿debe considerarse vivo el proceso?
- `ready`: ¿debe admitirse tráfico ahora?

El liveness vacío está sano. El readiness vacío falla cerrado. Cuando existen sondas de readiness, todas deben pasar.

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

`register(kind, name, probe)` devuelve una función de baja idempotente. Las rutas por defecto son `/livez` y `/readyz`. El handler acepta `GET` y `HEAD`, devuelve 200 cuando el informe pasa, 503 cuando no, 404 para cualquier otra ruta y 405 para otros métodos. Las respuestas usan `Cache-Control: no-store`. Los errores de las sondas no salen en el body público.

`readyProbe(probes)` registra la ventana de la App en ese mismo registro, bajo el nombre `"app"`, salvo que se pase otro nombre. La sonda pasa solo desde el momento en que el arranque termina hasta que empieza `stop()`, junto con el gauge `go_like.app.ready`. Sin ella, o sin alguna otra sonda de ready, `/readyz` permanece en 503. Esa es la regla de fallo cerrado.

Hay que delegar el `Handler` de salud desde el router propio. Core no lo monta. `ProbeRegistry.check(...)` funciona sin ninguna superficie HTTP. Un listener unary de `newServer` también responde `GET` y `HEAD` `/healthz` con un 200 vacío. Esa comprobación significa que el listener aceptó la petición. No ejecuta el registro de sondas.

## Un bundle de telemetría

Hay que construir uno mismo los objetos nativos del SDK. Se adaptan con los constructores del plug. El bundle se pasa a `telemetry(tel)` en `newApp`. Core registra entonces las unidades de RPC, HTTP, mensajería, jobs, configuración, registro y ciclo de vida. El código de negocio usa `@go-like/core/log`, `inSpan` y los handles de métricas tipados.

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

`newPinoHandler` debe recibir el mismo objeto `destination` que construyó el logger. `ignoreRequest` descarta la unidad entera de las rutas de sonda y de scrape, lo que mantiene las sondas de Kubernetes fuera de los logs de completado. Hay que construir el `Resource` de OpenTelemetry a partir de las mismas constantes `name` y `version` que se pasan a `newApp`.

`completionLogs` es `"failures"` o `"all"`. Las claves de atributos de spans y métricas son un conjunto cerrado. Core no pone mensajes de error, stacks ni causas en spans, etiquetas de métricas ni registros de completado. Los eventos de diagnóstico pueden adjuntar el `Error` local como `LogField.exception`. El plug asigna ese campo a la ranura nativa.

### Arranque antes de newApp

A menudo la configuración tiene que cargarse antes de que existan los servidores. El bundle puede observar ese trabajo antes de que la App lo posea:

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

`Telemetry.stop` antes de `start` drena cada proveedor sin admitirlo, y el bundle no puede arrancarse después. Un script que nunca llama a `newApp` usa `withTelemetry`, `tel.start` y `tel.stop` directamente. `newTelemetryRecorder` de `@go-like/core/testing` registra spans, métricas y logs en las pruebas.

## OpenTelemetry

`@go-like/otel` exporta `newOtelTracerProvider`, `newOtelMeterProvider`, `newOtelLogHandler` y `newOtelPropagator`. La dependencia peer es `@opentelemetry/api`. La aplicación construye los proveedores del SDK, registra un context manager y deja sin asignar el propagator global. Registrar uno puede duplicar `traceparent`.

Cada proveedor se apaga una vez. La espera de apagado por defecto es `defaultOtelShutdownTimeoutMs` (25 segundos). `shutdownTimeoutMs: 0` hace fallar de inmediato la espera del propietario. Los errores públicos son `OtelAlreadyStartedError` (`GO_LIKE_OTEL_ALREADY_STARTED`), `OtelShutdownTimeoutError` (`GO_LIKE_OTEL_SHUTDOWN_TIMEOUT`) y `OtelContextManagerMissingError` (`GO_LIKE_OTEL_CONTEXT_MANAGER_MISSING`).

## Prometheus

`@go-like/prometheus/metric` exporta `newPrometheusMeterProvider(registry)` y `createPrometheusHandler(registry, { path? })`. Hay que pasar el registro que se creó. El plug no toca el registro global. `start` registra `target_info` a partir del recurso de la App y después se resuelve. El handler de scrape es un `Handler` Web ordinario: se monta en el host Web de core, en el nivel de servidores, para que pare antes que el nivel de telemetría.

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

`newPinoHandler(logger, destination, ...options)` asigna `LogField.exception` a la clave `err` de Pino. El serializador `err` por defecto de Pino ya escribe `name`, `message` y `stack`. `pinoDrainTimeout(ms)` fija la frontera de drain del propietario. El ciclo de vida comprueba que `destination` es el stream con el que se construyó el logger, y después lo vacía, lo termina y lo cierra. Errores: `GO_LIKE_PINO_ALREADY_STARTED`, `GO_LIKE_PINO_DRAIN_TIMEOUT`, `GO_LIKE_PINO_DESTINATION_CLOSED`.

## Winston

`newWinstonHandler(logger)` asigna `LogField.exception` a la clave nativa `error` de Winston. `winston.format.json()` por sí solo serializa un `Error` como `{}`, así que desaparecen el mensaje y el stack. Hay que poner un formato que entienda `Error` delante de JSON. Pino no necesita este paso.

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

La admisión vuelve a enlazar el logger con `child(...)` a partir del recurso de la App. `stop` llama a `logger.end()` y espera `finish` o `close`. No hay un cierre forzado de Winston ni un timeout del plug; el `stopTimeout` de la App es la espera del llamador, y el valor por defecto es ilimitado. Errores: `GO_LIKE_WINSTON_ALREADY_STARTED`, `GO_LIKE_WINSTON_LOGGER_FINISHED`, `GO_LIKE_WINSTON_LOGGER_CLOSED`.

Los logs de negocio pasan por `@go-like/core/log` (`log.info(ctx, message, attrs)`). Los handlers activos reciben `trace_id`, `span_id` y `trace_flags` cuando hay un span en curso. La redacción de campos de la aplicación se queda en el logger nativo (`pino({ redact })`, formatos de Winston).

## Qué se registra

Las unidades de core incluyen servidor y cliente RPC, servidor HTTP, publicación y proceso de mensajería, ejecución y encolado de jobs, carga y recarga de configuración, registro y watch del registry, retry, transiciones del circuit, rechazos de límite de tasa, y el arranque, ready, stopping, stopped y el fallo de un participante de la App. Las llamadas de caché y de store no reciben una unidad de core: la aplicación llama al plug directamente. Los scrapes de salud se omiten cuando `ignoreRequest` lo dice.

Las claves de atributos, los nombres de métricas y los nombres de eventos de log son las constantes de `@go-like/core/telemetry` (`SemconvVersion` es `"1.45.0"`). Los atributos de métricas salen solo de los `attributeKeys` declarados en `newCounter`, `newHistogram`, `newUpDownCounter` y `newGauge`. Un topic, una URL o un id de usuario no pertenecen a una métrica.

Cuando no hay un `LogHandler` instalado, los eventos de diagnóstico de nivel error se escriben como una línea JSON en `console.error` con `event.name`, `error.type` y `go_like.operation`. La línea no incluye el texto del error. No hay un plug de log de consola.

## Lista de operaciones

- La aplicación construyó el SDK, el logger y el registro de Prometheus.
- El propagator global de OpenTelemetry no está asignado.
- `telemetry(tel)` está en la App, no dentro de `server(...)`.
- `/readyz` tiene una sonda de ready real, incluido `readyProbe` cuando el proceso debe informar la ventana de la App.
- Las rutas de sonda y de scrape están en `ignoreRequest` cuando sus logs ahogarían la señal.
- Winston expande `info.error` antes de `format.json()`.
- Las etiquetas y los campos de log tienen una policy de redacción en el logger o el exporter nativos.
