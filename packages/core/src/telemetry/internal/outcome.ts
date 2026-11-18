import { canceled, deadlineExceeded, type Context } from "../../context/index"
import { isError } from "../../internal/errors"
import type { UnitResult } from "../provider"
import { SemconvValue } from "../semconv"

const errorTypePattern = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/
const upperCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/

/** Bounded `error.type`. Context sentinels win, then a ServiceError code, an uppercase code, and `Error.name`. */
export function errorType(value: unknown, ctx?: Context): string {
  if (value === canceled || contextError(ctx) === canceled) return SemconvValue.errorCanceled
  if (value === deadlineExceeded || contextError(ctx) === deadlineExceeded) {
    return SemconvValue.errorDeadlineExceeded
  }
  const serviceCode = serviceErrorCode(value)
  if (serviceCode !== null && errorTypePattern.test(serviceCode)) return serviceCode
  const code = readCode(value)
  if (code !== null && upperCodePattern.test(code)) return code
  if (isError(value) && errorTypePattern.test(value.name)) return value.name
  if (typeof value === "number" && Number.isInteger(value) && value >= 500 && value <= 599) {
    return String(value)
  }
  return SemconvValue.other
}

/**
 * Maps a go-like ServiceError onto a unit result.
 * Any other value becomes `rpc.status_code` `"internal"`.
 */
export function rpcFailure(value: unknown): UnitResult {
  const status = serviceErrorStatus(value)
  const code = serviceErrorCode(value)
  if (status === null || code === null) return { error: value, rpcStatusCode: "internal" }
  const result: UnitResult = {
    error: value,
    rpcStatusCode: code,
    callerFault: status < 500
  }
  return result
}

/** Outcome of one finished unit. Span status is never `"ok"`: core leaves success UNSET. */
export interface UnitClassification {
  readonly outcome: "success" | "caller_fault" | "canceled" | "failure"
  readonly errorType: string | null
  readonly spanStatus: "unset" | "error"
  readonly level: "debug" | "info" | "warn" | "error"
  readonly rpcStatusCode: string | null
}

/** Classifies a unit ending. Server-side caller faults stay UNSET; deadlines are failures. */
export function classifyUnit(
  kind: string,
  result: UnitResult | undefined,
  ctx: Context
): UnitClassification {
  const server = isServerKind(kind)
  const hasError = result !== undefined && Object.hasOwn(result, "error")
  const error = hasError ? result.error : undefined
  const httpStatus = result?.httpStatus
  const streamStatus = result?.stream?.status
  const sentinel = contextError(ctx)
  const callerFault =
    server &&
    (result?.callerFault === true ||
      (serviceErrorStatus(error) !== null && (serviceErrorStatus(error) as number) < 500) ||
      (!hasError &&
        error === undefined &&
        httpStatus !== undefined &&
        httpStatus >= 400 &&
        httpStatus < 500))

  if (sentinel === canceled || error === canceled || streamStatus === "canceled") {
    return {
      outcome: "canceled",
      errorType: SemconvValue.errorCanceled,
      spanStatus: "unset",
      level: canceledLevel(kind, server),
      rpcStatusCode: rpcStatus(kind, result, SemconvValue.errorCanceled)
    }
  }
  if (sentinel === deadlineExceeded || error === deadlineExceeded) {
    return {
      outcome: "failure",
      errorType: SemconvValue.errorDeadlineExceeded,
      spanStatus: "error",
      level: failureLevel(kind, server),
      rpcStatusCode: rpcStatus(kind, result, SemconvValue.errorDeadlineExceeded)
    }
  }
  if (callerFault) {
    const code = serviceErrorCode(error)
    return {
      outcome: "caller_fault",
      errorType: code !== null && errorTypePattern.test(code) ? code : null,
      spanStatus: "unset",
      level: "info",
      rpcStatusCode: rpcStatus(kind, result, code ?? SemconvValue.rpcStatusOk)
    }
  }
  if (
    hasError ||
    (httpStatus !== undefined && httpStatus >= 500) ||
    streamStatus === "error" ||
    streamStatus === "truncated"
  ) {
    const type =
      streamStatus === "truncated" && error === undefined
        ? SemconvValue.errorStreamTruncated
        : errorType(error === undefined ? httpStatus : error, ctx)
    return {
      outcome: "failure",
      errorType: type,
      spanStatus: "error",
      level: failureLevel(kind, server),
      rpcStatusCode: rpcStatus(kind, result, type)
    }
  }
  return {
    outcome: "success",
    errorType: null,
    spanStatus: "unset",
    level: successLevel(kind, server),
    rpcStatusCode: rpcStatus(kind, result, SemconvValue.rpcStatusOk)
  }
}

