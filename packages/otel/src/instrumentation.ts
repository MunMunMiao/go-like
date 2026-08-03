import type { Context as LikegoContext } from "@likego/context"
import { fromServerContext, mergeToClientContext, newMetadata } from "@likego/metadata"
import { isServiceError } from "@likego/transport"
import {
  context,
  propagation,
  SpanStatusCode,
  type Counter,
  type Context as OtelContext,
  type Histogram,
  type Meter,
  type Span,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
  type Tracer
} from "@opentelemetry/api"

export type HeaderCarrier = Record<string, string>
export type HeaderPropagator = TextMapPropagator<HeaderCarrier>
export type FailureKind = "application_error" | "broker_error" | "transport_error"
export type RequestComponent = "client" | "server"
export type RequestOutcome = "canceled" | "failure" | "success"

const errorTypePattern = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/
const errorCodePattern = /^[A-Z0-9_.-]{1,64}$/

/** Holds the two official OpenTelemetry instruments used by LikeGo request instrumentation. */
export interface RequestMetrics {
  readonly requestsTotal: Counter
  readonly requestDurationSeconds: Histogram
}

/** Reads one bounded error identifier without exposing or trusting the complete failure object. */
function errorIdentifier(value: unknown, name: "name" | "code", pattern: RegExp): string | null {
  if (typeof value !== "object" || value === null) return null
  try {
    const identifier: unknown =
      name === "name" ? ("name" in value ? value.name : null) : "code" in value ? value.code : null
    return typeof identifier === "string" && pattern.test(identifier) ? identifier : null
  } catch {
    return null
  }
}

/** Adds only bounded error identifiers to one failed span. */
function recordErrorIdentifiers(span: Span, value: unknown): void {
  const errorType = errorIdentifier(value, "name", errorTypePattern)
  const errorCode = errorIdentifier(value, "code", errorCodePattern)
  if (errorType !== null) span.setAttribute("error.type", errorType)
  if (errorCode !== null) span.setAttribute("likego.error.code", errorCode)
}

/** Sets one propagation field on a mutable header carrier. */
function setHeader(carrier: HeaderCarrier, key: string, value: string): void {
  Object.defineProperty(carrier, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  })
}

/** Returns all case-insensitive propagation values for one header name. */
function getHeader(carrier: HeaderCarrier, key: string): string | string[] | undefined {
  const expected = key.toLowerCase()
  const values: string[] = []
  for (const name of Object.keys(carrier)) {
    if (name.toLowerCase() !== expected) continue
    const value = carrier[name]
    if (typeof value !== "string") throw new TypeError("propagation header values must be strings")
    values.push(value)
  }
  if (values.length === 0) return undefined
  if (values.length === 1) return values[0]
  return values
}

/** Returns every own propagation carrier key. */
function headerKeys(carrier: HeaderCarrier): string[] {
  return Object.keys(carrier)
}

const headerSetter: TextMapSetter<HeaderCarrier> = Object.freeze({ set: setHeader })
const headerGetter: TextMapGetter<HeaderCarrier> = Object.freeze({
  get: getHeader,
  keys: headerKeys
})

/** Rejects a non-structural official Tracer before an operation begins. */
export function validateTracer(tracer: Tracer): void {
  const candidate: unknown = tracer
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof tracer.startActiveSpan !== "function"
  ) {
    throw new TypeError("tracer must implement the OpenTelemetry Tracer interface")
  }
}

/** Rejects an invalid explicit propagator while leaving the global API application-owned. */
export function validatePropagator(propagator: HeaderPropagator | undefined): void {
  if (propagator === undefined) return
  const candidate: unknown = propagator
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof propagator.inject !== "function" ||
    typeof propagator.extract !== "function" ||
    typeof propagator.fields !== "function"
  ) {
    throw new TypeError("propagator must implement the OpenTelemetry TextMapPropagator interface")
  }
}

