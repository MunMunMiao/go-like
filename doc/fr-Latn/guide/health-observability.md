# Santé et observabilité

Les probes de santé et la télémétrie sont des points de composition. L'application crée le registre de probes, le logger, les providers du SDK OpenTelemetry et le registre Prometheus. Core possède les enregistrements d'unités de travail. Les plugs remplissent `LogHandler`, `TracerProvider`, `MeterProvider` et `Propagator`. Rien sur ce chemin n'installe pour vous un logger, un meter, un tracer ou un propagateur global.

## Liveness et readiness

`@go-like/core/health` a deux sortes de probes :

- `live` : le processus doit-il être considéré comme vivant ?
- `ready` : le trafic doit-il être admis maintenant ?

Une liveness vide est saine. Une readiness vide échoue en position fermée. Lorsque des probes de readiness existent, chacune d'elles doit réussir.

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

`register(kind, name, probe)` renvoie une fonction de désenregistrement idempotente. Les routes par défaut sont `/livez` et `/readyz`. Le handler accepte `GET` et `HEAD`, renvoie 200 lorsque le rapport réussit, 503 lorsqu'il échoue, 404 pour tout autre chemin, et 405 pour les autres méthodes. Les réponses utilisent `Cache-Control: no-store`. Les erreurs de probe restent hors du corps public.

`readyProbe(probes)` enregistre la fenêtre de l'App sur ce même registre sous le nom `"app"`, sauf si vous passez un autre nom. La probe ne réussit que depuis l'instant où le démarrage se termine jusqu'au début de `stop()`, en même temps que la jauge `go_like.app.ready`. Sans elle, ou sans une autre probe ready, `/readyz` reste 503. C'est la règle d'échec en position fermée.

Déléguez le `Handler` de santé depuis votre propre routeur. Core ne le monte pas. `ProbeRegistry.check(...)` fonctionne sans aucune surface HTTP. Un listener `newServer` unaire répond aussi à `GET` et `HEAD` `/healthz` par un 200 vide. Ce contrôle signifie que le listener a accepté la requête. Il n'exécute pas le registre de probes.

## Un bundle de télémétrie

Construisez vous-même les objets du SDK natif. Adaptez-les avec les constructeurs de plugs. Passez le bundle à `telemetry(tel)` sur `newApp`. Core enregistre alors les unités RPC, HTTP, messagerie, job, config, registre et cycle de vie. Le code métier utilise `@go-like/core/log`, `inSpan` et les handles de métriques typés.

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

`newPinoHandler` doit recevoir le même objet `destination` que celui qui a construit le logger. `ignoreRequest` abandonne l'unité entière pour les chemins de probe et de scrape, ce qui tient les probes Kubernetes hors des logs de complétion. Construisez la `Resource` OpenTelemetry à partir des mêmes constantes `name` et `version` que vous passez à `newApp`.

`completionLogs` vaut `"failures"` ou `"all"`. Les clés d'attributs de span et de métrique forment un ensemble fermé. Core ne place pas les messages d'erreur, les piles ni les causes sur les spans, les labels de métrique ou les enregistrements de complétion. Les événements de diagnostic peuvent attacher l'`Error` locale comme `LogField.exception`. Le plug mappe ce champ sur l'emplacement natif.

### Bootstrap avant newApp

La configuration doit souvent se charger avant que les serveurs existent. Le bundle peut observer ce travail avant que l'App en soit propriétaire :

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

`Telemetry.stop` avant `start` draine chaque provider sans l'admettre, et le bundle ne peut plus être démarré ensuite. Un script qui n'appelle jamais `newApp` utilise `withTelemetry`, `tel.start` et `tel.stop` directement. `newTelemetryRecorder` de `@go-like/core/testing` enregistre spans, métriques et logs dans les tests.

## OpenTelemetry

`@go-like/otel` exporte `newOtelTracerProvider`, `newOtelMeterProvider`, `newOtelLogHandler` et `newOtelPropagator`. La dépendance peer est `@opentelemetry/api`. L'application construit les providers du SDK, enregistre un context manager et laisse le propagateur global non défini. En enregistrer un peut dupliquer `traceparent`.

Chaque provider est arrêté une fois. L'attente d'arrêt par défaut est `defaultOtelShutdownTimeoutMs` (25 secondes). `shutdownTimeoutMs: 0` fait échouer immédiatement l'attente du propriétaire. Les erreurs publiques sont `OtelAlreadyStartedError` (`GO_LIKE_OTEL_ALREADY_STARTED`), `OtelShutdownTimeoutError` (`GO_LIKE_OTEL_SHUTDOWN_TIMEOUT`) et `OtelContextManagerMissingError` (`GO_LIKE_OTEL_CONTEXT_MANAGER_MISSING`).

