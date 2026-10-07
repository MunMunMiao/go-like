import { expect, test } from "bun:test"

import type { CallOption, CallRequest } from "@go-like/client"
import { background, withCancelCause, type Context } from "@go-like/context"
import { newMetadata } from "@go-like/metadata"
import { struct } from "@go-like/struct"
import {
  endpoint as serviceEndpoint,
  newServerContext,
  type TransportInfo
} from "@go-like/transport"
import { encodeJsonBody } from "@go-like/transport/json"
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricData
} from "@opentelemetry/sdk-metrics"

import {
  measureClient,
  measureClientMiddleware,
  measureUnaryMiddleware,
  newRequestMetrics,
  type RequestMetrics
} from "../src/index"
import { newLoopbackClient } from "./client-fixture"

const emptyResponse = new Response(null, { status: 204 })

/** Builds TransportInfo whose operation is independent of request headers. */
function transportInfo(operation: string): TransportInfo {
  const headers = newMetadata()
  return {
    kind: () => "http",
    endpoint: () => "",
    operation: () => operation,
    requestHeaders: () => headers,
    replyHeaders: () => headers,
    peerIdentity: () => null
  }
}

/** Returns one unique metric exported by the official in-memory SDK exporter. */
function metricNamed(exporter: InMemoryMetricExporter, name: string): MetricData {
  const matching: MetricData[] = []
  for (const resource of exporter.getMetrics()) {
    for (const scope of resource.scopeMetrics) {
      for (const metric of scope.metrics) {
        if (metric.descriptor.name === name) matching.push(metric)
      }
    }
  }
  expect(matching).toHaveLength(1)
  const found = matching[0]
  if (found === undefined) throw new Error(`metric is missing: ${name}`)
  return found
}

/** Returns whether one exported metric contains the exact bounded request attributes. */
function hasAttributes(
  metric: MetricData,
  component: string,
  operation: string,
  outcome: string
): boolean {
  return metric.dataPoints.some(
    (point) =>
      point.attributes.component === component &&
      point.attributes.operation === operation &&
      point.attributes.outcome === outcome
  )
}

