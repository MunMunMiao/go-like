import type { Broker, BrokerEvent, BrokerMessage, Subscriber } from "@go-like/broker"
import type { CallOption, CallRequest, Client } from "@go-like/client"
import type { Context } from "@go-like/context"
import type { Middleware } from "@go-like/server"
import type { Infer, Struct } from "@go-like/struct"
import {
  fromServerContext,
  observeResponseBody,
  type Endpoint,
  type ResponseBodyEnd,
  type ServerStream
} from "@go-like/transport"
import { observeCall } from "@go-like/transport/provider"
import type { Handler } from "@go-like/web"
import { Counter, Histogram, Registry, type RegistryContentType } from "prom-client"

export type RequestComponent = "broker" | "client" | "server" | "web"
export type RequestMetricLabel = "component" | "operation" | "outcome"
export type StreamMessageLabel = "component" | "operation" | "direction"
export type RequestOutcome = "canceled" | "failure" | "success"

/** Holds the official prom-client collectors used by go-like request instrumentation. */
export interface RequestMetrics {
  readonly requestsTotal: Counter<RequestMetricLabel>
  readonly requestDurationSeconds: Histogram<RequestMetricLabel>
  /** Counts server-stream messages. Absent on adapters that only implement unary collectors. */
  readonly streamMessagesTotal?: Counter<StreamMessageLabel>
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

/** Classifies a terminal body for a client or server operation. */
function outcomeFromEnd(
  end: ResponseBodyEnd | null,
  failure: unknown,
  ctx: Context
): RequestOutcome {
  if (failure !== null) return contextOutcome(ctx)
  if (end === null) return "success"
  if (end.reason === "cancel" || end.status.kind === "canceled") return "canceled"
  if (end.stream && end.status.kind !== "success") return "failure"
  return "success"
}

/** Adds sent or received stream messages when the collector exists. */
function recordStreamMessages(
  metrics: RequestMetrics,
  component: RequestComponent,
  operation: string,
  direction: "received" | "sent",
  end: ResponseBodyEnd | null
): void {
  if (end?.stream !== true || end.messageCount <= 0 || metrics.streamMessagesTotal === undefined) {
    return
  }
  try {
    metrics.streamMessagesTotal.inc({ component, operation, direction }, end.messageCount)
  } catch {
    // Metrics must not replace the wrapped operation's result.
  }
}

/** Classifies a failed Context-owned operation without inspecting its error. */
function contextOutcome(ctx: Context): RequestOutcome {
  try {
    return ctx.err() === null ? "failure" : "canceled"
  } catch {
    return "failure"
  }
}

/** Creates one bounded server operation from TransportInfo, never from request headers. */
function serverOperation(ctx: Context): string {
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
  const serviceName = operation.length === 0 || service.length === 0 ? UnknownRoute : service
  const endpointName = operation.length === 0 || endpoint.length === 0 ? UnknownRoute : endpoint
  return `${serviceName}/${endpointName}`
}

/** Distinguishes an asynchronous Web Handler result without changing synchronous semantics. */
function isResponsePromise(value: Response | Promise<Response>): value is Promise<Response> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false
  return "then" in value && typeof value.then === "function"
}

/** Classifies one failed Web request without inspecting the rejection value. */
function webFailureOutcome(request: Request): RequestOutcome {
  return request.signal.aborted ? "canceled" : "failure"
}

