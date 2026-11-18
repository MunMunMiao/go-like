import { withValue, type Context } from "../../context/index"
import { coreInstance } from "../../internal/instance"
import type { LogLevel } from "../../log/index"
import type { MeterProvider } from "../../metric/index"
import type { Attributes, CompletionLogMode, Scope } from "../types"
import type { Propagator, Span, SpanContext, TracerProvider } from "../../trace/index"

import { bindHandlers, installHandlers, type FanoutHandler } from "./fanout"

void coreInstance.version

const telemetryKey = Object.freeze({ name: "go-like.telemetry" })
const states = new WeakSet<object>()
const traceIdPattern = /^[0-9a-f]{32}$/
const spanIdPattern = /^[0-9a-f]{16}$/
const zeroTraceId = "0".repeat(32)
const zeroSpanId = "0".repeat(16)

/** Frozen telemetry slot carried by one Context. */
export interface TelemetryState {
  readonly tracer: TracerProvider | null
  readonly meters: readonly MeterProvider[]
  readonly fanout: readonly FanoutHandler[]
  readonly baseFanout: readonly FanoutHandler[]
  readonly propagator: Propagator | null
  readonly completionLogs: CompletionLogMode
  readonly ignoreRequest: ((request: Request) => boolean) | null
  readonly resource: Attributes
  readonly span: Span | null
  readonly operation: string
  readonly active: boolean
}

/** Fields needed to install one bundle into a Context. */
export interface StateInput {
  readonly tracer: TracerProvider | null
  readonly meters: readonly MeterProvider[]
  readonly handlers: readonly FanoutHandler[]
  readonly propagator: Propagator | null
  readonly completionLogs: CompletionLogMode
  readonly ignoreRequest: ((request: Request) => boolean) | null
  readonly resource: Attributes
  readonly span: Span | null
  readonly operation: string
}

const invalidSpanContext: SpanContext = Object.freeze({
  traceId: zeroTraceId,
  spanId: zeroSpanId,
  traceFlags: 0,
  traceState: "",
  isRemote: false
})

const noopSpan: Span = Object.freeze({
  /** Returns the shared invalid identity. */
  spanContext(): SpanContext {
    return invalidSpanContext
  },
  /** The shared span never records. */
  isRecording(): boolean {
    return false
  },
  /** Ignores attributes on the shared non-recording span. */
  setAttributes(): void {},
  /** Ignores events on the shared non-recording span. */
  addEvent(): void {},
  /** Ignores status on the shared non-recording span. */
  setStatus(): void {},
  /** Ignores errors on the shared non-recording span. */
  recordError(): void {},
  /** Ending the shared span is a no-op. */
  end(): void {}
})

/** Reads the telemetry slot in one Context lookup. */
export function stateFrom(ctx: Context): TelemetryState | null {
  const value = ctx.value(telemetryKey)
  if (typeof value !== "object" || value === null || !states.has(value)) return null
  return value as TelemetryState
}

/** Reports whether this Context has a tracer, meter, log handler, or propagator. */
export function observing(ctx: Context): boolean {
  return stateFrom(ctx)?.active === true
}

/** Returns the active span, or the shared non-recording span when ctx has none. */
export function spanFromContext(ctx: Context): Span {
  return stateFrom(ctx)?.span ?? noopSpan
}

/** Reports whether a span identity is a non-zero lowercase W3C id pair. */
export function isValidSpanContext(value: SpanContext): boolean {
  return (
    traceIdPattern.test(value.traceId) &&
    value.traceId !== zeroTraceId &&
    spanIdPattern.test(value.spanId) &&
    value.spanId !== zeroSpanId &&
    Number.isInteger(value.traceFlags) &&
    value.traceFlags >= 0 &&
    value.traceFlags <= 255 &&
    typeof value.traceState === "string"
  )
}

/** Correlation fields for one log record, or null when ctx has no valid span. */
export function logCorrelation(
  ctx: Context
): { readonly trace_id: string; readonly span_id: string; readonly trace_flags: string } | null {
  const span = stateFrom(ctx)?.span
  if (span === undefined || span === null) return null
  let context: SpanContext
  try {
    context = span.spanContext()
  } catch {
    return null
  }
  if (!isValidSpanContext(context)) return null
  return {
    trace_id: context.traceId,
    span_id: context.spanId,
    trace_flags: context.traceFlags.toString(16).padStart(2, "0")
  }
}

/** Builds a frozen slot. `handlers` are both the current fanout and the detach baseline. */
export function createState(input: StateInput): TelemetryState {
  const fanout = input.handlers
  const state: TelemetryState = {
    tracer: input.tracer,
    meters: input.meters,
    fanout,
    baseFanout: fanout,
    propagator: input.propagator,
    completionLogs: input.completionLogs,
    ignoreRequest: input.ignoreRequest,
    resource: input.resource,
    span: input.span,
    operation: input.operation,
    active:
      input.tracer !== null ||
      input.meters.length > 0 ||
      fanout.length > 0 ||
      input.propagator !== null
  }
  const frozen = Object.freeze(state)
  states.add(frozen)
  return frozen
}

/** Installs `state` with one `withValue`. */
export function writeState(ctx: Context, state: TelemetryState): Context {
  return withValue(ctx, telemetryKey, state)
}

/** Installs a bundle and resource, keeping no span and no bound log attributes. */
export function installState(ctx: Context, input: StateInput): Context {
  return writeState(ctx, createState({ ...input, span: null, operation: "" }))
}

