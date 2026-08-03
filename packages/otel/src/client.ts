import type { CallOption, CallRequest, Client, ClientMiddleware } from "@likego/client"
import type { Context } from "@likego/context"
import type { Infer, Struct } from "@likego/struct"
import type { Endpoint, Message } from "@likego/transport"
import { SpanKind, type TextMapPropagator, type Tracer } from "@opentelemetry/api"

import {
  contextOutcome,
  failSpan,
  injectHeaders,
  injectClientContext,
  startMeasurement,
  succeedSpan,
  validatePropagator,
  validateRequestMetrics,
  validateTracer,
  type HeaderCarrier,
  type RequestMetrics
} from "./instrumentation"

/** Calls one raw Client endpoint. */
type RawClientCall = (
  ctx: Context,
  request: CallRequest,
  ...options: readonly CallOption[] /* likego-typed-rest: preserves call options. */
) => Promise<Message>

/** Calls one runtime-erased typed Client endpoint. */
type TypedClientCall = (
  ctx: Context,
  endpoint: Endpoint,
  request: unknown,
  ...options: readonly CallOption[] /* likego-typed-rest: preserves call options. */
) => Promise<unknown>

/** Invokes one captured overload with a selected Context and optional raw request replacement. */
type ClientInvocation = (ctx: Context, request?: CallRequest) => Promise<unknown>

/** Decorates one complete Client call without reimplementing its codec boundary. */
type ClientDecorator = (
  ctx: Context,
  endpoint: CallRequest | Endpoint,
  invoke: ClientInvocation
) => Promise<unknown>

/** Creates one stable client span name from the declared service operation. */
function clientSpanName(request: CallRequest | Endpoint): string {
  return `likego.client ${request.service}/${request.endpoint}`
}

/** Rejects a value that cannot preserve the complete public Client contract. */
function validateClient(client: Client): void {
  const candidate: unknown = client
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof client.call !== "function" ||
    typeof client.close !== "function"
  ) {
    throw new TypeError("client must implement the LikeGo Client interface")
  }
}

/** Reports whether one runtime value carries the raw call request shape. */
function isCallRequest(value: unknown): value is CallRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "service" in value &&
    typeof value.service === "string" &&
    "endpoint" in value &&
    typeof value.endpoint === "string" &&
    "message" in value
  )
}

/** Reports whether one runtime value carries a typed endpoint shape. */
function isEndpoint(value: unknown): value is Endpoint {
  return (
    typeof value === "object" &&
    value !== null &&
    "service" in value &&
    typeof value.service === "string" &&
    "endpoint" in value &&
    typeof value.endpoint === "string" &&
    "request" in value &&
    typeof value.request === "object" &&
    value.request !== null &&
    "response" in value &&
    typeof value.response === "object" &&
    value.response !== null
  )
}

/** Reports whether one runtime value is a Client call option. */
function isCallOption(value: unknown): value is CallOption {
  return typeof value === "function"
}

/** Copies and validates one runtime argument suffix as Client call options. */
function runtimeCallOptions(values: readonly unknown[], start: number): readonly CallOption[] {
  const options: CallOption[] = []
  for (let index = start; index < values.length; index += 1) {
    const option = values[index]
    if (!isCallOption(option)) throw new TypeError("Client call option must be a function")
    options.push(option)
  }
  return options
}

/** Restores both Client overloads while delegating codec and retry semantics to the wrapped Client. */
function wrapClient(client: Client, decorate: ClientDecorator): Client {
  const rawCall: RawClientCall = client.call
  const typedCall: TypedClientCall = client.call
  const close = client.close

  /** Calls one typed endpoint while preserving the wrapped Client contract. */
  function call<RequestStruct extends Struct, ResponseStruct extends Struct>(
    ctx: Context,
    endpoint: Endpoint<RequestStruct, ResponseStruct>,
    request: NoInfer<Infer<RequestStruct>>,
    ...options: readonly CallOption[] /* likego-typed-rest: preserves call options. */
  ): Promise<Infer<ResponseStruct>>

  /** Calls one raw Message endpoint. */
  function call(
    ctx: Context,
    request: CallRequest,
    ...options: readonly CallOption[] /* likego-typed-rest: preserves call options. */
  ): Promise<Message>

  /** Dispatches one raw or typed call through the original Client receiver. */
  async function call(ctx: Context, subject: unknown, _first?: unknown): Promise<unknown> {
    const values: unknown[] = []
    for (let index = 2; index < arguments.length; index += 1) values.push(arguments[index])

    if (isCallRequest(subject)) {
      const request = subject
      const options = runtimeCallOptions(values, 0)
      /** Invokes the captured raw overload with the decorated Context. */
      async function invokeRaw(callContext: Context, replacement?: CallRequest): Promise<unknown> {
        const callArguments: [Context, CallRequest, ...CallOption[]] = [
          callContext,
          replacement ?? request
        ]
        for (const option of options) callArguments.push(option)
        return await rawCall.apply(client, callArguments)
      }
      return await decorate(ctx, request, invokeRaw)
    }

    if (!isEndpoint(subject)) throw new TypeError("Client call requires a request or Endpoint")
    const endpoint = subject
    if (values.length === 0) throw new TypeError("Client typed call requires a request value")
    const request = values[0]
    const options = runtimeCallOptions(values, 1)
    /** Invokes the captured typed overload with the decorated Context. */
    async function invokeTyped(callContext: Context): Promise<unknown> {
      const callArguments: [Context, Endpoint, unknown, ...CallOption[]] = [
        callContext,
        endpoint,
        request
      ]
      for (const option of options) callArguments.push(option)
      return await typedCall.apply(client, callArguments)
    }
    return await decorate(ctx, endpoint, invokeTyped)
  }

  return Object.freeze({
    call,
    /** Closes the wrapped Client through its original receiver without instrumentation. */
    close(ctx: Context): Promise<void> {
      return close.call(client, ctx)
    }
  })
}

