import type {
  OtelAlreadyStartedError,
  OtelContextManagerMissingError,
  OtelShutdownTimeoutError
} from "./types"

/** Second start, or a start after stop, while the provider is no longer idle. */
export function otelAlreadyStarted(
  status: OtelAlreadyStartedError["status"]
): OtelAlreadyStartedError {
  return Object.freeze(
    Object.assign(new Error("OpenTelemetry provider already started"), {
      name: "OtelAlreadyStartedError" as const,
      code: "GO_LIKE_OTEL_ALREADY_STARTED" as const,
      status
    })
  )
}

/** Owner wait failed. The native shutdown is still running. */
export function shutdownExceeded(timeoutMs: number): OtelShutdownTimeoutError {
  return Object.freeze(
    Object.assign(new Error(`OpenTelemetry shutdown exceeded ${timeoutMs} ms`), {
      name: "OtelShutdownTimeoutError" as const,
      code: "GO_LIKE_OTEL_SHUTDOWN_TIMEOUT" as const,
      timeoutMs
    })
  )
}

/** Construction required a ContextManager and `context.with` was a no-op. */
export function otelContextManagerMissing(): OtelContextManagerMissingError {
  return Object.freeze(
    Object.assign(
      new TypeError(
        "an OpenTelemetry ContextManager must be registered before newOtelTracerProvider"
      ),
      {
        name: "OtelContextManagerMissingError" as const,
        code: "GO_LIKE_OTEL_CONTEXT_MANAGER_MISSING" as const
      }
    )
  )
}