/** Rejects malformed request instrumentation handles before wrapping application behavior. */
export function validateRequestMetrics(metrics: RequestMetrics): void {
  const candidate: unknown = metrics
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof metrics.requestsTotal?.add !== "function" ||
    typeof metrics.requestDurationSeconds?.record !== "function"
  ) {
    throw new TypeError("metrics must be created by newRequestMetrics")
  }
}

/** Creates fixed request instruments from one application-owned official Meter. */
export function newRequestMetrics(meter: Meter): RequestMetrics {
  const candidate: unknown = meter
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof meter.createCounter !== "function" ||
    typeof meter.createHistogram !== "function"
  ) {
    throw new TypeError("meter must implement the OpenTelemetry Meter interface")
  }
  const requestsTotal = meter.createCounter("likego.request.completed", {
    description: "Completed LikeGo requests.",
    unit: "{request}"
  })
  const requestDurationSeconds = meter.createHistogram("likego.request.duration", {
    description: "Duration of completed LikeGo requests in seconds.",
    unit: "s"
  })
  return Object.freeze({ requestsTotal, requestDurationSeconds })
}

/** Starts one request duration and returns its single completion recorder. */
export function startMeasurement(
  metrics: RequestMetrics,
  component: RequestComponent,
  operation: string
): (outcome: RequestOutcome) => void {
  const started = performance.now()
  /** Records bounded terminal attributes without replacing the wrapped operation's result. */
  function complete(outcome: RequestOutcome): void {
    const attributes = { component, operation, outcome }
    try {
      metrics.requestsTotal.add(1, attributes)
    } catch {
      // Metrics must not replace the wrapped operation's result.
    }
    try {
      metrics.requestDurationSeconds.record((performance.now() - started) / 1000, attributes)
    } catch {
      // Metrics must not replace the wrapped operation's result.
    }
  }
  return complete
}

/** Classifies a failed Context-owned operation without inspecting its error. */
export function contextOutcome(ctx: LikegoContext): RequestOutcome {
  try {
    return ctx.err() === null ? "failure" : "canceled"
  } catch {
    return "failure"
  }
}

/** Reads and validates the exact propagation fields managed by the selected propagator. */
function managedFields(propagator: HeaderPropagator | undefined): readonly string[] {
  const fields = propagator === undefined ? propagation.fields() : propagator.fields()
  if (!Array.isArray(fields)) throw new TypeError("propagator fields must be an array")
  const copied: string[] = []
  for (const field of fields) {
    if (typeof field !== "string" || field.length === 0) {
      throw new TypeError("propagator fields must be non-empty strings")
    }
    copied.push(field)
  }
  return copied
}

/** Copies caller headers while removing only fields owned by the selected propagator. */
function propagationCarrier(
  headers: Readonly<Record<string, string>>,
  fields: readonly string[]
): HeaderCarrier {
  const managed = new Set<string>()
  for (const field of fields) managed.add(field.toLowerCase())
  const carrier: HeaderCarrier = {}
  for (const key of Object.keys(headers)) {
    if (managed.has(key.toLowerCase())) continue
    const value = headers[key]
    if (typeof value !== "string") throw new TypeError("propagation header values must be strings")
    setHeader(carrier, key, value)
  }
  return carrier
}

/** Injects the active official context into one detached immutable header record. */
export function injectHeaders(
  headers: Readonly<Record<string, string>>,
  propagator: HeaderPropagator | undefined
): Readonly<Record<string, string>> {
  const carrier = propagationCarrier(headers, managedFields(propagator))
  if (propagator === undefined) propagation.inject(context.active(), carrier, headerSetter)
  else propagator.inject(context.active(), carrier, headerSetter)
  return Object.freeze(carrier)
}

/** Injects active propagation fields into the canonical LikeGo client metadata Context. */
export function injectClientContext(
  ctx: LikegoContext,
  propagator: HeaderPropagator | undefined
): LikegoContext {
  return mergeToClientContext(ctx, newMetadata(injectHeaders(Object.freeze({}), propagator)))
}

