# HTTP and Buf gRPC Transport Alignment Implementation Plan

> Implementation record: this plan describes the original transport integration work. Its task list and
> commands do not establish current runtime success. The API is present in the checkout; current
> Connect/Bun/Deno limitations are recorded in the [package README](../../../packages/transport/grpc-buf/README.md)
> and [claim ledger](../../../doc/reference/claims.md). Do not repeat completed implementation tasks from this checklist.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Every behavior change follows superpowers:test-driven-development: add one focused failing test, record the expected RED failure, then write the minimum implementation and record GREEN.

**Goal:** Give HTTP/internal unary and Buf-backed standard gRPC the approved Kratos-style `newClient -> newXClient(client)` and `newServer -> registerXHandler(server, implementation)` workflow with direct, multi-address, and Discovery routing.

**Architecture:** Keep protocol owners honest. The common unary Client/Server continue to use the existing LikeGo Transport SPI; the Buf package wraps official Connect-ES HTTP/2 client/server primitives and does not implement the gRPC protocol. Both clients share the existing resident Discovery resolver and Registry Selector contract, while HTTP Struct registration and protobuf service registration use different narrow registrar types.

**Tech Stack:** TypeScript 7, Bun 1.4 package/build runner, Node 26, Deno 2.9, `@bufbuild/protobuf` 2.14.0, `@connectrpc/connect` 2.1.2, `@connectrpc/connect-node` 2.1.2, `@connectrpc/connect-web` 2.1.2.

**Spec:** `docs/superpowers/specs/2026-08-30-http-grpc-transport-alignment-design.md`

## Global Constraints

- Public terminology is `client`, `server`, `handler`, and `implementation`; do not introduce `conn`, `connection`, `newClientTransport`, or `newServiceTransport` in developer-facing examples or generated signatures.
- Generated calls are exactly `newXClient(client)` and `registerXHandler(server, handler)`.
- `handler(...)` is removed from `@go-like/server`; no deprecated alias remains.
- `withAddress(...addresses)` is construction-time only; no per-call address or service override remains.
- Direct and Discovery addresses use the same `Selector`; no second load-balancing API or watcher implementation is added.
- Struct HTTP/internal unary and protobuf gRPC share workflow only; do not coerce either wire ABI into the other.
- Buf/Connect packages own protobuf encoding, routing, framing, streams, trailers, and HTTP/2 protocol behavior.
- Buf online services, remote plugins, Google gRPC runtime, health, reflection, validation, and canonical error mapping remain out of scope.
- The package root is portable and must not resolve `@connectrpc/connect-node` or `node:*`; managed standard-gRPC owners live only at the capability subpath `/native`, with the same public API on Node, Bun, and Deno. Runtime-specific socket, TLS, and HTTP/2 types stay private.
- Node is upstream-supported by Connect-ES; Bun and Deno are pinned LikeGo compatibility targets proven by continuing interoperability tests.
- Every official Core `Endpointer` reports a synchronous protocol discriminator. Core rejects distinct protocols in one Registry `ServiceInstance`; HTTP/internal and standard gRPC use separate App service identities.
- Cross-publisher protocol-name collisions are unsupported configuration in the first release; clients assume each Discovery snapshot is homogeneous and do not add a Registry protocol field or filter.
- New and generated async signatures use native `Promise` and do not expose broad structural thenable declarations.
- Preserve all pre-existing dirty-worktree changes and generated fixtures. Do not stage, commit, push, publish, deploy, or delete user work.
- Because commits are not authorized, the controller captures before/after task snapshots in the SDD workspace and gives every reviewer a task-scoped diff package.
- Every RED and GREEN step records the command, exit code, relevant diagnostic or pass count, and the production change that makes the test fail in that task's report before the next step begins.

---

### Task 1: Publish the existing Discovery resolver for both client owners

**Files:**

- Modify: `packages/client/package.json`
- Modify: `tsconfig.base.json`
- Read without modifying: `packages/client/src/resolver.ts`
- Create: `packages/client/src/discovery.ts`
- Create: `packages/client/test/discovery-public-types.ts`
- Modify: `packages/client/test/client.test.ts`

**Interfaces:**

- Produces: `@go-like/client/discovery` exporting `DiscoveryResolver` and `newDiscoveryResolver(discovery)`.
- Preserves: the existing watcher cache, snapshot replacement, retry, block, Context cancellation, and idempotent close behavior.

- [ ] **Step 1: Write focused public-subpath and behavior tests**

Add a compile-time consumer importing only:

```ts
import {
  newDiscoveryResolver,
  type DiscoveryResolver
} from "@go-like/client/discovery"
```

In `client.test.ts`, retain the existing real fake-Discovery tests and add one assertion that two calls for the same service reuse one watcher and `close(ctx)` stops it once.

