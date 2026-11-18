import type { Context } from "@go-like/core/context"
import type { Attributes, Scope } from "@go-like/core/telemetry"
import { logEvent } from "@go-like/core/telemetry/provider"
import {
  spanFromContext,
  type Span,
  type SpanKind,
  type SpanStartOptions,
  type SpanStatusCode
} from "@go-like/core/trace"
import {
  ROOT_CONTEXT,
  SpanKind as OtelSpanKind,
  SpanStatusCode as OtelSpanStatusCode,
  context as otelContext,
  propagation,
  trace,
  type Span as OtelSpan,
  type Tracer as OtelTracer,
  type TracerProvider as ApiTracerProvider
} from "@opentelemetry/api"

import {
  bridgedContext,
  contextManagerActive,
  coreSpanContext,
  otelAttributes,
  otelSpanContext,
  rememberSpan,
  toOtelContext
} from "./bridge"
import { otelContextManagerMissing } from "./errors"
import { eventContextManagerMissing, eventGlobalPropagator } from "./events"
import { providerLifecycle, readShutdownTimeout } from "./lifecycle"
import type { OtelTracerProvider, OtelTracingOptions, Shutdownable } from "./types"

/** Every core span kind has an OTel kind. A new core kind fails this assignment. */
export const otelSpanKinds: Readonly<Record<SpanKind, OtelSpanKind>> = Object.freeze({
  internal: OtelSpanKind.INTERNAL,
  server: OtelSpanKind.SERVER,
  client: OtelSpanKind.CLIENT,
  producer: OtelSpanKind.PRODUCER,
  consumer: OtelSpanKind.CONSUMER
})

const spanStatuses: Readonly<Record<SpanStatusCode, OtelSpanStatusCode>> = Object.freeze({
  unset: OtelSpanStatusCode.UNSET,
  ok: OtelSpanStatusCode.OK,
  error: OtelSpanStatusCode.ERROR
})

function wrapSpan(span: OtelSpan): Span {
  let identity: ReturnType<Span["spanContext"]> | null = null
  return Object.freeze({
    spanContext() {
      identity ??= coreSpanContext(span.spanContext())
      return identity
    },
    isRecording() {
      return span.isRecording()
    },
    setAttributes(attributes: Attributes) {
      span.setAttributes(otelAttributes(attributes))
    },
    addEvent(name: string, attributes?: Attributes) {
      if (attributes === undefined) span.addEvent(name)
      else span.addEvent(name, otelAttributes(attributes))
    },
    setStatus(code: SpanStatusCode, description?: string) {
      span.setStatus(
        code === "error" && description !== undefined
          ? { code: spanStatuses.error, message: description }
          : { code: spanStatuses[code] }
      )
    },
    recordError(error: unknown, attributes?: Attributes) {
      span.recordException(error instanceof Error ? error : String(error))
      if (attributes !== undefined) span.setAttributes(otelAttributes(attributes))
    },
    end() {
      span.end()
    }
  })
}

/**
 * Adapts an application SDK TracerProvider.
 * `startSpan` honors `root`, `links`, and `kind`. `enter` is `context.with`, so `context.active()` matches the go-like span.
 */
export function newOtelTracerProvider(
  provider: ApiTracerProvider & Shutdownable,
  options: OtelTracingOptions = {}
): OtelTracerProvider {
  if (typeof provider?.getTracer !== "function" || typeof provider.shutdown !== "function") {
    throw new TypeError("provider must be an OpenTelemetry SDK TracerProvider")
  }
  if (options.requireContextManager === true && !contextManagerActive())
    throw otelContextManagerMissing()
  const timeoutMs = readShutdownTimeout(options.shutdownTimeoutMs)
  const implicitParent = options.implicitParent === true
  const tracers = new WeakMap<Scope, OtelTracer>()
  const lifecycle = providerLifecycle(provider, timeoutMs, (ctx) => {
    if (!contextManagerActive()) {
      logEvent(
        ctx,
        "warn",
        eventContextManagerMissing,
        "no OpenTelemetry ContextManager is registered; third-party spans will not nest under go-like spans"
      )
    }
    if (propagation.fields().includes("traceparent")) {
      logEvent(
        ctx,
        "warn",
        eventGlobalPropagator,
        "a global OpenTelemetry propagator owns traceparent; HTTP client auto-instrumentation may add a second traceparent to go-like calls"
      )
    }
  })
  return Object.freeze({
    startSpan(ctx: Context, scope: Scope, name: string, start: SpanStartOptions) {
      let tracer = tracers.get(scope)
      if (tracer === undefined) {
        tracer =
          scope.version === undefined
            ? provider.getTracer(scope.name)
            : provider.getTracer(scope.name, scope.version)
        tracers.set(scope, tracer)
      }
      const parent = start.root
        ? (bridgedContext(spanFromContext(ctx)) ?? ROOT_CONTEXT)
        : toOtelContext(ctx, implicitParent)
      const otelSpan = tracer.startSpan(
        name,
        {
          kind: otelSpanKinds[start.kind],
          attributes: otelAttributes(start.attributes),
          links: start.links.map((link) => ({
            context: otelSpanContext(link.context),
            attributes: otelAttributes(link.attributes)
          })),
          root: start.root
        },
        parent
      )
      const span = wrapSpan(otelSpan)
      rememberSpan(span, trace.setSpan(parent, otelSpan))
      return span
    },
    enter<R>(ctx: Context, fn: () => R): R {
      return otelContext.with(toOtelContext(ctx, implicitParent), fn)
    },
    lifecycle
  })
}
