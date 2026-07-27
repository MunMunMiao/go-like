import { expect, test } from "bun:test"

import type { Broker, BrokerEvent, BrokerMessage, Subscriber } from "@likego/broker"
import type { CallOption, CallRequest, Client } from "@likego/client"
import { background, withCancelCause, type Context } from "@likego/context"
import type { Message } from "@likego/transport"
import { endpoint, request as service } from "@likego/transport/headers"
import { Registry } from "prom-client"

import {
  measureBroker,
  measureClient,
  measureUnaryMiddleware,
  measureWebHandler,
  newRequestMetrics,
  type RequestMetrics
} from "../src/index"

const emptyBody = new Uint8Array()
const emptyMessage: Message = Object.freeze({ header: Object.freeze({}), body: emptyBody })

async function scrape(registry: Registry): Promise<string> {
  return await registry.metrics()
}

function countLine(body: string, component: string, operation: string, outcome: string): string {
  return `likego_requests_total{component="${component}",operation="${operation}",outcome="${outcome}"} 1`
}

function durationCountLine(
  body: string,
  component: string,
  operation: string,
  outcome: string
): string {
  return `likego_request_duration_seconds_count{component="${component}",operation="${operation}",outcome="${outcome}"} 1`
}

test("creates fixed application-owned collectors and rejects malformed instrumentation inputs", async () => {
  const registry = new Registry()
  const metrics = newRequestMetrics(registry)
  const registeredTotal = registry.getSingleMetric("likego_requests_total")
  const registeredDuration = registry.getSingleMetric("likego_request_duration_seconds")
  if (registeredTotal === undefined || registeredDuration === undefined) {
    throw new Error("request collectors were not registered")
  }

  expect(registeredTotal).toBe(metrics.requestsTotal)
  expect(registeredDuration).toBe(metrics.requestDurationSeconds)
  expect(Object.isFrozen(metrics)).toBe(true)
  expect(await scrape(registry)).not.toContain("error")
  expect(() => newRequestMetrics(registry)).toThrow(
    "A metric with the name likego_requests_total has already been registered"
  )

  const invalidMetrics = {}
  expect(() =>
    Reflect.apply(measureWebHandler, undefined, [() => new Response(), invalidMetrics])
  ).toThrow("metrics must be created by newRequestMetrics")
  expect(() => Reflect.apply(measureClient, undefined, [{}, metrics])).toThrow(
    "client must implement the LikeGo Client interface"
  )
  expect(() => Reflect.apply(measureWebHandler, undefined, [null, metrics])).toThrow(
    "Web handler must be a function"
  )
  expect(() => Reflect.apply(measureBroker, undefined, [{}, metrics])).toThrow(
    "broker must implement the LikeGo Broker interface"
  )
  expect(() => Reflect.apply(measureUnaryMiddleware(metrics), undefined, [null])).toThrow(
    "unary handler must be a function"
  )
})

test("measures each logical Client call once and preserves receiver, options, results, and failures", async () => {
  const registry = new Registry()
  const metrics = newRequestMetrics(registry)
  const result: Message = Object.freeze({
    header: Object.freeze({ native: "response" }),
    body: new Uint8Array([1])
  })
  const failure = new Error("secret client failure")
  const cancellation = new Error("caller canceled")
  let calls = 0
  let optionSeen: CallOption | null = null
  const closed = Promise.resolve()
  const native = {
    async call(
      _ctx: Context,
      request: CallRequest,
      ...options: readonly CallOption[]
    ): Promise<Message> {
      expect(this).toBe(native)
      calls += 1
      optionSeen = options[0] ?? null
      if (request.endpoint === "Fail") throw failure
      if (request.endpoint === "Cancel") throw cancellation
      return result
    },
    close(this: unknown): Promise<void> {
      expect(this).toBe(native)
      return closed
    }
  }
  const measured = measureClient(native as unknown as Client, metrics)
  const option: CallOption = (current) => current
  const request: CallRequest = {
    service: "catalog",
    endpoint: "Get",
    message: emptyMessage
  }

  expect(await measured.call(background(), request, option)).toBe(result)
  expect(calls).toBe(1)
  expect(optionSeen === option).toBe(true)
  expect(measured.close(background())).toBe(closed)
  await expect(
    measured.call(background(), { service: "catalog", endpoint: "Fail", message: emptyMessage })
  ).rejects.toBe(failure)
  const [canceledContext, cancel] = withCancelCause(background())
  cancel(cancellation)
  await expect(
    measured.call(canceledContext, {
      service: "catalog",
      endpoint: "Cancel",
      message: emptyMessage
    })
  ).rejects.toBe(cancellation)

  const body = await scrape(registry)
  expect(body).toContain(countLine(body, "client", "catalog/Get", "success"))
  expect(body).toContain(countLine(body, "client", "catalog/Fail", "failure"))
  expect(body).toContain(countLine(body, "client", "catalog/Cancel", "canceled"))
  expect(body).toContain(durationCountLine(body, "client", "catalog/Get", "success"))
  expect(body).not.toContain(failure.message)
})