- [ ] **Step 2: Run RED**

Run:

```bash
bun run --cwd packages/client typecheck
bun run --cwd packages/client test:unit
```

Expected RED: the `@go-like/client/discovery` export is unresolved. Record the exact diagnostic in the task report.

- [ ] **Step 3: Add the smallest supported subpath**

Create `src/discovery.ts` as a re-export only:

```ts
export { newDiscoveryResolver } from "./resolver"
export type { DiscoveryResolver } from "./resolver"
```

Add `"./discovery": "./src/discovery.ts"` to package exports and the matching `@go-like/client/discovery` TypeScript path mapping. Do not move the resolver into Registry and do not duplicate its implementation.

- [ ] **Step 4: Run GREEN and regression checks**

Run the two Task 1 commands again; expected exit 0. Also run `git diff --check`.

---

### Task 2: Move common Client addressing to construction time

**Files:**

- Modify: `packages/client/src/index.ts`
- Modify: `packages/client/test/client.test.ts`
- Modify: `packages/client/test/public-types.ts`

**Interfaces:**

- Consumes: Task 1 `newDiscoveryResolver` behavior unchanged.
- Produces:

```ts
export function withAddress(...addresses: readonly string[]): ClientOption
export function withService(service: string): ClientOption
```

- `ClientOptions` gains immutable `addresses` and `service`; `CallOptions.address` is deleted.

- [ ] **Step 1: Write RED contract tests**

Add focused tests for:

1. `newClient(withTransport(transport), withAddress("memory://a"))` calls `memory://a` without a call option.
2. `withAddress("memory://a", "memory://b")` feeds both addresses to an injected Selector and honors its selection.
3. Default round robin alternates two direct addresses.
4. `withAddress(...)` plus `withDiscovery(...)` throws at `newClient()`.
5. Discovery without `withService(...)` throws at `newClient()`.
6. `withService(...)` without Discovery throws at `newClient()`.
7. Missing both direct addresses and Discovery throws at `newClient()`.
8. Empty and duplicate direct addresses throw before dialing.
9. `withAddress(...)` is assignable to `ClientOption` and not assignable to `CallOption` in `public-types.ts`.

Use real selector return values and real fake transports; do not assert only that a mock was called.

- [ ] **Step 2: Run RED**

Run:

```bash
bun run --cwd packages/client test:unit
bun run --cwd packages/client typecheck
```

Expected RED: construction options/types do not exist and calls without per-call addresses fail.

- [ ] **Step 3: Implement immutable construction options**

Add fields to the existing option snapshot and every option reducer:

```ts
readonly addresses: readonly string[]
readonly service: string | null
```

Implement `withAddress(...addresses)` and `withService(service)` as `ClientOption`s. Normalize through existing well-formed string validation, copy and freeze values, reject empty input and duplicates.

At `newClient()`, validate exactly one source:

```text
direct: addresses.length > 0, discovery === null, service === null
discovery: addresses.length === 0, discovery !== null, service !== null
```

Create the default round-robin Selector for either source. During a direct attempt, create immutable synthetic `ServiceInstance` values from the configured addresses and the logical request service, then use the same `select()` validation and `SelectionDone` path as Discovery. Remove the direct bypass branch.

Delete `CallOptions.address`, the per-call `withAddress`, and every reducer copy of that field. Keep per-call filters/retry only.

- [ ] **Step 4: Run GREEN**

Run Task 2 tests and typecheck; expected exit 0. Run `git diff --check`.

---

### Task 3: Replace HTTP/internal unary `handler(...)` with pre-start registration

**Files:**

- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/test/server.test.ts`
- Modify: `packages/server/test/http-route.test.ts`
- Modify: `packages/server/test/public-types.ts`
- Modify: `packages/server/test/public-api.test.ts`
- Modify: `packages/core/src/app.ts`
- Modify: `packages/core/README.md`
- Modify: `packages/core/test/app.test.ts`
- Modify: `packages/core/test/public-types.ts`
- Modify: `packages/web/src/node-server.ts`
- Modify: `packages/web/test/node/host.test.ts`
- Modify: `packages/web/test/node/public-types.ts`

**Interfaces:**

- Produces:

```ts
export interface HandlerRegistrar {
  registerHandler<Request extends Struct, Response extends Struct>(
    endpoint: Endpoint<Request, Response>,
    handler: TypedHandler<Request, Response>
  ): void
  registerHandler(service: string, endpoint: string, handler: Handler): void
}
```

- `Server extends CoreServer, Endpointer, HandlerRegistrar` and reports the selected Transport `kind()` through `protocol()`.
- `Endpointer` requires `protocol(): string`; Core rejects more than one protocol before Registry publication.
- Deletes the exported lower-case `handler` option and `ServerOptions.handlers`.

- [ ] **Step 1: Write RED lifecycle and registration tests**

Add focused tests proving:

1. Construct with no handler, register typed endpoint, then serve successfully.
2. Construct with no handler and call `endpoint()`; it rejects before fake Transport `listen()` is invoked.
3. Direct `start()` on an empty Server rejects before `listen()`.
4. Duplicate typed and raw service/endpoint registration throws synchronously.
5. Registration after the first `endpoint()` call throws synchronously, even while bind is pending.
6. Registration after `start()` throws synchronously.
7. A failed bind does not reopen registration.
8. An `httpRoute(...)` targeting a missing registration rejects before `listen()`.
9. Concurrent `endpoint()` / `start()` uses one dispatcher and one bind.
10. A class-backed handler keeps its `this` receiver when registered through service glue.
11. A Registry App with HTTP and gRPC Endpointers rejects before `Registrar.register()`; two Endpointers reporting the same protocol publish normally.
12. Invalid empty protocol values reject before `Registrar.register()`.
13. Explicit App endpoints do not bypass the guard: mixed Endpointers plus `endpoint(...)` still reject with zero Registrar calls, while same-protocol Endpointers plus explicit endpoints remain valid.
14. Common `Server.protocol()` throws deterministic `TypeError` when the selected Transport omits `kind()` or returns an empty value.
15. Middleware composition failure is cached; repeated lifecycle calls rethrow the same failure without composing again or binding.

- [ ] **Step 2: Run RED**

Run:

```bash
bun run --cwd packages/server test:unit
bun run --cwd packages/server typecheck
bun run --cwd packages/core test:unit
bun run --cwd packages/core typecheck
bun run --cwd packages/web test:unit
bun run --cwd packages/web typecheck
```

Expected RED: `registerHandler` does not exist and empty construction currently throws too early.

- [ ] **Step 3: Implement the synchronous registrar and seal**

Keep a private mutable registration map in `newServer()`. Add overloaded `registerHandler` using the existing raw validation and typed adapter. Remove handler maps from construction option snapshots.

Add one synchronous `seal()` called before the first asynchronous boundary in both `endpoint()` and `start()`:

```ts
function seal(): AcceptHandler {
  if (sealedDispatcher !== null) return sealedDispatcher
  if (sealFailure !== null) throw sealFailure
  sealed = true
  try {
    if (registrations.size === 0) {
      throw new TypeError("server requires at least one registered handler")
    }
    // validate every httpRoute target
    sealedDispatcher = dispatcher(
      registrations,
      options.middleware,
      options.operationMiddleware,
      options.httpRoutes
    )
    return sealedDispatcher
  } catch (error) {
    sealFailure = error
    throw error
  }
}
```

Set `sealed = true` before validation so a failure cannot reopen registration. Cache either the one composed dispatcher or the exact seal failure; a later lifecycle call must not bypass validation or rerun user middleware composition. Keep the returned Server frozen; only the private map mutates before seal.

Delete `handler(...)` and remove `handlers` from `ServerOptions`. Expose `registerHandler` on the returned Server object.

Extend Core `Endpointer` with `protocol(): string`. At the beginning of `buildInstance()`, synchronously and unconditionally enumerate every configured object exposing `endpoint()`, require and call `protocol()`, then reject a missing/empty value or a second distinct value. Only after that preflight may the existing `currentEndpoints.length === 0` branch call asynchronous `endpoint(ctx)` methods. This order applies even when explicit App endpoints already exist and must complete before `Registrar.register()`. An explicit-only App with no Endpointer remains caller-trusted. The common Server delegates to the already-selected Transport `kind()` and throws `TypeError` when it is missing or empty. Do not infer from or encode the discriminator into advertised URLs or Registry metadata.

Add `protocol(): "http"` to the real `@go-like/web/node` Endpointer and focused runtime/type assertions. Core invokes structural `protocol` and `endpoint` methods with `.call(subject)` to preserve receivers. The Consul E2E Endpointer proxy is migrated in Task 4 with the remaining workspace consumers.

- [ ] **Step 4: Run GREEN**

Run all six Task 3 package commands plus `git diff --check`; expected exit 0.

---

### Task 4: Migrate existing common Client and Server consumers

**Files:**

- Modify: every tracked TypeScript consumer returned by:

```bash
rg -l 'withAddress\(' packages examples e2e test scripts --glob '*.ts' --glob '!**/.artifacts/**'
rg -l 'handler\(' packages examples e2e test scripts --glob '*.ts' --glob '!**/.artifacts/**'
```

- Modify: canonical Markdown examples under `README.md`, `doc/`, `docs/`, and package READMEs that show either removed API.

**Interfaces:**

- Consumes: Task 2 construction-time addressing and Task 3 `registerHandler`.
- Produces: no new API.

- [ ] **Step 1: Capture the complete migration list**

Write exact file lists and match counts to the task report before edits. Exclude generated `dist` and `.artifacts`; regenerate them through package build commands instead of hand editing.

- [ ] **Step 2: Migrate direct calls mechanically**

Move each direct address from:

```ts
const client = newClient(withTransport(transport))
await client.call(ctx, request, withAddress(address))
```

to:

```ts
const client = newClient(withTransport(transport), withAddress(address))
await client.call(ctx, request)
```

If one owner previously called several temporary addresses, create one owner per stable address set or one explicit multi-address owner; do not emulate the removed per-call override.

Replace each construction-time server handler option with a registration statement after construction:

```ts
const server = newServer(/* construction options */)
server.registerHandler(endpoint, implementation)
```

Application-facing examples with a named service must use a local `registerXHandler(server, implementation)` wrapper.

Update every official/custom `Endpointer` implementation and type fixture to return one stable non-empty `protocol()` value. Do not derive it from the advertised URL; common transport-backed servers reuse their Transport `kind()`.

- [ ] **Step 3: Run migration gates**

Run:

```bash
bun run --cwd packages/client test:unit
bun run --cwd packages/server test:unit
bun run --cwd packages/transport/http test:unit
bun run typecheck
rg -n 'withAddress\([^)]*\)' packages examples e2e test scripts --glob '*.ts' --glob '!**/.artifacts/**'
rg -n 'import .*\bhandler\b.*@go-like/server' packages examples e2e test scripts --glob '*.ts'
```

The first four commands exit 0. Remaining `withAddress` matches are construction options only; the named `handler` import search returns no matches.

---

### Task 4A: Complete named HTTP client glue

**Files:**

- Modify: the five named HTTP/internal service modules and their composition roots/tests:
  - `examples/bank-transfer-gateway/src/transport.ts`
  - `examples/healthcare-appointments/src/transport.ts`
  - `examples/telecom-service-provisioning/src/transport.ts`
  - `examples/commerce-catalog/src/pricing.ts`
  - `examples/enterprise-platform-runtime/src/echo.ts`
- Modify only the direct consumers/tests required to use those factories.

**Interfaces:**

- Produces one handwritten `newXClient(client)` for every named HTTP/internal service already exposing `registerXHandler(server, handler)`.
- The factory parameter and construction owner are named `client`; no `conn`, `connection`, `newClientTransport`, or call-time address override is introduced.
- Keeps the common `@go-like/client` Client generic; service glue remains outside framework packages.

- [ ] **Step 1: Add exact RED coverage**

Add focused behavioral/type coverage showing each factory delegates its typed method to the supplied common Client and preserves Context, request encoding, call options, response decoding, and errors.

- [ ] **Step 2: Replace direct generic calls at named service boundaries**

Use this workflow in every composition root:

```ts
const client = newClient(/* construction options */)
const service = newXClient(client)
```

Do not add an HTTP code generator, shared glue abstraction, or compatibility alias. HTTP and gRPC share the workflow, not their registrar/client ABI.

- [ ] **Step 3: Run affected example suites and workspace typecheck**

Run every affected example unit/typecheck gate plus the common Client/Server/HTTP suites and `git diff --check`. The source search for named services calling `client.call(...)` outside their `newXClient(client)` factory returns no matches.

---

### Task 5: Move the Buf package and freeze generated registrar/client names

**Files:**

- Move source package: `packages/grpc-buf` -> `packages/transport/grpc-buf`
- Modify: `packages/transport/grpc-buf/package.json`
- Modify: `packages/transport/grpc-buf/src/handler.ts`
- Modify: `packages/transport/grpc-buf/src/context.ts`
- Modify: `packages/transport/grpc-buf/src/index.ts`
- Modify: `packages/transport/grpc-buf/test/context.test.ts`
- Modify: `packages/protoc-gen-like/src/index.ts`
- Modify: `packages/protoc-gen-like/test/generator.test.ts`
- Modify: root `package.json`, `bun.lock`, `tsconfig.base.json`, `tsconfig.test.json`
- Modify: protobuf fixtures and package-resolution tests that name `@go-like/grpc-buf`

**Interfaces:**

- Produces package `@go-like/transport-grpc-buf` at `packages/transport/grpc-buf`.
- Produces `ServiceRegistrar = Pick<ConnectRouter, "service">`.
- Produces generated `registerXHandler(server, handler)` and `newXClient(client)` using local `stub`.
- Keeps the package root portable; it contains no static import or re-export of `@connectrpc/connect-node` or `node:*`.
- Carries the original Like Context through one private Connect `ContextKey` without replacing caller-owned `contextValues`.

- [ ] **Step 1: Write RED generator and package API tests**

Update generator snapshot expectations to the exact public shapes:

```ts
import type { ServiceRegistrar } from "@go-like/transport-grpc-buf"