test("records Client and unary Server outcomes through the official metrics SDK", async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const provider = new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: 60_000
      })
    ]
  })
  const metrics = newRequestMetrics(provider.getMeter("go-like-request-test"))
  const response = new Response("native")
  const clientFailure = new Error("client failed")
  const cancellation = new Error("canceled")
  let optionSeen: CallOption | null = null
  const native = async function nativeCall(
    _ctx: Context,
    request: CallRequest,
    ...options: readonly CallOption[]
  ): Promise<Response> {
    optionSeen = options[0] ?? null
    if (request.endpoint !== "Get") throw clientFailure
    return response
  }
  const measured = measureClientMiddleware(metrics)(native)
  const option: CallOption = (current) => current

  const delivered = await measured(
    background(),
    { service: "catalog", endpoint: "Get", headers: {}, body: null },
    option
  )
  expect(delivered.status).toBe(200)
  expect(await delivered.text()).toBe("native")
  expect(optionSeen === option).toBe(true)
  await expect(
    measured(background(), {
      service: "catalog",
      endpoint: "Fail",
      headers: {},
      body: null
    })
  ).rejects.toBe(clientFailure)

  const requestStruct = struct.object({ id: struct.number() })
  const responseStruct = struct.object({ total: struct.number() })
  const typedSubject = newLoopbackClient(async (request) => {
    const name = new URL(request.url).pathname.split("/").pop()
    if (name === "TypedFail") return new Response(new Uint8Array())
    const bytes = new Uint8Array(await request.arrayBuffer())
    const encoded = encodeJsonBody(responseStruct, { total: bytes.byteLength })
    const payload = new ArrayBuffer(encoded.byteLength)
    new Uint8Array(payload).set(encoded)
    return new Response(payload, {
      headers: { "content-type": "application/json; charset=utf-8" }
    })
  })
  const wrapped = measureClient(typedSubject.client, metrics)
  const typed = serviceEndpoint("catalog", "Typed", requestStruct, responseStruct)
  expect(await wrapped.call(background(), typed, { id: 7 })).toEqual({
    total: 8
  })
  await expect(
    wrapped.call(
      background(),
      serviceEndpoint("catalog", "TypedFail", requestStruct, responseStruct),
      { id: 7 }
    )
  ).rejects.toMatchObject({
    code: "GO_LIKE_TRANSPORT_PROTOCOL",
    message: "client typed response is invalid"
  })
  await wrapped.close(background())
  const [canceledClientContext, cancelClient] = withCancelCause(background())
  cancelClient(cancellation)
  await expect(
    measured(canceledClientContext, {
      service: "catalog",
      endpoint: "Cancel",
      headers: {},
      body: null
    })
  ).rejects.toBe(clientFailure)

  const serverFailure = new Error("server failed")
  const middleware = measureUnaryMiddleware(metrics)
  const ok = new Response(null, { status: 204 })
  const successful = middleware(async () => ok)
  const failing = middleware(() => {
    throw serverFailure
  })
  const routed = new Request("https://service.test/payments/Authorize", {
    method: "POST",
    headers: { "Go-Like-Service": "attacker-controlled-tenant-9817" }
  })
  const routedContext = newServerContext(background(), transportInfo("payments/Authorize"))
  expect(await successful(routedContext, routed)).toBe(ok)
  await expect(failing(routedContext, routed)).rejects.toBe(serverFailure)
  const [canceledServerContext, cancelServer] = withCancelCause(background())
  cancelServer(cancellation)
  await expect(
    failing(newServerContext(canceledServerContext, transportInfo("payments/Authorize")), routed)
  ).rejects.toBe(serverFailure)
  const missing = new Request("https://service.test/missing")
  expect(await successful(background(), missing)).toBe(ok)
  const root = background()
  const exploding: Context = {
    deadline: root.deadline,
    done: root.done,
    err: root.err,
    value(): never {
      throw new Error("transport info unavailable")
    }
  }
  await expect(failing(exploding, routed)).rejects.toBe(serverFailure)

  await provider.forceFlush()
  const total = metricNamed(exporter, "go-like.request.completed")
  const duration = metricNamed(exporter, "go-like.request.duration")
  for (const metric of [total, duration]) {
    expect(hasAttributes(metric, "client", "catalog/Get", "success")).toBe(true)
    expect(hasAttributes(metric, "client", "catalog/Fail", "failure")).toBe(true)
    expect(hasAttributes(metric, "client", "catalog/Cancel", "canceled")).toBe(true)
    expect(hasAttributes(metric, "client", "catalog/Typed", "success")).toBe(true)
    expect(hasAttributes(metric, "client", "catalog/TypedFail", "failure")).toBe(true)
    expect(hasAttributes(metric, "server", "payments/Authorize", "success")).toBe(true)
    expect(hasAttributes(metric, "server", "payments/Authorize", "failure")).toBe(true)
    expect(hasAttributes(metric, "server", "payments/Authorize", "canceled")).toBe(true)
    expect(hasAttributes(metric, "server", "unknown/unknown", "success")).toBe(true)
    expect(hasAttributes(metric, "server", "unknown/unknown", "failure")).toBe(true)
  }
  expect(total.dataPoints.every((point) => point.value === 1)).toBe(true)
  expect(total.descriptor.unit).toBe("{request}")
  expect(duration.descriptor.unit).toBe("s")
  await provider.shutdown()
})

