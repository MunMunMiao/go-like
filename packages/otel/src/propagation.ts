import type { Context } from "@go-like/core/context"
import { withRemoteSpanContext } from "@go-like/core/telemetry/provider"
import {
  spanFromContext,
  type CarrierReader,
  type CarrierWriter,
  type Propagator
} from "@go-like/core/trace"
import { ROOT_CONTEXT, isSpanContextValid, trace, type TextMapPropagator } from "@opentelemetry/api"

import { coreSpanContext, rememberSpan, toOtelContext } from "./bridge"

/**
 * Adapts an OTel `TextMapPropagator` to the core socket.
 * A carrier with no valid span context returns `ctx` unchanged, including baggage-only carriers.
 *
 * Known upstream bug, not worked around by go-like: when the application also registers a global OTel
 * propagator and enables `@opentelemetry/instrumentation-undici`, undici appends a second `traceparent`
 * to go-like's Node `fetch` requests, and the receiver rejects the folded value, starting a new trace.
 * Until the fix ships, an application can give `UndiciInstrumentation` an `ignoreRequestHook` that
 * skips requests already carrying `traceparent`.
 * https://github.com/open-telemetry/opentelemetry-js-contrib/issues/2796
 * https://github.com/open-telemetry/opentelemetry-js-contrib/issues/3711
 * Fix in progress: https://github.com/open-telemetry/opentelemetry-js-contrib/pull/3713
 */
export function newOtelPropagator(propagator: TextMapPropagator): Propagator {
  if (typeof propagator?.inject !== "function" || typeof propagator.extract !== "function") {
    throw new TypeError("propagator must be an OpenTelemetry TextMapPropagator")
  }
  return Object.freeze({
    inject(ctx: Context, carrier: CarrierWriter): void {
      propagator.inject(toOtelContext(ctx, false), carrier, {
        set: (target, key, value) => {
          target.set(key, value)
        }
      })
    },
    extract(ctx: Context, carrier: CarrierReader): Context {
      const extracted = propagator.extract(ROOT_CONTEXT, carrier, {
        get: (source, key) => source.get(key) ?? undefined,
        keys: (source) => [...source.keys()]
      })
      const spanContext = trace.getSpanContext(extracted)
      if (spanContext === undefined || !isSpanContextValid(spanContext)) return ctx
      const next = withRemoteSpanContext(ctx, coreSpanContext({ ...spanContext, isRemote: true }))
      rememberSpan(spanFromContext(next), extracted)
      return next
    },
    fields: () => propagator.fields()
  })
}