export function registerOrderServiceHandler(
  server: ServiceRegistrar,
  handler: OrderServiceHandler
): void

export function newOrderServiceClient(
  client: ConnectTransport
): OrderServiceClient
```

Assert generated code imports the one canonical `ServiceRegistrar` from `@go-like/transport-grpc-buf`, calls `server.service(...)`, declares `const stub = createClient(OrderService, client)`, and delegates through `stub`. The generated file must not declare another registrar type and must not retain a `ConnectRouter` import. Update package public API/type tests to import the same runtime-package type.

Before the move, add the Context RED test at `packages/grpc-buf/test/context.test.ts`; it moves with the package during implementation. Prove `callOptions(ctx, overrides)` preserves an unrelated caller Connect value while making the original Like Context readable by the package-private carrier. The private key/helper must not be exported from the package root.

- [ ] **Step 2: Run RED**

Run:

```bash
bun run --cwd packages/protoc-gen-like test:unit
bun run --cwd packages/protoc-gen-like typecheck
bun run --cwd packages/grpc-buf test:unit
bun run --cwd packages/grpc-buf typecheck
```

Expected RED: snapshots still use `router` / `transport`, the new package/type path is unresolved, and the private Context carrier assertion fails. Record each independent failure before implementation.

- [ ] **Step 3: Move and minimally rename**

Relocate source/test/config files with history-preserving moves; do not carry `dist` or `.artifacts` as source changes. Rename package metadata and all workspace references.

In grpc-buf, export:

```ts
export type ServiceRegistrar = Pick<ConnectRouter, "service">
export type Routes = (server: ServiceRegistrar) => void
```

`newHandler(routes)` creates the upstream router internally and passes it structurally to `routes`. Generated `*_like.ts` imports `ServiceRegistrar` from this package; it never copies the type. Update generator imports and emitted parameter/local names only; do not add networking to generated code.

Implement the Context carrier as a private module contract used later by `/native`. Overlay caller `ContextValues` instead of mutating it; because upstream `ContextValues` has no iterator, use the smallest delegating wrapper with one local key and fallback `get`/`set`/`delete` behavior. Preserve metadata, signal, and timeout mapping already owned by `callOptions()`.

- [ ] **Step 4: Run GREEN**

Run protoc generator unit/typecheck, `bun run proto:generate`, protobuf fixture typecheck/test, grpc-buf unit/typecheck, and `git diff --check`; expected exit 0.

---

### Task 6: Add the managed standard-gRPC Client owner

**Files:**

- Create: `packages/transport/grpc-buf/src/client.ts`
- Create: `packages/transport/grpc-buf/src/options.ts`
- Create: `packages/transport/grpc-buf/src/native.ts`
- Modify: `packages/transport/grpc-buf/package.json`
- Create: `packages/transport/grpc-buf/test/client.test.ts`
- Modify: `packages/transport/grpc-buf/test/public-api.test.ts`
- Modify: `packages/transport/grpc-buf/test/public-types.ts`

**Interfaces:**

- Consumes: `@go-like/client/discovery`, `Discovery`, `Selector`, `TLSConfig`, and official `Http2SessionManager` / `createGrpcTransport`.
- Produces only from `@go-like/transport-grpc-buf/native`:

```ts
export interface Client extends ConnectTransport {
  close(ctx: Context): Promise<void>
}

