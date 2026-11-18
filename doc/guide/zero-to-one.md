# Clinic Appointment Booking: 0 to 1

This path follows one business invariant through an internal policy call, a Fetch handler, health, and one App. The runnable tree is `examples/healthcare-appointments`. The snippets below use that example's names. A disposable availability cache is an extra milestone you add in the same composition root. It is not a second source of truth.

## The invariant

1. A doctor cannot have overlapping active appointments.
2. Cancellation releases the slot.
3. Repeating the same appointment id with the same content is idempotent.
4. Reusing an appointment id with different content is rejected.
5. A cached availability projection, if you add one, never authorizes a booking by itself.

The example implements the first four rules with an in-memory repository and checks a maximum duration through `appointment-policy.v1/check`. It does not claim a database, a distributed lock, authentication, or a production clinic workflow.

## Layout

```text
examples/healthcare-appointments/
  src/contract.ts    defineService and Structs
  src/service.ts     repository and booking rules
  src/transport.ts   memory Server and Client
  src/http.ts        Fetch handler
  src/main.ts        Node host and App
  test/main.test.ts
```

From the repository root:

```sh
bun install --frozen-lockfile
bun run --cwd examples/healthcare-appointments test:unit
```

Package version `0.0.1` does not establish npm availability. Inside this checkout the only go-like dependency the example needs is `@go-like/core`.

## M0: domain rules

`src/service.ts` owns `BookAppointmentCommand`, the repository, and the overlap check. Context is the first argument even when the in-memory repository does not block. A later store or cache can use the same signature.

The example rejects a bad id, a non-positive window, an overlap, and an id reused with different content. Tests for those cases belong next to the repository, with no App and no HTTP.

## M1: the policy service

`src/contract.ts` binds the operation:

```ts
import { struct } from "@go-like/core/struct"
import { defineService } from "@go-like/core/transport"

const command = struct.object({
  appointmentId: struct.string(),
  doctorId: struct.string(),
  patientId: struct.string(),
  startsAt: struct.number(),
  endsAt: struct.number()
})

export const appointmentPolicy = defineService("appointment-policy.v1", {
  check: {
    request: command,
    response: struct.object({ allowed: struct.literal(true) })
  }
})
```

`src/transport.ts` puts both ends on one memory transport. The address `memory://appointment-policy.v1` is not the operation name.

```ts
import { newClient, withEndpoint, withTransport } from "@go-like/core/client"
import { address, newServer, transport as serverTransport } from "@go-like/core/server"
import { serviceError } from "@go-like/core/transport"
import { newMemoryTransport } from "@go-like/core/transport/memory"
import { appointmentPolicy } from "./contract"

const transport = newMemoryTransport()
const server = newServer(serverTransport(transport), address("memory://appointment-policy.v1"))
appointmentPolicy.registerHandler(server, {
  check(_ctx, command) {
    if (command.endsAt - command.startsAt > 7_200_000) {
      throw serviceError("appointment_policy_rejected", "appointment duration exceeds policy", 409)
    }
    return { allowed: true as const }
  }
})
const caller = appointmentPolicy.newClient(
  newClient(withTransport(transport), withEndpoint("memory://appointment-policy.v1"))
)
```

`src/http.ts` is a `contextHandler`. It forwards the request Context into booking and cancellation. HTTP 400 is a malformed body. HTTP 409 is a rejected booking. Those statuses are the Web handler's choice. The policy failure is a `ServiceError` with status 409 on the internal call.

## M2: availability cache

A memory cache is optional and process-local. Keys and values are bytes. The repository stays authoritative: a hit skips a read, a miss or an expiry reads again, and a booking or cancellation deletes the key. A cache error must not turn into a successful booking.

```ts
import { expiresIn } from "@go-like/core/cache"
import { newMemoryCache } from "@go-like/core/cache/memory"

const cache = newMemoryCache()
await cache.put(ctx, key, bytes, expiresIn(5_000))
const hit = await cache.get(ctx, key)
```

`newMemoryCache` is not a `Server`. `@go-like/redis/cache` is a `Server`; that one goes in `resources(...)`.

## M3: liveness and readiness

Create one registry, point the App at it, and dispatch `/livez` and `/readyz` yourself. Without `readyProbe`, `/readyz` stays 503.

```ts
import { newApp, readyProbe, server } from "@go-like/core"
import { newProbeRegistry } from "@go-like/core/health"
import { createHealthHandler, type Handler } from "@go-like/core/web"

const probes = newProbeRegistry()
probes.register("ready", "policy", async (ctx) => {
  await policyServer.endpoint(ctx)
})
const health = createHealthHandler(probes)

const handler: Handler = async (request) => {
  const { pathname } = new URL(request.url)
  if (pathname === "/livez" || pathname === "/readyz") return await health(request)
  return appointmentHandler(request)
}

const app = newApp(readyProbe(probes), server(policyServer, web))
void handler
void app
```

## M4: one lifecycle owner

`src/main.ts` in the example is the composition root: repository, policy service, handler, `newNodeServer`, `signal()`, and `afterStart` that waits for `endpoint(ctx)` before writing `GO_LIKE_EXAMPLE_READY`. Add `readyProbe` when you expose `/readyz`. Close the policy client in `afterStop` if it outlives the memory server.

```ts
import { afterStart, name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { hostname, newNodeServer, port } from "@go-like/core/web/node"

const httpServer = newNodeServer(handler, hostname(host), port(portNumber))
const app = newApp(
  signal(),
  name("healthcare-appointments"),
  server(policy.server, httpServer),
  afterStart(async (ctx) => {
    await httpServer.endpoint(ctx)
  })
)
await app.run()
```

`server(...)` launches both participants together. The policy server is in-process, so it does not need the resource tier. A Redis cache or a file store would.

## M5: what the tests establish

`test/main.test.ts` exercises the in-memory rules and the internal call. A passing unit test does not establish Docker, a published tarball, or a production booking system. Record the command if you claim a result. See [Verification](/reference/verification).

## Troubleshooting

| Symptom                        | Check                                                                       |
| ------------------------------ | --------------------------------------------------------------------------- |
| `Cannot find package`          | Run `bun install --frozen-lockfile`. Imports are `@go-like/core/...`.       |
| HTTP 404                       | The handler does not know that path. Health routes are not mounted for you. |
| HTTP 400                       | The JSON body failed the handler's own check.                               |
| HTTP 409                       | The repository or the policy rejected the command.                          |
| Typed call fails validation    | Request or response does not match the Struct.                              |
| Client cannot reach the server | Client and server must share one `newMemoryTransport()` instance.           |
| `app.run()` does not return    | It waits until stop. `signal()` or `app.stop()` ends it.                    |
| `EADDRINUSE`                   | The port is taken.                                                          |
| Cache value disappeared        | Memory cache is process-local. TTL and `delete` also remove it.             |
| `/readyz` is 503               | Register a ready probe, including `readyProbe(probes)`.                     |
