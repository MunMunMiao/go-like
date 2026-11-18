# Error handling

Match Context sentinels by identity, service failures with `isServiceError`, and framework or plug failures by a documented `code`. A message is diagnostic text. Several failures retained together are an `AggregateError`.

## Match in this order

```ts
import { canceled, deadlineExceeded } from "@go-like/core/context"
import { isServiceError } from "@go-like/core/transport"

if (error === canceled || error === deadlineExceeded) {
  // Context termination. cause(ctx) is an application-supplied cancel cause.
} else if (isServiceError(error)) {
  // Application service failure. code, status, and metadata are the service contract.
} else if (error instanceof AggregateError) {
  // Inspect error.errors in order, including nested aggregates.
} else if (typeof error === "object" && error !== null && "code" in error) {
  // Match one code from this page.
} else {
  // Classify by the documented boundary, or propagate the value unchanged.
}
```

Do not branch on `error.message`. Do not use `instanceof` for plug errors: a different realm or package copy will not share the class. `StructError` is the exception that also offers `isStructError` from `@go-like/core/struct`, because it is a real class with `code` `GO_LIKE_STRUCT_INVALID`.

`ServiceError.code` is not a `GO_LIKE_*` code. Call `isServiceError` before reading it. `circuitOpen` from `@go-like/core/resilience` is a sentinel with no `GO_LIKE_*` code.

`TypeError` and `RangeError` are programmer errors at the boundary that threw them. An unclassified failure is propagated. Retry is a separate decision, described below.

## Retry and reconcile

| Failure                                                                              | Policy                                                                                                            |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| State, already started, unsupported capability, validation, authentication, protocol | Do not retry. Fix the order, input, capability, credentials, or payload.                                          |
| Transport or HTTP availability                                                       | Retry only when the operation is replayable and a policy authorizes it. Bound the attempts.                       |
| Uncertain mutation, lease loss, cleanup after commit                                 | Reconcile. `GO_LIKE_ETCD_STORE_CLEANUP` means the write committed.                                                |
| Conflict, compacted revision, expired snapshot, no endpoint                          | Refresh the revision, cursor, snapshot, or discovery view. Do not send the same request again unchanged.          |
| Shutdown timeout or unexpected terminal                                              | Do not restart the same one-shot owner. Observe the native terminal, then construct a new owner if policy allows. |

An HTTP status does not by itself make a write safe to replay.

## Aggregates, cause, and redaction

Inspect every `AggregateError.errors` entry. Order is defined only where a package says so: one failure is thrown as itself, and App stop aggregates in phase order with telemetry last.

`Error.cause` is local. Core completion logs, span attributes, and metric labels do not carry message, stack, or cause. Diagnostic events may attach the local `Error` as `LogField.exception`. Pino maps that to `err` and serializes it. Winston maps it to `error`, and `format.json()` alone turns an `Error` into `{}` unless a format expands it. See [Health and observability](/guide/health-observability).

Consul, etcd, Vault, and Kubernetes transport errors replace the foreign rejection when the client holds a secret. Do not assume every plug preserves `cause`.

## Core