export function newClient(...options: readonly ClientOption[]): Client
export function withAddress(...addresses: readonly string[]): ClientOption
export function withService(service: string): ClientOption
export function withDiscovery(discovery: Discovery): ClientOption
export function withSelector(selector: Selector): ClientOption
export function withBlock(): ClientOption
export function withTLSConfig(config: TLSConfig | null): ClientOption
```

- [ ] **Step 1: Write RED Client tests**

Use injectable private factories in tests only where native networking is unavoidable. Cover observable behavior:

1. One direct address delegates unary and streaming calls to an upstream gRPC Transport.
2. Two direct addresses use one Selector.
3. Discovery requires `withService`; direct/Discovery conflict fails before creating a session.
4. Concurrent calls to the same address create one session manager.
5. Different selected addresses create one manager each.
6. Unary feedback runs once on resolve/reject.
7. Streaming feedback does not run when `stream()` returns; it runs once on iterable completion, throw, cancellation, and `return()`.
8. `close(ctx)` aborts every manager and closes the resolver once; repeated close is idempotent and calls after close reject.
9. TLS material is defensively copied; missing certificate/key pair and non-PEM material fail before connection I/O.
10. Blocking Discovery observes cancellation from the original Like Context carried by `callOptions()`.
11. A Selector reads a custom Like Context value; a raw upstream Connect caller without the private carrier gets a signal/timeout-derived fallback Context.
12. Native URLs are canonical absolute root `http:` / `https:` URLs; credentials, query, fragment, and non-root paths reject before manager creation, and equivalent URLs share one manager.
13. A canceled `close(ctx)` stops only that caller's wait; cleanup continues, active wrappers settle once, and no manager can be resurrected.
14. Calling `return()` or `throw()` on the raw response iterator before its first `next()` aborts the upstream call signal, publishes feedback once, and lets `close()` complete.
15. A deterministic request/abort race that makes the official manager internally retry closes the late stream, re-aborts the manager to a terminal state, and continues cleanup after an expired close waiter.
16. Close racing asynchronous Discovery/selection cannot create or retrieve an address owner after the terminal state begins.

- [ ] **Step 2: Run RED**

Run grpc-buf unit/typecheck. Expected RED: managed Client exports are absent.

- [ ] **Step 3: Implement the smallest owner**

Export `./native` from package metadata and from `src/native.ts`; do not re-export it from the portable `src/index.ts`. Snapshot Go-style functional options. Use the same direct/discovery validation as Task 2. On each `unary` or `stream`, recover the carried Like Context or construct the explicit raw-client fallback, resolve instances, select one canonical URL, and lazily memoize:

```ts
interface AddressOwner {
  readonly manager: Http2SessionManager
  readonly transport: ConnectTransport
}
```

Create exactly one `Http2SessionManager(address, sessionOptions, tlsOptions)` for each selected address, then pass a private terminal structural adapter around it to official `createGrpcTransport({ baseUrl: address, sessionManager: adapter })`. This adapter is not another pool. Its `request()` rejects after terminal close, tracks every admitted inner `manager.request()` until settlement, and re-aborts the official manager after late fulfillment or rejection. On late fulfillment it also closes/resets the returned stream before rejecting with the owner-close reason. Cleanup drains those acquisitions independently of any caller wait. Recheck terminal owner state after asynchronous Discovery/selection and before address-owner retrieval/creation.

Give every streaming call a private AbortController and link its signal with caller and owner signals before invoking upstream. Replace only the returned `StreamResponse.message` with an explicit AsyncIterator wrapper whose `next`, `return`, and `throw` paths share one idempotent completion function. `return()` and `throw()` first abort the per-call controller, delegate an upstream method only if present, then finish feedback; repeated or concurrent terminals cannot publish twice. Do not use only an async generator: `return()` before the first `next()` skips its body and `finally`. Owner close aborts the linked signal and completes every admitted wrapper. Preserve every other upstream response field. At the generated `createClient()` boundary, follow Connect-ES's signal-cancellation model rather than forking its promise client; generated server/bidi callers cancel their Like Context when stopping early.

- [ ] **Step 4: Run GREEN**

Run grpc-buf unit/typecheck and `git diff --check`; expected exit 0.

---

### Task 7: Add the managed standard-gRPC Server owner

**Files:**

- Create: `packages/transport/grpc-buf/src/server.ts`
- Extend: `packages/transport/grpc-buf/src/options.ts`
- Modify: `packages/transport/grpc-buf/src/native.ts`
- Create: `packages/transport/grpc-buf/test/server.test.ts`
- Modify: `packages/transport/grpc-buf/test/public-api.test.ts`
- Modify: `packages/transport/grpc-buf/test/public-types.ts`

**Interfaces:**

- Produces:

```ts
export interface Server extends CoreServer, Endpointer, ServiceRegistrar {}
export function newServer(...options: readonly ServerOption[]): Server
export function address(value: string): ServerOption
export function advertise(value: string): ServerOption
export function tlsConfig(value: TLSConfig | null): ServerOption
export function clientAuth(value: "none" | "require"): ServerOption
```

- [ ] **Step 1: Write RED Server tests**

Cover:

1. `newServer()` defaults to `127.0.0.1:0`.
2. `registerXHandler(server, implementation)` followed by `endpoint()` binds once and returns `http://host:port`.
3. `endpoint()` and `start()` share one bind.
4. Empty, duplicate, and late service registration fails before native `listen()`.
5. Failed bind does not reopen registration.
6. `stop(ctx)` is idempotent and waits for native close.
7. TLS returns `https://`; required client auth requires a CA and key/certificate pair.
8. The official adapter receives the sealed routes; tests assert service behavior, not only callback invocation.
9. A wildcard bind requires non-wildcard `advertise(...)`; a host-only advertise retains the actual ephemeral port.
10. h2c rejects TLS or client-auth options; TLS requires a PEM certificate/key pair; `clientAuth("require")` also requires a PEM CA; DER and server-side `serverName` reject before I/O.
11. `protocol()` returns `"grpc"` while `endpoint()` remains directly dialable `http://` / `https://`.
12. Stop first rejects new admission, drains active streams, then force-closes remaining sessions when the stop Context expires; owner shutdown continues after that caller stops waiting.
13. A manual service registration with a non-empty interceptor option still produces only `grpc` handlers; Connect and gRPC-Web remain disabled.
14. Frozen public Server option snapshots remain unchanged while adapter creation succeeds with a fresh mutable adapter-call object.

