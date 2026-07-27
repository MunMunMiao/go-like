import { expect, test } from "bun:test"

import { withAddress, type CallOption, type CallRequest } from "@likego/client"
import { background, withCancelCause, type Context } from "@likego/context"
import { endpoint as serviceEndpoint, type BodyCodec, type Message } from "@likego/transport"
import { contentType, endpoint, request as service } from "@likego/transport/headers"
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

const emptyMessage: Message = Object.freeze({
  header: Object.freeze({}),
  body: new Uint8Array()
})

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
  const metrics = newRequestMetrics(provider.getMeter("likego-request-test"))
  const response: Message = Object.freeze({
    header: Object.freeze({ native: "response" }),
    body: new Uint8Array([1])
  })
  const clientFailure = new Error("client failed")
  const cancellation = new Error("canceled")
  let optionSeen: CallOption | null = null
  const native = async function nativeCall(
    _ctx: Context,
    request: CallRequest,
    ...options: readonly CallOption[]
  ): Promise<Message> {
    optionSeen = options[0] ?? null
    if (request.endpoint !== "Get") throw clientFailure
    return response
  }
  const measured = measureClientMiddleware(metrics)(native)
  const option: CallOption = (current) => current

  expect(
    await measured(
      background(),
      { service: "catalog", endpoint: "Get", message: emptyMessage },
      option
    )
  ).toBe(response)
  expect(optionSeen === option).toBe(true)
  await expect(
    measured(background(), {
      service: "catalog",
      endpoint: "Fail",
      message: emptyMessage
    })
  ).rejects.toBe(clientFailure)

  const requestCodec: BodyCodec<{ readonly id: number }> = {
    contentType: "application/json",
    encode(value) {
      return new TextEncoder().encode(JSON.stringify(value))
    },
    decode(body) {
      return JSON.parse(new TextDecoder().decode(body))
    }
  }
  const responseCodec: BodyCodec<{ readonly total: number }> = {
    contentType: "application/json",
    encode(value) {
      return new TextEncoder().encode(JSON.stringify(value))
    },
    decode(body) {
      return JSON.parse(new TextDecoder().decode(body))
    }
  }
  const typedSubject = newLoopbackClient((request) => {
    if (request.header[endpoint] === "TypedFail") {
      return { header: {}, body: new Uint8Array() }
    }
    return {
      header: { native: "response", [contentType]: "application/json; charset=utf-8" },
      body: responseCodec.encode({ total: request.body.byteLength }) as Uint8Array
    }
  })
  const wrapped = measureClient(typedSubject.client, metrics)
  const typed = serviceEndpoint("catalog", "Typed", requestCodec, responseCodec)
  expect(await wrapped.call(background(), typed, { id: 7 }, withAddress("loopback"))).toEqual({
    total: 8
  })
  await expect(
    wrapped.call(
      background(),
      serviceEndpoint("catalog", "TypedFail", requestCodec, responseCodec),
      { id: 7 },
      withAddress("loopback")
    )
  ).rejects.toMatchObject({
    code: "LIKEGO_TRANSPORT_PROTOCOL",
    message: "client typed response is invalid"
  })
  await wrapped.close(background())
  const [canceledClientContext, cancelClient] = withCancelCause(background())
  cancelClient(cancellation)
  await expect(
    measured(canceledClientContext, {
      service: "catalog",
      endpoint: "Cancel",
      message: emptyMessage
    })
  ).rejects.toBe(clientFailure)

  const serverFailure = new Error("server failed")
  const middleware = measureUnaryMiddleware(metrics)
  const successful = middleware(async (_ctx, message) => message)
  const failing = middleware(() => {
    throw serverFailure
  })
  const routed: Message = {
    header: {
      [service.toLowerCase()]: "payments",
      [endpoint.toUpperCase()]: "Authorize"
    },
    body: new Uint8Array()
  }
  expect(await successful(background(), routed)).toBe(routed)
  await expect(failing(background(), routed)).rejects.toBe(serverFailure)
  const [canceledServerContext, cancelServer] = withCancelCause(background())
  cancelServer(cancellation)
  await expect(failing(canceledServerContext, routed)).rejects.toBe(serverFailure)
  expect(await successful(background(), emptyMessage)).toBe(emptyMessage)

  await provider.forceFlush()
  const total = metricNamed(exporter, "likego_requests_total")
  const duration = metricNamed(exporter, "likego_request_duration_seconds")
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
  }
  expect(total.dataPoints.every((point) => point.value === 1)).toBe(true)
  expect(duration.descriptor.unit).toBe("s")
  await provider.shutdown()
})