/** High-frequency units obey `completionLogs`. Lifecycle units always log. */
export function completionAllowed(
  mode: "all" | "failures" | "none",
  kind: string,
  outcome: UnitClassification["outcome"]
): boolean {
  if (!isHighFrequency(kind)) return true
  if (mode === "none") return false
  if (mode === "all") return true
  return outcome === "failure"
}

/** Reports whether the unit is a server-side classification subject. */
function isServerKind(kind: string): boolean {
  return (
    kind === "rpc.server" ||
    kind === "http.server" ||
    kind === "messaging.process" ||
    kind === "job.run"
  )
}

/** Reports whether the unit is one of the seven high-frequency completion records. */
function isHighFrequency(kind: string): boolean {
  return (
    isServerKind(kind) ||
    kind === "rpc.client" ||
    kind === "messaging.publish" ||
    kind === "job.enqueue"
  )
}

/** Completion level for a canceled unit. App boundaries stay info; clients stay debug. */
function canceledLevel(kind: string, server: boolean): "debug" | "info" {
  if (server || kind === "app.start" || kind === "app.stop") return "info"
  return "debug"
}

/** Completion level for a successful unit. */
function successLevel(kind: string, server: boolean): "debug" | "info" {
  if (server || kind === "app.start" || kind === "app.stop" || kind === "config.reload")
    return "info"
  return "debug"
}

/** Completion level for a failed unit. App start and stop are errors; other clients are warnings. */
function failureLevel(kind: string, server: boolean): "error" | "warn" {
  if (server || kind === "app.start" || kind === "app.stop") return "error"
  return "warn"
}

/** Reads `ctx.err()` without letting a broken Context change the classification. */
function contextError(ctx: Context | undefined): Error | null {
  if (ctx === undefined) return null
  try {
    return ctx.err()
  } catch {
    return null
  }
}

/** Reads a ServiceError code when the value has the public ServiceError shape. */
function serviceErrorCode(value: unknown): string | null {
  if (!isServiceErrorShape(value)) return null
  const code = own(value, "code")
  return typeof code === "string" ? code : null
}

/** Reads a ServiceError HTTP status when the value has the public ServiceError shape. */
function serviceErrorStatus(value: unknown): number | null {
  if (!isServiceErrorShape(value)) return null
  const status = own(value, "status")
  return typeof status === "number" ? status : null
}

/** Recognizes a ServiceError without importing the transport brand. */
function isServiceErrorShape(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false
  return own(value, "name") === "ServiceError" && typeof own(value, "code") === "string"
}

/** Reads an own `code` string from an arbitrary thrown value. */
function readCode(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null
  const code = own(value, "code")
  return typeof code === "string" ? code : null
}

/** Reads one own data property without invoking an inherited member. */
function own(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

/** Uses an explicit protocol status when the caller set one, otherwise the classification fallback. */
function rpcStatus(kind: string, result: UnitResult | undefined, fallback: string): string | null {
  if (kind !== "rpc.server" && kind !== "rpc.client") return null
  const explicit = result?.rpcStatusCode
  if (typeof explicit === "string" && explicit.length > 0) return explicit
  return fallback
}