- [ ] **Step 2: Run RED**

Run grpc-buf unit/typecheck. Expected RED: managed Server exports are absent.

- [ ] **Step 3: Implement lifecycle around official adapters**

Store service registrations synchronously until the first `endpoint()` or `start()`, then seal before any `await`. Use the exact upstream generic method type and a private closure list:

```ts
interface RouteRegistration {
  readonly typeName: string
  apply(server: ConnectRouter): void
}

const registrations: RouteRegistration[] = []
const registeredTypeNames = new Set<string>()
let sealed = false
let grpcServer!: Server

const service: ConnectRouter["service"] = function registerService(
  descriptor,
  implementation,
  options
) {
  if (sealed) throw new TypeError("gRPC server registration is sealed")
  if (registeredTypeNames.has(descriptor.typeName)) {
    throw new TypeError(`gRPC service already registered: ${descriptor.typeName}`)
  }
  registeredTypeNames.add(descriptor.typeName)
  registrations.push(Object.freeze({
    typeName: descriptor.typeName,
    apply(server): void {
      server.service(descriptor, implementation, {
        ...options,
        grpc: true,
        grpcWeb: false,
        connect: false
      })
    }
  }))
  return grpcServer
}
```

Do not erase the signature to `any`, `unknown[]`, or a Struct `HandlerRegistrar`. Connect 2.1.2 re-enables all protocols whenever `service(...)` receives any options object, so the private registration closure must spread caller options first and then force `grpc: true`, `grpcWeb: false`, and `connect: false`. Keep these version-pinned flags private; they are not part of LikeGo's public `ServiceRegistrar`. At seal, snapshot the registrations and build one `Routes` callback that applies them in declaration order to the `ConnectRouter` supplied by `connectNodeAdapter({ routes, grpc: true, connect: false, grpcWeb: false })`. The object passed to `connectNodeAdapter()` must be a fresh mutable object because Connect Node installs its default `acceptCompression` field in place; do not pass a frozen public option snapshot. Then create one `node:http2` server: `createServer` for h2c or `createSecureServer` for TLS/mTLS.