/** Projects decoded LikeGo server metadata over direct wire headers for parent extraction. */
function serverHeaderCarrier(
  ctx: LikegoContext,
  headers: Readonly<Record<string, string>>
): HeaderCarrier {
  const carrier = propagationCarrier(headers, Object.freeze([]))
  const metadata = fromServerContext(ctx)
  if (metadata === null) return carrier
  for (const key of Object.keys(metadata)) {
    const values = metadata[key]
    if (values === undefined || values.length === 0) continue
    const value = values[values.length - 1]
    if (value !== undefined) setHeader(carrier, key, value)
  }
  return carrier
}

/** Extracts one remote parent from immutable headers without mutating the carrier. */
export function extractHeaders(
  headers: Readonly<Record<string, string>>,
  propagator: HeaderPropagator | undefined
): OtelContext {
  const carrier = propagationCarrier(headers, Object.freeze([]))
  return propagator === undefined
    ? propagation.extract(context.active(), carrier, headerGetter)
    : propagator.extract(context.active(), carrier, headerGetter)
}

/** Extracts one remote parent from direct headers and canonical LikeGo server metadata. */
export function extractServerContext(
  ctx: LikegoContext,
  headers: Readonly<Record<string, string>>,
  propagator: HeaderPropagator | undefined
): OtelContext {
  const carrier = serverHeaderCarrier(ctx, headers)
  return propagator === undefined
    ? propagation.extract(context.active(), carrier, headerGetter)
    : propagator.extract(context.active(), carrier, headerGetter)
}

/** Copies standard Headers into the immutable carrier shape used by explicit propagators. */
function requestHeaderCarrier(headers: Headers): HeaderCarrier {
  const carrier: HeaderCarrier = {}
  for (const [key, value] of headers) setHeader(carrier, key, value)
  return carrier
}

/** Extracts one remote parent from standard Request headers without mutating them. */
export function extractRequestHeaders(
  headers: Headers,
  propagator: HeaderPropagator | undefined
): OtelContext {
  const carrier = requestHeaderCarrier(headers)
  return propagator === undefined
    ? propagation.extract(context.active(), carrier, headerGetter)
    : propagator.extract(context.active(), carrier, headerGetter)
}

/** Reads one case-insensitive routing field or returns a stable unknown marker. */
export function routeField(headers: Readonly<Record<string, string>>, expected: string): string {
  const value = getHeader(propagationCarrier(headers, Object.freeze([])), expected)
  return typeof value === "string" ? value : "unknown"
}

/** Marks one successfully completed operation with only low-cardinality outcome data. */
export function succeedSpan(span: Span): void {
  span.setAttribute("likego.outcome", "ok")
  span.setStatus({ code: SpanStatusCode.OK })
}

/** Completes one Web span at the response-header boundary without touching its body. */
export function completeResponseSpan(span: Span, response: Response): void {
  span.setAttribute("http.response.status_code", response.status)
  if (response.status >= 500) {
    span.setAttribute("likego.outcome", "http_server_error")
    span.setStatus({ code: SpanStatusCode.ERROR })
    return
  }
  span.setAttribute("likego.outcome", response.status >= 400 ? "http_client_error" : "ok")
}

/** Classifies one failed operation without copying error text into span attributes. */
export function failSpan(
  span: Span,
  ctx: LikegoContext,
  value: unknown,
  fallback: FailureKind
): void {
  let outcome: string = fallback
  try {
    if (ctx.err() !== null) outcome = "canceled"
    else if (isServiceError(value)) outcome = "service_error"
  } catch {
    // Observability must not replace the wrapped operation's failure.
  }
  span.setAttribute("likego.outcome", outcome)
  span.setStatus({ code: SpanStatusCode.ERROR })
  recordErrorIdentifiers(span, value)
}

/** Classifies one failed standard Web request without copying error text into attributes. */
export function failRequestSpan(
  span: Span,
  signal: AbortSignal,
  value: unknown,
  fallback: FailureKind
): void {
  let outcome: string = fallback
  if (signal.aborted) outcome = "canceled"
  else if (isServiceError(value)) outcome = "service_error"
  span.setAttribute("likego.outcome", outcome)
  span.setStatus({ code: SpanStatusCode.ERROR })
  recordErrorIdentifiers(span, value)
}