/** Creates the fixed low-cardinality request collectors in an application-owned registry. */
export function newRequestMetrics(registry: Registry<RegistryContentType>): RequestMetrics {
  const requestsTotal = new Counter<RequestMetricLabel>({
    name: "go_like_requests_total",
    help: "Total completed go-like requests.",
    labelNames: ["component", "operation", "outcome"],
    registers: [registry]
  })
  const requestDurationSeconds = new Histogram<RequestMetricLabel>({
    name: "go_like_request_duration_seconds",
    help: "Duration of completed go-like requests in seconds.",
    labelNames: ["component", "operation", "outcome"],
    registers: [registry]
  })
  const streamMessagesTotal = new Counter<StreamMessageLabel>({
    name: "go_like_stream_messages_total",
    help: "Total go-like server-stream messages sent or received.",
    labelNames: ["component", "operation", "direction"],
    registers: [registry]
  })
  return Object.freeze({ requestsTotal, requestDurationSeconds, streamMessagesTotal })
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
    throw new TypeError("client must implement the go-like Client interface")
  }
  validateRequestMetrics(metrics)
  const call = client.call
  const close = client.close

  /** Measures one typed Client call. */
  function measuredCall<RequestStruct extends Struct, ResponseStruct extends Struct>(
    ctx: Context,
    endpoint: Endpoint<RequestStruct, ResponseStruct>,
    request: NoInfer<Infer<RequestStruct>>,
    ...options: readonly CallOption[] /* go-like-typed-rest: preserves the Client call ABI. */
  ): Promise<Infer<ResponseStruct>>

  /** Measures one raw Client call. */
  function measuredCall(
    ctx: Context,
    request: CallRequest,
    ...options: readonly CallOption[] /* go-like-typed-rest: preserves the Client call ABI. */
  ): Promise<Response>

  /** Measures either public Client call overload through the original receiver. */
  async function measuredCall(
    ctx: Context,
    subject: CallRequest | Endpoint,
    _first?: unknown
  ): Promise<unknown> {
    const values: unknown[] = []
    for (let index = 2; index < arguments.length; index += 1) {
      values.push(arguments[index])
    }
    const complete = startMeasurement(metrics, "client", `${subject.service}/${subject.endpoint}`)
    const callArguments: unknown[] = [ctx, subject]
    for (const value of values) callArguments.push(value)
    return await observeCall(
      ctx,
      performance.now(),
      function invoke(callContext: Context): Promise<unknown> {
        const args = callArguments.slice()
        args[0] = callContext
        return Reflect.apply(call, client, args)
      },
      function record(end, failure): void {
        complete(outcomeFromEnd(end, failure, ctx))
        recordStreamMessages(
          metrics,
          "client",
          `${subject.service}/${subject.endpoint}`,
          "received",
          end
        )
      }
    )
  }

  /** Measures one server stream through the original receiver. */
  async function measuredStream<RequestStruct extends Struct, ResponseStruct extends Struct>(
    ctx: Context,
    endpoint: Endpoint<RequestStruct, ResponseStruct, true>,
    request: NoInfer<Infer<RequestStruct>>,
    ...options: readonly CallOption[] /* go-like-typed-rest: preserves the Client call ABI. */
  ): Promise<ServerStream<Infer<ResponseStruct>>> {
    if (typeof client.stream !== "function") throw new TypeError("client must implement stream")
    const operation = `${endpoint.service}/${endpoint.endpoint}`
    const complete = startMeasurement(metrics, "client", operation)
    return (await observeCall(
      ctx,
      performance.now(),
      function invoke(callContext: Context): Promise<unknown> {
        const args: [
          Context,
          Endpoint<RequestStruct, ResponseStruct, true>,
          NoInfer<Infer<RequestStruct>>,
          ...CallOption[]
        ] = [callContext, endpoint, request, ...options]
        return client.stream!.apply(client, args)
      },
      function record(end, failure): void {
        complete(outcomeFromEnd(end, failure, ctx))
        recordStreamMessages(metrics, "client", operation, "received", end)
      }
    )) as ServerStream<Infer<ResponseStruct>>
  }

  return Object.freeze({
    call: measuredCall,
    stream: measuredStream,
    /** Closes the native Client through its original receiver without recording a request. */
    close(ctx: Context): Promise<void> {
      return close.call(client, ctx)
    }
  })
}

/** Creates unary Server middleware that records the TransportInfo operation. */
export function measureUnaryMiddleware(metrics: RequestMetrics): Middleware {
  validateRequestMetrics(metrics)
  return (next) => {
    if (typeof next !== "function") throw new TypeError("unary handler must be a function")
    return async (ctx, request) => {
      const operation = serverOperation(ctx)
      const complete = startMeasurement(metrics, "server", operation)
      try {
        const response = await next(ctx, request)
        return observeResponseBody(
          response,
          function ended(end): void {
            complete(outcomeFromEnd(end, null, ctx))
            recordStreamMessages(metrics, "server", operation, "sent", end)
          },
          { startedAt: performance.now() }
        )
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
    /** Completes a response when its body ends, preserving a null body. */
    function resolveResponse(response: Response): Response {
      return observeResponseBody(
        response,
        function ended(end): void {
          if (request.signal.aborted || end.reason === "cancel" || end.status.kind === "canceled") {
            complete("canceled")
          } else if (end.stream) {
            complete(end.status.kind === "success" ? "success" : "failure")
            recordStreamMessages(metrics, "web", request.method, "sent", end)
          } else {
            complete(end.httpStatus >= 500 ? "failure" : "success")
          }
        },
        { startedAt: performance.now() }
      )
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
    throw new TypeError("broker must implement the go-like Broker interface")
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
      const complete = startMeasurement(metrics, "broker", "publish")
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
      handler: (ctx: Context, event: BrokerEvent<NativeEvent>) => void | Promise<void>,
      options?: SubscribeOptions
    ): Promise<Subscriber> {
      if (typeof handler !== "function") throw new TypeError("broker handler must be a function")
      /** Records one native delivery without replacing its event or failure. */
      async function measuredHandler(
        eventContext: Context,
        event: BrokerEvent<NativeEvent>
      ): Promise<void> {
        const complete = startMeasurement(metrics, "broker", "consume")
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
  const normalized = new URL(path, "http://go-like.invalid").pathname
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
 * Adapts one application-owned prom-client Registry to the standard go-like Web Handler ABI.
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