The native Context bridge remains generated glue, not Server code: Connect Node creates the same upstream `HandlerContext` used by the portable router, and each generated method adapter calls the existing `fromHandlerContext(context)` before invoking the ctx-first implementation. Add a real native request assertion that Like metadata, cancellation, and deadline reach the implementation through this path.

Keep native server/session types private. Track every HTTP/2 session from the native server's `session` event. Normal stop calls `server.close()` and `session.close()` to stop new streams while draining admitted work. Only the forced/deadline path aborts the adapter shutdown signal and calls `session.destroy()` on remaining sessions; a session admitted during the close race is closed immediately. Reuse the existing Core `waitForContext` helper to bound bind/close callers without transferring ownership. Publish only directly dialable `http://` / `https://` endpoints. Reuse the common Server's wildcard/advertise rules instead of inventing another interpretation.

- [ ] **Step 4: Run GREEN**

Run grpc-buf unit/typecheck and `git diff --check`; expected exit 0.

---

### Task 8: Prove portable and standard-gRPC runtime interoperability

**Files:**

- Modify: `packages/transport/grpc-buf/test/e2e/portable-runtime.ts`
- Create: `packages/transport/grpc-buf/test/e2e/native-runtime.ts`
- Create: `packages/transport/grpc-buf/test/e2e/native-harness.ts`
- Modify: `packages/transport/grpc-buf/package.json`
- Modify: `e2e/definitions.ts`
- Modify: staged package consumer fixtures and scripts

**Interfaces:**

- Consumes: Tasks 5-7 package, generated glue, managed Client/Server.
- Produces: reproducible Node/Bun/Deno and independent-client evidence.

- [ ] **Step 1: Extend the real protobuf fixture**

Use the existing Order service's unary, server-streaming, client-streaming, and bidi methods. The native runtime script starts the managed Server, registers one implementation, calls it through the managed Client, then closes both owners and prints one deterministic JSON result.

- [ ] **Step 2: Run RED**

Run the new script under Bun first. Expected RED: native Client/Server package entry or E2E script is missing until Tasks 6-7 are integrated.

- [ ] **Step 3: Add cross-runtime and independent-client harness**

Run the same compiled JavaScript under:

```bash
bun .../native-runtime.js
node .../native-runtime.js
deno run --allow-net --allow-read .../native-runtime.js
```

