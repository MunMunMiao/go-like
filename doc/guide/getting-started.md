# Getting started

This guide takes the shortest useful route through go-like:

1. Run a standard Fetch handler.
2. Put that handler behind a host and one Core App.
3. Add an explicit request Context when the handler performs cancellable work.
4. Move to the [Clinic Appointment Booking project](/guide/zero-to-one) when the basic lifecycle is clear.

go-like is not the router in this example. The handler can come from plain Web code, Hono, Elysia, H3, or another framework that exposes the standard Fetch shape.

## Before you install

The repository root is private and currently records package version `0.0.1`. Repository documentation says the `@go-like/*` packages have not yet been published to npm. From a checkout, use the workspace lockfile:

```sh
bun install --frozen-lockfile
```

The declared validation matrix is Bun `1.x`, Node.js `26.x`, Deno with no fixed version requirement, TypeScript `7.0.2`, and k6 `2.1.0`. Bun 1.x and Node.js 26.x are the supported validation ranges; Deno is still probed and tested, but the repository does not enforce a Deno version pin. Other Bun or Node.js major versions may still execute a source example, but they are not the repository's full validation environment.

After a future published release, the intended dependency shape for a small Node-hosted Web service is:

```sh
bun add @go-like/context @go-like/core @go-like/web
```

Do not use that command as evidence that the current checkout is installable from npm.

## One standard Web handler

The public `@go-like/web` contract is deliberately small:

```ts
import type { Handler } from "@go-like/web"

export const handler: Handler = (request) => {
  const url = new URL(request.url)
  return Response.json({
    method: request.method,
    path: url.pathname
  })
}
```

`Handler` is `(request: Request) => Response | Promise<Response>`. It does not bind a port, install signal listeners, or decide how the application shuts down.

## Add a Node host and Core App

`@go-like/web/node` supplies a Node host around the same Fetch handler. `@go-like/core/node` supplies the process-signal adapter. The following imports and options are current public exports:

```ts
import process from "node:process"

import { afterStart, name, newApp, server, stopTimeout } from "@go-like/core"
import { signal } from "@go-like/core/node"
import type { Handler } from "@go-like/web"
import { newNodeServer, port } from "@go-like/web/node"

const handler: Handler = (request) => {
  const path = new URL(request.url).pathname
  return Response.json({ message: "hello from go-like", path })
}

const webServer = newNodeServer(handler, port(3000))
const app = newApp(
  name("hello"),
  server(webServer),
  stopTimeout(30_000),
  signal(),
  afterStart(async function announceReady(ctx): Promise<void> {
    await webServer.endpoint(ctx)
    process.stdout.write("GO_LIKE_EXAMPLE_READY=hello\n")
  })
)

await app.run()
```

Save this as `src/main.ts` in a workspace application and run it with:

```sh
bun run src/main.ts
```

Wait for the `GO_LIKE_EXAMPLE_READY=hello` line before sending traffic. Then, in another terminal:

```sh
curl -i http://127.0.0.1:3000/hello
```

Press `Ctrl-C` in the service terminal. `signal()` maps the first `SIGTERM`, `SIGQUIT`, or `SIGINT` to the same idempotent `App.stop()` operation. It does not provide a second-signal force-stop API; after the first signal, the adapter removes its own listeners and the runtime handles a later signal normally.

### First checkpoint

You should now be able to answer four different questions:

- Which function owns the URL route? The application or Web framework handler.
- Which object owns the listening resource? `webServer`.
- Which object coordinates the resource? `app`.
- What does the stop timeout mean? It bounds the Core cleanup wait; it does not prove that every uncooperative native resource is already terminal.

## Add a request Context

Use `contextHandler` when the handler needs cancellation, a deadline, or request-scoped values. It bridges `Request.signal` to a private go-like `Context` and leaves the Web ABI unchanged:

```ts
import { contextHandler, type Handler } from "@go-like/web"

export const handler: Handler = contextHandler(async (ctx, request) => {
  if (ctx.err() !== null) {
    return Response.json({ code: "request_canceled" }, { status: 499 })
  }

  const url = new URL(request.url)
  const [deadline, hasDeadline] = ctx.deadline()
  return Response.json({
    path: url.pathname,
    hasDeadline,
    deadline: hasDeadline ? deadline.toISOString() : null
  })
})
```

