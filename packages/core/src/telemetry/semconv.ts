/**
 * OpenTelemetry semantic-convention version these names were checked against.
 * A rename is a breaking change of core.
 */
export const SemconvVersion = "1.45.0"

/**
 * Attribute keys shared by spans, metrics, and logs.
 * `rpc.status_code` follows `rpc.system.name`: `go_like` uses a ServiceError code or `"ok"`;
 * `grpc` and `connectrpc` use the canonical upper-case gRPC status name.
 * `go_like.server.index` is the index within one lifecycle tier.
 */
export const AttributeKey = {
  errorType: "error.type",
  serviceName: "service.name",
  serviceVersion: "service.version",
  serviceInstanceId: "service.instance.id",
  rpcSystemName: "rpc.system.name",
  rpcMethod: "rpc.method",
  rpcStatusCode: "rpc.status_code",
  httpRequestMethod: "http.request.method",
  httpResponseStatusCode: "http.response.status_code",
  urlScheme: "url.scheme",
  messagingSystemName: "messaging.system.name",
  messagingOperationName: "messaging.operation.name",
  messagingOperationType: "messaging.operation.type",
  messagingDestinationName: "messaging.destination.name",
  messagingDestinationTemplate: "messaging.destination.template",
  messagingMessageBodySize: "messaging.message.body.size",
  operation: "go_like.operation",
  outcome: "go_like.outcome",
  durationMs: "go_like.duration_ms",
  rpcStream: "go_like.rpc.stream",
  rpcStreamMessages: "go_like.rpc.stream.messages",
  rpcStreamHandshakeMs: "go_like.rpc.stream.handshake_ms",
  rpcStreamStatus: "go_like.rpc.stream.status",
  rpcDirection: "go_like.rpc.direction",
  jobName: "go_like.job.name",
  jobTrigger: "go_like.job.trigger",
  jobSystem: "go_like.job.system",
  jobQueue: "go_like.job.queue",
  jobId: "go_like.job.id",
  jobAttempt: "go_like.job.attempt",
  appStopReason: "go_like.app.stop.reason",
  serverIndex: "go_like.server.index",
  /** Which App tier a lifecycle event belongs to. */
  lifecycleTier: "go_like.lifecycle.tier",
  registryService: "go_like.registry.service",
  registryInstances: "go_like.registry.instances",
  retryAttempt: "go_like.retry.attempt",
  retryDelayMs: "go_like.retry.delay_ms",
  circuitBreakerName: "go_like.circuit_breaker.name",
  circuitBreakerState: "go_like.circuit_breaker.state"
} as const

/** Closed attribute values owned by core. */
export const SemconvValue = {
  other: "_OTHER",
  rpcSystemGoLike: "go_like",
  /** Stable `rpc.system.name` value in semantic conventions 1.45.0. */
  rpcSystemGrpc: "grpc",
  /** Experimental `rpc.system.name` value in semantic conventions 1.45.0. */
  rpcSystemConnectrpc: "connectrpc",
  rpcStatusOk: "ok",
  errorCanceled: "canceled",
  errorDeadlineExceeded: "deadline_exceeded",
  errorStreamTruncated: "stream_truncated",
  messagingOperationTypeSend: "send",
  messagingOperationTypeProcess: "process",
  messagingOperationNamePublish: "publish",
  messagingOperationNameProcess: "process",
  jobTriggerSchedule: "schedule",
  jobTriggerQueue: "queue",
  directionSent: "sent",
  directionReceived: "received",
  outcomeSuccess: "success",
  outcomeCallerFault: "caller_fault",
  outcomeCanceled: "canceled",
  outcomeFailure: "failure",
  lifecycleTierTelemetry: "telemetry",
  lifecycleTierResource: "resource",
  lifecycleTierServer: "server"
} as const

/** Metric names core records, pinned to semantic conventions 1.45.0 where the name is upstream. */
export const MetricName = {
  rpcServerCallDuration: "rpc.server.call.duration",
  rpcClientCallDuration: "rpc.client.call.duration",
  rpcStreamMessages: "go_like.rpc.stream.messages",
  httpServerRequestDuration: "http.server.request.duration",
  httpServerActiveRequests: "http.server.active_requests",
  messagingClientOperationDuration: "messaging.client.operation.duration",
  messagingProcessDuration: "messaging.process.duration",
  jobRunDuration: "go_like.job.run.duration",
  appReady: "go_like.app.ready",
  configReloads: "go_like.config.reloads",
  registryWatchUpdates: "go_like.registry.watch.updates",
  retryAttempts: "go_like.retry.attempts",
  circuitBreakerTransitions: "go_like.circuit_breaker.transitions",
  rateLimitRejections: "go_like.rate_limit.rejections"
} as const

/** `event.name` values core writes on log records. */
export const LogEvent = {
  rpcServerCompleted: "go_like.rpc.server.completed",
  rpcClientCompleted: "go_like.rpc.client.completed",
  httpServerCompleted: "go_like.http.server.completed",
  messagingPublishCompleted: "go_like.messaging.publish.completed",
  messagingProcessCompleted: "go_like.messaging.process.completed",
  jobRunCompleted: "go_like.job.run.completed",
  jobEnqueueCompleted: "go_like.job.enqueue.completed",
  appStarted: "go_like.app.started",
  appReady: "go_like.app.ready",
  appStopping: "go_like.app.stopping",
  appStopped: "go_like.app.stopped",
  serverFailed: "go_like.server.failed",
  configLoaded: "go_like.config.loaded",
  configReloaded: "go_like.config.reloaded",
  configReloadFailed: "go_like.config.reload_failed",
  configTerminal: "go_like.config.terminal",
  registryRegistered: "go_like.registry.registered",
  registryDeregistered: "go_like.registry.deregistered",
  registryWatchUpdated: "go_like.registry.watch.updated",
  registryWatchFailed: "go_like.registry.watch.failed",
  registryHeartbeatFailed: "go_like.registry.heartbeat_failed",
  retryScheduled: "go_like.retry.scheduled",
  circuitBreakerTransition: "go_like.circuit_breaker.transition",
  rateLimitRejected: "go_like.rate_limit.rejected",
  transportHandlerRejected: "go_like.transport.handler_rejected",
  transportCleanupFailed: "go_like.transport.cleanup_failed",
  webHostClientAborted: "go_like.web.host.client_aborted",
  webHostResponseFailed: "go_like.web.host.response_failed",
  instrumentFailed: "go_like.telemetry.instrument_failed"
} as const

/** Span event names core writes. */
export const SpanEvent = {
  retry: "go_like.retry",
  circuitBreakerTransition: "go_like.circuit_breaker.transition",
  rateLimited: "go_like.rate_limited",
  serverFailed: "go_like.server.failed"
} as const

/** Field names every log plug writes. Diagnostic events carry the local Error under `exception`. */
export const LogField = {
  traceId: "trace_id",
  spanId: "span_id",
  traceFlags: "trace_flags",
  event: "event.name",
  exception: "exception"
} as const
