import type { Context } from "../context/index"
import type { CarrierReader, CarrierWriter, Propagator, SpanContext } from "./index"
import {
  isValidSpanContext,
  spanFromContext,
  withRemoteSpanContext
} from "../telemetry/internal/state"

const traceparentPattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/
const fields = Object.freeze(["traceparent", "tracestate"])
const maxTraceStateLength = 512

/** W3C Trace Context propagator. Version `00` only. `tracestate` longer than 512 characters is dropped. */
export function newTraceContextPropagator(): Propagator {
  return {
    /** Header names this propagator owns. */
    fields(): readonly string[] {
      return fields
    },
    /** Writes `traceparent` and, when present, `tracestate`. Writes nothing without a valid span. */
    inject(ctx: Context, carrier: CarrierWriter): void {
      let context: SpanContext
      try {
        context = spanFromContext(ctx).spanContext()
      } catch {
        return
      }
      if (!isValidSpanContext(context)) return
      const flags = (context.traceFlags & 0xff).toString(16).padStart(2, "0")
      carrier.set("traceparent", `00-${context.traceId}-${context.spanId}-${flags}`)
      if (context.traceState !== "") carrier.set("tracestate", context.traceState)
    },
    /**
     * Returns `ctx` unchanged when the carrier has no valid `traceparent`. Never throws.
     * A value folded from two header fields (`"<a>, <b>"`) is rejected: W3C Trace Context defines
     * `traceparent` as one field, and a version `00` value with extra content is invalid.
     * Known upstream bug, not worked around here: `@opentelemetry/instrumentation-undici` appends a
     * second `traceparent` to a Node `fetch` request that already carries one, so a go-like client
     * under a global OTel propagator plus undici instrumentation reaches the server as a folded value.
     * https://github.com/open-telemetry/opentelemetry-js-contrib/issues/2796
     * https://github.com/open-telemetry/opentelemetry-js-contrib/issues/3711
     * Fix in progress: https://github.com/open-telemetry/opentelemetry-js-contrib/pull/3713
     */
    extract(ctx: Context, carrier: CarrierReader): Context {
      let raw: string | null
      try {
        raw = carrier.get("traceparent")
      } catch {
        return ctx
      }
      if (raw === null || raw.includes(",")) return ctx
      const match = traceparentPattern.exec(raw)
      const traceId = match?.[1]
      const spanId = match?.[2]
      const flags = match?.[3]
      if (traceId === undefined || spanId === undefined || flags === undefined) return ctx
      if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return ctx
      let traceState = ""
      try {
        const state = carrier.get("tracestate")
        if (state !== null && state.length <= maxTraceStateLength) traceState = state
      } catch {
        traceState = ""
      }
      return replace(ctx, traceId, spanId, flags, traceState)
    }
  }
}

/** Stores one remote parent. The caller has already rejected an invalid identity. */
function replace(
  ctx: Context,
  traceId: string,
  spanId: string,
  flags: string,
  traceState: string
): Context {
  const context: SpanContext = {
    traceId,
    spanId,
    traceFlags: Number.parseInt(flags, 16),
    traceState,
    isRemote: true
  }
  return withRemoteSpanContext(ctx, context)
}