test("preserves typed Client Struct and protocol failures", async () => {
  const provider = new MeterProvider({ readers: [] })
  const metrics = newRequestMetrics(provider.getMeter("go-like-typed-validation-test"))
  const requestStruct = struct.object({ id: struct.number() })
  const responseStruct = struct.object({ total: struct.number() })
  const subject = newLoopbackClient((request) => {
    const name = new URL(request.url).pathname.split("/").pop()
    if (name === "Missing") return new Response(new Uint8Array())
    if (name === "Duplicate") {
      return new Response(new Uint8Array(), {
        headers: { "content-type": "application/json, application/json" }
      })
    }
    if (name === "Malformed") {
      return new Response("{", { headers: { "content-type": "application/json" } })
    }
    return new Response('{"total":"invalid"}', {
      headers: { "content-type": "application/json" }
    })
  })
  const client = measureClient(subject.client, metrics)

  await expect(
    Reflect.apply(client.call, client, [
      background(),
      serviceEndpoint("catalog", "Encode", requestStruct, responseStruct),
      { id: "invalid" }
    ])
  ).rejects.toMatchObject({ name: "StructError" })
  await expect(
    client.call(
      background(),
      serviceEndpoint("catalog", "Missing", requestStruct, responseStruct),
      { id: 1 }
    )
  ).rejects.toMatchObject({
    code: "GO_LIKE_TRANSPORT_PROTOCOL",
    message: "client typed response is invalid"
  })
  await expect(
    client.call(
      background(),
      serviceEndpoint("catalog", "Duplicate", requestStruct, responseStruct),
      { id: 1 }
    )
  ).rejects.toMatchObject({
    code: "GO_LIKE_TRANSPORT_PROTOCOL",
    message: "client typed response is invalid"
  })
  await expect(
    client.call(
      background(),
      serviceEndpoint("catalog", "Malformed", requestStruct, responseStruct),
      { id: 1 }
    )
  ).rejects.toMatchObject({
    code: "GO_LIKE_TRANSPORT_PROTOCOL",
    message: "client typed response is invalid",
    cause: { name: "TypeError" }
  })
  await expect(
    client.call(background(), serviceEndpoint("catalog", "Decode", requestStruct, responseStruct), {
      id: 1
    })
  ).rejects.toMatchObject({
    code: "GO_LIKE_TRANSPORT_PROTOCOL",
    message: "client typed response is invalid",
    cause: { name: "StructError" }
  })
  await expect(Reflect.apply(client.call, client, [background(), null])).rejects.toThrow(
    "Client call requires a request or Endpoint"
  )
  await expect(
    Reflect.apply(client.call, client, [
      background(),
      serviceEndpoint("catalog", "Missing", requestStruct, responseStruct)
    ])
  ).rejects.toThrow("Client typed call requires a request value")
  await expect(
    Reflect.apply(client.call, client, [
      background(),
      { service: "catalog", endpoint: "Raw", headers: {}, body: null },
      1
    ])
  ).rejects.toThrow("Client call option must be a function")
  await provider.shutdown()
})

test("validates instrumentation inputs and never replaces application outcomes", async () => {
  const provider = new MeterProvider({ readers: [] })
  const metrics = newRequestMetrics(provider.getMeter("go-like-validation-test"))
  expect(Object.isFrozen(metrics)).toBe(true)
  expect(() => newRequestMetrics(null as never)).toThrow(
    "meter must implement the OpenTelemetry Meter interface"
  )
  expect(() => measureClientMiddleware({} as never)).toThrow(
    "metrics must be created by newRequestMetrics"
  )
  expect(() => measureClientMiddleware(metrics)(null as never)).toThrow(
    "client handler must be a function"
  )
  expect(() => measureUnaryMiddleware({} as never)).toThrow(
    "metrics must be created by newRequestMetrics"
  )
  expect(() => measureUnaryMiddleware(metrics)(null as never)).toThrow(
    "unary handler must be a function"
  )

  const applicationFailure = new Error("application failure")
  const hostileMetrics: RequestMetrics = {
    requestsTotal: {
      add(): never {
        throw new Error("counter unavailable")
      }
    },
    requestDurationSeconds: {
      record(): never {
        throw new Error("histogram unavailable")
      }
    }
  }
  const client = measureClientMiddleware(hostileMetrics)(async (_ctx, request) => {
    if (request.endpoint === "Fail") throw applicationFailure
    return emptyResponse
  })
  await expect(
    client(background(), {
      service: "catalog",
      endpoint: "Get",
      headers: {},
      body: null
    })
  ).resolves.toBe(emptyResponse)
  const base = background()
  const hostileContext: Context = {
    deadline: base.deadline,
    done: base.done,
    err(): never {
      throw new Error("context unavailable")
    },
    value: base.value
  }
  await expect(
    client(hostileContext, {
      service: "catalog",
      endpoint: "Fail",
      headers: {},
      body: null
    })
  ).rejects.toBe(applicationFailure)
  await provider.shutdown()
})
