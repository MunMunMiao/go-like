import type { Broker, BrokerEvent, BrokerMessage, Subscriber } from "@likego/broker"
import type { CallOption, CallRequest, Client } from "@likego/client"
import type { Context } from "@likego/context"
import type { Middleware } from "@likego/server"
import type { Endpoint, Message } from "@likego/transport"
import { endpoint, request as service } from "@likego/transport/headers"
import type { Handler } from "@likego/web"
import { Counter, Histogram, Registry, type RegistryContentType } from "prom-client"

export type RequestComponent = "broker" | "client" | "server" | "web"
export type RequestMetricLabel = "component" | "operation" | "outcome"
export type RequestOutcome = "canceled" | "failure" | "success"

/** Holds the two official prom-client collectors used by LikeGo request instrumentation. */
export interface RequestMetrics {
  readonly requestsTotal: Counter<RequestMetricLabel>
  readonly requestDurationSeconds: Histogram<RequestMetricLabel>
}

export interface PrometheusHandlerOptions {
  /** Selects the exact URL pathname served by the Web Handler. */
  readonly path?: string
}

interface ScrapeRegistry {
  readonly contentType: RegistryContentType
  /** Collects the current registry using the official prom-client contract. */
  metrics(): Promise<string>
}

const DefaultPath = "/metrics"
const CacheControl = "no-store"
const PlainTextContentType = "text/plain; charset=utf-8"
const MetricsUnavailable = "metrics unavailable\n"
const NotFound = "not found\n"
const MethodNotAllowed = "method not allowed\n"
const Encoder = new TextEncoder()
const UnknownRoute = "unknown"

/** Rejects malformed instrumentation handles before wrapping application behavior. */
function validateRequestMetrics(metrics: RequestMetrics): void {
  const candidate: unknown = metrics
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof metrics.requestsTotal?.inc !== "function" ||
    typeof metrics.requestDurationSeconds?.startTimer !== "function"
  ) {
    throw new TypeError("metrics must be created by newRequestMetrics")
  }
}

/** Starts one request duration and returns its single completion recorder. */
function startMeasurement(
  metrics: RequestMetrics,
  component: RequestComponent,
  operation: string
): (outcome: RequestOutcome) => void {
  let stopDuration:
    | ((labels?: Partial<Record<RequestMetricLabel, string | number>>) => number)
    | null
  try {
    stopDuration = metrics.requestDurationSeconds.startTimer({ component, operation })
  } catch {
    stopDuration = null
  }
  /** Records the bounded terminal outcome in both collectors. */
  function complete(outcome: RequestOutcome): void {
    const labels = { component, operation, outcome }
    try {
      metrics.requestsTotal.inc(labels)
    } catch {
      // Metrics must not replace the wrapped operation's result.
    }
    try {
      stopDuration?.({ outcome })
    } catch {
      // Metrics must not replace the wrapped operation's result.
    }
  }
  return complete
}

/** Classifies a failed Context-owned operation without inspecting its error. */
function contextOutcome(ctx: Context): RequestOutcome {
  try {
    return ctx.err() === null ? "failure" : "canceled"
  } catch {
    return "failure"
  }
}

/** Reads one reserved routing header without exposing other request metadata. */
function routeField(headers: Readonly<Record<string, string>>, expected: string): string {
  const name = expected.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) return headers[key] ?? UnknownRoute
  }
  return UnknownRoute
}

/** Creates one bounded server operation from the reserved service and endpoint headers. */
function serverOperation(headers: Readonly<Record<string, string>>): string {
  return `${routeField(headers, service)}/${routeField(headers, endpoint)}`
}

/** Distinguishes an asynchronous Web Handler result without changing synchronous semantics. */
function isResponsePromise(value: Response | Promise<Response>): value is Promise<Response> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false
  return "then" in value && typeof value.then === "function"
}

/** Classifies one completed Web response at the response-header boundary. */
function webResponseOutcome(request: Request, response: Response): RequestOutcome {
  if (request.signal.aborted) return "canceled"
  return response.status >= 500 ? "failure" : "success"
}

/** Classifies one failed Web request without inspecting the rejection value. */
function webFailureOutcome(request: Request): RequestOutcome {
  return request.signal.aborted ? "canceled" : "failure"
}

/** Creates the fixed low-cardinality request collectors in an application-owned registry. */
export function newRequestMetrics(registry: Registry<RegistryContentType>): RequestMetrics {
  const requestsTotal = new Counter<RequestMetricLabel>({
    name: "likego_requests_total",
    help: "Total completed LikeGo requests.",
    labelNames: ["component", "operation", "outcome"],
    registers: [registry]
  })
  const requestDurationSeconds = new Histogram<RequestMetricLabel>({
    name: "likego_request_duration_seconds",
    help: "Duration of completed LikeGo requests in seconds.",
    labelNames: ["component", "operation", "outcome"],
    registers: [registry]
  })
  return Object.freeze({ requestsTotal, requestDurationSeconds })
}

