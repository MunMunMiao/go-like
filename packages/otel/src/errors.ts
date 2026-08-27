import type { OtelAlreadyStartedError, OtelShutdownTimeoutError } from "./types"

export type OtelServerState = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed"

const alreadyStartedName: OtelAlreadyStartedError["name"] = "OtelAlreadyStartedError"
const alreadyStartedCode: OtelAlreadyStartedError["code"] = "GO_LIKE_OTEL_ALREADY_STARTED"
const shutdownTimeoutName: OtelShutdownTimeoutError["name"] = "OtelShutdownTimeoutError"
const shutdownTimeoutCode: OtelShutdownTimeoutError["code"] = "GO_LIKE_OTEL_SHUTDOWN_TIMEOUT"

/** Builds the immutable error returned by every attempt to restart one server. */
export function newOtelAlreadyStartedError(
  status: Exclude<OtelServerState, "idle">
): OtelAlreadyStartedError {
  return Object.freeze(
    Object.assign(new Error("OpenTelemetry server has already started"), {
      name: alreadyStartedName,
      code: alreadyStartedCode,
      status
    })
  )
}

/** Builds the immutable error for an exceeded owner shutdown wait. */
export function newOtelShutdownTimeoutError(timeoutMs: number): OtelShutdownTimeoutError {
  return Object.freeze(
    Object.assign(new Error(`OpenTelemetry provider shutdown exceeded ${timeoutMs}ms`), {
      name: shutdownTimeoutName,
      code: shutdownTimeoutCode,
      timeoutMs
    })
  )
}

/** Preserves native Error identity and normalizes non-Error lifecycle rejections. */
export function normalizeOtelError(operation: string, value: unknown): Error {
  if (value instanceof Error) return value
  return Object.freeze(
    new Error(`OpenTelemetry ${operation} rejected with a non-Error value`, { cause: value })
  )
}
