# Terminology

This glossary keeps the English source precise and gives translators a stable semantic base. API identifiers, package names, route tokens, header names, commands, URLs, versions, and code remain unchanged in localized documentation.

## Core terms

| Term                   | Meaning in go-like                                                                                                                             | Do not use it to mean                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Context**            | Explicit operation scope carrying deadline, cancellation result, cause, and values; passed first to blocking work                              | Dependency-injection bag, ambient request state, Go ABI, or a goroutine/channel     |
| **App**                | One-shot coordinator for startup, registration, hooks, Server stop calls, terminal joins, and lifecycle errors                                 | Global service container or process supervisor for resources it was never given     |
| **Server**             | Structural `start(ctx)` / `stop(ctx)` lifecycle boundary                                                                                       | Automatically a Web server, readiness signal, or reverse-order dependency scheduler |
| **Handler**            | Standard Web `(Request) => Response \| Promise<Response>` function, or the separate internal `(Context, Message)` unary handler when qualified | A universal router handler or a listener by itself                                  |
| **owner**              | Component responsible for admitting a resource and actually requesting/observing its cleanup                                                   | Any caller that merely waits for an operation                                       |
| **admission**          | Point at which a resource has been accepted into a lifecycle and its owner is responsible for stopping it                                      | A health check or proof of production readiness                                     |
| **terminal**           | Provider or resource fact that the native operation has finished                                                                               | A caller timeout or an unresolved Promise that was abandoned                        |
| **caller wait**        | The time a caller is willing to await a result, often bounded by Context                                                                       | Cancellation of the underlying owner operation                                      |
| **unary**              | One request Message followed by one response Message                                                                                           | One-way delivery, streaming, or full duplex                                         |
| **Message**            | Internal headers plus a `Uint8Array` body at the Transport boundary                                                                            | A Fetch Request or a generated Protobuf message                                     |
| **Endpoint**           | Named typed operation with service, endpoint, request Struct, and response Struct                                                              | Network address, IDL, generated stub, or a Registry endpoint URL                    |
| **operation identity** | Canonical `service/endpoint`, such as `orders/Orders.Get`                                                                                      | Hostname, port, or transport URL                                                    |
| **transport address**  | Opaque destination passed to `Transport.dial`, such as `memory://orders` or `https://orders.example`                                           | Operation name or inferred protocol contract                                        |

## Control-plane and data-plane terms

| Term                             | Meaning in go-like                                                                           | Do not collapse it into                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Registry**                     | Contract for registering and reading service instance reachability                           | Durable business Store or global service locator                                   |
| **Registrar**                    | Registration and deregistration interface                                                    | Discovery watcher or health probe                                                  |
| **Discovery**                    | Reads and watches complete service-instance snapshots                                        | Registry backend protocol or selector policy                                       |
| **Watcher**                      | Owns a stream of complete replacement snapshots and a stop operation                         | Add/remove patch event stream                                                      |
| **authoritative empty snapshot** | Snapshot that says the service currently has no endpoints; selection fails closed            | A transient watcher outage that should retain stale endpoints forever              |
| **Selector**                     | Chooses one `ServiceEndpoint` and receives explicit synchronous feedback                     | Circuit breaker, retry policy, Registry, or load balancer with universal semantics |
| **Filter**                       | Pure ordered transformation of a discovered `ServiceInstance[]` snapshot                     | A security authorization check or endpoint health probe                            |
| **ServiceInstance**              | Service identity plus version, metadata, and transport URLs                                  | A single operation or a database record                                            |
| **selection feedback**           | Outcome facts sent to a Selector after the selected attempt                                  | Resource ownership transfer or an asynchronous settlement protocol                 |
| **Config**                       | Immutable merged source snapshots, validation, reload, and accepted source watcher lifecycle | Ambient environment variable lookup or a transaction across resources              |
| **last-good snapshot**           | Most recent accepted Config publication retained across a recoverable reload failure         | A claim that every backend read is current                                         |
| **Store**                        | Context-first byte records with revision, CAS, TTL, and pagination options                   | Database, ORM, Cache, or Event Store                                               |
| **Cache**                        | Disposable values with optional TTL that can be recomputed                                   | Authoritative state, durable record, lock, or CAS store                            |
| **Broker**                       | Topic-based byte publish/subscribe while preserving native delivery identity                 | BullMQ queue, Event Store, or universal settlement API                             |
| **Event**                        | Optional typed Codec projection over Broker bytes                                            | Durable event history, replay, or schema registry                                  |
| **native delivery**              | Provider object retained as `event.native`, such as `Msg` or `JsMsg`                         | An object go-like can safely acknowledge with one common method                    |
| **liveness**                     | Whether the process is alive enough for the platform's liveness policy                       | Readiness to receive traffic                                                       |
| **readiness**                    | Whether the service should receive traffic now                                               | Proof that all external dependencies are permanently healthy                       |
| **provider**                     | Backend implementation of a narrow contract                                                  | All lifecycle wrappers or one universal adapter bucket                             |
| **lifecycle adapter**            | Server wrapper around an application-created native resource                                 | Replacement for the native library's API                                           |

