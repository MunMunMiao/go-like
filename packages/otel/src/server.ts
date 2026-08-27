import type { Middleware } from "@go-like/server"
import { endpoint, request as service } from "@go-like/transport/headers"
import { SpanKind, type Span, type TextMapPropagator, type Tracer } from "@opentelemetry/api"

import {
  contextOutcome,
  extractServerContext,
  extractRequestHeaders,
  failSpan,
  failRequestSpan,
  completeResponseSpan,
  routeField,
  startMeasurement,
  succeedSpan,
  validatePropagator,
  validateRequestMetrics,
  validateTracer,
  type HeaderCarrier,
  type RequestMetrics
} from "./instrumentation"

/** Creates one ordinary unary middleware with explicit remote-parent extraction. */
export function traceUnaryMiddleware(
  tracer: Tracer,
  propagator?: TextMapPropagator<HeaderCarrier>
): Middleware {
  validateTracer(tracer)
  validatePropagator(propagator)

  return (next) => {
    if (typeof next !== "function") throw new TypeError("unary handler must be a function")
    return async (ctx, message) => {
      const serviceName = routeField(message.header, service)
      const endpointName = routeField(message.header, endpoint)
      const parent = extractServerContext(ctx, message.header, propagator)
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
          try {
            const response = await next(ctx, message)
            succeedSpan(span)
            return response
          } catch (value) {
            failSpan(span, ctx, value, "application_error")
            throw value
          } finally {
            span.end()
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
    return async (ctx, message) => {
      const serviceName = routeField(message.header, service)
      const endpointName = routeField(message.header, endpoint)
      const complete = startMeasurement(metrics, "server", `${serviceName}/${endpointName}`)
      try {
        const response = await next(ctx, message)
        complete("success")
        return response
      } catch (value) {
        complete(contextOutcome(ctx))
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

/** Completes and ends one successful Web span while preserving Response identity. */
function completeWebResponse(span: Span, response: Response): Response {
  try {
    completeResponseSpan(span, response)
    return response
  } finally {
    span.end()
  }
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
        try {
          const result = captured(request)
          if (isResponsePromise(result)) {
            return result.then(
              (response) => completeWebResponse(span, response),
              (value) => failWebRequest(span, request, value)
            )
          }
          return completeWebResponse(span, result)
        } catch (value) {
          return failWebRequest(span, request, value)
        }
      }
    )
  }
}
