import { expect, test } from "bun:test"

import type { BrokerEvent, Subscriber } from "@likego/broker"
import { newBrokerServer } from "@likego/broker"
import { background, cause, withCancel, withCancelCause, type Context } from "@likego/context"

import { newMemoryBroker } from "../src/index"

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

/** Creates one manually settled promise for deterministic lifecycle tests. */
function deferred<T>(): Deferred<T> {
  let settle: ((value: T) => void) | null = null
  const promise = new Promise<T>((resolve) => {
    settle = resolve
  })
  return Object.freeze({
    promise,
    resolve(value: T): void {
      const current = settle
      if (current === null) throw new Error("deferred already settled")
      settle = null
      current(value)
    }
  })
}

/** Allows already admitted promise callbacks to run without using a timer. */
async function nextTurn(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

/** Returns one publish rejection while requiring Error normalization. */
async function rejected(operation: PromiseLike<void>): Promise<Error> {
  try {
    await operation
  } catch (value) {
    if (value instanceof Error) return value
    throw new Error("Memory Broker rejected with a non-Error value")
  }
  throw new Error("Memory Broker operation unexpectedly fulfilled")
}

test("broadcasts exact topics with per-delivery immutable snapshots", async () => {
  const broker = newMemoryBroker()
  const firstContext = background()
  const secondContext = background()
  const firstEvents: BrokerEvent<null>[] = []
  const secondEvents: BrokerEvent<null>[] = []
  await broker.subscribe(firstContext, "orders", (ctx, event) => {
    expect(ctx).toBe(firstContext)
    firstEvents.push(event)
  })
  await broker.subscribe(secondContext, "orders", (ctx, event) => {
    expect(ctx).toBe(secondContext)
    secondEvents.push(event)
  })
  let otherCalls = 0
  await broker.subscribe(background(), "orders.created", () => {
    otherCalls += 1
  })

  const headers = { source: "api" }
  const body = new Uint8Array([1, 2])
  const publishing = broker.publish(background(), "orders", { headers, body })
  headers.source = "changed"
  body[0] = 9
  await publishing

  expect(otherCalls).toBe(0)
  expect(firstEvents).toHaveLength(1)
  expect(secondEvents).toHaveLength(1)
  const first = firstEvents[0]
  const second = secondEvents[0]
  if (first === undefined || second === undefined) throw new Error("deliveries missing")
  expect(first).not.toBe(second)
  expect(first.message).not.toBe(second.message)
  expect(first.message.headers).not.toBe(second.message.headers)
  expect(first.topic).toBe("orders")
  expect(first.native).toBeNull()
  expect(first.message.headers).toEqual({ source: "api" })
  expect(Object.isFrozen(first)).toBe(true)
  expect(Object.isFrozen(first.message)).toBe(true)
  expect(Object.isFrozen(first.message.headers)).toBe(true)
  const firstRead = first.message.body
  firstRead[0] = 8
  expect(first.message.body).toEqual(new Uint8Array([1, 2]))
  expect(second.message.body).toEqual(new Uint8Array([1, 2]))
  expect(first.message.body).not.toBe(first.message.body)
})

test("serializes each subscriber while different subscribers run in parallel", async () => {
  const broker = newMemoryBroker()
  const release = deferred<void>()
  const slow: number[] = []
  const fast: number[] = []
  await broker.subscribe(background(), "events", async (_ctx, event) => {
    const value = event.message.body[0]
    slow.push(value ?? -1)
    if (value === 1) await release.promise
  })
  await broker.subscribe(background(), "events", (_ctx, event) => {
    fast.push(event.message.body[0] ?? -1)
  })

  let firstSettled = false
  const first = broker
    .publish(background(), "events", { headers: {}, body: new Uint8Array([1]) })
    .then(() => {
      firstSettled = true
    })
  const second = broker.publish(background(), "events", {
    headers: {},
    body: new Uint8Array([2])
  })
  for (let turn = 0; turn < 8 && fast.length < 2; turn += 1) await Promise.resolve()
  expect(slow).toEqual([1])
  expect(fast).toEqual([1, 2])
  expect(firstSettled).toBe(false)
  release.resolve()
  await Promise.all([first, second])
  expect(slow).toEqual([1, 2])
})

test("publish without subscribers succeeds and pre-cancellation admits nothing", async () => {
  const broker = newMemoryBroker()
  await broker.publish(background(), "unused", { headers: {}, body: new Uint8Array() })

  let calls = 0
  await broker.subscribe(background(), "events", () => {
    calls += 1
  })
  const canceled = withCancelCause(background())
  const reason = new Error("publish canceled")
  canceled[1](reason)
  await expect(
    broker.publish(canceled[0], "events", { headers: {}, body: new Uint8Array() })
  ).rejects.toBe(reason)
  expect(calls).toBe(0)

  const subscribeCanceled = withCancel(background())
  subscribeCanceled[1]()
  const expected = cause(subscribeCanceled[0]) ?? subscribeCanceled[0].err()
  await expect(broker.subscribe(subscribeCanceled[0], "events", () => {})).rejects.toBe(expected)
})

test("unsubscribe removes admission then shares the caller-independent drain", async () => {
  const broker = newMemoryBroker()
  const release = deferred<void>()
  const subscribeContext = background()
  const contexts: Context[] = []
  let calls = 0
  const subscriber = await broker.subscribe(subscribeContext, "events", async (ctx) => {
    contexts.push(ctx)
    calls += 1
    await release.promise
  })
  const publishing = broker.publish(background(), "events", {
    headers: {},
    body: new Uint8Array([1])
  })
  await nextTurn()

  const canceled = withCancelCause(background())
  const reason = new Error("stop waiter canceled")
  canceled[1](reason)
  await expect(subscriber.unsubscribe(canceled[0])).rejects.toBe(reason)
  await broker.publish(background(), "events", { headers: {}, body: new Uint8Array([2]) })
  expect(calls).toBe(1)
  release.resolve()
  await publishing
  await subscriber.unsubscribe(background())
  await subscriber.unsubscribe(background())
  expect(contexts).toEqual([subscribeContext])
})

test("handler failure terminates only that subscriber and preserves Error identity", async () => {
  const broker = newMemoryBroker()
  const failure = new Error("handler failed")
  let failingCalls = 0
  const failing = await broker.subscribe(background(), "events", () => {
    failingCalls += 1
    throw failure
  })
  const healthy: number[] = []
  await broker.subscribe(background(), "events", (_ctx, event) => {
    healthy.push(event.message.body[0] ?? -1)
  })

  const first = broker.publish(background(), "events", {
    headers: {},
    body: new Uint8Array([1])
  })
  const second = broker.publish(background(), "events", {
    headers: {},
    body: new Uint8Array([2])
  })
  const firstResult = rejected(first)
  const secondResult = rejected(second)
  expect(await firstResult).toBe(failure)
  expect(await secondResult).toBe(failure)
  expect(failingCalls).toBe(1)
  expect(healthy).toEqual([1, 2])
  await expect(failing.unsubscribe(background())).rejects.toBe(failure)

  await broker.publish(background(), "events", {
    headers: {},
    body: new Uint8Array([3])
  })
  expect(healthy).toEqual([1, 2, 3])
})

test("waits healthy deliveries and aggregates failures in subscription order", async () => {
  const broker = newMemoryBroker()
  const firstFailure = new Error("first")
  const release = deferred<void>()
  let healthyFinished = false
  await broker.subscribe(background(), "events", () => {
    throw firstFailure
  })
  await broker.subscribe(background(), "events", async () => {
    await release.promise
    healthyFinished = true
  })
  await broker.subscribe(background(), "events", () => {
    throw "third"
  })

  let settled = false
  const publishing = broker
    .publish(background(), "events", { headers: {}, body: new Uint8Array() })
    .catch((error: unknown) => {
      settled = true
      throw error
    })
  await nextTurn()
  expect(settled).toBe(false)
  release.resolve()
  const failure = await rejected(publishing)
  expect(healthyFinished).toBe(true)
  expect(failure).toBeInstanceOf(AggregateError)
  if (!(failure instanceof AggregateError)) throw new Error("aggregate missing")
  expect(failure.cause).toBe(firstFailure)
  expect(failure.errors[0]).toBe(firstFailure)
  expect(failure.errors[1]).toMatchObject({
    message: "Memory Broker handler rejected with a non-Error value",
    cause: "third"
  })
})

test("caller cancellation abandons only the publish wait", async () => {
  const broker = newMemoryBroker()
  const release = deferred<void>()
  let finished = false
  await broker.subscribe(background(), "events", async () => {
    await release.promise
    finished = true
  })
  const selected = withCancelCause(background())
  const publishing = broker.publish(selected[0], "events", {
    headers: {},
    body: new Uint8Array()
  })
  await nextTurn()
  const reason = new Error("publish wait canceled")
  selected[1](reason)
  await expect(publishing).rejects.toBe(reason)
  release.resolve()
  await nextTurn()
  expect(finished).toBe(true)
})

test("integrates with newBrokerServer without owning a broker connection", async () => {
  const broker = newMemoryBroker()
  const received: number[] = []
  const server = newBrokerServer(broker, "orders", (_ctx, event) => {
    received.push(event.message.body[0] ?? -1)
  })
  const running = server.start(background())
  await nextTurn()
  await broker.publish(background(), "orders", {
    headers: {},
    body: new Uint8Array([7])
  })
  expect(received).toEqual([7])
  await server.stop(background())
  await running
  await broker.publish(background(), "orders", {
    headers: {},
    body: new Uint8Array([8])
  })
  expect(received).toEqual([7])
})

test("reports handler failure through newBrokerServer runtime", async () => {
  const broker = newMemoryBroker()
  const failure = new Error("server handler failed")
  const server = newBrokerServer(broker, "orders", () => {
    throw failure
  })
  const running = server.start(background())
  await nextTurn()

  await expect(
    broker.publish(background(), "orders", { headers: {}, body: new Uint8Array([1]) })
  ).rejects.toBe(failure)
  await expect(running).rejects.toBe(failure)
  await expect(server.stop(background())).rejects.toBe(failure)
})

test("validates topics messages handlers and unsupported options", async () => {
  const broker = newMemoryBroker()
  expect(broker.string()).toBe("memory")
  await expect(
    broker.publish(background(), "", { headers: {}, body: new Uint8Array() })
  ).rejects.toBeInstanceOf(TypeError)
  await expect(
    broker.publish(background(), "\ud800", { headers: {}, body: new Uint8Array() })
  ).rejects.toBeInstanceOf(TypeError)
  await expect(
    broker.publish(background(), "\udc00", { headers: {}, body: new Uint8Array() })
  ).rejects.toBeInstanceOf(TypeError)
  await expect(
    broker.publish(background(), "猫-\ud83d\udc08", {
      headers: {},
      body: new Uint8Array()
    })
  ).resolves.toBeUndefined()
  await expect(
    Reflect.apply(broker.publish, broker, [background(), "events", null])
  ).rejects.toBeInstanceOf(TypeError)
  await expect(
    Reflect.apply(broker.publish, broker, [background(), "events", { headers: {}, body: [] }])
  ).rejects.toBeInstanceOf(TypeError)
  await expect(
    Reflect.apply(broker.publish, broker, [
      background(),
      "events",
      { headers: null, body: new Uint8Array() }
    ])
  ).rejects.toBeInstanceOf(TypeError)
  await expect(
    Reflect.apply(broker.publish, broker, [
      background(),
      "events",
      { headers: [], body: new Uint8Array() }
    ])
  ).rejects.toBeInstanceOf(TypeError)
  await expect(
    Reflect.apply(broker.publish, broker, [
      background(),
      "events",
      { headers: { "": "value" }, body: new Uint8Array() }
    ])
  ).rejects.toBeInstanceOf(TypeError)
  await expect(
    Reflect.apply(broker.publish, broker, [
      background(),
      "events",
      { headers: { "\ud800": "value" }, body: new Uint8Array() }
    ])
  ).rejects.toBeInstanceOf(TypeError)
  await expect(
    Reflect.apply(broker.publish, broker, [
      background(),
      "events",
      { headers: { key: 1 }, body: new Uint8Array() }
    ])
  ).rejects.toBeInstanceOf(TypeError)
  await expect(
    Reflect.apply(broker.publish, broker, [
      background(),
      "events",
      { headers: { key: "\udc00" }, body: new Uint8Array() }
    ])
  ).rejects.toBeInstanceOf(TypeError)
  await expect(
    Reflect.apply(broker.publish, broker, [
      background(),
      "events",
      { headers: { __proto__: "safe" }, body: new Uint8Array() }
    ])
  ).resolves.toBeUndefined()
  await expect(
    Reflect.apply(broker.publish, broker, [
      background(),
      "events",
      { headers: {}, body: new Uint8Array() },
      {}
    ])
  ).rejects.toThrow("not supported")
  await expect(
    Reflect.apply(broker.subscribe, broker, [background(), "events", null])
  ).rejects.toBeInstanceOf(TypeError)
  await expect(
    Reflect.apply(broker.subscribe, broker, [background(), "events", () => {}, {}])
  ).rejects.toThrow("not supported")
})

test("unsubscribe is harmless before delivery and empty topic buckets are reusable", async () => {
  const broker = newMemoryBroker()
  const first = await broker.subscribe(background(), "events", () => {})
  await first.unsubscribe(background())
  const second: Subscriber = await broker.subscribe(background(), "events", () => {})
  await broker.publish(background(), "events", { headers: {}, body: new Uint8Array() })
  await second.unsubscribe(background())
})
