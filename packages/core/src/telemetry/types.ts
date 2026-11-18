import type { Context } from "../context/index"
import type { LogHandler } from "../log/index"
import type { MeterProvider } from "../metric/index"
import type { Propagator, TracerProvider } from "../trace/index"

/** OpenTelemetry-compatible attribute value. Members are not null and values do not nest. */
export type AttributeValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | readonly boolean[]

/** Attribute map shared by the trace and metric sockets. */
export type Attributes = Readonly<Record<string, AttributeValue>>

/**
 * Instrumentation scope.
 * Core uses `{ name: "go-like" }`. User handles default to `{ name: "app" }`.
 */
export interface Scope {
  readonly name: string
  readonly version?: string
}

/**
 * Lifecycle of one provider after a Telemetry bundle admits it.
 * The shape matches `Server`, and it is declared here so socket entries do not import the root.
 * Every implementation must accept `stop` before `start`.
 */
export interface TelemetryLifecycle {
  /** Admits the provider. The returned promise may stay pending until the native terminal. */
  start(ctx: Context): Promise<void>
  /** Starts one owner drain. `ctx` bounds only this caller's wait. */
  stop(ctx: Context): Promise<void>
}

/** Which high-frequency completion records core writes. The default is `"failures"`. */
export type CompletionLogMode = "all" | "failures" | "none"

/** Options for one Telemetry bundle. At most one tracer provider is allowed. */
export interface TelemetryOptions {
  /** At most one: span identity cannot be fanned out. */
  readonly tracerProvider?: TracerProvider
  /** Any number. Every instrument records into each provider. */
  readonly meterProviders?: readonly MeterProvider[]
  /** Any number. Core fans out to every handler whose `enabled` is true. */
  readonly logHandlers?: readonly LogHandler[]
  /** `undefined` selects the W3C Trace Context propagator. `null` disables propagation. */
  readonly propagator?: Propagator | null
  /** Default `"failures"`. */
  readonly completionLogs?: CompletionLogMode
  /**
   * Web requests for which core records no unit.
   * The predicate must be cheap. A throw counts as false.
   */
  readonly ignoreRequest?: (request: Request) => boolean
}

declare const telemetryBrand: unique symbol

/**
 * Explicit provider bundle.
 * `server` and `resources` reject it at compile time. The brand symbol stays module-private.
 * `stop` before `start` drains every provider without admission and marks the bundle stopped.
 */
export interface Telemetry extends TelemetryLifecycle {
  readonly [telemetryBrand]: true
}

/** Rejection from `Telemetry.start` when the bundle has already started or stopped. */
export interface TelemetryAlreadyStartedError extends Error {
  readonly name: "TelemetryAlreadyStartedError"
  readonly code: "GO_LIKE_TELEMETRY_ALREADY_STARTED"
}