| Code                                       | Entry                              | Meaning                                                                                                               |
| ------------------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `GO_LIKE_APP_NOT_READY`                    | `@go-like/core` `AppNotReadyError` | `readyProbe` ran outside the ready window. `phase` is `created`, `starting`, `stopping`, or `stopped`.                |
| `GO_LIKE_RESOURCE_ALREADY_STARTED`         | `@go-like/core/lifecycle`          | Second `start` on a `newResourceServer`.                                                                              |
| `GO_LIKE_RESOURCE_CLOSED`                  | `@go-like/core/lifecycle`          | The resource terminal resolved cleanly before stop.                                                                   |
| `GO_LIKE_TELEMETRY_ALREADY_STARTED`        | `@go-like/core/telemetry`          | `start` after a successful start, or after a stop that ran before start.                                              |
| `GO_LIKE_STRUCT_INVALID`                   | `@go-like/core/struct`             | Struct parse failed. Read `issues`.                                                                                   |
| `GO_LIKE_TRANSPORT_CLOSED`                 | `@go-like/core/transport`          | The transport owner is closed.                                                                                        |
| `GO_LIKE_TRANSPORT_STATE`                  | `@go-like/core/transport`          | The lifecycle transition is invalid.                                                                                  |
| `GO_LIKE_TRANSPORT_UNSUPPORTED_CAPABILITY` | `@go-like/core/transport`          | This transport cannot do what the option asked. `newHTTPTransport()` cannot listen.                                   |
| `GO_LIKE_TRANSPORT_PROTOCOL`               | `@go-like/core/transport`          | The request, response, metadata, or codec is invalid.                                                                 |
| `GO_LIKE_NODE_SERVER_ALREADY_STARTED`      | `@go-like/core/web/node`           | The Node host was started again. `status` is the lifecycle state.                                                     |
| `GO_LIKE_NODE_SERVER_FORCE_CLOSE`          | `@go-like/core/web/node`           | Drain exceeded its deadline. `timeoutMs` and `activeRequests` are the diagnostics.                                    |
| `GO_LIKE_NODE_SERVER_UNEXPECTED_CLOSE`     | `@go-like/core/web/node`           | The Node host closed outside owner stop.                                                                              |
| `GO_LIKE_BUN_SERVER_ALREADY_STARTED`       | `@go-like/core/web/bun`            | The Bun host was started again.                                                                                       |
| `GO_LIKE_BUN_SERVER_FORCE_CLOSE`           | `@go-like/core/web/bun`            | Drain exceeded its deadline. `activeRequests` counts in-flight requests.                                              |
| `GO_LIKE_CONFIG_ALREADY_LOADED`            | `@go-like/core/config`             | `load` after leaving idle. `status` is the lifecycle state.                                                           |
| `GO_LIKE_CONFIG_SOURCE`                    | `@go-like/core/config`             | A named source failed. `sourceName` and `phase` say which.                                                            |
| `GO_LIKE_CONFIG_SOURCE_MISSING`            | `@go-like/core/config`             | A required source document is absent.                                                                                 |
| `GO_LIKE_CONFIG_NOT_FOUND`                 | `@go-like/core/config`             | Config is not loaded, or the dotted key is absent.                                                                    |
| `GO_LIKE_CONFIG_VALIDATION`                | `@go-like/core/config`             | Schema issues, a throw, or an invalid result. `reason` is `issues`, `threw`, `malformed-result`, or `invalid-output`. |
| `GO_LIKE_REGISTRY_STATE`                   | `@go-like/core/registry`           | The operation is invalid in the current state.                                                                        |
| `GO_LIKE_WATCHER_STOPPED`                  | `@go-like/core/registry`           | `next` after stop.                                                                                                    |
| `GO_LIKE_WATCHER_OVERFLOW`                 | `@go-like/core/registry`           | The watch buffer dropped events. Rebuild from a full snapshot.                                                        |
| `GO_LIKE_REGISTRY_PROTOCOL`                | `@go-like/core/registry`           | A record is malformed or conflicts.                                                                                   |
| `GO_LIKE_UNSUPPORTED_REGISTRY_CAPABILITY`  | `@go-like/core/registry`           | The provider does not implement the request.                                                                          |
| `GO_LIKE_NO_AVAILABLE_ENDPOINT`            | `@go-like/core/registry`           | Discovery, filters, or selection produced no endpoint.                                                                |
| `GO_LIKE_STORE_CONFLICT`                   | `@go-like/core/store`              | `ifAbsent` or `ifRevision` did not match.                                                                             |
| `GO_LIKE_JOB_STATE`                        | `@go-like/core/job`                | The schedule, queue, or worker is in the wrong state.                                                                 |
| `GO_LIKE_JOB_DRAIN_TIMEOUT`                | `@go-like/core/job`                | The owner drain exceeded `drainTimeoutMs`. Active runs are canceled and still awaited.                                |
| `GO_LIKE_JOB_UNKNOWN_NAME`                 | `@go-like/core/job`                | The queue has no handler for that name.                                                                               |
| `GO_LIKE_JOB_PERMANENT`                    | `@go-like/core/job`                | `newPermanentJobError`. The queue must not retry it.                                                                  |