/** Wraps one logical Client call and records it once regardless of transport retries. */
export function measureClient(client: Client, metrics: RequestMetrics): Client {
  const candidate: unknown = client
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof client.call !== "function" ||
    typeof client.close !== "function"
  ) {
    throw new TypeError("client must implement the LikeGo Client interface")
  }
  validateRequestMetrics(metrics)
  const call = client.call
  const close = client.close

  /** Measures one typed Client call. */
  function measuredCall<Request, Response>(
    ctx: Context,
    endpoint: Endpoint<Request, Response>,
    request: NoInfer<Request>,
    ...options: readonly CallOption[] /* likego-typed-rest: preserves the Client call ABI. */
  ): Promise<Response>

  /** Measures one raw Client call. */
  function measuredCall(
    ctx: Context,
    request: CallRequest,
    ...options: readonly CallOption[] /* likego-typed-rest: preserves the Client call ABI. */
  ): Promise<Message>

  /** Measures either public Client call overload through the original receiver. */
  async function measuredCall(
    ctx: Context,
    subject: CallRequest | Endpoint<unknown, unknown>,
    _first?: unknown
  ): Promise<unknown> {
    const values: unknown[] = []
    for (let index = 2; index < arguments.length; index += 1) {
      values.push(arguments[index])
    }
    const complete = startMeasurement(metrics, "client", `${subject.service}/${subject.endpoint}`)
    const callArguments: unknown[] = [ctx, subject]
    for (const value of values) callArguments.push(value)
    try {
      const response: unknown = await Reflect.apply(call, client, callArguments)
      complete("success")
      return response
    } catch (value) {
      complete(contextOutcome(ctx))
      throw value
    }
  }

  return Object.freeze({
    call: measuredCall,
    /** Closes the native Client through its original receiver without recording a request. */
    close(ctx: Context): Promise<void> {
      return close.call(client, ctx)
    }
  })
}