/** Wraps one unary Client with explicit W3C-compatible propagation and spans. */
export function traceClient(
  client: Client,
  tracer: Tracer,
  propagator?: TextMapPropagator<HeaderCarrier>
): Client {
  validateClient(client)
  validateTracer(tracer)
  validatePropagator(propagator)

  /** Traces one complete raw or typed call and injects propagation through LikeGo metadata. */
  async function traced(
    ctx: Context,
    endpoint: CallRequest | Endpoint,
    invoke: ClientInvocation
  ): Promise<unknown> {
    return await tracer.startActiveSpan(
      clientSpanName(endpoint),
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "likego.kind": "client",
          "likego.service": endpoint.service,
          "likego.endpoint": endpoint.endpoint
        }
      },
      async (span) => {
        try {
          let propagated = ctx
          let request: CallRequest | undefined
          if (isCallRequest(endpoint)) {
            request = {
              service: endpoint.service,
              endpoint: endpoint.endpoint,
              message: {
                header: injectHeaders(endpoint.message.header, propagator),
                body: endpoint.message.body
              }
            }
          } else {
            propagated = injectClientContext(ctx, propagator)
          }
          const response = await invoke(propagated, request)
          succeedSpan(span)
          return response
        } catch (value) {
          failSpan(span, ctx, value, "transport_error")
          throw value
        } finally {
          span.end()
        }
      }
    )
  }

  return wrapClient(client, traced)
}

/** Wraps one Client with fixed OpenTelemetry request metrics. */
export function measureClient(client: Client, metrics: RequestMetrics): Client {
  validateClient(client)
  validateRequestMetrics(metrics)

  /** Measures one complete raw or typed call without replacing its result. */
  async function measured(
    ctx: Context,
    endpoint: CallRequest | Endpoint,
    invoke: ClientInvocation
  ): Promise<unknown> {
    const complete = startMeasurement(metrics, "client", `${endpoint.service}/${endpoint.endpoint}`)
    try {
      const response = await invoke(ctx)
      complete("success")
      return response
    } catch (value) {
      complete(contextOutcome(ctx))
      throw value
    }
  }

  return wrapClient(client, measured)
}

/** Decorates one raw Client call with fixed OpenTelemetry request metrics. */
function measureRawCall(
  metrics: RequestMetrics,
  next: (ctx: Context, request: CallRequest, options: readonly CallOption[]) => Promise<Message>
): (ctx: Context, request: CallRequest, options: readonly CallOption[]) => Promise<Message> {
  /** Measures one logical raw call without replacing its result or failure. */
  async function measuredRawCall(
    ctx: Context,
    request: CallRequest,
    options: readonly CallOption[]
  ): Promise<Message> {
    const complete = startMeasurement(metrics, "client", `${request.service}/${request.endpoint}`)
    try {
      const response = await next(ctx, request, options)
      complete("success")
      return response
    } catch (value) {
      complete(contextOutcome(ctx))
      throw value
    }
  }
  return measuredRawCall
}

/** Creates Client middleware with fixed OpenTelemetry request metrics. */
export function measureClientMiddleware(metrics: RequestMetrics): ClientMiddleware {
  validateRequestMetrics(metrics)
  return (next) => {
    if (typeof next !== "function") throw new TypeError("client handler must be a function")
    /** Adapts the Client middleware tail to the shared measured raw path. */
    async function nextRaw(
      ctx: Context,
      request: CallRequest,
      options: readonly CallOption[]
    ): Promise<Message> {
      const callArguments: [Context, CallRequest, ...CallOption[]] = [ctx, request]
      for (const option of options) callArguments.push(option)
      return await next.apply(undefined, callArguments)
    }
    const measured = measureRawCall(metrics, nextRaw)
    /** Preserves every ordered Client middleware CallOption. */
    async function measuredClientCall(
      ctx: Context,
      request: CallRequest,
      ...options: readonly CallOption[] /* likego-typed-rest: preserves call options. */
    ): Promise<Message> {
      return await measured(ctx, request, options)
    }
    return measuredClientCall
  }
}
