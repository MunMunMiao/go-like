import type { Context } from "@go-like/core/context"
import { isValidSpanContext } from "@go-like/core/telemetry/provider"
import type { Attributes } from "@go-like/core/telemetry"
import { spanFromContext, type Span, type SpanContext } from "@go-like/core/trace"
import {
  ROOT_CONTEXT,
  context as otelContext,
  createContextKey,
  createTraceState,
  trace,
  type Attributes as OtelAttributes,
  type Context as OtelContext,
  type SpanContext as OtelSpanContext
} from "@opentelemetry/api"

/**
 * core Span -> the OTel Context that carries that span.
 * Keys are the span object, so dropping the span from ctx drops the entry (D39).
 */
const bridged = new WeakMap<Span, OtelContext>()
const probeKey = createContextKey("go-like.otel.context-manager-probe")

/** Projects an OTel span context onto the core span identity. */
export function coreSpanContext(value: OtelSpanContext): SpanContext {
  return Object.freeze({
    traceId: value.traceId,
    spanId: value.spanId,
    traceFlags: value.traceFlags,
    traceState: value.traceState?.serialize() ?? "",
    isRemote: value.isRemote === true
  })
}

/** Projects a core span identity onto an OTel span context. */
export function otelSpanContext(value: SpanContext): OtelSpanContext {
  return {
    traceId: value.traceId,
    spanId: value.spanId,
    traceFlags: value.traceFlags,
    isRemote: value.isRemote,
    ...(value.traceState === "" ? {} : { traceState: createTraceState(value.traceState) })
  }
}

/** Core attribute maps are valid OTel attribute maps. */
export function otelAttributes(value: Attributes): OtelAttributes {
  return value as OtelAttributes
}

/** True when `context.with` changes `context.active()`, i.e. a ContextManager is registered. */
export function contextManagerActive(): boolean {
  const probe = ROOT_CONTEXT.setValue(probeKey, true)
  return otelContext.with(probe, () => otelContext.active() === probe)
}

/**
 * Projects ctx onto an OTel Context.
 * A span this plug created, or the remote span stored by extract, wins.
 * Another valid span is set on `ROOT_CONTEXT`. With no span, `implicitParent` may use `context.active()`.
 */
export function toOtelContext(ctx: Context, implicitParent: boolean): OtelContext {
  const span = spanFromContext(ctx)
  const known = bridged.get(span)
  if (known !== undefined) return known
  const spanContext = span.spanContext()
  if (!isValidSpanContext(spanContext)) return implicitParent ? otelContext.active() : ROOT_CONTEXT
  return trace.setSpanContext(ROOT_CONTEXT, otelSpanContext(spanContext))
}

/** Records the OTel Context for a core span this plug created or extracted. */
export function rememberSpan(span: Span, value: OtelContext): void {
  bridged.set(span, value)
}

/** The OTel Context stored for `span`, if this plug created or extracted it. */
export function bridgedContext(span: Span): OtelContext | undefined {
  return bridged.get(span)
}