/** Creates unary Server middleware that records the reserved service operation. */
export function measureUnaryMiddleware(metrics: RequestMetrics): Middleware {
  validateRequestMetrics(metrics)
  return (next) => {
    if (typeof next !== "function") throw new TypeError("unary handler must be a function")
    return async (ctx, message) => {
      const complete = startMeasurement(metrics, "server", serverOperation(message.header))
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

/** Wraps one standard Web Handler while preserving synchronous and asynchronous return semantics. */
export function measureWebHandler(handler: Handler, metrics: RequestMetrics): Handler {
  if (typeof handler !== "function") throw new TypeError("Web handler must be a function")
  validateRequestMetrics(metrics)
  const captured = handler

  /** Measures one request only until its Response headers or rejection are available. */
  function measuredWebHandler(request: Request): Response | Promise<Response> {
    const complete = startMeasurement(metrics, "web", request.method)
    /** Completes an asynchronous response without replacing its identity. */
    function resolveResponse(response: Response): Response {
      complete(webResponseOutcome(request, response))
      return response
    }
    /** Completes an asynchronous failure before preserving its rejection identity. */
    function rejectResponse(value: unknown): never {
      complete(webFailureOutcome(request))
      throw value
    }
    try {
      const result = captured(request)
      if (isResponsePromise(result)) return result.then(resolveResponse, rejectResponse)
      return resolveResponse(result)
    } catch (value) {
      return rejectResponse(value)
    }
  }

  return measuredWebHandler
}

/** Wraps Broker publish and delivery handling without taking subscription ownership. */
export function measureBroker<PublishOptions, PublishResult, SubscribeOptions, NativeEvent>(
  broker: Broker<PublishOptions, PublishResult, SubscribeOptions, NativeEvent>,
  metrics: RequestMetrics
): Broker<PublishOptions, PublishResult, SubscribeOptions, NativeEvent> {
  const candidate: unknown = broker
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof broker.publish !== "function" ||
    typeof broker.subscribe !== "function" ||
    typeof broker.string !== "function"
  ) {
    throw new TypeError("broker must implement the LikeGo Broker interface")
  }
  validateRequestMetrics(metrics)
  const publish = broker.publish
  const subscribe = broker.subscribe
  const string = broker.string

  return Object.freeze({
    /** Measures one publish while preserving its native result and receiver. */
    async publish(
      ctx: Context,
      topic: string,
      message: BrokerMessage,
      options?: PublishOptions
    ): Promise<PublishResult> {
      const complete = startMeasurement(metrics, "broker", `publish ${topic}`)
      try {
        const result =
          options === undefined
            ? await publish.call(broker, ctx, topic, message)
            : await publish.call(broker, ctx, topic, message, options)
        complete("success")
        return result
      } catch (value) {
        complete(contextOutcome(ctx))
        throw value
      }
    },

    /** Measures each consumed delivery while returning the native Subscriber unchanged. */
    async subscribe(
      ctx: Context,
      topic: string,
      handler: (ctx: Context, event: BrokerEvent<NativeEvent>) => void | PromiseLike<void>,
      options?: SubscribeOptions
    ): Promise<Subscriber> {
      if (typeof handler !== "function") throw new TypeError("broker handler must be a function")
      /** Records one native delivery without replacing its event or failure. */
      async function measuredHandler(
        eventContext: Context,
        event: BrokerEvent<NativeEvent>
      ): Promise<void> {
        const complete = startMeasurement(metrics, "broker", `consume ${topic}`)
        try {
          await handler(eventContext, event)
          complete("success")
        } catch (value) {
          complete(contextOutcome(eventContext))
          throw value
        }
      }
      return options === undefined
        ? await subscribe.call(broker, ctx, topic, measuredHandler)
        : await subscribe.call(broker, ctx, topic, measuredHandler, options)
    },

    /** Returns the wrapped broker's diagnostic name through its original receiver. */
    string(): string {
      return string.call(broker)
    }
  })
}

/** Accepts the official registry contract across duplicate prom-client installations. */
function supportsScrape(value: unknown): value is ScrapeRegistry {
  if (typeof value !== "object" || value === null) return false
  try {
    if (!("metrics" in value) || typeof value.metrics !== "function") return false
    if (!("contentType" in value)) return false
    return (
      value.contentType === Registry.PROMETHEUS_CONTENT_TYPE ||
      value.contentType === Registry.OPENMETRICS_CONTENT_TYPE
    )
  } catch {
    return false
  }
}

/** Returns the UTF-8 byte length used for an explicit HTTP Content-Length header. */
function contentLength(body: string): string {
  return String(Encoder.encode(body).byteLength)
}

/** Validates and captures one already-normalized absolute URL pathname. */
function metricsPath(value: string | undefined): string {
  const path = value ?? DefaultPath
  if (path.length === 0 || !path.startsWith("/") || path.includes("?") || path.includes("#")) {
    throw new TypeError("path must be a normalized absolute URL pathname")
  }
  const normalized = new URL(path, "http://likego.invalid").pathname
  if (normalized !== path) {
    throw new TypeError("path must be a normalized absolute URL pathname")
  }
  return path
}

/** Creates a response whose body and byte length remain correct for GET and HEAD. */
function textResponse(
  method: string,
  body: string,
  status: number,
  contentType: string,
  extraHeaders?: Readonly<Record<string, string>>
): Response {
  const headers = new Headers(extraHeaders)
  headers.set("Cache-Control", CacheControl)
  headers.set("Content-Type", contentType)
  headers.set("Content-Length", contentLength(body))
  return new Response(method === "HEAD" ? null : body, { status, headers })
}

/**
 * Adapts one application-owned prom-client Registry to the standard LikeGo Web Handler ABI.
 *
 * The handler performs a fresh registry collection for GET and HEAD. Registry lifecycle, metric
 * registration, and cleanup remain under application ownership.
 */
export function createPrometheusHandler(
  registry: Registry<RegistryContentType>,
  options?: PrometheusHandlerOptions
): Handler {
  if (!supportsScrape(registry))
    throw new TypeError("registry must support the prom-client Registry scrape contract")
  const scrapeRegistry = registry
  const path = metricsPath(options?.path)

  /** Collects one scrape while keeping collector failures out of the public response body. */
  async function prometheusHandler(request: Request): Promise<Response> {
    const method = request.method.toUpperCase()
    if (new URL(request.url).pathname !== path) {
      return textResponse(method, NotFound, 404, PlainTextContentType)
    }
    if (method !== "GET" && method !== "HEAD") {
      return textResponse(method, MethodNotAllowed, 405, PlainTextContentType, {
        Allow: "GET, HEAD"
      })
    }
    try {
      const body = await scrapeRegistry.metrics()
      return textResponse(method, body, 200, scrapeRegistry.contentType)
    } catch {
      return textResponse(method, MetricsUnavailable, 500, PlainTextContentType)
    }
  }

  return prometheusHandler
}
