import type { CallOption, CallRequest, Client, ClientMiddleware } from "@go-like/client"
import type { Context } from "@go-like/context"
import type { Infer, Struct } from "@go-like/struct"
import type { Endpoint, ServerStream } from "@go-like/transport"
import { observeCall } from "@go-like/transport/provider"
import { SpanKind, type TextMapPropagator, type Tracer } from "@opentelemetry/api"

import {
  annotateBodySpan,
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
  ...options: readonly CallOption[] /* go-like-typed-rest: preserves call options. */
) => Promise<Response>

/** Calls one runtime-erased typed Client endpoint. */
type TypedClientCall = (
  ctx: Context,
  endpoint: Endpoint,
  request: unknown,
  ...options: readonly CallOption[] /* go-like-typed-rest: preserves call options. */
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
  return `go-like.client ${request.service}/${request.endpoint}`
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
    throw new TypeError("client must implement the go-like Client interface")
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
    "headers" in value &&
    "body" in value
  )
}

/** Reports whether headers are a plain record rather than a Fetch header list. */
function isHeaderRecord(headers: HeadersInit): headers is Record<string, string> {
  return (
    typeof headers === "object" &&
    headers !== null &&
    !Array.isArray(headers) &&
    !(headers instanceof Headers)
  )
}

/** Copies one plain header record without dropping own keys such as __proto__. */
function copyHeaderRecord(
  headers: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  const record: Record<string, string> = {}
  for (const key of Object.keys(headers)) {
    Object.defineProperty(record, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: headers[key]
    })
  }
  return record
}

/** Copies Fetch headers into the immutable record consumed by propagators. */
function copyHeaderList(headers: Headers): Readonly<Record<string, string>> {
  const record: Record<string, string> = {}
  headers.forEach((value, key) => {
    record[key] = value
  })
  return record
}

/** Normalizes CallRequest headers before propagation injection. */
function callHeaders(headers: HeadersInit): Readonly<Record<string, string>> {
  if (isHeaderRecord(headers)) return copyHeaderRecord(headers)
  return copyHeaderList(new Headers(headers))
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
    ...options: readonly CallOption[] /* go-like-typed-rest: preserves call options. */
  ): Promise<Infer<ResponseStruct>>

  /** Calls one raw Fetch endpoint. */
  function call(
    ctx: Context,
    request: CallRequest,
    ...options: readonly CallOption[] /* go-like-typed-rest: preserves call options. */
  ): Promise<Response>

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

  /** Opens one server stream through the original receiver and the same decorator. */
  async function stream<RequestStruct extends Struct, ResponseStruct extends Struct>(
    ctx: Context,
    endpoint: Endpoint<RequestStruct, ResponseStruct, true>,
    request: NoInfer<Infer<RequestStruct>>,
    ...options: readonly CallOption[] /* go-like-typed-rest: preserves call options. */
  ): Promise<ServerStream<Infer<ResponseStruct>>> {
    if (typeof client.stream !== "function") {
      throw new TypeError("client must implement stream")
    }
    const values = runtimeCallOptions(options, 0)
    /** Invokes the captured stream method with the decorated Context. */
    async function invokeStream(callContext: Context): Promise<unknown> {
      const callArguments: [
        Context,
        Endpoint<RequestStruct, ResponseStruct, true>,
        NoInfer<Infer<RequestStruct>>,
        ...CallOption[]
      ] = [callContext, endpoint, request]
      for (const option of values) callArguments.push(option)
      return await client.stream!.apply(client, callArguments)
    }
    return (await decorate(ctx, endpoint, invokeStream)) as ServerStream<Infer<ResponseStruct>>
  }

  return Object.freeze({
    call,
    stream,
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

  /** Traces one complete raw or typed call and injects propagation through go-like metadata. */
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
          "go-like.kind": "client",
          "go-like.service": endpoint.service,
          "go-like.endpoint": endpoint.endpoint
        }
      },
      async (span) => {
        const startedAt = performance.now()
        let ended = false
        /** Ends the client span once. */
        function endSpan(): void {
          if (ended) return
          ended = true
          span.end()
        }
        let propagated = ctx
        let request: CallRequest | undefined
        if (isCallRequest(endpoint)) {
          request = {
            service: endpoint.service,
            endpoint: endpoint.endpoint,
            headers: injectHeaders(callHeaders(endpoint.headers), propagator),
            body: endpoint.body
          }
        } else {
          propagated = injectClientContext(ctx, propagator)
        }
        return await observeCall(
          propagated,
          startedAt,
          function invokeObserved(callContext: Context): Promise<unknown> {
            return invoke(callContext, request)
          },
          function record(end, failure): void {
            try {
              if (failure !== null) failSpan(span, ctx, failure, "transport_error")
              else if (end !== null) annotateBodySpan(span, end, false)
              else succeedSpan(span)
            } finally {
              endSpan()
            }
          }
        )
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
    let recorded = false
    /** Records the logical call once. */
    function finish(outcome: "success" | "failure" | "canceled"): void {
      if (recorded) return
      recorded = true
      complete(outcome)
    }
    return await observeCall(
      ctx,
      performance.now(),
      function invokeObserved(callContext: Context): Promise<unknown> {
        return invoke(callContext)
      },
      function record(end, failure): void {
        if (failure !== null) {
          finish(contextOutcome(ctx))
          return
        }
        if (end?.reason === "cancel" || end?.status.kind === "canceled") {
          finish("canceled")
          return
        }
        if (end?.stream === true && end.status.kind !== "success") {
          finish("failure")
          return
        }
        finish("success")
      }
    )
  }

  return wrapClient(client, measured)
}

/** Decorates one raw Client call with fixed OpenTelemetry request metrics. */
function measureRawCall(
  metrics: RequestMetrics,
  next: (ctx: Context, request: CallRequest, options: readonly CallOption[]) => Promise<Response>
): (ctx: Context, request: CallRequest, options: readonly CallOption[]) => Promise<Response> {
  /** Measures one logical raw call without replacing its result or failure. */
  async function measuredRawCall(
    ctx: Context,
    request: CallRequest,
    options: readonly CallOption[]
  ): Promise<Response> {
    const complete = startMeasurement(metrics, "client", `${request.service}/${request.endpoint}`)
    let recorded = false
    /** Records the logical raw call once. */
    function finish(outcome: "success" | "failure" | "canceled"): void {
      if (recorded) return
      recorded = true
      complete(outcome)
    }
    return (await observeCall(
      ctx,
      performance.now(),
      function invokeRaw(callContext: Context): Promise<unknown> {
        return next(callContext, request, options)
      },
      function record(end, failure): void {
        if (failure !== null) {
          finish(contextOutcome(ctx))
          return
        }
        if (end?.reason === "cancel" || end?.status.kind === "canceled") {
          finish("canceled")
          return
        }
        if (end?.stream === true && end.status.kind !== "success") {
          finish("failure")
          return
        }
        finish("success")
      }
    )) as Promise<Response>
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
    ): Promise<Response> {
      const callArguments: [Context, CallRequest, ...CallOption[]] = [ctx, request]
      for (const option of options) callArguments.push(option)
      return await next.apply(undefined, callArguments)
    }
    const measured = measureRawCall(metrics, nextRaw)
    /** Preserves every ordered Client middleware CallOption. */
    async function measuredClientCall(
      ctx: Context,
      request: CallRequest,
      ...options: readonly CallOption[] /* go-like-typed-rest: preserves call options. */
    ): Promise<Response> {
      return await measured(ctx, request, options)
    }
    return measuredClientCall
  }
}