/** Drops the span, bound log attributes, and operation identity. Providers stay. */
export function detachSpan(ctx: Context): Context {
  const state = stateFrom(ctx)
  if (state === null) return ctx
  if (state.span === null && state.operation === "" && state.fanout === state.baseFanout) return ctx
  return writeState(ctx, replace(state, { span: null, operation: "", fanout: state.baseFanout }))
}

/** Sets the operation identity used by resident loops that have no unit span. */
export function withOperation(ctx: Context, operation: string): Context {
  if (typeof operation !== "string") throw new TypeError("operation must be a string")
  const state = stateFrom(ctx)
  if (state === null || state.operation === operation) return ctx
  return writeState(ctx, replace(state, { operation }))
}

/** Stores a local or remote span. `operation` replaces the identity only when it is a string. */
export function withSpan(ctx: Context, span: Span, operation: string | null): Context {
  const state = stateFrom(ctx)
  if (state === null) {
    return writeState(
      ctx,
      createState({
        tracer: null,
        meters: [],
        handlers: installHandlers([]),
        propagator: null,
        completionLogs: "failures",
        ignoreRequest: null,
        resource: Object.freeze({}),
        span,
        operation: operation ?? ""
      })
    )
  }
  return writeState(
    ctx,
    replace(state, {
      span,
      operation: operation ?? state.operation
    })
  )
}

/** Stores a frozen non-recording remote span. Invalid identities throw TypeError. */
export function withRemoteSpanContext(ctx: Context, context: SpanContext): Context {
  if (!isValidSpanContext(context)) throw new TypeError("span context is invalid")
  const remote = Object.freeze({
    traceId: context.traceId,
    spanId: context.spanId,
    traceFlags: context.traceFlags,
    traceState: context.traceState,
    isRemote: true
  })
  const span: Span = Object.freeze({
    /** Returns the frozen remote identity. */
    spanContext(): SpanContext {
      return remote
    },
    /** A remote parent does not record. */
    isRecording(): boolean {
      return false
    },
    /** Ignores attributes on a remote span. */
    setAttributes(): void {},
    /** Ignores events on a remote span. */
    addEvent(): void {},
    /** Ignores status on a remote span. */
    setStatus(): void {},
    /** Ignores errors on a remote span. */
    recordError(): void {},
    /** Ending a remote span is a no-op. */
    end(): void {}
  })
  return withSpan(ctx, span, null)
}

/** Replaces the fanout with handlers bound to `attrs`. */
export function withBoundLogs(ctx: Context, attrs: Parameters<typeof bindHandlers>[1]): Context {
  const state = stateFrom(ctx)
  if (state === null || state.fanout.length === 0) return ctx
  const fanout = bindHandlers(state.fanout, attrs)
  if (fanout === state.fanout) return ctx
  return writeState(ctx, replace(state, { fanout }))
}

/**
 * Runs `fn` under `TracerProvider.enter(ctx)` when the provider has a bridge.
 * The callback runs once even if `enter` fails to call it.
 */
export function enterScope<R>(ctx: Context, fn: () => R): R {
  const enter = stateFrom(ctx)?.tracer?.enter
  if (typeof enter !== "function") return fn()
  let called = false
  let result: R
  try {
    result = enter(ctx, () => {
      called = true
      return fn()
    })
  } catch (error) {
    if (!called) return fn()
    throw error
  }
  if (!called) return fn()
  return result
}

/** Runs `fn` with the span and operation removed and the provider's implicit context reset. */
export function enterRoot<R>(ctx: Context, fn: () => R): R {
  return enterScope(detachSpan(ctx), fn)
}

/** Applies `ignoreRequest` once. A throw counts as false, and a missing predicate is false. */
export function ignoredRequest(ctx: Context, request: Request): boolean {
  const predicate = stateFrom(ctx)?.ignoreRequest
  if (predicate === undefined || predicate === null) return false
  try {
    return predicate(request) === true
  } catch {
    return false
  }
}

/** Reads the resource attributes installed with the bundle. Outside an App this is `{}`. */
export function resourceFromContext(ctx: Context): Attributes {
  return stateFrom(ctx)?.resource ?? Object.freeze({})
}

/** Reads the completion-log mode, defaulting to failures when telemetry is absent. */
export function completionMode(ctx: Context): CompletionLogMode {
  return stateFrom(ctx)?.completionLogs ?? "failures"
}

/** Scope core stamps on its own instruments. */
export function coreScope(version: string): Scope {
  return Object.freeze({ name: "go-like", version })
}

/** Whether a user log at `level` should build a record. */
export function logLevelEnabled(ctx: Context, level: LogLevel): boolean {
  const state = stateFrom(ctx)
  if (state === null) return false
  for (const item of state.fanout) {
    try {
      if (item.handler.enabled(ctx, level) === true) return true
    } catch {
      // A throwing gate is treated as disabled.
    }
  }
  return false
}

/** Copies a slot with a small patch and a fresh brand. */
function replace(state: TelemetryState, patch: Partial<TelemetryState>): TelemetryState {
  const next: TelemetryState = {
    tracer: state.tracer,
    meters: state.meters,
    fanout: patch.fanout ?? state.fanout,
    baseFanout: state.baseFanout,
    propagator: state.propagator,
    completionLogs: state.completionLogs,
    ignoreRequest: state.ignoreRequest,
    resource: state.resource,
    span: patch.span === undefined ? state.span : patch.span,
    operation: patch.operation ?? state.operation,
    active: state.active
  }
  const frozen = Object.freeze(next)
  states.add(frozen)
  return frozen
}
