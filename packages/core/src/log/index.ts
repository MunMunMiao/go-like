/**
 * Log entry.
 * Declares the `LogHandler` socket and the context-first `log.*` front end.
 */
import type { Context } from "../context/index"
import type { AttributeValue, TelemetryLifecycle } from "../telemetry/types"
import { writeLog } from "../telemetry/internal/events"
import { logLevelEnabled, withBoundLogs } from "../telemetry/internal/state"

/** Log level names shared with pino and winston. Severity numbers are 5, 9, 13, and 17. */
export type LogLevel = "debug" | "info" | "warn" | "error"

/** Structured log value: an attribute, null, a local Error, or a nested map. */
export type LogValue = AttributeValue | null | Error | { readonly [key: string]: LogValue }

/** Attribute map on one log record. */
export type LogAttrs = Readonly<Record<string, LogValue>>

/** One record delivered to a handler. Bound attributes are already merged when `withAttrs` is absent. */
export interface LogRecord {
  /** Epoch milliseconds. */
  readonly time: number
  readonly level: LogLevel
  readonly message: string
  /** `go_like.*` for core events, `""` for user records. */
  readonly event: string
  readonly attrs: LogAttrs
}

/**
 * Log backend.
 * Core writes completion records and diagnostic events here. `stop` before `start` must be accepted.
 */
export interface LogHandler {
  /** Cheap level gate, called before core builds attributes. */
  enabled(ctx: Context, level: LogLevel): boolean
  /** Writes one record. Must not block. Core isolates throws. */
  handle(ctx: Context, record: LogRecord): void
  /** Optional child-logger fast path. When absent, core merges bound attributes into the record. */
  withAttrs?(attrs: LogAttrs): LogHandler
  /** Native lifecycle owned by the bundle after admission. Absent when the application keeps it. */
  readonly lifecycle?: TelemetryLifecycle
}

/** Writes one record at `level`. No handler means one context lookup and return. */
export function log(ctx: Context, level: LogLevel, message: string, attrs?: LogAttrs): void {
  writeLog(ctx, level, "", message, attrs)
}

/** Writes one debug record. */
export function debug(ctx: Context, message: string, attrs?: LogAttrs): void {
  log(ctx, "debug", message, attrs)
}

/** Writes one info record. */
export function info(ctx: Context, message: string, attrs?: LogAttrs): void {
  log(ctx, "info", message, attrs)
}

/** Writes one warn record. */
export function warn(ctx: Context, message: string, attrs?: LogAttrs): void {
  log(ctx, "warn", message, attrs)
}

/** Writes one error record. User records do not use the console fallback. */
export function error(ctx: Context, message: string, attrs?: LogAttrs): void {
  log(ctx, "error", message, attrs)
}

/** Reports whether any installed handler would accept `level`. */
export function enabled(ctx: Context, level: LogLevel): boolean {
  return logLevelEnabled(ctx, level)
}

/**
 * Returns a context whose records carry `attrs`.
 * Returns `ctx` itself when no handler is installed or `attrs` is empty.
 */
export function withLogAttrs(ctx: Context, attrs: LogAttrs): Context {
  return withBoundLogs(ctx, attrs)
}