Add TLS and mTLS fixtures generated into a temporary test directory, never committed keys. Run every runtime as server and call it with a separate upstream `createGrpcTransport()` client that does not call or import the managed `newClient`. Verify all four cardinalities and close the server before deleting the temporary directory.

For every pinned runtime server configured with `clientAuth("require")`, run three upstream-client cases against the same handler counter: a trusted client certificate/key succeeds; no client certificate is rejected with zero handler calls; a client certificate signed by an untrusted CA is rejected with zero handler calls. A generic application rejection does not count as mTLS evidence.

Also call every runtime server with `buf curl --protocol grpc`; this is the independent implementation gate. The separate upstream `createGrpcTransport()` client remains a useful cross-call but is not counted as independent interoperability evidence. Add an active bidi close case and expired client/server close-wait cases.

Using generated `newXClient(client)` plus `withCancel(...)`, prove on Node, Bun, and Deno that early stop of both server-streaming and bidi cancels the Like Context, the next read rejects as canceled, the server observes cancellation, selection feedback completes once, and Client close settles. Do not add `return()` / `throw()` to generated types or fork Connect's promise client.

Build or import the staged portable root in a browser/Edge-targeted smoke fixture and fail if it resolves `node:*`. Prove separate `orders-http` and `orders-grpc` Registry identities route to the intended clients, and prove a single App containing both protocol markers rejects before publication.

Retain the Fetch portable unary/server-streaming test and its explicit request-streaming rejection boundary.

- [ ] **Step 4: Run GREEN**

Run grpc-buf portable/native E2E scripts plus staged-tarball Node consumer. Record versions and exact pass matrix in the report. Run `git diff --check`.

---

### Task 9: Canonical documentation, package build, and full verification

**Files:**

- Modify: root `README.md`
- Modify: `doc/reference/packages.md`
- Modify: `doc/reference/providers.md`
- Modify: `doc/guide/comparison.md`
- Modify: `docs/developer-experience-alignment.md`
- Modify: `packages/client/README.md`
- Modify: `packages/server/README.md`
- Modify: `packages/transport/http/README.md`
- Modify: `packages/transport/grpc-buf/README.md`
- Modify: exact package claims and staged release fixtures affected by the rename

**Interfaces:**

- Produces no new runtime API; documents only behavior proven by Tasks 1-8.

- [ ] **Step 1: Update canonical examples**

Show exactly the direct single, direct multi, Discovery, server registration, portable Fetch, and managed gRPC examples from the spec. Use `client` for the owner and generated factory argument. Do not claim browser standard gRPC, cross-runtime upstream support, mTLS, health, reflection, or full streaming beyond the tests actually run.

Show generated streaming early-stop with `const [ctx, cancel] = withCancel(parent)`, cancellation before `break`, and an idempotent `finally { cancel() }`. Do not imply that breaking a Connect-generated server/bidi iterable calls raw iterator `return()`.

- [ ] **Step 2: Build every changed package**

Run builds for Registry dependencies if changed, Client, Server, HTTP transport, protoc-gen-like, and transport-grpc-buf. Inspect generated `dist/package.json` names/exports.

- [ ] **Step 3: Run full gates**

Run:

```bash
bun run verify
git diff --check
git status --short --branch
```

Expected: `bun run verify` and `git diff --check` exit 0. Status contains only the approved existing protobuf work plus this plan's changes; nothing is staged.

- [ ] **Step 4: Run final source-boundary searches**

Run:

```bash
rg -n '@go-like/grpc-buf|packages/grpc-buf' \
  README.md doc docs packages examples e2e test scripts package.json bun.lock \
  tsconfig.base.json tsconfig.test.json \
  --glob '!docs/superpowers/**' --glob '!dist/**' --glob '!**/.artifacts/**'
rg -n 'import .*\bhandler\b.*@go-like/server' packages examples e2e test scripts --glob '*.ts'
rg -n 'call\([^\n]*withAddress\(' packages examples e2e test scripts --glob '*.ts'
rg -n '\b(conn|connection)\b' packages/protoc-gen-like packages/transport/grpc-buf \
  --glob '*.ts' --glob '*.md'
rg -n '@connectrpc/connect-node|node:' packages/transport/grpc-buf/src/index.ts \
  packages/transport/grpc-buf/src/handler.ts packages/transport/grpc-buf/src/context.ts
```

The scoped stale-name search, the next two removed-API searches, and the portable-root Node dependency search return no stale runtime, lockfile, metadata, fixture, or canonical-documentation references. Historical design/plan evidence under `docs/superpowers` is intentionally excluded. The `conn|connection` search may match factual internal connection/session documentation, but generated signatures and developer examples use `client`.

- [ ] **Step 5: Final review handoff**

The controller generates a whole-change review package from the SDD before/after snapshots and dispatches the final Linus/code-quality review. Do not commit or push; report verified commands, residual baseline warnings, and any explicit rulings.