## Runtime and security terms

| Term                       | Meaning in go-like                                                                  | Required qualification                                                                |
| -------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **portable**               | Shared code uses standard Web/ECMAScript APIs or injected capabilities              | Not proof that every runtime can bind sockets, watch files, use UDP, or configure TLS |
| **Fetch Handler**          | Standard one-argument `Request` to `Response` function                              | A Handler still needs a host/listener                                                 |
| **`/node` subpath**        | Explicit runtime-specific entrypoint with Node capabilities                         | Do not infer Deno support from the root package                                       |
| **standard Web streaming** | Request/Response bodies and Web Streams, including framework SSE/WebSocket behavior | Not internal full-duplex RPC streaming                                                |
| **TLS**                    | Transport encryption and peer certificate verification at the host/provider layer   | Not application authentication or authorization                                       |
| **mTLS**                   | TLS configuration requiring a verified client certificate                           | Not automatic mapping from certificate to user, tenant, or role                       |
| **metadata**               | Immutable transport/application key-value data with explicit propagation rules      | Trusted identity, claims, or automatic downstream forwarding                          |
| **replay authorization**   | Caller declaration that a bounded retry may repeat an operation                     | Proof of business idempotency, deduplication, or exactly-once effects                 |
| **redaction**              | Policy that avoids emitting secrets or payloads in a log/trace/health surface       | Constraint on application-owned native logger or exporter code                        |

## Recommended English phrasing

Use these forms consistently:

- “internal unary call” rather than “RPC” when discussing the current go-like Client/Transport contract;
- “complete replacement snapshot” rather than “watch event” for the public Registry watcher result;
- “opaque transport address” rather than “endpoint” when referring to a network URL;
- “caller-wait boundary” rather than “force timeout” unless a provider exposes a real force operation;
- “explicit replay authorization” rather than “automatic retry safety”;
- “application-owned provider” when the application created the native connection, Registry, logger, or telemetry provider;
- “declared E2E lane” when a script exists but its current result has not been run;
- “baseline audit reported” when referring to supplied historical/local command evidence;
- “not established by this audit” for npm, hosted CI, production, published consumer, Docker, cross-runtime, or soak claims that were not executed.

## Prohibited shortcuts

Do not call go-like:

- a Go-compatible framework;
- an all-in-one microservice framework;
- a universal RPC stack;
- a Protobuf or IDL replacement;
- a database, ORM, Event Store, or queue abstraction;
- a global DI container or service locator;
- an automatic authentication or authorization system;
- a universal streaming framework;
- a production guarantee based only on source, package count, or version.

## Translation parity rules

The localized trees should preserve:

1. every package name, public function, type, route token, header, command, URL, version, and numeric limit exactly;
2. the distinction between `Registry` and `Discovery`, `Store` and `Cache`, `Broker` and `Event`, and `provider` and `lifecycle adapter`;
3. the negative boundary around gRPC, Protobuf, IDL, full-duplex RPC, global auth, and automatic instrumentation;
4. the evidence label attached to claims;
5. the difference between a source contract, a declared test, a passing command, and an unresolved evidence gap.

For right-to-left pages, isolate code, URLs, `service/endpoint`, `Go-Like-Metadata`, shell commands, and version strings in code spans or fenced code blocks. Do not translate or reorder those identifiers.
