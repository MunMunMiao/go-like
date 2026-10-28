# Health and observability

Health and observability are explicit composition points in go-like. The application creates probes, logger destinations, OpenTelemetry providers, and Prometheus registries. go-like wraps their request or lifecycle boundary; it does not silently install global infrastructure.

## Liveness and readiness

`@go-like/health` has two probe kinds:

- `live`: should the process be considered alive?
- `ready`: should traffic be admitted now?

The empty-registry rules are intentionally different:

- empty liveness is healthy;
- empty readiness fails closed because a service with no readiness evidence should not be assumed ready;
- when readiness probes exist, all registered readiness probes must pass.

The public registry API is:

```ts
import { newProbeRegistry } from "@go-like/health"

const probes = newProbeRegistry()
probes.register("live", "process", async (ctx) => {
  if (ctx.err() !== null) throw ctx.err() as Error
})
probes.register("ready", "policy", async (ctx) => {
  await policyServer.endpoint(ctx)
})
```

`register(kind, name, probe, options?)` returns an idempotent unregister function. Probe names are restricted public identifiers. The default probe timeout is 1,000 ms; provide `timeoutMs` when a dependency has a different honest budget. Checks run concurrently against a stable registration snapshot and return results in registration order.

`@go-like/web/health` provides the standard handler:

```ts
import { createHealthHandler } from "@go-like/web/health"

const health = createHealthHandler(probes)
```

The default routes are `/livez` and `/readyz`. The handler accepts `GET` and `HEAD`, returns `200` for a passing report, `503` for unavailable or failing probes, `404` for unknown paths, and `405` for unsupported methods. Responses use `Cache-Control: no-store` and redact probe errors from the public payload.

If you need one application router, delegate the health Handler from the framework route table. go-like does not mount the route into your application automatically.

`ProbeRegistry.check(...)` can be called directly by an application with no HTTP surface. `/livez` and `/readyz` are projected only when the application explicitly uses `@go-like/web/health`; they are not automatic business routes or a management service.

## Unary Server process check

`@go-like/server` is a different surface from `@go-like/web/health`. A `newServer(...)` listener that uses Node HTTP transport answers `GET` and `HEAD` `/healthz` with HTTP `200` and an empty body by default. That check means the unary listener accepted the request; it is not a readiness registry and it does not inspect brokers, stores, or TLS peers.

`httpRoute("GET", "/healthz", …)` replaces that default. Unmatched `/livez` and `/readyz` on the unary listener stay `404` unless the application mounts `@go-like/web/health` (or another Handler) on those paths.

A TCP connect to a published Docker port is not proof that this `/healthz` is live. Docker Desktop can accept host TCP through docker-proxy before the process TLS or HTTP listener is ready. Probe the HTTP (or TLS HTTP/2) response and retry on disconnect during startup. An HTTP response, including `503`, proves that the management endpoint is responding; it does not prove business admission. A separate management listener, or a health route on the application listener, may bind early and report `/livez` as `200` while `/readyz` remains `503` until required work-plane resources have admitted. When health and business routes share a listener, business routes must still fail closed before readiness.

## Readiness is an admission policy

A readiness probe should answer whether this process should receive traffic, not whether every dependency in the universe is reachable. Examples include:

- the internal policy Server has admitted its listener;
- a required Config snapshot has loaded;
- a local Store is readable;
- a native consumer is connected and able to accept work.

Do not make liveness depend on a remote database unless your deployment policy truly treats that database as process liveness. Do not make readiness a permanent success flag when the service has not loaded its required configuration.

The request Context passed into a probe is authoritative. A slow probe should observe cancellation and return a useful error. A timeout means the probe did not establish readiness within its budget; it is not proof that the dependency is dead.

## Signals are distinct facts

| Signal                     | Question answered                                               | go-like expression                                                             | Does not prove                                                    |
| -------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Address discovery          | Where can another service call it?                              | Explicit `endpoint(...)` or a network Server's `Endpointer.endpoint(ctx)`      | Process health, dependency health, or successful work             |
| Process liveness           | Should a supervisor consider the process still making progress? | `ProbeRegistry.check(ctx, "live")`, with optional HTTP projection              | Business traffic or queue work can be admitted                    |
| Work admission / readiness | Is this instance willing to accept the next unit of work?       | Application-defined ready probes; protocol management owns actual draining     | Running work succeeds or remote dependencies stay healthy forever |
| Work outcome               | Did one request, message, or job complete?                      | Handler or processor result, ack/nack, exit code, or Job condition             | Long-lived process health or admission of the next unit           |
| Progress / telemetry       | Has a resident process recently shown activity or failure?      | Metrics, logs, traces, application heartbeat, or an optional platform watchdog | A discoverable address or a business-completion promise           |

`/livez` and `/readyz` are HTTP expressions of process liveness and work admission, not a new business data plane. Early health routes do not admit business routes.

## Workload admission matrix

| Workload                           | Admission evidence                                                                                                            | Health expression                                                                       | Stop accepting new work                                                                                                                                   | Completion expression                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| HTTP/internal unary service        | The listener has bound, its advertised address can be obtained, and dependencies required by application policy are satisfied | It may install `/livez` and `/readyz`; a Service can use readiness for traffic draining | Listener/registrar stop and deregistration                                                                                                                | Request result                                          |
| Resident BullMQ/NATS/Broker worker | A native Worker is ready and running, or its subscription has admitted                                                        | `ProbeRegistry.check(...)` can be called directly; management HTTP is optional          | The application requests App/Server stop; the adapter then invokes the native pause/unsubscribe/drain/close it owns. Readiness alone does not drain work. | Processor/handler result and native settlement          |
| Resident Croner scheduler          | Paused jobs have been validated and resumed, with future schedules remaining                                                  | Readiness can mean only that the scheduler and required configuration have admitted     | The application requests App/Server stop and the adapter prevents future schedules; do not invent callback draining                                       | Each callback's result, logs, and metrics               |
| Kubernetes Job/CronJob             | A new process starts one explicit unit of work                                                                                | Long-lived readiness is usually unnecessary; a bounded execution diagnostic is optional | Controller, deadline, signal, and process exit                                                                                                            | Exit code, Job `Complete`/`Failed`, retry, and deadline |