Context has no `GO_LIKE_*` code. Compare `canceled` and `deadlineExceeded`.

`GO_LIKE_CORE_DUPLICATE_INSTANCE` is thrown while a second copy of core is evaluated. The error type is not exported. The message includes both URLs and versions.

`GO_LIKE_BUN_SERVER_UNEXPECTED_CLOSE` is produced when the Bun host closes outside owner stop. The public Bun entry exports the already-started and force-close types. It does not export a named unexpected-close type.

`GO_LIKE_HTTP_TRANSPORT_UNEXPECTED_EXIT` exists on the HTTP transport implementation when a serve loop ends without an upstream error. The public `@go-like/core/transport/http` entry does not export that type. Do not branch on it as a stable import.

## Shared plug families

Consul, etcd, Vault, and Kubernetes each export one HTTP error, one transport error, and one protocol error from the package root. The `operation` field is prefixed by the socket (`registry.*`, `config.*`, `store.*`). Older per-socket codes such as separate config-only HTTP codes are not part of the public surface. A test that feeds one of those old literals is checking that the predicate rejects it.

| Root                  | Codes                                                                                    | Secret boundary                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `@go-like/consul`     | `GO_LIKE_CONSUL_HTTP`, `GO_LIKE_CONSUL_TRANSPORT`, `GO_LIKE_CONSUL_PROTOCOL`             | Token is omitted from the URL and the message. A secret-bearing transport failure replaces the foreign graph. |
| `@go-like/etcd`       | `GO_LIKE_ETCD_HTTP`, `GO_LIKE_ETCD_TRANSPORT`, `GO_LIKE_ETCD_PROTOCOL`                   | Status and operation only. Token and body are not retained.                                                   |
| `@go-like/vault`      | `GO_LIKE_VAULT_HTTP`, `GO_LIKE_VAULT_TRANSPORT`, `GO_LIKE_VAULT_PROTOCOL`                | Body, token, namespace, and secret data are not retained.                                                     |
| `@go-like/kubernetes` | `GO_LIKE_KUBERNETES_HTTP`, `GO_LIKE_KUBERNETES_TRANSPORT`, `GO_LIKE_KUBERNETES_PROTOCOL` | Token and response body are not public diagnostics.                                                           |

Socket-specific codes stay on the socket entry:

| Code                                           | Entry                         | Meaning                                                                                             |
| ---------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `GO_LIKE_CONSUL_STORE_UNCERTAIN`               | `@go-like/consul/store`       | Readback could not prove a write, delete, or session outcome.                                       |
| `GO_LIKE_CONSUL_STORE_UNSUPPORTED_COMBINATION` | `@go-like/consul/store`       | The TTL and CAS combination cannot be atomic. `combination` is `ttl-cas` or `cas-existing-ttl`.     |
| `GO_LIKE_ETCD_STORE_COMPACTED`                 | `@go-like/etcd/store`         | The list revision was compacted. Restart from the first page.                                       |
| `GO_LIKE_ETCD_STORE_LEASE_LOST`                | `@go-like/etcd/store`         | The TTL lease disappeared before commit.                                                            |
| `GO_LIKE_ETCD_STORE_UNCERTAIN`                 | `@go-like/etcd/store`         | Readback could not prove the write or delete.                                                       |
| `GO_LIKE_ETCD_STORE_CLEANUP`                   | `@go-like/etcd/store`         | The mutation committed and lease cleanup failed. `committed` is `true`. Do not replay the mutation. |
| `GO_LIKE_VAULT_STORE_UNCERTAIN`                | `@go-like/vault/store`        | Readback could not prove the write or delete.                                                       |
| `GO_LIKE_VAULT_STORE_SNAPSHOT`                 | `@go-like/vault/store`        | The process-local list cursor is invalid, expired, or over capacity.                                |
| `GO_LIKE_ZOOKEEPER_OPERATION`                  | `@go-like/zookeeper/registry` | A native operation failed. Retry only when the exported `retryable` field is true.                  |
| `GO_LIKE_ZOOKEEPER_AUTHENTICATION`             | `@go-like/zookeeper/registry` | Authentication failed terminally.                                                                   |
| `GO_LIKE_FILE_STORE_STATE`                     | `@go-like/file/store`         | The operation is outside the admitted lock lifecycle.                                               |
| `GO_LIKE_FILE_STORE_CORRUPTION`                | `@go-like/file/store`         | Encoding, JSON, schema, checksum, or record validation failed. Do not overwrite automatically.      |
| `GO_LIKE_FILE_STORE_LOCKED`                    | `@go-like/file/store`         | The directory lock is held, or a stale lock is not yet verified.                                    |
| `GO_LIKE_CACHE_REDIS_OPERATION`                | `@go-like/redis/cache`        | Connect, command, or close failed. Use the authoritative path.                                      |
| `GO_LIKE_CACHE_REDIS_PROTOCOL`                 | `@go-like/redis/cache`        | The value is not the cache carrier this plug writes.                                                |
| `GO_LIKE_NATS_CORE_UNEXPECTED_EXIT`            | `@go-like/nats/broker`        | The subscription closed before owner stop.                                                          |
| `GO_LIKE_NATS_CORE_DRAIN_TIMEOUT`              | `@go-like/nats/broker`        | Drain exceeded the boundary and unsubscribe was requested. `forced` is `true`.                      |
| `GO_LIKE_NATS_JETSTREAM_UNEXPECTED_EXIT`       | `@go-like/nats/jetstream`     | The consumer closed before owner stop.                                                              |
| `GO_LIKE_NATS_JETSTREAM_CLOSE_TIMEOUT`         | `@go-like/nats/jetstream`     | Close exceeded the boundary and native stop was requested. `forced` is `true`.                      |
| `GO_LIKE_BULLMQ_UNEXPECTED_EXIT`               | `@go-like/bullmq/job`         | The Worker closed without a requested stop. `queueName` is set.                                     |

`GO_LIKE_CACHE_REDIS_STATE` is assigned inside the Redis cache for a private lifecycle rejection. It has no public structural type. Handle the cache operation through the public codes or as a generic failure.

## Telemetry plugs

| Code                                   | Entry                  | Meaning                                                                                           |
| -------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------- |
| `GO_LIKE_OTEL_ALREADY_STARTED`         | `@go-like/otel`        | The provider adapter was started again.                                                           |
| `GO_LIKE_OTEL_SHUTDOWN_TIMEOUT`        | `@go-like/otel`        | Shutdown exceeded `shutdownTimeoutMs`. The default is 25 seconds. `0` fails the wait immediately. |
| `GO_LIKE_OTEL_CONTEXT_MANAGER_MISSING` | `@go-like/otel`        | `requireContextManager` found no registered context manager.                                      |
| `GO_LIKE_PINO_ALREADY_STARTED`         | `@go-like/pino/log`    | The destination adapter was started again.                                                        |
| `GO_LIKE_PINO_DRAIN_TIMEOUT`           | `@go-like/pino/log`    | Drain exceeded its boundary.                                                                      |
| `GO_LIKE_PINO_DESTINATION_CLOSED`      | `@go-like/pino/log`    | The destination closed outside owner shutdown.                                                    |
| `GO_LIKE_WINSTON_ALREADY_STARTED`      | `@go-like/winston/log` | The logger adapter was started again.                                                             |
| `GO_LIKE_WINSTON_LOGGER_FINISHED`      | `@go-like/winston/log` | The logger reached `finish` before owner stop.                                                    |
| `GO_LIKE_WINSTON_LOGGER_CLOSED`        | `@go-like/winston/log` | The logger emitted `close` outside owner stop.                                                    |

YAML decode failures from `@go-like/yaml/config` are `TypeError`s with a fixed message. They are not `GO_LIKE_*` codes.