## Prometheus

`@go-like/prometheus/metric` exporte `newPrometheusMeterProvider(registry)` et `createPrometheusHandler(registry, { path? })`. Passez le registre que vous avez créé. Le plug ne touche pas au registre global. `start` enregistre `target_info` depuis la ressource de l'App, puis se résout. Le handler de scrape est un `Handler` Web ordinaire : montez-le sur le host Web de core, dans le palier serveurs, afin qu'il s'arrête avant le palier télémétrie.

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

`newPinoHandler(logger, destination, ...options)` mappe `LogField.exception` sur la clé `err` de Pino. Le sérialiseur `err` par défaut de Pino écrit déjà `name`, `message` et `stack`. `pinoDrainTimeout(ms)` fixe la frontière de drain du propriétaire. Le cycle de vie contrôle que `destination` est le flux avec lequel le logger a été construit, puis le flush, le termine et le ferme. Erreurs : `GO_LIKE_PINO_ALREADY_STARTED`, `GO_LIKE_PINO_DRAIN_TIMEOUT`, `GO_LIKE_PINO_DESTINATION_CLOSED`.

## Winston

`newWinstonHandler(logger)` mappe `LogField.exception` sur la clé native `error` de Winston. `winston.format.json()` seul sérialise une `Error` en `{}`, de sorte que le message et la pile disparaissent. Placez un format conscient des `Error` devant JSON. Pino n'a pas besoin de cette étape.

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

L'admission relie le logger avec `child(...)` depuis la ressource de l'App. `stop` appelle `logger.end()` et attend `finish` ou `close`. Il n'y a pas de fermeture forcée Winston ni de timeout de plug ; le `stopTimeout` de l'App est l'attente de l'appelant, et la valeur par défaut est illimitée. Erreurs : `GO_LIKE_WINSTON_ALREADY_STARTED`, `GO_LIKE_WINSTON_LOGGER_FINISHED`, `GO_LIKE_WINSTON_LOGGER_CLOSED`.

Les logs métier passent par `@go-like/core/log` (`log.info(ctx, message, attrs)`). Les handlers actifs reçoivent `trace_id`, `span_id` et `trace_flags` lorsqu'un span est courant. Le masquage des champs applicatifs reste sur le logger natif (`pino({ redact })`, formats Winston).

## Ce qui est enregistré

Les unités de core comprennent le serveur et le client RPC, le serveur HTTP, la publication et le traitement de messages, l'exécution et l'enqueue de jobs, le chargement et le rechargement de config, l'enregistrement et le watch de registre, le retry, les transitions de circuit, les rejets de limite de débit, ainsi que le démarrage, ready, stopping, stopped de l'App et l'échec d'un participant. Les appels cache et store ne reçoivent pas d'unité core : l'application appelle le plug directement. Les scrapes de santé sont omis lorsque `ignoreRequest` le dit.

Les clés d'attributs, les noms de métriques et les noms d'événements de log sont les constantes de `@go-like/core/telemetry` (`SemconvVersion` vaut `"1.45.0"`). Les attributs de métrique ne viennent que des `attributeKeys` déclarés sur `newCounter`, `newHistogram`, `newUpDownCounter` et `newGauge`. Un sujet, une URL ou un identifiant utilisateur n'a pas sa place sur une métrique.

Lorsqu'aucun `LogHandler` n'est installé, les événements de diagnostic de niveau erreur sont écrits en une ligne JSON sur `console.error` avec `event.name`, `error.type` et `go_like.operation`. La ligne n'inclut pas le texte de l'erreur. Il n'y a pas de plug de log console.

## Liste de contrôle d'exploitation

- L'application a construit le SDK, le logger et le registre Prometheus.
- Le propagateur global OpenTelemetry n'est pas défini.
- `telemetry(tel)` est sur l'App, pas à l'intérieur de `server(...)`.
- `/readyz` a une vraie probe ready, y compris `readyProbe` lorsque le processus doit rapporter la fenêtre de l'App.
- Les chemins de probe et de scrape sont listés dans `ignoreRequest` lorsque leurs logs noieraient le signal.
- Winston développe `info.error` avant `format.json()`.
- Les labels et les champs de log ont une policy de masquage sur le logger ou l'exporter natif.
