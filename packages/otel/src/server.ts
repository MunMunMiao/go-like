import type { Context } from "@go-like/context"
import type { Middleware } from "@go-like/server"
import { fromServerContext, observeResponseBody } from "@go-like/transport"
import { SpanKind, type Span, type TextMapPropagator, type Tracer } from "@opentelemetry/api"

import {
  annotateBodySpan,
  contextOutcome,
  extractServerContext,
  extractRequestHeaders,
  failSpan,
  failRequestSpan,
  startMeasurement,
  validatePropagator,
  validateRequestMetrics,
  validateTracer,
  type HeaderCarrier,
  type RequestMetrics
} from "./instrumentation"

/** Reads the pathname operation, mapping a missing side to the stable unknown marker. */
function operationIdentity(ctx: Context): readonly [string, string] {
  let operation = ""
  try {
    const info = fromServerContext(ctx)
    if (info !== null) operation = info.operation()
  } catch {
    operation = ""
  }
  const slash = operation.indexOf("/")
  const service = slash < 0 ? operation : operation.slice(0, slash)
  const endpoint = slash < 0 ? "" : operation.slice(slash + 1)
  return [
    operation.length === 0 || service.length === 0 ? "unknown" : service,
    operation.length === 0 || endpoint.length === 0 ? "unknown" : endpoint
  ]
}

/** Copies Request headers into the immutable carrier shape used by propagators. */
function headerRecord(headers: Headers): Readonly<Record<string, string>> {
  const record: Record<string, string> = {}
  headers.forEach((value, key) => {
    record[key] = value
  })
  return record
}

/** Creates one ordinary unary middleware with explicit remote-parent extraction. */
export function traceUnaryMiddleware(
  tracer: Tracer,
  propagator?: TextMapPropagator<HeaderCarrier>
): Middleware {
  validateTracer(tracer)
  validatePropagator(propagator)

  return (next) => {
    if (typeof next !== "function") throw new TypeError("unary handler must be a function")
    return async (ctx, request) => {
      const [serviceName, endpointName] = operationIdentity(ctx)
      const parent = extractServerContext(ctx, headerRecord(request.headers), propagator)
      return await tracer.startActiveSpan(
        `go-like.server ${serviceName}/${endpointName}`,
        {
          kind: SpanKind.SERVER,
          attributes: {
            "go-like.kind": "server",
            "go-like.service": serviceName,
            "go-like.endpoint": endpointName
          }
        },
        parent,
        async (span) => {
          const startedAt = performance.now()
          let ended = false
          /** Ends the server span once. */
          function endSpan(): void {
            if (ended) return
            ended = true
            span.end()
          }
          try {
            const response = await next(ctx, request)
            return observeResponseBody(
              response,
              function endedBody(end): void {
                annotateBodySpan(span, end, false)
                endSpan()
              },
              { startedAt }
            )
          } catch (value) {
            failSpan(span, ctx, value, "application_error")
            endSpan()
            throw value
          }
        }
      )
    }
  }
}

/** Creates unary Server middleware with fixed OpenTelemetry request metrics. */
export function measureUnaryMiddleware(metrics: RequestMetrics): Middleware {
  validateRequestMetrics(metrics)
  return (next) => {
    if (typeof next !== "function") throw new TypeError("unary handler must be a function")
    return async (ctx, request) => {
      const [serviceName, endpointName] = operationIdentity(ctx)
      const complete = startMeasurement(metrics, "server", `${serviceName}/${endpointName}`)
      let recorded = false
      /** Records the server operation once. */
      function finish(outcome: "success" | "failure" | "canceled"): void {
        if (recorded) return
        recorded = true
        complete(outcome)
      }
      try {
        const response = await next(ctx, request)
        return observeResponseBody(
          response,
          function ended(end): void {
            if (end.reason === "cancel" || end.status.kind === "canceled") {
              finish("canceled")
              return
            }
            if (end.stream && end.status.kind !== "success") {
              finish("failure")
              return
            }
            finish("success")
          },
          { startedAt: performance.now() }
        )
      } catch (value) {
        finish(contextOutcome(ctx))
        throw value
      }
    }
  }
}

/** Distinguishes an asynchronous Web Handler result without inspecting the Response realm. */
function isResponsePromise(value: Response | Promise<Response>): value is Promise<Response> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false
  return "then" in value && typeof value.then === "function"
}

/** Completes and ends one Web span when its body ends, preserving a null body. */
function completeWebResponse(span: Span, response: Response, startedAt: number): Response {
  let ended = false
  /** Ends the Web span once. */
  function endSpan(): void {
    if (ended) return
    ended = true
    span.end()
  }
  return observeResponseBody(
    response,
    function endedBody(end): void {
      annotateBodySpan(span, end, true)
      endSpan()
    },
    { startedAt }
  )
}

/** Fails and ends one Web span before rethrowing the original value. */
function failWebRequest(span: Span, request: Request, value: unknown): never {
  try {
    failRequestSpan(span, request.signal, value, "application_error")
  } finally {
    span.end()
  }
  throw value
}

/** Wraps one standard single-argument Web Handler without taking body or runtime ownership. */
export function traceWebHandler(
  handler: (request: Request) => Response | Promise<Response>,
  tracer: Tracer,
  propagator?: TextMapPropagator<HeaderCarrier>
): (request: Request) => Response | Promise<Response> {
  if (typeof handler !== "function") throw new TypeError("Web handler must be a function")
  validateTracer(tracer)
  validatePropagator(propagator)
  const captured = handler

  return /** Runs one Web request under its extracted remote parent until response headers arrive. */ function tracedWebHandler(
    request: Request
  ): Response | Promise<Response> {
    const parent = extractRequestHeaders(request.headers, propagator)
    return tracer.startActiveSpan(
      request.method,
      {
        kind: SpanKind.SERVER,
        attributes: {
          "go-like.kind": "web",
          "http.request.method": request.method
        }
      },
      parent,
      (span) => {
        const startedAt = performance.now()
        try {
          const result = captured(request)
          if (isResponsePromise(result)) {
            return result.then(
              (response) => completeWebResponse(span, response, startedAt),
              (value) => failWebRequest(span, request, value)
            )
          }
          return completeWebResponse(span, result, startedAt)
        } catch (value) {
          return failWebRequest(span, request, value)
        }
      }
    )
  }
}
