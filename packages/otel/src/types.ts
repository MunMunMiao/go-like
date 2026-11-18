import type { LogHandler } from "@go-like/core/log"
import type { MeterProvider } from "@go-like/core/metric"
import type { Scope, TelemetryLifecycle } from "@go-like/core/telemetry"
import type { TracerProvider } from "@go-like/core/trace"

/** Native lifecycle member the API provider interfaces do not declare. */
export interface Shutdownable {
  shutdown(): Promise<void>
}

/**
 * Options for `newOtelTracerProvider`.
 */
export interface OtelTracingOptions {
  /**
   * Integer from 0 through 2147483647. Any other value throws RangeError.
   * The deadline is checked as soon as `shutdown()` starts, so 0 fails the owner wait immediately
   * while the native shutdown continues. The default is 25000.
   */
  readonly shutdownTimeoutMs?: number
  /** When ctx has no go-like span and the unit is not root, parent the span under `context.active()`. Default false. */
  readonly implicitParent?: boolean
  /**
   * When true, construction throws `OtelContextManagerMissingError` if `context.with` is not honored.
   * Default false: `start` writes one warning instead.
   */
  readonly requireContextManager?: boolean
}

/** Options for `newOtelMeterProvider`. */
export interface OtelMetricsOptions {
  /** Integer from 0 through 2147483647. Same meaning as `OtelTracingOptions.shutdownTimeoutMs`. Default 25000. */
  readonly shutdownTimeoutMs?: number
}

/** Options for `newOtelLogHandler`. */
export interface OtelLogsOptions {
  /** OTel logger instrumentation scope. Default `{ name: "go-like" }`. */
  readonly scope?: Scope
  /** Integer from 0 through 2147483647. Same meaning as `OtelTracingOptions.shutdownTimeoutMs`. Default 25000. */
  readonly shutdownTimeoutMs?: number
}

/** Core tracer whose lifecycle owns the application SDK TracerProvider after admission. */
export interface OtelTracerProvider extends TracerProvider {
  readonly lifecycle: TelemetryLifecycle
}

/** Core meter whose lifecycle owns the application SDK MeterProvider after admission. */
export interface OtelMeterProvider extends MeterProvider {
  readonly lifecycle: TelemetryLifecycle
}

/**
 * Core log handler. It has no `withAttrs`; core merges bound attributes.
 * Its lifecycle owns the application SDK LoggerProvider after admission.
 */
export interface OtelLogHandler extends LogHandler {
  readonly lifecycle: TelemetryLifecycle
}

/** Second `start` after the provider has left idle. */
export interface OtelAlreadyStartedError extends Error {
  readonly name: "OtelAlreadyStartedError"
  readonly code: "GO_LIKE_OTEL_ALREADY_STARTED"
  readonly status: "starting" | "running" | "stopping" | "stopped" | "failed"
}

/**
 * The owner wait exceeded `shutdownTimeoutMs`.
 * The promise returned by `start` still waits for the native terminal.
 */
export interface OtelShutdownTimeoutError extends Error {
  readonly name: "OtelShutdownTimeoutError"
  readonly code: "GO_LIKE_OTEL_SHUTDOWN_TIMEOUT"
  readonly timeoutMs: number
}

/** `requireContextManager` found no registered OTel ContextManager at construction. */
export interface OtelContextManagerMissingError extends Error {
  readonly name: "OtelContextManagerMissingError"
  readonly code: "GO_LIKE_OTEL_CONTEXT_MANAGER_MISSING"
}
