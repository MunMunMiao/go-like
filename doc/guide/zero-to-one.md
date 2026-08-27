# Clinic Appointment Booking: 0 to 1

This is a guided 0-to-1 project path for learning go-like through a concrete business invariant rather than a generic Todo list. It describes a target project and its runnable checkpoints; it is not a claim that the target tree is already committed as one copy-paste application. The project is a clinic appointment service with an in-process policy service, a canonical appointment repository, a disposable availability cache, health endpoints, and one explicit application lifecycle.

The repository already contains `examples/healthcare-appointments`, which is the starting implementation for this guide. Its current code uses raw JSON `Message` handling for the policy service. The typed `Endpoint` and `Struct` version below is a documented upgrade path built from current public exports; it was not added to the example during this documentation phase. Keep that distinction when reporting verification.

## The invariant

The service must preserve five rules:

1. A doctor cannot have overlapping active appointments.
2. Cancellation releases the time slot.
3. Repeating the same appointment request with the same appointment ID is idempotent.
4. Reusing an appointment ID with different appointment content is rejected.
5. Availability is cached only as an acceleration; the repository remains authoritative.

The current repository example implements the first four rules with an in-memory repository and validates a maximum appointment duration through an internal policy service. It does not claim a database, a distributed lock, durable cache, authentication, or a production booking workflow.

## What you will build

```text
clinic-appointments/
|-- package.json
|-- tsconfig.json
|-- README.md
|-- src/
|   |-- contract.ts       # typed policy Endpoint and Structs
|   |-- service.ts        # domain invariant and canonical repository
|   |-- transport.ts      # policy Server and Client over Memory Transport
|   |-- cache.ts          # availability cache and invalidation policy
|   |-- http.ts           # Fetch routes and health delegation
|   `-- main.ts           # one composition root and one Core App
`-- test/
    |-- main.test.ts      # domain, typed call, HTTP, cache, health, cancellation
    `-- node-e2e.ts       # real bind, request, stop, and port release
```

The existing workspace example has this smaller current tree:

```text
examples/healthcare-appointments/
|-- package.json
|-- tsconfig.json
|-- README.md
|-- src/
|   |-- service.ts
|   |-- transport.ts      # current raw JSON policy boundary
|   |-- http.ts
|   `-- main.ts
`-- test/main.test.ts
```

The second tree is the source of truth for what is already in the checkout. The first tree is the target shape for the tutorial milestones. M0 and the baseline commands can be run against the current example immediately; M1-M5 become runnable after the files and tests in the target tree are added. The snippets below name every application-owned type or factory they use so that the remaining work is explicit rather than hidden behind pseudocode.

## Prerequisites and commands

From the repository root:

```sh
bun install --frozen-lockfile
```

The packages are workspace dependencies in this checkout. The repository does not use runtime or tool versions as execution eligibility. Each selected verification lane checks that its required tools can run and records the observed environment. Command behavior and results, not version numbers, determine the outcome. The current package documentation says the packages are not yet published to npm.

Run the existing baseline example:

```sh
HOST=127.0.0.1 PORT=3000 bun run --cwd examples/healthcare-appointments start
```

The `start` script builds the root packages, creates a prepared Node bundle, and runs it. Wait for the `GO_LIKE_EXAMPLE_READY` line before sending traffic. In another terminal:

```sh
NOW=$(($(date +%s) * 1000))
curl -i -sS http://127.0.0.1:3000/v1/appointments \
  -H 'content-type: application/json' \
  -d "{\"appointmentId\":\"appointment-1\",\"doctorId\":\"doctor-1\",\"patientId\":\"patient-1\",\"startsAt\":$((NOW + 3600000)),\"endsAt\":$((NOW + 5400000))}"

curl -i -sS -X DELETE \
  http://127.0.0.1:3000/v1/appointments/appointment-1
```

Stop the foreground process with `Ctrl-C`. Do not start a second hidden App for the policy service; the current example puts the policy Server and Web Server into the same Core App.

Focused checks for the current example are:

```sh
bun run --cwd examples/healthcare-appointments typecheck
bun run --cwd examples/healthcare-appointments test:unit
```

The example also declares an E2E wrapper:

```sh
bun run --cwd examples/healthcare-appointments test:e2e
```

That command builds and runs the example E2E task. It is a command to execute, not a statement that the current checkout has passed it.

## M0: domain rules first

The domain module is Context-first even though the in-memory repository's critical section is synchronous. That makes cancellation and future provider replacement visible at the boundary:

```ts
import type { Context } from "@go-like/context"

