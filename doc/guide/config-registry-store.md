# Configuration, registry, store, and cache

Configuration, service reachability, records, and acceleration all involve data, but their contracts answer different questions:

| Domain   | Question                                                    | go-like contract                                                         | Typical lifetime               |
| -------- | ----------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------ |
| Config   | What configuration snapshot should this process use?        | Immutable merged source snapshots, validation, reload, last-good value   | Process or deployment          |
| Registry | Which service instances can be reached now?                 | Registration, complete discovery snapshots, watchers, filters, selectors | Ephemeral control plane        |
| Store    | Which durable record exists at this key and revision?       | Read/write/delete/list, revision, CAS, TTL, cursor                       | Business or operational state  |
| Cache    | Can this disposable value accelerate an authoritative path? | Context-first get/put/delete, optional TTL                               | Disposable and reconstructible |

Do not replace one with another just because all four have a `get`-like operation. Their failure, consistency, and ownership promises are intentionally different.

## Config

The core Config API is built around explicit sources and immutable publications:

```ts
import { background } from "@go-like/context"
import { newConfig, objectSource, source } from "@go-like/config"

const config = newConfig(
  source(
    objectSource("defaults", {
      service: { name: "appointments", port: 3000 }
    })
  )
)

await config.load(background())
const serviceName = config.value("service.name").load()
await config.close(background())
```

Current public core functions include:

- `newConfig(...)` creates the lifecycle manager;
- `source(...)` captures an ordered source list;
- `objectSource(...)` creates an immutable in-memory source;
- `schema(...)` validates each publication through Standard Schema;
- `resolver(...)` transforms a complete merged source value before publication;
- `placeholderResolver()` resolves supported placeholders explicitly;
- `onReloadError(...)` observes recoverable background reload failures;
- `onTerminalError(...)` observes the first unrecoverable post-load watcher failure.

A Config object exposes `load(ctx)`, `scan(ctx, schema)`, `value(key)`, `watch(key, observer)`, and `close(ctx)`. It is not automatically a Core `Server`; compose `load` and `close` in application hooks or an explicit owner.

The environment and file subpaths are explicit:

```ts
import { envSource } from "@go-like/config/env"
import { fileSource, jsonFileDecoder } from "@go-like/config/file"
import { newNodeFileCapability } from "@go-like/config/node"
import { decodeYaml } from "@go-like/config/yaml"
```

`envSource(environment, options)` accepts an injected environment record. It does not read a runtime global. The `/node` subpath supplies Node file capabilities; importing it changes the runtime dependency graph.

External Config providers use separate packages:

- `@go-like/config-consul` with `consulSource(...)`;
- `@go-like/config-etcd` with `etcdSource(...)`;
- `@go-like/config-kubernetes` with `kubernetesSource(...)` for one namespaced ConfigMap or Secret key;
- `@go-like/config-vault` with `vaultSource(...)` for Vault KV v2.

These HTTP-backed providers use an injected Fetch capability and retain backend-specific watch and recovery semantics. Kubernetes resource versions and relists, etcd compaction recovery, Consul blocking queries, and Vault protocol errors are not interchangeable.

### Config rules

- A source snapshot is copied and frozen before publication.
- A reload failure can retain the last accepted value; use `onReloadError` to observe it.
- A terminal watcher failure is separate from a recoverable reload failure; use `onTerminalError` to connect it to application policy.
- A source name is a logical identity, not a backend URL.
- A Config watcher must be closed by its owner; `App.stop()` does not discover arbitrary Config instances.
- Do not claim that multiple ConfigMap or Secret keys form one cross-resource transaction.

## Registry and discovery

The Registry contract has separate registration and read/observe roles:

```ts
interface Registrar {
  register(ctx: Context, service: ServiceInstance): Promise<void>
  deregister(ctx: Context, service: ServiceInstance): Promise<void>
}

interface Discovery {
  getService(ctx: Context, name: string): Promise<readonly ServiceInstance[]>
  watch(ctx: Context, name: string): Promise<Watcher>
}
```

A `ServiceInstance` contains:

```ts
interface ServiceInstance {
  id: string
  name: string
  version: string
  metadata: Readonly<Record<string, string>>
  endpoints: readonly string[]
}
```

The public watcher contract returns complete replacement snapshots. Backend events may be add/remove notifications internally, but consumers must not assume a patch stream. An empty snapshot is meaningful: it says that the service currently has no endpoints, so selection fails closed.

A Core App can register the endpoints of its `Endpointer` Servers:

```ts
import { name, newApp, registrar, server } from "@go-like/core"

const app = newApp(name("pricing"), registrar(registry), server(pricingServer))
```

The App registers after starting and preparing endpoints, then deregisters before canceling the long-lived Server Context during stop. Provider leases, sessions, heartbeats, and registration-loss callbacks remain provider concerns.

Filters and selectors are separate from Registry storage:

```ts
import { newClient, withDiscovery, withFilter, withSelector, withTransport } from "@go-like/client"
import { filterLabel, filterVersion, newRoundRobinSelector } from "@go-like/registry"

const client = newClient(
  withTransport(transport),
  withDiscovery(discovery),
  withSelector(newRoundRobinSelector())
)

await client.call(
  ctx,
  operation,
  request,
  withFilter(filterVersion("v2"), filterLabel("zone", "a"))
)
```

Filters run in declaration order. A selector chooses one URL and returns a synchronous `SelectionDone` callback. P2C and EWMA use that feedback for endpoint-local health and load state; they are not substitutes for an operation-level circuit breaker.

## Registry providers

| Provider                       | Backend mechanism                             | Use it when                                                  | Boundary                                                                        |
| ------------------------------ | --------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `@go-like/registry-consul`     | Consul health and blocking-query model        | Consul is already the service control plane                  | TTL, health filtering, and blocking indexes remain Consul semantics             |
| `@go-like/registry-etcd`       | JSON gateway, leases, revisioned watch/relist | etcd is available through an HTTP gateway                    | Compaction, lease loss, and protocol conflicts are provider errors              |
| `@go-like/registry-kubernetes` | `discovery.k8s.io/v1` EndpointSlice           | The application should select EndpointSlice-backed instances | It is not Kubernetes Service DNS, a fabricated TTL, or a Deployment controller  |
| `@go-like/registry-mdns`       | Local multicast DNS and TTL cache             | Small local-network discovery                                | UDP capability is in `@go-like/registry-mdns/node`; there is no global revision |
| `@go-like/registry-zookeeper`  | Ephemeral znodes and native sessions          | ZooKeeper is the established control plane                   | The package explicitly does not support Deno                                    |

Providers fail closed on malformed managed records or identity conflicts. They should not silently choose an arbitrary endpoint when the backend has ambiguous ownership.

## Store

The Store contract is Context-first and revision-aware:

```ts
import { background } from "@go-like/context"
import { ifAbsent, ifRevision, prefix } from "@go-like/store"
import { newMemoryStore } from "@go-like/store-memory"

const store = newMemoryStore()
const created = await store.write(
  background(),
  { key: "appointment/appointment-1", value: new TextEncoder().encode("booked") },
  ifAbsent()
)

const current = await store.read(background(), "appointment/appointment-1")
await store.write(
  background(),
  {
    key: current?.key ?? "appointment/appointment-1",
    value: new TextEncoder().encode("cancelled")
  },
  ifRevision(created.revision)
)

const page = await store.list(background(), prefix("appointment/"))
```

The core options are:

- `expiresIn(ms)` for a record TTL where the provider supports it;
- `ifAbsent()` for create-only admission;
- `ifRevision(revision)` for compare-and-set writes and deletes;
- `prefix(value)`, `limit(count)`, and `cursor(value)` for ordered pages.

A Store record contains `key`, bytes, metadata, `revision`, and `expiresAt`. `StoreConflictError` preserves the expected and actual revisions. Use Store for authoritative records or checkpoints when its provider's guarantees match the application.

Providers include:

- `@go-like/store-memory`: process-local, immediately usable test state;
- `@go-like/store-file`: local file snapshots with single-owner lifecycle, using `@go-like/store-file/node` for the Node host;
- `@go-like/store-consul`: Consul KV-backed records with provider-specific unsupported combinations;
- `@go-like/store-etcd`: revision and lease-aware etcd gateway implementation;
- `@go-like/store-vault`: Vault KV v2 records without a promise of uniform Store TTL/CAS semantics.

The file Store is not a multi-process database. Vault Store is not a drop-in implementation of every Store option. Keep those limits in the provider documentation and deployment design.

## Cache

Cache is a disposable acceleration boundary:

```ts
import { expiresIn } from "@go-like/cache"
import { newMemoryCache } from "@go-like/cache-memory"

const cache = newMemoryCache()
const key = "availability/doctor-1"
const cached = await cache.get(ctx, key)
if (cached === null) {
  const authoritative = await appointmentRepository.readAvailability(ctx, "doctor-1")
  await cache.put(
    ctx,
    key,
    new TextEncoder().encode(JSON.stringify(authoritative)),
    expiresIn(30_000)
  )
}
```

The Cache contract exposes `get`, `put`, and `delete`. A miss, expiry, or cache error must fall back to the authoritative path when the business operation requires correctness. `@go-like/cache-memory` is process-local and does not persist on process exit. `@go-like/cache-redis` owns its native Redis integration boundary and has its own runtime and credential considerations.

## Provider and runtime decisions

Before adding a provider, write down:

1. Which package or subpath is imported?
2. Which backend and version are required?
3. Does the provider use injected Fetch, a Node-only capability, or a vendor client?
4. Who creates and closes the native connection, watcher, file handle, or session?
5. What happens on a watcher compaction, lease loss, malformed record, or ambiguous mutation?
6. Which test lane actually exercises it: source/unit, conformance, runtime, Docker provider, or published consumer?

The [Provider reference](/reference/providers) contains the fuller matrix. The [Verification reference](/reference/verification) distinguishes source evidence from commands that have run.