test("preserves typed Client codec and protocol failures", async () => {
  const provider = new MeterProvider({ readers: [] })
  const metrics = newRequestMetrics(provider.getMeter("likego-typed-validation-test"))
  const encodeFailure = new Error("encode rejected")
  const decodeFailure = new Error("decode rejected")
  const validCodec: BodyCodec<unknown> = {
    contentType: "application/json",
    encode(value) {
      return new TextEncoder().encode(JSON.stringify(value))
    },
    decode(body) {
      return JSON.parse(new TextDecoder().decode(body))
    }
  }
  const invalidRequestCodec: BodyCodec<unknown> = {
    contentType: "application/json",
    encode() {
      throw encodeFailure
    },
    decode: validCodec.decode
  }
  const rejectedResponseCodec: BodyCodec<unknown> = {
    contentType: "application/json",
    encode: validCodec.encode,
    decode() {
      throw decodeFailure
    }
  }
  const subject = newLoopbackClient((request) => {
    if (request.header[endpoint] === "Missing") {
      return { header: {}, body: new Uint8Array() }
    }
    if (request.header[endpoint] === "Duplicate") {
      return {
        header: {
          "Content-Type": "application/json",
          "content-type": "application/json"
        },
        body: new Uint8Array()
      }
    }
    return {
      header: { [contentType]: "application/json" },
      body: new TextEncoder().encode("{}")
    }
  })
  const client = measureClient(subject.client, metrics)

  await expect(
    client.call(
      background(),
      serviceEndpoint("catalog", "Encode", invalidRequestCodec, validCodec),
      {}
    )
  ).rejects.toBe(encodeFailure)
  await expect(
    client.call(
      background(),
      serviceEndpoint("catalog", "Missing", validCodec, validCodec),
      {},
      withAddress("loopback")
    )
  ).rejects.toMatchObject({
    code: "LIKEGO_TRANSPORT_PROTOCOL",
    message: "client typed response is invalid"
  })
  await expect(
    client.call(
      background(),
      serviceEndpoint("catalog", "Duplicate", validCodec, validCodec),
      {},
      withAddress("loopback")
    )
  ).rejects.toMatchObject({
    code: "LIKEGO_TRANSPORT_PROTOCOL",
    message: "client typed response is invalid"
  })
  await expect(
    client.call(
      background(),
      serviceEndpoint("catalog", "Decode", validCodec, rejectedResponseCodec),
      {},
      withAddress("loopback")
    )
  ).rejects.toMatchObject({
    code: "LIKEGO_TRANSPORT_PROTOCOL",
    message: "client typed response is invalid",
    cause: decodeFailure
  })
  await expect(Reflect.apply(client.call, client, [background(), null])).rejects.toThrow(
    "Client call requires a request or Endpoint"
  )
  await expect(
    Reflect.apply(client.call, client, [
      background(),
      serviceEndpoint("catalog", "Missing", validCodec, validCodec)
    ])
  ).rejects.toThrow("Client typed call requires a request value")
  await expect(
    Reflect.apply(client.call, client, [
      background(),
      { service: "catalog", endpoint: "Raw", message: emptyMessage },
      1
    ])
  ).rejects.toThrow("Client call option must be a function")
  await provider.shutdown()
})

test("validates instrumentation inputs and never replaces application outcomes", async () => {
  const provider = new MeterProvider({ readers: [] })
  const metrics = newRequestMetrics(provider.getMeter("likego-validation-test"))
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
    return emptyMessage
  })
  await expect(
    client(background(), {
      service: "catalog",
      endpoint: "Get",
      message: emptyMessage
    })
  ).resolves.toBe(emptyMessage)
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
      message: emptyMessage
    })
  ).rejects.toBe(applicationFailure)
  await provider.shutdown()
})