export interface BookAppointmentCommand {
  readonly appointmentId: string
  readonly doctorId: string
  readonly patientId: string
  readonly startsAt: number
  readonly endsAt: number
}

export type AppointmentStatus = "booked" | "cancelled"

export interface Appointment extends BookAppointmentCommand {
  readonly status: AppointmentStatus
}

export interface AppointmentRepository {
  book(ctx: Context, command: BookAppointmentCommand): Appointment
  cancel(ctx: Context, appointmentId: string): Appointment
  get(ctx: Context, appointmentId: string): Appointment | undefined
}
```

The repository should check `ctx.err()` before mutating state. The current example's `newMemoryAppointmentRepository()` does this and stores a fingerprint with each appointment. Its overlap predicate is:

```ts
function overlaps(
  leftStartsAt: number,
  leftEndsAt: number,
  rightStartsAt: number,
  rightEndsAt: number
): boolean {
  return leftStartsAt < rightEndsAt && rightStartsAt < leftEndsAt
}
```

That predicate makes adjacent appointments valid while overlapping active appointments for one doctor fail. Cancellation changes the stored status to `cancelled`; a second cancellation returns the same canceled record.

### M0 tests

Write these tests before adding HTTP or transport:

```ts
import { background } from "@go-like/context"
import { expect, test } from "bun:test"
import { newBookAppointment, newMemoryAppointmentRepository } from "../src/service"
test("rejects an overlapping active slot", () => {
  const repository = newMemoryAppointmentRepository()
  const book = newBookAppointment(repository, () => 1_000)
  book(background(), {
    appointmentId: "a-1",
    doctorId: "doctor-1",
    patientId: "patient-1",
    startsAt: 2_000,
    endsAt: 3_000
  })

  expect(() =>
    book(background(), {
      appointmentId: "a-2",
      doctorId: "doctor-1",
      patientId: "patient-2",
      startsAt: 2_500,
      endsAt: 3_500
    })
  ).toThrow("doctor time conflict")
})
```

The current `test/main.test.ts` contains this case plus cancellation reuse, idempotent cancellation, and an HTTP handler check. Those tests are inspected repository evidence until the command above has run in your environment.

## M1: a typed internal policy service

The typed internal contract uses `@go-like/struct` and `@go-like/transport`. This is runtime validation on a unary Message boundary, not an IDL or generated RPC service.

### `src/contract.ts`

```ts
import { struct, type Infer } from "@go-like/struct"
import { endpoint } from "@go-like/transport"

const CheckRequest = struct.object({
  appointmentId: struct.string(),
  doctorId: struct.string(),
  patientId: struct.string(),
  startsAt: struct.number(),
  endsAt: struct.number()
})

const CheckResponse = struct.object({
  allowed: struct.boolean()
})

export type CheckRequest = Infer<typeof CheckRequest>
export type CheckResponse = Infer<typeof CheckResponse>

export const checkAppointment = endpoint(
  "appointment-policy",
  "AppointmentPolicy.Check",
  CheckRequest,
  CheckResponse
)
```

The route tokens are visible ASCII and cannot contain `/` or `*`. The `Endpoint` contains request and response Struct instances and the two route tokens. It does not describe a network address or a generated client.

### `src/transport.ts`

```ts
import { newClient, withAddress, withTransport } from "@go-like/client"
import type { Context } from "@go-like/context"
import {
  address,
  handler,
  newServer,
  transport as serverTransport,
  type Server
} from "@go-like/server"
import { newMemoryTransport } from "@go-like/transport-memory"

import { checkAppointment, type CheckRequest, type CheckResponse } from "./contract"

const policyAddress = "memory://appointment-policy"

export interface AppointmentPolicy {
  readonly server: Server
  validate(ctx: Context, request: CheckRequest): Promise<CheckResponse>
  close(ctx: Context): Promise<void>
}

