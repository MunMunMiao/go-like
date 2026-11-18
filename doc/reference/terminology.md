# Terminology

This glossary is the English source for translators. API identifiers, package names, route tokens, header names, commands, URLs, versions, and code stay unchanged in localized pages.

## Core terms

| Term                   | Meaning in go-like                                                                                                                      | Do not use it to mean                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Socket**             | A structural contract core declares and a plug implements, such as `Server`, `LogHandler`, `Registry`, `Store`, `Broker`, or `JobQueue` | A TCP socket, or a wrapper around a core function                                            |
| **Plug**               | A package that fills one or more sockets with an ecosystem client the application constructed                                           | A second framework, or a global registration                                                 |
| **Context**            | Explicit operation scope: deadline, cancellation, cause, and values. Passed first                                                       | A dependency-injection bag, ambient request state, or a Go `context.Context`                 |
| **App**                | One-shot coordinator for the telemetry, resource, and server tiers                                                                      | A global container or a supervisor for objects it was never given                            |
| **Tier**               | Telemetry, resources, or servers. Order and budgets are fixed by the App                                                                | A dependency graph or a user-defined shutdown priority                                       |
| **Server**             | Structural `start(ctx)` / `stop(ctx)`                                                                                                   | Automatically a Web server, a readiness signal, or a reverse-order scheduler of its siblings |
| **Resource**           | A `Server` in `resources(...)` whose `start` resolves when the object is usable                                                         | A long-running listener. Those belong in `server(...)`                                       |
| **Handler**            | Standard Web `(Request) => Response \| Promise<Response>`, or the internal `(Context, Request) => Response` when the sentence says so   | A router, or a listener by itself                                                            |
| **Owner**              | The component that admits a resource and is the one caller of its drain                                                                 | Any caller that only waits                                                                   |
| **Admission**          | The point at which `start` has resolved and the App owns `stop`                                                                         | A health check or a production-readiness proof                                               |
| **Terminal**           | The native operation has finished                                                                                                       | A caller timeout, or a Promise that was abandoned                                            |
| **Caller wait**        | How long a caller awaits, often bounded by Context or `stopTimeout`                                                                     | Cancellation of the owner operation                                                          |
| **Endpoint**           | A named typed operation: service, endpoint, request Struct, response Struct                                                             | A network address or a registry URL                                                          |
| **Operation identity** | `service/endpoint`, such as `appointment-policy.v1/check`                                                                               | A host, port, or URL                                                                         |
| **Transport address**  | Opaque destination, such as `memory://orders` or `https://orders.example`                                                               | The operation name                                                                           |

## Control plane and data plane

| Term                             | Meaning                                                                       | Do not collapse it into                            |
| -------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------- |
| **Registry**                     | Register and read instance reachability                                       | A business store or a service locator              |
| **Registrar**                    | Register and deregister                                                       | A discovery watcher                                |
| **Discovery**                    | Read and watch complete instance snapshots                                    | A selector policy                                  |
| **Watcher**                      | A stream of complete replacement snapshots, plus stop                         | An add/remove event stream                         |
| **Authoritative empty snapshot** | The service currently has no endpoints. Selection fails closed                | A reason to keep the previous snapshot forever     |
| **Selector**                     | Chooses one endpoint and receives synchronous feedback                        | A circuit breaker or a universal load balancer     |
| **Filter**                       | A pure ordered transformation of a snapshot                                   | An authorization check                             |
| **Config**                       | Immutable merged snapshots, validation, reload, last-good publication         | Ambient environment lookup                         |
| **Last-good snapshot**           | The last accepted config publication kept across a recoverable reload failure | A claim that every backend read is current         |
| **Store**                        | Context-first byte records with revision, CAS, TTL, and pages                 | A database, an ORM, a cache, or an event store     |
| **Cache**                        | Disposable values with optional TTL                                           | Authoritative state                                |
| **Broker**                       | Topic bytes, with native delivery identity preserved                          | A job queue or a universal ack API                 |
| **Event**                        | A codec over broker bytes (`eventBroker`)                                     | History, replay, or a schema registry              |
| **Job**                          | A `Schedule` timetable or a `JobQueue`                                        | A broker subscription                              |
| **Native delivery**              | The provider object on `event.native`                                         | An object core can acknowledge with one method     |
| **Liveness**                     | Whether the process should be considered alive                                | Readiness for traffic                              |
| **Readiness**                    | Whether traffic should be admitted now                                        | Proof that every dependency is permanently healthy |
| **Provider**                     | A plug's implementation of one socket                                         | Every lifecycle wrapper                            |

## Runtime and security

| Term                       | Meaning                                                           | Qualification                                                          |
| -------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Portable**               | Standard Web or ECMAScript APIs, or an injected capability        | Not proof of a TCP listener, file watch, UDP, or TLS on every runtime  |
| **`/node` subpath**        | An explicit Node entry                                            | Not implied by the package root                                        |
| **Standard Web streaming** | Fetch bodies and Web Streams                                      | Not an internal SSE call or bidi RPC                                   |
| **TLS / mTLS**             | Transport peer verification at the host or plug                   | Not application authentication or a mapping from certificate to user   |
| **Metadata**               | Immutable key-value data with explicit propagation                | Not trusted identity, and not forwarded unless the handler forwards it |
| **Replay authorization**   | The caller declared that a bounded retry may repeat the operation | Not proof of idempotency                                               |
| **Redaction**              | The native logger or exporter omits secrets and payloads          | Core completion records already omit error text                        |

## Phrasing

- "internal unary call" for the core Client and Transport contract;
- "complete replacement snapshot" for a registry watch result;
- "opaque transport address" for a network URL;
- "caller-wait boundary" for `stopTimeout` and a plug drain timeout;
- "application-owned provider" when the application created the connection, registry, or logger;
- "declared lane" when a script exists and its result has not been recorded for this tree;
- "baseline audit reported" for the historical command evidence on this site.

Do not call go-like a Go-compatible framework, an all-in-one microservice framework, a universal RPC stack, a database, a global DI container, an authentication system, or a production guarantee based on package count or version `0.0.1`.

## Translation parity

Localized trees keep:

1. every package name, function, type, route, header, command, URL, version, and numeric limit;
2. the distinctions among Registry and Discovery, Store and Cache, Broker and Event, socket and plug, resource tier and server tier;
3. the portable Connect Fetch boundary, the managed gRPC `./node` boundary, and the exclusions for browser standard gRPC and Fetch bidi;
4. the evidence label on a claim;
5. the difference between a source contract, a declared test, a passing command, and a gap.

For right-to-left pages, isolate code, URLs, `service/endpoint`, shell commands, and versions in code spans. Do not translate those identifiers.
