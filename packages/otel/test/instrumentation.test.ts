import { describe, expect, test } from "bun:test"

import type { Broker, BrokerEvent, BrokerMessage, Subscriber } from "@likego/broker"
import { withAddress, type CallOption, type Client, type CallRequest } from "@likego/client"
import { background, withCancelCause, type Context as LikegoContext } from "@likego/context"
import { newMetadata, newServerContext } from "@likego/metadata"
import { struct } from "@likego/struct"
import { endpoint as typedEndpoint, serviceError, type Message } from "@likego/transport"
import { contentType, endpoint, metadata, request as service } from "@likego/transport/headers"
import { decodeMetadataHeader } from "@likego/transport/provider"
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
  type TextMapPropagator
} from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
  type ReadableSpan
} from "@opentelemetry/sdk-trace"

import {
  measureClient,
  traceBroker,
  traceClient,
  traceUnaryMiddleware,
  traceWebHandler,
  type RequestMetrics
} from "../src/index"
import type { HeaderCarrier } from "../src/instrumentation"
import { newLoopbackClient } from "./client-fixture"

interface NativeEvent {
  readonly sequence: number
}

interface PublishOptions {
  readonly durable: boolean
}

interface SubscribeOptions {
  readonly queue: string
}

interface StreamingRequestInit extends RequestInit {
  readonly duplex: "half"
}

const secretSentinel = "LIKEGO_SECRET_SENTINEL"

/** Creates one secret-bearing Error with valid bounded diagnostic identifiers. */
function secretFailure(name = "SensitiveError", code = "LIKEGO_TEST_FAILURE"): Error {
  const failure = new Error(secretSentinel, { cause: new Error(secretSentinel) })
  failure.name = name
  failure.stack = `${secretSentinel}_STACK`
  Object.defineProperty(failure, "code", { enumerable: true, value: code })
  return failure
}

/** Creates one Error whose diagnostic getters throw secret-bearing failures. */
function hostileFailure(): Error {
  const failure = new Error(secretSentinel, { cause: new Error(secretSentinel) })
  failure.stack = `${secretSentinel}_STACK`
  Object.defineProperties(failure, {
    name: {
      get(): never {
        throw new Error(`${secretSentinel}_NAME`)
      }
    },
    code: {
      get(): never {
        throw new Error(`${secretSentinel}_CODE`)
      }
    }
  })
  return failure
}

/** Creates one stable native subscription handle. */
function subscriptionHandle(topic: string): Subscriber {
  return Object.freeze({
    topic,
    unsubscribe(): Promise<void> {
      return Promise.resolve()
    }
  })
}

/** Finds one unique finished span by name. */
function spanNamed(spans: readonly ReadableSpan[], name: string): ReadableSpan {
  const matching = spans.filter((span) => span.name === name)
  expect(matching).toHaveLength(1)
  const found = matching[0]
  if (found === undefined) throw new Error(`span is missing: ${name}`)
  return found
}

/** Returns one required value captured through an asynchronous callback. */
function required<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`${label} is missing`)
  return value
}