export function newAppointmentPolicy(maximumDurationMs = 7_200_000): AppointmentPolicy {
  const transport = newMemoryTransport()
  const client = newClient(withTransport(transport))
  const server = newServer(
    serverTransport(transport),
    address(policyAddress),
    handler(checkAppointment, (_ctx, request) => {
      if (request.endsAt - request.startsAt > maximumDurationMs) {
        throw new Error("appointment duration exceeds policy")
      }
      return { allowed: true }
    })
  )

  return Object.freeze({
    server,
    async validate(ctx: Context, request: CheckRequest): Promise<CheckResponse> {
      return await client.call(ctx, checkAppointment, request, withAddress(policyAddress))
    },
    close(ctx: Context): Promise<void> {
      return client.close(ctx)
    }
  })
}
```

The current committed example uses a raw `Message` policy handler and a `serviceError(...)` with status `409`. That is a valid lower-level boundary. The typed version above changes the request and response codec, but it does not change the core ownership model: one Memory Transport instance, one internal Server, one Client, and explicit close.

### Forward the Context

The booking use case should pass the same request Context to the policy Client and repository:

```ts
async function validatedBook(ctx: Context, command: CheckRequest): Promise<Appointment> {
  await policy.validate(ctx, command)
  return repository.book(ctx, command)
}
```

Replacing `ctx` with `background()` would discard the request deadline, cancellation, and Context ancestry. That is a correctness regression, not a harmless simplification.

### M1 tests

Test all of the following:

| Test                   | Expected result                                      |
| ---------------------- | ---------------------------------------------------- |
| valid typed request    | `allowed: true` and a booked appointment             |
| overlong request       | policy failure before repository mutation            |
| invalid field type     | typed request decode failure                         |
| invalid response shape | typed response encode failure at the Server boundary |
| canceled Context       | policy and repository observe the same cancellation  |
| client close           | resident Transport Client cleanup is explicit        |

The current example's policy test already verifies rejection before repository mutation and success through `Client -> Memory Transport -> Server`. The typed test is a proposed extension.

## M2: availability Cache

Cache is useful for a read projection, not for booking authority. The Cache package exposes Context-first `get`, `put`, and `delete`; `@go-like/cache-memory` provides `newMemoryCache()` and `@go-like/cache` provides `expiresIn(...)`:

```ts
import type { Context } from "@go-like/context"
import { expiresIn } from "@go-like/cache"
import { newMemoryCache } from "@go-like/cache-memory"

interface Availability {
  readonly doctorId: string
  readonly slots: readonly { readonly startsAt: number; readonly endsAt: number }[]
}

interface AvailabilityRepository extends AppointmentRepository {
  readAvailability(ctx: Context, doctorId: string): Availability
}

const availabilityCache = newMemoryCache()
declare const repository: AvailabilityRepository

async function readAvailability(ctx: Context, doctorId: string) {
  const key = `availability/${doctorId}`
  const cached = await availabilityCache.get(ctx, key)
  if (cached !== null) {
    return JSON.parse(new TextDecoder().decode(cached)) as Availability
  }

  const authoritative = repository.readAvailability(ctx, doctorId)
  await availabilityCache.put(
    ctx,
    key,
    new TextEncoder().encode(JSON.stringify(authoritative)),
    expiresIn(30_000)
  )
  return authoritative
}

async function invalidateAvailability(ctx: Context, doctorId: string): Promise<void> {
  await availabilityCache.delete(ctx, `availability/${doctorId}`)
}
```

`Availability`, `AvailabilityRepository`, and `repository.readAvailability(...)` are application-owned additions in this tutorial, not go-like exports. Implement them in `src/service.ts` before running M2. Booking and cancellation must invalidate the key after the authoritative mutation. If invalidation fails, report it and choose an explicit consistency policy; do not silently treat the cache as the booking source of truth.

### M2 tests

- a miss reads the repository and populates the cache;
- a hit does not read the repository again;
- a booking or cancellation deletes the projection;
- an expired value falls back to the repository;
- a cache failure does not turn a correct authoritative read into a false booking result;
- process restart loses Memory Cache state by design.

## M3: liveness and readiness

Create the registry in the composition root and delegate two paths to `createHealthHandler(...)`:

```ts
import type { Context } from "@go-like/context"
import { newProbeRegistry } from "@go-like/health"
import { createHealthHandler } from "@go-like/web/health"
import type { Handler } from "@go-like/web"