The Context contract is intentionally Go-shaped but JavaScript-native:

```ts
interface Context {
  deadline(): readonly [Date, boolean]
  done(): AbortSignal | null
  err(): ContextError | null
  value(key: unknown): unknown
}
```

Use `withTimeout`, `withCancel`, and `cause` from `@go-like/context` inside application operations. Pass the Context as the first argument rather than putting it into a mutable options bag:

```ts
import { background, cause, withTimeout } from "@go-like/context"

const [operationContext, cancel] = withTimeout(background(), 2_000)
try {
  await repository.read(operationContext, "appointment-1")
} catch (error) {
  const operationCause = cause(operationContext)
  // Keep the operation error and cancellation cause distinct in real error policy.
  void error
  void operationCause
} finally {
  cancel()
}
```

`withoutCancel(ctx)` keeps Context values while removing the parent's deadline and cancellation. Core uses this distinction for long-lived server ownership and shutdown cleanup. See [Architecture](/guide/architecture) before using it to detach work yourself.

## Use an existing Fetch framework

go-like does not publish a second router. The current examples pass native framework handlers directly:

```ts
import { Hono } from "hono"
import { newNodeServer, port } from "@go-like/web/node"

const framework = new Hono().get("/users/:id", (context) => {
  return context.json({ id: context.req.param("id") })
})

const webServer = newNodeServer(framework.fetch, port(3000))
```

The repository contains the same integration shape for Hono, Elysia, and H3 in `examples/hono`, `examples/elysia`, and `examples/h3`. These examples demonstrate a native Fetch handler plus a go-like-managed Node host; they are not go-like router wrappers.

## Learn in order

| Stage | Page or example                                         | New idea                                                                       |
| ----- | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1     | `examples/vanilla-web`                                  | Handler, host, App, signal, and a real Node bind                               |
| 2     | [Architecture](/guide/architecture)                     | Context ownership, admission, terminal state, and shutdown order               |
| 3     | `examples/bank-transfer-gateway`                        | Typed `Endpoint`, `Struct`, Client, Server, and Memory Transport               |
| 4     | [Clinic project](/guide/zero-to-one)                    | A business invariant, internal policy call, health, tests, and troubleshooting |
| 5     | [Service calls](/guide/service-call)                    | Discovery, filters, selectors, retry authorization, and cleanup                |
| 6     | [Configuration and state](/guide/config-registry-store) | Why Config, Registry, Store, and Cache are separate contracts                  |
| 7     | [Broker and events](/guide/broker-events)               | Native delivery and settlement semantics                                       |
| 8     | [Health and observability](/guide/health-observability) | Explicit probes, metrics, tracing, logging, and security boundaries            |

## Checkout commands for the existing examples

The example directories are private workspace applications. Copying one directory does not make an independently installable package. From the repository root:

```sh
bun run --cwd examples/vanilla-web start
bun run --cwd examples/vanilla-web test:unit
bun run --cwd examples/healthcare-appointments typecheck
bun run --cwd examples/healthcare-appointments test:unit
```

The `start` scripts build the root packages first and then run the prepared application. Provider Docker, cross-runtime, and published-consumer checks use the repository E2E runner; see [Verification](/reference/verification) before running them.

## First-run failures

- If the ready line never appears, inspect the service terminal for a build, bind, or `afterStart` error. Do not treat an open process as proof that the listener was admitted.
- If the command reports `EADDRINUSE`, choose another port and use the same port in the `port(...)` option and the `curl` URL. Do not start a second copy on the occupied port.
- If a copied app cannot resolve `@go-like/*`, run it from the repository root after `bun install --frozen-lockfile`; the current `0.0.1` workspace packages are not an npm installation.
- If the runtime rejects the source syntax, compare the local Bun/Node/Deno versions with the declared matrix in [Verification](/reference/verification) before treating it as an API failure.
