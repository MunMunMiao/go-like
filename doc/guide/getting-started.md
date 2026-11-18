# Getting started

This guide takes the shortest useful route through go-like:

1. Run a standard Fetch handler on a Node host inside one App.
2. Register readiness so `/readyz` can pass.
3. Add an explicit request Context when the handler does cancellable work.
4. Move to the [Clinic Appointment Booking project](/guide/zero-to-one) when that lifecycle is clear.

go-like is not the router. The handler can come from plain Web code, Hono, Elysia, H3, or another framework that exposes the standard Fetch shape.

## Before you install

The repository root is private and records package version `0.0.1`. That version does not establish npm availability. From a checkout:

```sh
bun install --frozen-lockfile
```

The repository does not use runtime or tool versions as execution eligibility. Each selected verification lane checks that its required tools can run and records the observed environment.

When a published release is independently confirmed, a small Node Web service depends on one package:

```sh
bun add @go-like/core
```

Logging, metrics, traces, and ecosystem backends are separate plugs. Add one only when the application constructs that native client.

## One Web service

`Handler` lives at `@go-like/core/web`. The Node host lives at `@go-like/core/web/node`. Process signals live at `@go-like/core/node`. The following shape is the current public API. Pass `signal()` yourself: core does not install signal handlers. Pass `readyProbe(probes)` on the same registry the health handler uses, or `/readyz` stays closed.

```ts
import { name, newApp, readyProbe, server, version } from "@go-like/core"
import { newProbeRegistry } from "@go-like/core/health"
import { signal } from "@go-like/core/node"
import { contextHandler, createHealthHandler, requestContext } from "@go-like/core/web"
import { newNodeServer, port } from "@go-like/core/web/node"

const probes = newProbeRegistry()
probes.register("ready", "warmup", async () => {
  // Check a process-local dependency here. Return to pass, throw to fail.
})

const health = createHealthHandler(probes)
const handler = contextHandler(async (ctx, request) => {
  const { pathname } = new URL(request.url)
  if (pathname === "/livez" || pathname === "/readyz") return await health(request)
  return Response.json({
    path: pathname,
    hasContext: requestContext(request) !== null && ctx.err() === null
  })
})

const web = newNodeServer(handler, port(3000))
export const app = newApp(
  signal(),
  name("hello-web"),
  version("v1"),
  readyProbe(probes),
  server(web)
)

await app.run()
```

`run()` resolves after the App stops. `Ctrl-C` delivers `SIGINT`. `signal()` maps the first `SIGTERM`, `SIGQUIT`, or `SIGINT` to the same idempotent `App.stop()` and sets `process.exitCode` to `128` plus the signal number. A later signal is left to the runtime.

Empty liveness passes. Empty readiness fails closed. `readyProbe` passes only after startup has finished and before stop begins. See [Health and observability](/guide/health-observability).

### First checkpoint

- The handler owns the URL route.
- `web` owns the listening socket.
- `app` admits that server, then stops it.
- `stopTimeout`, when set, bounds how long `run()` waits. It does not by itself finish a native socket that ignores shutdown.

## Add a request Context

`contextHandler` adapts `(ctx, request)` to a Fetch `Handler`. The host stores the request Context on the `Request`. `requestContext(request)` reads it back. The Context carries AppInfo and, when telemetry is installed, the `http.server` span. It is canceled when the request ends or aborts.

```ts
import type { Context } from "@go-like/core/context"
import { contextHandler, type Handler } from "@go-like/core/web"

export const handler: Handler = contextHandler(async (ctx: Context, request: Request) => {
  if (ctx.err() !== null) return new Response(null, { status: 499 })
  const url = new URL(request.url)
  return Response.json({ path: url.pathname })
})
```

For work that continues after the handler returns a body, also observe `request.signal`. `contextHandler` ends its Context when the handler returns the `Response`.

## Use an existing Fetch framework

Hono, Elysia, and H3 examples pass the framework Fetch function to `newNodeServer` and put that host in `server(...)`. The framework keeps routes and middleware.

```ts
import { Hono } from "hono"
import { name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { newNodeServer, port } from "@go-like/core/web/node"

const app = new Hono()
app.get("/hello", (c) => c.json({ ok: true }))

const web = newNodeServer(app.fetch, port(3000))
await newApp(signal(), name("hono"), server(web)).run()
```

The runnable copies are `examples/hono`, `examples/elysia`, `examples/h3`, and `examples/vanilla-web`.

## Learn in order

1. This page: one host, one App, one ready probe.
2. [Clinic Appointment Booking](/guide/zero-to-one): a domain invariant and an internal unary call.
3. [Architecture](/guide/architecture): resource tier, server tier, and budgets.
4. [Service calls](/guide/service-call), then [Configuration, registry, store, and cache](/guide/config-registry-store).
5. [Health and observability](/guide/health-observability) when you add logs, metrics, or traces.

## Checkout commands

From the repository root, after `bun install --frozen-lockfile`:

```sh
bun run --cwd examples/vanilla-web test:unit
bun run --cwd examples/healthcare-appointments test:unit
```

Those commands typecheck and run the example unit tests. They do not start Docker or prove npm publication.

## First-run failures

| What you see                                    | What it usually means                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `/readyz` returns 503                           | The registry has no passing readiness probe. Register one, including `readyProbe(probes)` if the App itself should count.      |
| The process exits on `SIGTERM` without draining | `signal()` was omitted.                                                                                                        |
| `TypeError: pass telemetry with telemetry(...)` | A `Telemetry` bundle was passed to `server(...)` or `resources(...)`. Use `telemetry(tel)`.                                    |
| The port is already in use                      | Another process holds it. The host error is the runtime's listen error.                                                        |
| `Cannot find package`                           | The workspace install has not been run, or the import still uses a pre-migration specifier. See [Migration](/guide/migration). |