describe("explicit OpenTelemetry instrumentation", () => {
  test("propagates one official trace through Client, unary Server, publish, and consume", async () => {
    context.disable()
    propagation.disable()
    const manager = new AsyncLocalStorageContextManager().enable()
    expect(context.setGlobalContextManager(manager)).toBe(true)
    expect(propagation.setGlobalPropagator(new W3CTraceContextPropagator())).toBe(true)
    const exporter = new InMemorySpanExporter()
    const provider = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter })]
    })
    const tracer = provider.getTracer("likego-instrumentation-test")
    const ctx = background()
    const nativeSubscription = subscriptionHandle("orders.created")
    const nativePublishResult = Object.freeze({ sequence: 41 })
    const nativeEvent = Object.freeze({ sequence: 42 })
    const captured: {
      delivery:
        | ((ctx: LikegoContext, event: BrokerEvent<NativeEvent>) => void | PromiseLike<void>)
        | null
      publishedMessage: BrokerMessage | null
      deliveredEvent: BrokerEvent<NativeEvent> | null
      transported: CallRequest | null
      response: Message | null
    } = {
      delivery: null,
      publishedMessage: null,
      deliveredEvent: null,
      transported: null,
      response: null
    }
    let stringReceiver = false
    const rawBroker: Broker<
      PublishOptions,
      typeof nativePublishResult,
      SubscribeOptions,
      NativeEvent
    > & {
      readonly marker: string
    } = {
      marker: "native-broker",
      async publish(_ctx, topic, message, options) {
        expect(this.marker).toBe("native-broker")
        expect(topic).toBe("orders.created")
        expect(options).toEqual({ durable: true })
        captured.publishedMessage = message
        const event = Object.freeze({ topic, message, native: nativeEvent })
        await context.with(ROOT_CONTEXT, async () => {
          await required(captured.delivery, "delivery handler")(_ctx, event)
        })
        return nativePublishResult
      },
      async subscribe(_ctx, topic, handler, options) {
        expect(this.marker).toBe("native-broker")
        expect(topic).toBe("orders.created")
        expect(options).toEqual({ queue: "workers" })
        captured.delivery = handler
        return nativeSubscription
      },
      string() {
        stringReceiver = this.marker === "native-broker"
        return "native-broker"
      }
    }
    const broker = traceBroker(rawBroker, tracer)
    expect(broker.string()).toBe("native-broker")
    expect(stringReceiver).toBe(true)
    expect(
      await broker.subscribe(
        ctx,
        "orders.created",
        async (_eventContext, event) => {
          captured.deliveredEvent = event
          await Promise.resolve()
          expect(trace.getSpan(context.active())?.spanContext().traceId).toBeDefined()
        },
        { queue: "workers" }
      )
    ).toBe(nativeSubscription)

    const brokerBody = new Uint8Array([4, 2])
    const serverResponse: Message = Object.freeze({
      header: Object.freeze({ result: "ok" }),
      body: new Uint8Array([9])
    })
    const serverHandler = traceUnaryMiddleware(tracer)(async (requestContext, incoming) => {
      const result = await broker.publish(
        requestContext,
        "orders.created",
        {
          headers: { caller: "kept", TraceParent: "stale", tracestate: "stale" },
          body: brokerBody
        },
        { durable: true }
      )
      expect(result).toBe(nativePublishResult)
      expect(incoming.header.caller).toBe("kept")
      return serverResponse
    })
    const inputBody = new Uint8Array([1, 2, 3])
    const input: CallRequest = {
      service: "catalog",
      endpoint: "CreateOrder",
      message: {
        header: { caller: "kept", TraceParent: "stale", tracestate: "stale" },
        body: inputBody
      }
    }
    const rawClient = {
      marker: "native-client",
      async call(
        this: { readonly marker: string },
        requestContext: LikegoContext,
        request: CallRequest
      ) {
        expect(this.marker).toBe("native-client")
        captured.transported = request
        return await context.with(ROOT_CONTEXT, async () => {
          return await serverHandler(requestContext, {
            header: {
              ...request.message.header,
              [service]: request.service,
              [endpoint]: request.endpoint
            },
            body: request.message.body
          })
        })
      },
      async close(this: { readonly marker: string }) {
        expect(this.marker).toBe("native-client")
      }
    } as unknown as Client & { readonly marker: string }
    const client = traceClient(rawClient, tracer)
    await tracer.startActiveSpan("root", async (root) => {
      try {
        captured.response = await client.call(ctx, input)
      } finally {
        root.end()
      }
    })
    await client.close(ctx)
    await provider.forceFlush()

    const transported = required(captured.transported, "transported request")
    const publishedMessage = required(captured.publishedMessage, "published message")
    const deliveredEvent = required(captured.deliveredEvent, "delivered event")
    expect(captured.response).toBe(serverResponse)
    expect(transported.service).toBe("catalog")
    expect(transported.endpoint).toBe("CreateOrder")
    expect(transported.message.body).toBe(inputBody)
    expect(transported.message.header.caller).toBe("kept")
    expect(transported.message.header.TraceParent).toBeUndefined()
    expect(transported.message.header.tracestate).toBeUndefined()
    expect(transported.message.header.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/)
    expect(input.message.header).toEqual({
      caller: "kept",
      TraceParent: "stale",
      tracestate: "stale"
    })
    expect(publishedMessage.body).toBe(brokerBody)
    expect(publishedMessage.headers.caller).toBe("kept")
    expect(publishedMessage.headers.TraceParent).toBeUndefined()
    expect(publishedMessage.headers.tracestate).toBeUndefined()
    expect(publishedMessage.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/)
    expect(deliveredEvent.native).toBe(nativeEvent)
    expect(deliveredEvent.message).toBe(publishedMessage)

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(5)
    const root = spanNamed(spans, "root")
    const clientSpan = spanNamed(spans, "likego.client catalog/CreateOrder")
    const serverSpan = spanNamed(spans, "likego.server catalog/CreateOrder")
    const publishSpan = spanNamed(spans, "likego.broker publish orders.created")
    const consumeSpan = spanNamed(spans, "likego.broker consume orders.created")
    expect(clientSpan.kind).toBe(SpanKind.CLIENT)
    expect(serverSpan.kind).toBe(SpanKind.SERVER)
    expect(publishSpan.kind).toBe(SpanKind.PRODUCER)
    expect(consumeSpan.kind).toBe(SpanKind.CONSUMER)
    expect(clientSpan.parentSpanContext?.spanId).toBe(root.spanContext().spanId)
    expect(serverSpan.parentSpanContext?.spanId).toBe(clientSpan.spanContext().spanId)
    expect(publishSpan.parentSpanContext?.spanId).toBe(serverSpan.spanContext().spanId)
    expect(consumeSpan.parentSpanContext?.spanId).toBe(publishSpan.spanContext().spanId)
    expect(new Set(spans.map((span) => span.spanContext().traceId))).toEqual(
      new Set([root.spanContext().traceId])
    )
    expect(clientSpan.attributes).toMatchObject({
      "likego.kind": "client",
      "likego.service": "catalog",
      "likego.endpoint": "CreateOrder",
      "likego.outcome": "ok"
    })
    expect(serverSpan.attributes).toMatchObject({
      "likego.kind": "server",
      "likego.service": "catalog",
      "likego.endpoint": "CreateOrder",
      "likego.outcome": "ok"
    })
    expect(publishSpan.attributes).toMatchObject({
      "likego.kind": "broker_publish",
      "likego.topic": "orders.created",
      "likego.outcome": "ok"
    })
    expect(consumeSpan.attributes).toMatchObject({
      "likego.kind": "broker_consume",
      "likego.topic": "orders.created",
      "likego.outcome": "ok"
    })
    expect(
      spans
        .filter((span) => span.name !== "root")
        .every((span) => span.status.code === SpanStatusCode.OK)
    ).toBe(true)

    context.disable()
    propagation.disable()
    manager.disable()
    await provider.shutdown()
  })

  test("delegates stacked typed Client calls once and reports Struct validation failures", async () => {
    context.disable()
    propagation.disable()
    const manager = new AsyncLocalStorageContextManager().enable()
    expect(context.setGlobalContextManager(manager)).toBe(true)
    expect(propagation.setGlobalPropagator(new W3CTraceContextPropagator())).toBe(true)
    const exporter = new InMemorySpanExporter()
    const provider = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter })]
    })
    const tracer = provider.getTracer("likego-typed-client-test")
    const payload = struct.object({ id: struct.number() })
    const outcomes: string[] = []
    const metrics: RequestMetrics = {
      requestsTotal: {
        add(_value, attributes): void {
          outcomes.push(String(attributes?.outcome))
        }
      } as RequestMetrics["requestsTotal"],
      requestDurationSeconds: {
        record(): void {}
      } as RequestMetrics["requestDurationSeconds"]
    }
    const server = traceUnaryMiddleware(tracer)(async (_ctx, request) => ({
      header: { [contentType]: "application/json; charset=utf-8" },
      body:
        request.header[endpoint] === "TypedFail"
          ? new TextEncoder().encode('{"id":"invalid"}')
          : new TextEncoder().encode('{"id":42}')
    }))
    const subject = newLoopbackClient((request) => {
      const propagated = decodeMetadataHeader(request.header[metadata] ?? null)
      if (propagated === null) throw new Error("typed request metadata is missing")
      return server(newServerContext(background(), propagated), request)
    })
    const client = traceClient(measureClient(subject.client, metrics), tracer)
    const contract = typedEndpoint("catalog", "TypedRead", payload, payload)
    let result: unknown = null
    await tracer.startActiveSpan("typed-root", async (span) => {
      try {
        result = await client.call(background(), contract, { id: 7 }, withAddress("loopback"))
      } finally {
        span.end()
      }
    })

    await expect(
      client.call(
        background(),
        typedEndpoint("catalog", "TypedFail", payload, payload),
        { id: 8 },
        withAddress("loopback")
      )
    ).rejects.toMatchObject({
      code: "LIKEGO_TRANSPORT_PROTOCOL",
      cause: { name: "StructError" }
    })
    await provider.forceFlush()

    const typedRequest = required(subject.sent[0] ?? null, "typed request")
    expect(result).toEqual({ id: 42 })
    expect(subject.sent).toHaveLength(2)
    expect(new TextDecoder().decode(typedRequest.body)).toBe('{"id":7}')
    expect(typedRequest.header[contentType]).toBe("application/json")
    expect(typedRequest.header.traceparent).toBeUndefined()
    expect(decodeMetadataHeader(typedRequest.header[metadata] ?? null)?.traceparent?.[0]).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/
    )
    const spans = exporter.getFinishedSpans()
    expect(spanNamed(spans, "likego.client catalog/TypedRead").attributes).toMatchObject({
      "likego.service": "catalog",
      "likego.endpoint": "TypedRead",
      "likego.outcome": "ok"
    })
    const failed = spanNamed(spans, "likego.client catalog/TypedFail")
    expect(failed.attributes["likego.outcome"]).toBe("transport_error")
    expect(failed.status.code).toBe(SpanStatusCode.ERROR)
    expect(spanNamed(spans, "likego.server catalog/TypedRead").parentSpanContext?.spanId).toBe(
      spanNamed(spans, "likego.client catalog/TypedRead").spanContext().spanId
    )
    expect(outcomes).toEqual(["success", "failure"])

    await provider.shutdown()
    context.disable()
    propagation.disable()
    manager.disable()
  })

  test("forwards zero and multiple Client call options by identity and order", async () => {
    const tracer = trace.getTracer("likego-call-options-test")
    const first: CallOption = (options) => options
    const second: CallOption = (options) => options
    const observed: Array<{
      readonly argumentCount: number
      readonly options: readonly CallOption[]
    }> = []
    const rawClient = {
      marker: "option-client",
      async call(
        this: { readonly marker: string },
        _ctx: LikegoContext,
        request: CallRequest,
        ...options: readonly CallOption[]
      ) {
        expect(this.marker).toBe("option-client")
        observed.push({ argumentCount: arguments.length, options })
        return request.message
      },
      async close(this: { readonly marker: string }) {
        expect(this.marker).toBe("option-client")
      }
    } as unknown as Client & { readonly marker: string }
    const client = traceClient(rawClient, tracer)
    const request: CallRequest = {
      service: "catalog",
      endpoint: "Read",
      message: { header: {}, body: new Uint8Array([1]) }
    }

    await client.call(background(), request)
    await client.call(background(), request, first, second)

    expect(observed).toHaveLength(2)
    expect(observed[0]?.argumentCount).toBe(2)
    expect(observed[0]?.options).toEqual([])
    expect(observed[1]?.argumentCount).toBe(4)
    expect(observed[1]?.options).toHaveLength(2)
    expect(observed[1]?.options[0]).toBe(first)
    expect(observed[1]?.options[1]).toBe(second)
  })

  test("preserves synchronous Web handlers and applies HTTP status semantics without touching bodies", async () => {
    const exporter = new InMemorySpanExporter()
    const provider = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter })]
    })
    const tracer = provider.getTracer("likego-web-status-test")
    const responseBody = new ReadableStream<Uint8Array>({ pull(): void {} })
    const ok = new Response(responseBody, { status: 200 })
    const missing = new Response(null, { status: 404 })
    const failed = new Response(null, { status: 500 })
    const asynchronous = new Response(null, { status: 201 })
    const handled: Request[] = []
    const handler = traceWebHandler((request) => {
      handled.push(request)
      if (request.method === "GET") return ok
      if (request.method === "POST") return missing
      return failed
    }, tracer)
    const requestBody = new ReadableStream<Uint8Array>({ pull(): void {} })
    const postInit: StreamingRequestInit = {
      method: "POST",
      body: requestBody,
      duplex: "half",
      headers: { "x-caller": "kept" }
    }
    const getRequest = new Request("https://web.example.test/orders/123?secret=value")
    const postRequest = new Request("https://web.example.test/missing/456", postInit)
    const putRequest = new Request("https://web.example.test/fail/789", { method: "PUT" })

    try {
      const synchronous = handler(getRequest)
      expect(synchronous).not.toBeInstanceOf(Promise)
      if (synchronous instanceof Promise) throw new Error("Web handler became asynchronous")
      expect(synchronous).toBe(ok)
      expect(Object.is(synchronous.body, responseBody)).toBe(true)
      expect(synchronous.body?.locked).toBe(false)
      expect(handler(postRequest)).toBe(missing)
      expect(handler(putRequest)).toBe(failed)
      const asyncHandler = traceWebHandler(async () => asynchronous, tracer)
      await expect(
        asyncHandler(new Request("https://web.example.test/async", { method: "HEAD" }))
      ).resolves.toBe(asynchronous)
      await provider.forceFlush()

      expect(handled).toEqual([getRequest, postRequest, putRequest])
      expect(handled[1]?.body).toBe(postRequest.body)
      expect(Object.is(postRequest.body, requestBody)).toBe(true)
      expect(postRequest.body?.locked).toBe(false)
      expect(postRequest.headers.get("x-caller")).toBe("kept")
      const spans = exporter.getFinishedSpans()
      expect(spans).toHaveLength(4)
      const okSpan = spanNamed(spans, "GET")
      const missingSpan = spanNamed(spans, "POST")
      const failedSpan = spanNamed(spans, "PUT")
      const asyncSpan = spanNamed(spans, "HEAD")
      expect(okSpan.attributes).toMatchObject({
        "likego.kind": "web",
        "http.request.method": "GET",
        "http.response.status_code": 200,
        "likego.outcome": "ok"
      })
      expect(missingSpan.attributes).toMatchObject({
        "http.request.method": "POST",
        "http.response.status_code": 404,
        "likego.outcome": "http_client_error"
      })
      expect(failedSpan.attributes).toMatchObject({
        "http.request.method": "PUT",
        "http.response.status_code": 500,
        "likego.outcome": "http_server_error"
      })
      expect(asyncSpan.attributes).toMatchObject({
        "http.request.method": "HEAD",
        "http.response.status_code": 201,
        "likego.outcome": "ok"
      })
      expect(okSpan.status.code).toBe(SpanStatusCode.UNSET)
      expect(missingSpan.status.code).toBe(SpanStatusCode.UNSET)
      expect(failedSpan.status.code).toBe(SpanStatusCode.ERROR)
      expect(asyncSpan.status.code).toBe(SpanStatusCode.UNSET)
      expect(spans.map((span) => span.name)).not.toContain("/orders/123")
      expect(spans.map((span) => span.name).join(" ")).not.toContain("secret=value")
    } finally {
      await provider.shutdown()
    }
  })

  test("classifies Web application failure and cancellation outcomes", async () => {
    const exporter = new InMemorySpanExporter()
    const provider = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter })]
    })
    const tracer = provider.getTracer("likego-web-failure-test")
    const applicationFailure = new Error("Web handler failed")
    const cancellation = new Error("Web operation canceled")

    try {
      const rejectedWeb = traceWebHandler(async () => {
        throw applicationFailure
      }, tracer)
      await expect(
        Promise.resolve(
          rejectedWeb(new Request("https://web.example.test/rejected", { method: "PATCH" }))
        )
      ).rejects.toBe(applicationFailure)

      const controller = new AbortController()
      controller.abort(cancellation)
      const canceledWeb = traceWebHandler(() => {
        throw cancellation
      }, tracer)
      let canceledWebFailure: unknown = null
      try {
        canceledWeb(
          new Request("https://web.example.test/canceled", {
            method: "DELETE",
            signal: controller.signal
          })
        )
      } catch (value) {
        canceledWebFailure = value
      }
      expect(canceledWebFailure).toBe(cancellation)
      await provider.forceFlush()

      const spans = exporter.getFinishedSpans()
      expect(spans).toHaveLength(2)
      const rejectedSpan = spanNamed(spans, "PATCH")
      const canceledSpan = spanNamed(spans, "DELETE")
      expect(rejectedSpan.attributes["likego.outcome"]).toBe("application_error")
      expect(canceledSpan.attributes["likego.outcome"]).toBe("canceled")
      expect(spans.every((span) => span.status.code === SpanStatusCode.ERROR)).toBe(true)
      expect(spans.every((span) => span.events.length === 0)).toBe(true)
    } finally {
      await provider.shutdown()
    }
  })

  test("exports only bounded error identifiers from a secret-bearing failure", async () => {
    const exporter = new InMemorySpanExporter()
    const provider = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter })]
    })
    const tracer = provider.getTracer("likego-error-redaction-test")
    const failure = secretFailure()

    try {
      const failed = traceWebHandler(() => {
        throw failure
      }, tracer)
      expect(() => failed(new Request("https://web.example.test/"))).toThrow(failure)
      await provider.forceFlush()

      const span = spanNamed(exporter.getFinishedSpans(), "GET")
      expect(span.status.code).toBe(SpanStatusCode.ERROR)
      expect(span.attributes).toMatchObject({
        "likego.outcome": "application_error",
        "error.type": "SensitiveError",
        "likego.error.code": "LIKEGO_TEST_FAILURE"
      })
      expect(span.events).toEqual([])
      const exported = JSON.stringify({
        attributes: span.attributes,
        events: span.events,
        status: span.status
      })
      expect(exported).not.toContain(secretSentinel)
      expect(exported).not.toContain("exception.message")
      expect(exported).not.toContain("exception.stacktrace")
      expect(exported).not.toContain("cause")
    } finally {
      await provider.shutdown()
    }
  })

  test("isolates throwing diagnostic getters from the original traced failure", async () => {
    const exporter = new InMemorySpanExporter()
    const provider = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter })]
    })
    const tracer = provider.getTracer("likego-hostile-error-test")
    const failure = hostileFailure()

    try {
      const failed = traceWebHandler(() => {
        throw failure
      }, tracer)
      expect(() => failed(new Request("https://web.example.test/"))).toThrow(failure)
      await provider.forceFlush()

      const span = spanNamed(exporter.getFinishedSpans(), "GET")
      expect(span.status.code).toBe(SpanStatusCode.ERROR)
      expect(span.attributes["likego.outcome"]).toBe("application_error")
      expect(span.attributes).not.toHaveProperty("error.type")
      expect(span.attributes).not.toHaveProperty("likego.error.code")
      expect(span.events).toEqual([])
    } finally {
      await provider.shutdown()
    }
  })

  test("isolates a throwing Context error reader from the original traced failure", async () => {
    const exporter = new InMemorySpanExporter()
    const provider = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter })]
    })
    const tracer = provider.getTracer("likego-hostile-context-test")
    const failure = new Error("business failure")
    const contextFailure = new Error("Context inspection failed")
    const hostileContext: LikegoContext = Object.freeze({
      deadline: background().deadline,
      done: background().done,
      err(): never {
        throw contextFailure
      },
      value: background().value
    })
    const client = traceClient(
      {
        async call() {
          throw failure
        },
        async close() {}
      },
      tracer
    )

    try {
      await expect(
        client.call(hostileContext, {
          service: "catalog",
          endpoint: "Read",
          message: { header: {}, body: new Uint8Array() }
        })
      ).rejects.toBe(failure)
      await provider.forceFlush()

      const span = spanNamed(exporter.getFinishedSpans(), "likego.client catalog/Read")
      expect(span.attributes["likego.outcome"]).toBe("transport_error")
      expect(span.status.code).toBe(SpanStatusCode.ERROR)
    } finally {
      await provider.shutdown()
    }
  })

  test("omits malformed and oversized error identifiers from spans", async () => {
    const exporter = new InMemorySpanExporter()
    const provider = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter })]
    })
    const tracer = provider.getTracer("likego-invalid-error-test")
    let failure = secretFailure("Invalid Error", "lowercase")
    const failed = traceWebHandler(() => {
      throw failure
    }, tracer)

    try {
      expect(() => failed(new Request("https://web.example.test/"))).toThrow(failure)
      failure = secretFailure("X".repeat(65), "X".repeat(65))
      expect(() => failed(new Request("https://web.example.test/"))).toThrow(failure)
      await provider.forceFlush()

      const spans = exporter.getFinishedSpans()
      expect(spans).toHaveLength(2)
      for (const span of spans) {
        expect(span.attributes).not.toHaveProperty("error.type")
        expect(span.attributes).not.toHaveProperty("likego.error.code")
        expect(span.events).toEqual([])
      }
    } finally {
      await provider.shutdown()
    }
  })

  test("classifies cancellation, ServiceError, transport, server, and broker failures", async () => {
    const exporter = new InMemorySpanExporter()
    const provider = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter })]
    })
    const tracer = provider.getTracer("likego-failure-test")
    const transportFailure = new Error("transport failed")
    const serviceFailure = serviceError("not_found", "not found", 404)
    const canceledFailure = new Error("caller stopped")
    const request: CallRequest = {
      service: "catalog",
      endpoint: "Read",
      message: { header: {}, body: new Uint8Array() }
    }
    for (const [ctx, failure] of [
      [background(), serviceFailure],
      [background(), transportFailure]
    ] as const) {
      const client = traceClient(
        {
          async call() {
            throw failure
          },
          async close() {}
        },
        tracer
      )
      await expect(client.call(ctx, request)).rejects.toBe(failure)
    }
    const [canceledContext, cancel] = withCancelCause(background())
    cancel(canceledFailure)
    const canceledClient = traceClient(
      {
        async call() {
          throw canceledFailure
        },
        async close() {}
      },
      tracer
    )
    await expect(canceledClient.call(canceledContext, request)).rejects.toBe(canceledFailure)

    const applicationFailure = new Error("handler failed")
    const failingHandler = traceUnaryMiddleware(tracer)(async () => {
      throw applicationFailure
    })
    await expect(
      failingHandler(background(), {
        header: { [service]: "catalog", [endpoint]: "Write" },
        body: new Uint8Array()
      })
    ).rejects.toBe(applicationFailure)

    const brokerFailure = new Error("publish failed")
    const captured: {
      delivery:
        | ((ctx: LikegoContext, event: BrokerEvent<NativeEvent>) => void | PromiseLike<void>)
        | null
    } = { delivery: null }
    const rawBroker: Broker<void, void, void, NativeEvent> = {
      async publish() {
        throw brokerFailure
      },
      async subscribe(_ctx, _topic, handler) {
        captured.delivery = handler
        return subscriptionHandle("topic")
      },
      string() {
        return "failure-broker"
      }
    }
    const broker = traceBroker(rawBroker, tracer)
    await expect(
      broker.publish(background(), "topic", { headers: {}, body: new Uint8Array() })
    ).rejects.toBe(brokerFailure)
    const consumerFailure = new Error("consumer failed")
    await broker.subscribe(background(), "topic", async () => {
      throw consumerFailure
    })
    const deliveryHandler = required(captured.delivery, "delivery handler")
    await expect(
      deliveryHandler(background(), {
        topic: "topic",
        message: { headers: {}, body: new Uint8Array() },
        native: { sequence: 1 }
      })
    ).rejects.toBe(consumerFailure)
    await provider.forceFlush()

    const spans = exporter.getFinishedSpans()
    expect(
      spans
        .filter((span) => span.name === "likego.client catalog/Read")
        .map((span) => span.attributes["likego.outcome"])
    ).toEqual(["service_error", "transport_error", "canceled"])
    expect(spanNamed(spans, "likego.server catalog/Write").attributes["likego.outcome"]).toBe(
      "application_error"
    )
    expect(spanNamed(spans, "likego.broker publish topic").attributes["likego.outcome"]).toBe(
      "broker_error"
    )
    expect(spanNamed(spans, "likego.broker consume topic").attributes["likego.outcome"]).toBe(
      "application_error"
    )
    expect(spans.every((span) => span.status.code === SpanStatusCode.ERROR)).toBe(true)
    expect(spans.every((span) => span.events.length === 0)).toBe(true)
    await provider.shutdown()
  })

  test("preserves __proto__ as an own propagation header across client and server adapters", async () => {
    const tracer = trace.getTracer("likego-special-header-test")
    const captured: HeaderCarrier[] = []
    const client = {
      async call(_ctx: LikegoContext, request: CallRequest) {
        captured.push(request.message.header)
        return request.message
      },
      async close() {}
    } as unknown as Client
    const passthrough: TextMapPropagator<HeaderCarrier> = {
      inject() {},
      extract(otelContext) {
        return otelContext
      },
      fields() {
        return []
      }
    }
    await traceClient(client, tracer, passthrough).call(background(), {
      service: "service",
      endpoint: "copy",
      message: {
        header: Object.fromEntries([["__proto__", "copied"]]),
        body: new Uint8Array()
      }
    })

    const injecting: TextMapPropagator<HeaderCarrier> = {
      inject(_otelContext, carrier, setter) {
        setter.set(carrier, "__proto__", "injected")
      },
      extract(otelContext) {
        return otelContext
      },
      fields() {
        return ["__proto__"]
      }
    }
    await traceClient(client, tracer, injecting).call(background(), {
      service: "service",
      endpoint: "inject",
      message: { header: {}, body: new Uint8Array() }
    })

    let serverCarrier: HeaderCarrier | null = null
    const serverPropagator: TextMapPropagator<HeaderCarrier> = {
      inject() {},
      extract(otelContext, carrier) {
        serverCarrier = carrier
        return otelContext
      },
      fields() {
        return []
      }
    }
    const server = traceUnaryMiddleware(tracer, serverPropagator)(async (_ctx, message) => message)
    await server(
      newServerContext(background(), newMetadata(Object.fromEntries([["__proto__", "metadata"]]))),
      { header: {}, body: new Uint8Array() }
    )

    let webCarrier: HeaderCarrier | null = null
    const webPropagator: TextMapPropagator<HeaderCarrier> = {
      inject() {},
      extract(otelContext, carrier) {
        webCarrier = carrier
        return otelContext
      },
      fields() {
        return []
      }
    }
    const web = traceWebHandler(() => new Response(null, { status: 204 }), tracer, webPropagator)
    expect(
      web(
        new Request("https://web.example.test/special-header", {
          headers: new Headers([["__proto__", "web"]])
        })
      )
    ).toBeInstanceOf(Response)

    expect(Object.hasOwn(captured[0] ?? {}, "__proto__")).toBe(true)
    expect(captured[0]?.__proto__).toBe("copied")
    expect(Object.hasOwn(captured[1] ?? {}, "__proto__")).toBe(true)
    expect(captured[1]?.__proto__).toBe("injected")
    expect(Object.hasOwn(serverCarrier ?? {}, "__proto__")).toBe(true)
    expect(Object.getOwnPropertyDescriptor(serverCarrier ?? {}, "__proto__")?.value).toBe(
      "metadata"
    )
    expect(Object.hasOwn(webCarrier ?? {}, "__proto__")).toBe(true)
    expect(Object.getOwnPropertyDescriptor(webCarrier ?? {}, "__proto__")?.value).toBe("web")
  })

  test("supports an explicit propagator, exact optional arguments, and construction failures", async () => {
    const tracer = trace.getTracer("likego-explicit-propagator-test")
    let propagationInjections = 0
    const propagator: TextMapPropagator<HeaderCarrier> = {
      inject(_otelContext, carrier, setter) {
        propagationInjections += 1
        setter.set(carrier, "x-trace", "explicit")
      },
      extract(otelContext, carrier, getter) {
        expect(getter.keys(carrier)).toContain("x-trace")
        expect(getter.get(carrier, "X-Trace")).toEqual(["explicit", "second"])
        return otelContext
      },
      fields() {
        return ["x-trace"]
      }
    }
    const captured: { clientRequest: CallRequest | null } = { clientRequest: null }
    const client = traceClient(
      {
        async call(_ctx: LikegoContext, request: CallRequest) {
          captured.clientRequest = request
          return request.message
        },
        async close() {}
      } as unknown as Client,
      tracer,
      propagator
    )
    await client.call(background(), {
      service: "service",
      endpoint: "endpoint",
      message: { header: { "X-Trace": "stale", keep: "yes" }, body: new Uint8Array() }
    })
    expect(required(captured.clientRequest, "client request").message.header).toEqual({
      keep: "yes",
      "x-trace": "explicit"
    })
    expect(propagationInjections).toBe(1)
    const handler = traceUnaryMiddleware(tracer, propagator)(async (_ctx, message) => message)
    await handler(background(), {
      header: { "x-trace": "explicit", "X-Trace": "second" },
      body: new Uint8Array()
    })

    let requestExtractions = 0
    const requestPropagator: TextMapPropagator<HeaderCarrier> = {
      inject(_otelContext, carrier, setter) {
        setter.set(carrier, "x-web-trace", "explicit")
      },
      extract(otelContext, carrier, getter) {
        requestExtractions += 1
        expect(getter.get(carrier, "X-Web-Trace")).toBe("explicit")
        return otelContext
      },
      fields() {
        return ["x-web-trace"]
      }
    }
    const explicitWeb = traceWebHandler(
      (request) => new Response(request.body, { status: 202 }),
      tracer,
      requestPropagator
    )
    expect(
      explicitWeb(
        new Request("https://web.example.test/explicit", {
          headers: { "x-web-trace": "explicit" }
        })
      )
    ).toBeInstanceOf(Response)
    expect(requestExtractions).toBe(1)

    let publishArguments = 0
    let subscribeArguments = 0
    const broker = traceBroker<void, void, void, NativeEvent>(
      {
        async publish() {
          publishArguments = arguments.length
        },
        async subscribe() {
          subscribeArguments = arguments.length
          return subscriptionHandle("topic")
        },
        string() {
          return "optional"
        }
      },
      tracer,
      propagator
    )
    await broker.publish(background(), "topic", { headers: {}, body: new Uint8Array() })
    await broker.subscribe(background(), "topic", async () => {})
    expect(publishArguments).toBe(3)
    expect(subscribeArguments).toBe(3)

    expect(() => traceClient(null as never, tracer)).toThrow("Client")
    expect(() => traceClient({} as never, tracer)).toThrow("Client")
    expect(() => traceClient(client, null as never)).toThrow("Tracer")
    expect(() => traceClient(client, tracer, {} as never)).toThrow("TextMapPropagator")
    expect(() => traceUnaryMiddleware(null as never)).toThrow("Tracer")
    expect(() => traceUnaryMiddleware(tracer)(null as never)).toThrow("handler")
    expect(() => traceWebHandler(null as never, tracer)).toThrow("Web handler")
    expect(() => traceWebHandler(() => new Response(), null as never)).toThrow("Tracer")
    expect(() => traceWebHandler(() => new Response(), tracer, {} as never)).toThrow(
      "TextMapPropagator"
    )
    expect(() => traceBroker(null as never, tracer)).toThrow("Broker")
    expect(() => traceBroker({} as never, tracer)).toThrow("Broker")
    expect(() => traceBroker(broker, null as never)).toThrow("Tracer")
    expect(() => traceBroker(broker, tracer, {} as never)).toThrow("TextMapPropagator")

    const invalidFields: TextMapPropagator<HeaderCarrier> = {
      inject: propagator.inject,
      extract: propagator.extract,
      fields() {
        return [""]
      }
    }
    const invalidClient = traceClient(client, tracer, invalidFields)
    await expect(
      invalidClient.call(background(), {
        service: "service",
        endpoint: "endpoint",
        message: { header: {}, body: new Uint8Array() }
      })
    ).rejects.toThrow("non-empty strings")
  })
})