test("keeps metrics and hostile Context failures from replacing application outcomes", async () => {
  let timerStarts = 0
  const metrics = {
    requestsTotal: {
      inc(): void {
        throw new Error("counter unavailable")
      }
    },
    requestDurationSeconds: {
      startTimer(): (labels?: unknown) => number {
        timerStarts += 1
        if (timerStarts === 1) throw new Error("timer unavailable")
        return () => {
          throw new Error("timer completion unavailable")
        }
      }
    }
  } as unknown as RequestMetrics
  const response = emptyMessage
  const failure = new Error("application failure")
  let selectedFailure: Error | null = null
  const client: Client = {
    async call(): Promise<Message> {
      if (selectedFailure !== null) throw selectedFailure
      return response
    },
    async close(): Promise<void> {}
  }
  const measured = measureClient(client, metrics)

  await expect(
    measured.call(background(), {
      service: "catalog",
      endpoint: "Get",
      message: emptyMessage
    })
  ).resolves.toBe(response)
  await expect(
    measured.call(background(), {
      service: "catalog",
      endpoint: "List",
      message: emptyMessage
    })
  ).resolves.toBe(response)

  selectedFailure = failure
  const hostile: Context = {
    deadline: background().deadline,
    done: background().done,
    err(): never {
      throw new Error("hostile Context")
    },
    value: background().value
  }
  await expect(
    measured.call(hostile, {
      service: "catalog",
      endpoint: "Fail",
      message: emptyMessage
    })
  ).rejects.toBe(failure)
})

test("measures unary Server operations from reserved route headers", async () => {
  const registry = new Registry()
  const metrics = newRequestMetrics(registry)
  const failure = new Error("secret server failure")
  const cancellation = new Error("server caller canceled")
  const middleware = measureUnaryMiddleware(metrics)
  const success = middleware(async (_ctx, message) => message)
  const fail = middleware(() => {
    throw failure
  })
  const cancelHandler = middleware(() => {
    throw cancellation
  })
  const routed: Message = {
    header: {
      [service.toLowerCase()]: "payments",
      [endpoint.toUpperCase()]: "Authorize"
    },
    body: emptyBody
  }

  expect(await success(background(), routed)).toBe(routed)
  await expect(fail(background(), routed)).rejects.toBe(failure)
  const [canceledContext, cancel] = withCancelCause(background())
  cancel(cancellation)
  await expect(cancelHandler(canceledContext, routed)).rejects.toBe(cancellation)
  expect(await success(background(), emptyMessage)).toBe(emptyMessage)

  const body = await scrape(registry)
  expect(body).toContain(countLine(body, "server", "payments/Authorize", "success"))
  expect(body).toContain(countLine(body, "server", "payments/Authorize", "failure"))
  expect(body).toContain(countLine(body, "server", "payments/Authorize", "canceled"))
  expect(body).toContain(countLine(body, "server", "unknown/unknown", "success"))
  expect(body).not.toContain(failure.message)
})

test("preserves synchronous and asynchronous Web semantics with method-only operations", async () => {
  const registry = new Registry()
  const metrics = newRequestMetrics(registry)
  const syncResponse = new Response("created", { status: 201 })
  const sync = measureWebHandler(() => syncResponse, metrics)
  const syncResult = sync(
    new Request("https://service.test/orders/customer-123?token=secret", { method: "POST" })
  )
  expect(syncResult).toBe(syncResponse)

  const serverFailure = new Response("unavailable", { status: 503 })
  expect(
    measureWebHandler(
      () => serverFailure,
      metrics
    )(new Request("https://service.test/orders", { method: "GET" }))
  ).toBe(serverFailure)

  const asyncResponse = new Response(null, { status: 204 })
  const asyncHandler = measureWebHandler(async () => asyncResponse, metrics)
  const asyncResult = asyncHandler(
    new Request("https://service.test/orders/customer-456", { method: "PATCH" })
  )
  expect(asyncResult).toBeInstanceOf(Promise)
  expect(await asyncResult).toBe(asyncResponse)

  const syncFailure = new Error("synchronous secret")
  const failingSync = measureWebHandler(() => {
    throw syncFailure
  }, metrics)
  expect(() =>
    failingSync(new Request("https://service.test/private/sync", { method: "DELETE" }))
  ).toThrow(syncFailure)

  const asyncFailure = new Error("asynchronous secret")
  const failingAsync = measureWebHandler(() => Promise.reject(asyncFailure), metrics)
  await expect(
    failingAsync(new Request("https://service.test/private/async", { method: "PUT" }))
  ).rejects.toBe(asyncFailure)

  const abort = new AbortController()
  abort.abort(new Error("request canceled"))
  expect(
    measureWebHandler(
      () => new Response("late"),
      metrics
    )(
      new Request("https://service.test/private/canceled", {
        method: "OPTIONS",
        signal: abort.signal
      })
    )
  ).toBeInstanceOf(Response)

  const body = await scrape(registry)
  expect(body).toContain(countLine(body, "web", "POST", "success"))
  expect(body).toContain(countLine(body, "web", "GET", "failure"))
  expect(body).toContain(countLine(body, "web", "PATCH", "success"))
  expect(body).toContain(countLine(body, "web", "DELETE", "failure"))
  expect(body).toContain(countLine(body, "web", "PUT", "failure"))
  expect(body).toContain(countLine(body, "web", "OPTIONS", "canceled"))
  expect(body).not.toContain("customer-123")
  expect(body).not.toContain("token")
  expect(body).not.toContain(syncFailure.message)
  expect(body).not.toContain(asyncFailure.message)
})