Kubernetes readiness affects Service routing only; it does not pause a broker consumer. A Job or CronJob expresses completion through its exit code and Job condition, not a long-lived readiness state.

## Prometheus

`@go-like/prometheus` uses an application-owned `prom-client` `Registry`:

```ts
import { Registry } from "prom-client"
import { createPrometheusHandler, newRequestMetrics } from "@go-like/prometheus"

const metricsRegistry = new Registry()
const requestMetrics = newRequestMetrics(metricsRegistry)
const metricsHandler = createPrometheusHandler(metricsRegistry)
```

The exact `newRequestMetrics` overload is defined by the package's public types. The important ownership rule is stable: the application creates the Registry, and the go-like instrumentation records bounded request metrics against it. It does not access the global Prometheus registry and does not create a background collection task.

Instrumented components include client, unary server, Web, and broker wrappers. Keep labels low-cardinality. An operation such as `orders/Orders.Get` is a safer label than an arbitrary URL, user ID, topic with unbounded tenant data, or request ID. Metrics should not contain credentials, raw request bodies, metadata, or payload values.

## OpenTelemetry

`@go-like/otel` accepts application-configured providers:

```ts
import { newOtelServer, traceWebHandler } from "@go-like/otel"

const tracedHandler = traceWebHandler(webHandler, tracer)
const otelServer = newOtelServer({
  tracerProvider,
  meterProvider
})
```

The public package offers explicit wrappers such as `traceClient`, `traceUnaryMiddleware`, `traceWebHandler`, `traceBroker`, `measureClient`, `measureClientMiddleware`, `measureUnaryMiddleware`, and `newRequestMetrics`. `newOtelServer(...)` owns the lifecycle boundary for the supplied providers after admission.

It does **not** install a global `TracerProvider`, `MeterProvider`, exporter, context manager, propagator, or automatic instrumentation. Install those through the OpenTelemetry SDK and runtime-specific setup that your application controls. A trace wrapper cannot create asynchronous context propagation that the selected runtime has not configured.

Keep `operation`, outcome, and bounded component identity in attributes. Avoid credentials, raw headers, payloads, full URLs with secrets, and high-cardinality user or topic values. The adapter's safe records do not constrain application-owned native logger or exporter code; that code still needs its own redaction policy.

## Pino and Winston

`@go-like/pino` and `@go-like/winston` are lifecycle and wrapper packages, not replacement logging systems. The application owns logger construction, levels, formats, redaction, child loggers, destinations, and transports.

The adapters expose wrappers such as:

- Pino: `logClient`, `logUnaryMiddleware`, `logWebHandler`, `logBroker`, `newPinoServer`, `pinoDrainTimeout`;
- Winston: corresponding client, unary, Web, and broker wrappers plus `newWinstonServer`.

After successful admission, the adapter joins the native destination or logger shutdown to Core. A timeout is a wait boundary; do not report that an asynchronous ThreadStream, file destination, or Winston transport is terminal unless its native finish/close signal says so.

## Security boundary

Health and observability do not authenticate a caller. The security layers are separate:

| Layer                | go-like contribution                                                                                                 | Application or platform responsibility                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Transport encryption | Node HTTP transport can use explicit TLS material; `clientAuth("require")` can require a verified client certificate | Certificates, CA rotation, SNI policy, deployment defaults, trust model                 |
| Authentication       | No universal JWT, OAuth, OIDC, or bearer-token validator                                                             | Parse and validate credentials, identity, issuer, audience, and expiry                  |
| Authorization        | No generic claims or ACL engine                                                                                      | Map identity to tenant, role, operation, and data permissions                           |
| Metadata             | Immutable snapshots, client/server separation, explicit propagation allowlists, bounded wire header                  | Treat metadata as untrusted until authenticated; decide what may cross a hop            |
| Logs and traces      | Low-level wrappers can avoid raw payloads and headers                                                                | Application-owned logs, exporters, and custom diagnostics still need redaction          |
| Retry                | Explicit replay authorization and bounded attempts                                                                   | Idempotency keys, deduplication, transaction policy, and duplicate side-effect handling |

Default Node HTTP transport options are not a security policy. Plain HTTP can be configured, TLS is not automatically enabled for every entrypoint, and mTLS certificate admission does not map a certificate to a business principal. Portable Fetch clients cannot portably inject custom PEM CA or mTLS material.

Metadata headers are data, not trusted identity. The server only forwards metadata downstream through explicit `exact` or `prefix` rules. Keep authorization and cookie fields out of broad propagation rules.

## Operations checklist

For each service, record:

- the liveness and readiness route paths;
- which readiness dependencies are required before traffic admission;
- probe timeout and cancellation behavior;
- the application-owned Prometheus Registry and scrape route;
- the OpenTelemetry providers, exporters, and context manager;
- logger destination and drain terminal signal;
- label and attribute cardinality policy;
- credential and payload redaction policy;
- the difference between caller timeout, adapter owner timeout, and native terminal state;
- the command and runtime evidence that actually exercised the setup.

The [claims ledger](/reference/claims) and [verification reference](/reference/verification) define the language to use when a wrapper exists in source but a provider E2E or runtime result has not been run.
