/**
 * Trace entry.
 * Declares the span sockets, the user `inSpan` API, and the built-in W3C propagator.
 */
import type { Context } from "../context/index"
import { errorType } from "../telemetry/internal/outcome"
import { enterScope, spanFromContext, stateFrom, withSpan } from "../telemetry/internal/state"
import type { Attributes, Scope, TelemetryLifecycle } from "../telemetry/types"
import { AttributeKey } from "../telemetry/semconv"

import { newTraceContextPropagator } from "./w3c"

export { spanFromContext, newTraceContextPropagator }

/** OTel span kind. */
export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer"

/** Terminal span status. Core leaves success UNSET and never sets a description. */
export type SpanStatusCode = "unset" | "ok" | "error"

/** W3C trace identity. `traceId` is 32 lowercase hex digits and `spanId` is 16. Neither may be all zeros. */
export interface SpanContext {
  readonly traceId: string
  readonly spanId: string
  /** W3C trace-flags byte. Bit 0 means sampled. */
  readonly traceFlags: number
  /** Serialized `tracestate`. Empty when absent. */
  readonly traceState: string
  readonly isRemote: boolean
}

/** Causal reference to a span in this trace or another one. */
export interface SpanLink {
  readonly context: SpanContext
  readonly attributes: Attributes
}

/**
 * One span.
 * Core stores and returns the exact object from `startSpan`. It never wraps that object.
 */
export interface Span {
  spanContext(): SpanContext
  isRecording(): boolean
  setAttributes(attributes: Attributes): void
  addEvent(name: string, attributes?: Attributes): void
  setStatus(code: SpanStatusCode, description?: string): void
  /** User-only. Core never calls it. */
  recordError(error: unknown, attributes?: Attributes): void
  /** Ends once. Later calls do nothing. */
  end(): void
}

/** Resolved options core passes to `TracerProvider.startSpan`. */
export interface SpanStartOptions {
  readonly kind: SpanKind
  readonly attributes: Attributes
  readonly links: readonly SpanLink[]
  /**
   * The span starts a new trace. The provider must not consult its own implicit context.
   */
  readonly root: boolean
}

/**
 * Tracing backend.
 * The parent span is the one carried by ctx. `enter` must call `fn` once, synchronously, and return its result.
 */
export interface TracerProvider {
  startSpan(ctx: Context, scope: Scope, name: string, options: SpanStartOptions): Span
  /**
   * Optional bridge for a provider that has its own implicit context.
   * When ctx carries no span, that implicit context must become empty.
   */
  enter?<R>(ctx: Context, fn: () => R): R
  /** Native lifecycle owned by the bundle after admission. Absent when the application keeps it. */
  readonly lifecycle?: TelemetryLifecycle
}

/** Read side of a propagation carrier. Key lookup is case-insensitive. */
export interface CarrierReader {
  get(key: string): string | null
  keys(): readonly string[]
}

/** Write side of a propagation carrier. Core replaces values and never appends. */
export interface CarrierWriter {
  set(key: string, value: string): void
}

/**
 * Cross-process propagator.
 * `extract` returns the same context when the carrier holds nothing valid, and it never throws on bad input.
 */
export interface Propagator {
  inject(ctx: Context, carrier: CarrierWriter): void
  extract(ctx: Context, carrier: CarrierReader): Context
  /** Header names this propagator owns. Core deletes caller-supplied copies before inject. */
  fields(): readonly string[]
}

/** Options for `inSpan`. */
export interface SpanOptions {
  /** Defaults to `"internal"`. */
  readonly kind?: SpanKind
  readonly attributes?: Attributes
  /** Defaults to `{ name: "app" }`. */
  readonly scope?: Scope
}

const appScope: Scope = Object.freeze({ name: "app" })
const emptyAttributes: Attributes = Object.freeze({})
const emptyLinks: readonly SpanLink[] = Object.freeze([])

/**
 * Runs `fn` inside a child span and inside the provider's implicit scope.
 * Without a tracer, calls `fn(ctx, spanFromContext(ctx))` and does not derive a context.
 * The user span name does not replace `go_like.operation`.
 */
export async function inSpan<T>(
  ctx: Context,
  name: string,
  fn: (ctx: Context, span: Span) => T | Promise<T>,
  options?: SpanOptions
): Promise<T> {
  const tracer = stateFrom(ctx)?.tracer
  if (tracer === undefined || tracer === null) return fn(ctx, spanFromContext(ctx))
  let span: Span
  try {
    span = tracer.startSpan(ctx, options?.scope ?? appScope, name, {
      kind: options?.kind ?? "internal",
      attributes: options?.attributes ?? emptyAttributes,
      links: emptyLinks,
      root: false
    })
  } catch {
    return fn(ctx, spanFromContext(ctx))
  }
  const child = withSpan(ctx, span, null)
  try {
    const result = await enterScope(child, () => fn(child, span))
    endSpan(span, false, undefined)
    return result
  } catch (error) {
    endSpan(span, true, error)
    throw error
  }
}

/** Ends a user span. A thrown error sets status `"error"` and `error.type`, without `recordError`. */
function endSpan(span: Span, failed: boolean, error: unknown): void {
  try {
    if (failed && span.isRecording()) {
      span.setStatus("error")
      span.setAttributes({ [AttributeKey.errorType]: errorType(error) })
    }
    span.end()
  } catch {
    // The user error, when there is one, is the failure that leaves this function.
  }
}