test("preserves Broker native results, events, Subscribers, options, and receiver", async () => {
  interface PublishOptions {
    readonly durable: boolean
  }
  interface SubscribeOptions {
    readonly queue: string
  }
  interface NativeEvent {
    readonly sequence: number
  }
  const registry = new Registry()
  const metrics = newRequestMetrics(registry)
  const nativeResult = Object.freeze({ sequence: 11 })
  const subscriber: Subscriber = Object.freeze({
    topic: "orders.created",
    async unsubscribe(): Promise<void> {}
  })
  const publishFailure = new Error("secret publish failure")
  const consumeFailure = new Error("secret consume failure")
  const cancellation = new Error("broker operation canceled")
  const handlers = new Map<
    string,
    (ctx: Context, event: BrokerEvent<NativeEvent>) => void | PromiseLike<void>
  >()
  let publishOptions: PublishOptions | undefined
  let subscribeOptions: SubscribeOptions | undefined
  const native: Broker<PublishOptions, typeof nativeResult, SubscribeOptions, NativeEvent> = {
    async publish(_ctx, topic, _message, options): Promise<typeof nativeResult> {
      expect(this).toBe(native)
      publishOptions = options
      if (topic === "orders.failed" || topic === "orders.canceled") throw publishFailure
      return nativeResult
    },
    async subscribe(_ctx, topic, handler, options): Promise<Subscriber> {
      expect(this).toBe(native)
      handlers.set(topic, handler)
      subscribeOptions = options
      return subscriber
    },
    string(): string {
      expect(this).toBe(native)
      return "native-broker"
    }
  }
  const measured = measureBroker(native, metrics)
  const message: BrokerMessage = Object.freeze({
    headers: Object.freeze({ secret: "do-not-record" }),
    body: new Uint8Array([9])
  })

  expect(await measured.publish(background(), "orders.created", message, { durable: true })).toBe(
    nativeResult
  )
  expect(publishOptions).toEqual({ durable: true })
  expect(await measured.publish(background(), "orders.updated", message)).toBe(nativeResult)
  expect(publishOptions).toBeUndefined()
  await expect(measured.publish(background(), "orders.failed", message)).rejects.toBe(
    publishFailure
  )
  const [canceledPublishContext, cancelPublish] = withCancelCause(background())
  cancelPublish(cancellation)
  await expect(measured.publish(canceledPublishContext, "orders.canceled", message)).rejects.toBe(
    publishFailure
  )
  expect(measured.string()).toBe("native-broker")

  let received: BrokerEvent<NativeEvent> | null = null
  expect(
    await measured.subscribe(
      background(),
      "orders.created",
      async (_ctx, event) => {
        received = event
      },
      { queue: "workers" }
    )
  ).toBe(subscriber)
  expect(subscribeOptions).toEqual({ queue: "workers" })
  const event: BrokerEvent<NativeEvent> = Object.freeze({
    topic: "orders.created",
    message,
    native: Object.freeze({ sequence: 12 })
  })
  await handlers.get("orders.created")?.(background(), event)
  expect(received === event).toBe(true)

  await measured.subscribe(background(), "orders.failed", () => {
    throw consumeFailure
  })
  expect(subscribeOptions).toBeUndefined()
  await expect(handlers.get("orders.failed")?.(background(), event)).rejects.toBe(consumeFailure)

  await measured.subscribe(background(), "orders.canceled", () => {
    throw consumeFailure
  })
  const [canceledConsumeContext, cancelConsume] = withCancelCause(background())
  cancelConsume(cancellation)
  await expect(handlers.get("orders.canceled")?.(canceledConsumeContext, event)).rejects.toBe(
    consumeFailure
  )
  await expect(
    Reflect.apply(measured.subscribe, measured, [background(), "orders.invalid", null])
  ).rejects.toThrow("broker handler must be a function")

  const body = await scrape(registry)
  expect(body).toContain(countLine(body, "broker", "publish orders.created", "success"))
  expect(body).toContain(countLine(body, "broker", "publish orders.updated", "success"))
  expect(body).toContain(countLine(body, "broker", "publish orders.failed", "failure"))
  expect(body).toContain(countLine(body, "broker", "publish orders.canceled", "canceled"))
  expect(body).toContain(countLine(body, "broker", "consume orders.created", "success"))
  expect(body).toContain(countLine(body, "broker", "consume orders.failed", "failure"))
  expect(body).toContain(countLine(body, "broker", "consume orders.canceled", "canceled"))
  expect(body).not.toContain("do-not-record")
  expect(body).not.toContain(publishFailure.message)
  expect(body).not.toContain(consumeFailure.message)
})