import type { Appointment, BookAppointmentCommand } from "./service"
import { newBookAppointment, newCancelAppointment, newMemoryAppointmentRepository } from "./service"
import { newAppointmentPolicy } from "./transport"
import { newAppointmentHandler } from "./http"

const repository = newMemoryAppointmentRepository()
const policy = newAppointmentPolicy()
const book = async (ctx: Context, command: BookAppointmentCommand): Promise<Appointment> => {
  const decision = await policy.validate(ctx, command)
  if (!decision.allowed) throw new Error("appointment policy rejected request")
  return newBookAppointment(repository)(ctx, command)
}
const cancel = newCancelAppointment(repository)
const probes = newProbeRegistry()
probes.register("ready", "policy", async (ctx) => {
  await policy.server.endpoint(ctx)
})

const healthHandler = createHealthHandler(probes)
const appointmentHandler: Handler = newAppointmentHandler(book, cancel)

const webHandler: Handler = (request) => {
  const path = new URL(request.url).pathname
  if (path === "/livez" || path === "/readyz") return healthHandler(request)
  return appointmentHandler(request)
}
```

The default routes are `/livez` and `/readyz`. Empty liveness is healthy; empty readiness fails closed. The `policy` probe above makes readiness depend on internal listener admission without pretending that an external database is always process liveness.

A production service should add only the readiness dependencies that are truly required for traffic. Probe names are public identifiers and health payloads are intentionally sanitized.

## M4: one lifecycle owner

The composition root should construct the resources once and place them under one App:

```ts
import process from "node:process"
import { afterStart, afterStop, name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { hostname, newNodeServer, port } from "@go-like/web/node"

const policy = newAppointmentPolicy()
const httpServer = newNodeServer(webHandler, hostname("127.0.0.1"), port(3000))
const app = newApp(
  signal(),
  name("healthcare-appointments"),
  server(policy.server, httpServer),
  afterStart(async (ctx) => {
    await httpServer.endpoint(ctx)
    process.stdout.write("GO_LIKE_EXAMPLE_READY=healthcare-appointments\n")
  }),
  afterStop((ctx) => policy.close(ctx))
)

await app.run()
```

The `afterStop` hook is one explicit ordering boundary for the policy Client. Core itself stops sibling Servers concurrently. If a more complex dependency order is required, compose the dependent resources into one Server or explicit hook rather than relying on declaration order.

`signal()` is the Node/Bun process adapter. The domain, typed contract, Memory Transport, and health modules can remain portable; the `@go-like/core/node` import is a deliberate runtime choice.

## M5: test plan and evidence

| Layer      | Test                                                                  | Evidence target                                  |
| ---------- | --------------------------------------------------------------------- | ------------------------------------------------ |
| Domain     | overlap, cancellation reuse, idempotency, conflicting ID              | `src/service.ts` behavior and unit test result   |
| Context    | canceled booking does not mutate repository or call policy            | focused Context test                             |
| Typed call | Struct decode/encode, policy rejection, response validation           | `@go-like/client` and `@go-like/server` boundary |
| Cache      | miss, hit, TTL, invalidation, failure fallback                        | `newMemoryCache()` tests                         |
| Health     | empty liveness, empty readiness, failing probe, 405/404               | `newProbeRegistry()` and `createHealthHandler()` |
| HTTP       | `POST`, `DELETE`, invalid JSON, conflict status                       | standard Fetch Handler test                      |
| Lifecycle  | policy and Web Server admitted under one App; close Client explicitly | Core App and Server terminal behavior            |
| Node E2E   | real bind, request, signal, stop, port release                        | example E2E wrapper and residual checks          |

For the current repository example, the focused commands are:

```sh
bun run --cwd examples/healthcare-appointments typecheck
bun run --cwd examples/healthcare-appointments test:unit
bun run --cwd examples/healthcare-appointments test:e2e
```

For the whole examples lane:

```sh
bun run test:e2e:examples
```

The full E2E lane builds packages and uses the repository runner. Docker providers and cross-runtime consumers are separate scopes. Record the candidate commit, runtime versions, exit status, summary, and residual processes or containers; a script's presence is not a pass result.

## Milestones

| Milestone | Deliverable                                 | Move on when                                                         |
| --------- | ------------------------------------------- | -------------------------------------------------------------------- |
| M0        | Domain repository and invariant tests       | Overlap and cancellation behavior are deterministic                  |
| M1        | Typed policy Endpoint over Memory Transport | The call is real Client/Server/Transport, not a direct function call |
| M2        | Cache projection with invalidation          | Cache failure cannot replace the authority                           |
| M3        | `/livez` and `/readyz`                      | Empty readiness and failing probes are understood                    |
| M4        | One App, signal, explicit Client cleanup    | Every admitted resource has one owner                                |
| M5        | Unit and Node E2E evidence                  | Results are recorded with command and exit status                    |

Do not add Registry, Redis, Vault, a real broker, authentication, or retries before these milestones are clear. Each adds a new ownership or failure model that should be introduced deliberately.

## Troubleshooting

### `Cannot find package "@go-like/..."`

You are likely running outside the workspace or relying on an unpublished package. Run `bun install --frozen-lockfile` from the repository root and execute a workspace script such as `bun run --cwd examples/healthcare-appointments start`.

### The request returns `404`

The current example only exposes `POST /v1/appointments` and `DELETE /v1/appointments/{appointmentId}`. Check the method, path, and the `GO_LIKE_EXAMPLE_READY` line. Health routes belong to the M3 tutorial extension, not the current committed example.

### The request returns `400`

The example requires string IDs and numeric `startsAt`/`endsAt` values. `startsAt` must be in the future relative to the injected clock and `endsAt` must be greater than `startsAt`. Check that the shell arithmetic produced numbers rather than quoted strings.

### The request returns `409`

A doctor slot overlaps an active appointment, an appointment ID was reused with different content, or the policy service rejected the duration. The policy is called before the repository mutation, so a policy rejection should not create a record.

### A typed call reports invalid request or response body

Check that the client and server use the same `Endpoint` Structs and that the request Content-Type is exactly `application/json`. `handler(contract, fn)` performs JSON and Struct validation at the Server boundary.

### Memory Client cannot reach the Server

`newMemoryTransport()` creates an instance-private address map. The Client and Server must share the same Transport instance and the exact bound `memory:` address. A matching URL in two separately constructed Memory Transport instances does not connect.

### `app.run()` appears to hang

A long-lived `Server.start(ctx)` may remain pending for the service lifetime. That is expected. `app.run()` resolves after stop and terminal cleanup, not immediately after a listener is bound. Use `afterStart` or `server.endpoint(ctx)` for an admission signal.

### No ready line or `EADDRINUSE`

The current example prints `GO_LIKE_EXAMPLE_READY` only after the Node listener has an endpoint. If the line never appears, inspect the foreground process for a build, bind, or `afterStart` error. If the bind reports `EADDRINUSE`, stop the process that owns the port or choose another `PORT`; do not send traffic to a port that was never admitted.

### Docker or runtime prerequisites are missing

The focused typecheck and unit commands do not need Docker. Provider E2E needs the services declared by its scope, cross-runtime E2E needs the declared runtime binaries, and the published scope needs its tarball fixture. Check the exact E2E scope and record its exit status instead of treating a missing prerequisite as an application failure.

### Stop returns a timeout or aggregate error

A timeout bounds the caller's cleanup wait. It does not prove that a native resource stopped, and sibling Servers stop concurrently. Inspect the primary error, adapter terminal barrier, and residual process or socket evidence before calling the shutdown clean.

### Cache data disappeared

`@go-like/cache-memory` is process-local and disposable. Use an explicit Store provider for authoritative records, and document its actual durability and ownership rather than treating a Cache as a database.

## Boundary recap

This project teaches a real path through go-like while staying small:

```text
Request
  -> standard Fetch Handler
  -> Context-first appointment use case
  -> typed Client call
  -> Memory Transport
  -> unary Server policy handler
  -> canonical appointment repository
  -> disposable availability Cache
  -> Response

App.stop()
  -> deregistration if configured
  -> concurrent Server stop
  -> explicit Client / provider cleanup
  -> terminal result
```

It does not teach gRPC, Protobuf, IDL generation, internal full-duplex streams, distributed locking, durable messaging, or production authentication. Those are separate design decisions outside this small project.
