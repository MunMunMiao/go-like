import { describe, expect, test } from "bun:test"

import { background, withCancelCause, type Context } from "@likego/context"
import { headers, type Msg, type NatsConnection } from "@nats-io/transport-node"
import { newNatsCoreBroker } from "../src/broker"
import { FakeSubscription, coreMessage, deferred, nextTurn } from "./broker-helpers"

describe("NATS Core Broker", () => {
  test("publishes detached bytes and official headers without owning the connection", async () => {
    const calls: unknown[][] = []
    const connection = {
      identity: "borrowed",
      publish(this: { identity: string }, ...args: unknown[]) {
        expect(this.identity).toBe("borrowed")
        calls.push(args)
        const bytes = args[1]
        if (bytes instanceof Uint8Array) bytes[0] = 99
      },
      subscribe() {
        return new FakeSubscription()
      }
    } as unknown as NatsConnection
    const broker = newNatsCoreBroker(connection)
    const body = new Uint8Array([7, 8])

    await broker.publish(
      background(),
      "events.created",
      { headers: { "trace-parent": "abc" }, body },
      { reply: "reply.subject" }
    )
    await broker.publish(background(), "events.empty", { headers: {}, body })

    expect(broker.string()).toBe("nats-core")
    expect(body).toEqual(new Uint8Array([7, 8]))
    expect(calls).toHaveLength(2)
    expect(calls[0]?.[0]).toBe("events.created")
    expect(calls[0]?.[2]).toMatchObject({ reply: "reply.subject" })
    const options = calls[0]?.[2] as { headers: ReturnType<typeof headers> }
    expect(options.headers.get("trace-parent")).toBe("abc")
    expect(calls[1]).toHaveLength(2)
  })

  test("delivers defensive bytes and exact native messages through the shared lifecycle", async () => {
    const subscription = new FakeSubscription()
    let subscribeOptions: unknown = null
    const connection = {
      publish() {},
      subscribe(_topic: string, options?: unknown) {
        subscribeOptions = options
        return subscription
      }
    } as unknown as NatsConnection
    const broker = newNatsCoreBroker(connection)
    const native = coreMessage("events.actual", [3, 4], ["first", "last"])
    const observed: {
      native: Msg | null
      firstBody: Uint8Array | null
      secondBody: Uint8Array | null
    } = { native: null, firstBody: null, secondBody: null }
    let observedHeader = ""
    const subscriptionOwner = await broker.subscribe(
      background(),
      "events.*",
      (_ctx, event) => {
        observed.native = event.native
        observed.firstBody = event.message.body
        observed.firstBody[0] = 77
        observed.secondBody = event.message.body
        observedHeader = event.message.headers["x-test"] ?? ""
      },
      { queue: "workers" }
    )

    subscription.push(native)
    await nextTurn()
    expect(subscriptionOwner.topic).toBe("events.*")
    expect(subscribeOptions).toEqual({ queue: "workers" })
    expect(observed.native).toBe(native)
    expect(observed.firstBody).toEqual(new Uint8Array([77, 4]))
    expect(observed.secondBody).toEqual(new Uint8Array([3, 4]))
    expect(native.data).toEqual(new Uint8Array([3, 4]))
    expect(observedHeader).toBe("last")

    await subscriptionOwner.unsubscribe(background())
    expect(subscription.drainCalls).toBe(1)
  })

  test("propagates exact handler failures while the existing lifecycle drains", async () => {
    const subscription = new FakeSubscription()
    const connection = {
      publish() {},
      subscribe() {
        return subscription
      }
    } as unknown as NatsConnection
    const broker = newNatsCoreBroker(connection)
    const failure = new Error("handler failed")
    const subscriptionOwner = await broker.subscribe(background(), "events", () => {
      throw failure
    })

    subscription.push(coreMessage("events", [1]))
    await nextTurn()
    await expect(subscriptionOwner.unsubscribe(background())).rejects.toBe(failure)
    expect(subscription.drainCalls).toBe(1)
  })

  test("rolls back a provisional subscription when Context cancels during native subscribe", async () => {
    const subscription = new FakeSubscription()
    subscription.unsubscribe = () => {
      subscription.unsubscribeCalls += 1
    }
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("canceled during native subscribe")
    let connectionCloseCalls = 0
    const connection = {
      publish() {},
      subscribe() {
        cancel(reason)
        return subscription
      },
      close() {
        connectionCloseCalls += 1
      }
    } as unknown as NatsConnection
    const subscribing = newNatsCoreBroker(connection).subscribe(ctx, "events", () => {})
    let settled = false
    void subscribing.catch(() => {
      settled = true
    })

    await nextTurn()
    expect(subscription.unsubscribeCalls).toBe(1)
    expect(subscription.drainCalls).toBe(0)
    expect(connectionCloseCalls).toBe(0)
    expect(settled).toBe(false)

    subscription.terminal.resolve()
    await expect(subscribing).rejects.toBe(reason)
  })

  test("normalizes a non-Error post-subscribe Context failure after native rollback", async () => {
    const subscription = new FakeSubscription()
    let reads = 0
    const context: Context = {
      deadline: () => [new Date(0), false],
      done: () => null,
      err() {
        reads += 1
        if (reads > 1) throw "post-subscribe Context failure"
        return null
      },
      value: () => null
    }
    const connection = {
      publish() {},
      subscribe() {
        return subscription
      }
    } as unknown as NatsConnection

    const failure = await newNatsCoreBroker(connection)
      .subscribe(context, "events", () => {})
      .catch((value: unknown) => value)

    expect(failure).toMatchObject({
      message: "NATS Core Broker admission rejected with a non-Error value",
      cause: "post-subscribe Context failure"
    })
    expect(subscription.unsubscribeCalls).toBe(1)
  })

  test("reports passive native terminal rejection from unsubscribe", async () => {
    const subscription = new FakeSubscription()
    const connection = {
      publish() {},
      subscribe() {
        return subscription
      }
    } as unknown as NatsConnection
    const subscriptionOwner = await newNatsCoreBroker(connection).subscribe(
      background(),
      "events",
      () => {}
    )

    subscription.queue.finish()
    subscription.terminal.reject("native closed rejection")
    await nextTurn()
    const failure = await subscriptionOwner
      .unsubscribe(background())
      .catch((value: unknown) => value)

    expect(failure).toMatchObject({
      name: "NatsCoreUnexpectedExitError",
      code: "LIKEGO_NATS_CORE_UNEXPECTED_EXIT"
    })
    await expect(subscriptionOwner.unsubscribe(background())).rejects.toBe(failure)
  })

  test("forces only the subscription when official drain rejects", async () => {
    const subscription = new FakeSubscription()
    const failure = new Error("drain rejected")
    subscription.drain = () => Promise.reject(failure)
    const connection = {
      publish() {},
      subscribe() {
        return subscription
      }
    } as unknown as NatsConnection
    const subscriptionOwner = await newNatsCoreBroker(connection).subscribe(
      background(),
      "events",
      () => {}
    )

    await expect(subscriptionOwner.unsubscribe(background())).rejects.toBe(failure)
    expect(subscription.unsubscribeCalls).toBe(1)
  })

  test("normalizes synchronous terminal, drain, and force failures without losing ownership", async () => {
    const terminalSubscription = new FakeSubscription()
    terminalSubscription.queue.finish()
    Object.defineProperty(terminalSubscription, "closed", {
      configurable: true,
      get() {
        throw "closed getter failure"
      }
    })
    const terminalConnection = {
      publish() {},
      subscribe() {
        return terminalSubscription
      }
    } as unknown as NatsConnection
    const passive = await newNatsCoreBroker(terminalConnection).subscribe(
      background(),
      "events",
      () => {}
    )
    await expect(passive.unsubscribe(background())).rejects.toMatchObject({
      code: "LIKEGO_NATS_CORE_UNEXPECTED_EXIT"
    })

    const stoppingSubscription = new FakeSubscription()
    stoppingSubscription.drain = () => {
      throw "drain failure"
    }
    stoppingSubscription.unsubscribe = () => {
      throw "unsubscribe failure"
    }
    const stoppingConnection = {
      publish() {},
      subscribe() {
        return stoppingSubscription
      }
    } as unknown as NatsConnection
    const subscriptionOwner = await newNatsCoreBroker(stoppingConnection).subscribe(
      background(),
      "events",
      () => {}
    )
    const stopping = subscriptionOwner.unsubscribe(background())
    stoppingSubscription.queue.finish()
    stoppingSubscription.terminal.resolve()
    const failure = await stopping.catch((value: unknown) => value)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toHaveLength(2)
    await expect(subscriptionOwner.unsubscribe(background())).rejects.toEqual(failure)
  })

  test("forces native cleanup after the provider owner deadline", async () => {
    const subscription = new FakeSubscription()
    const drainGate = deferred<void>()
    subscription.drain = () => drainGate.promise
    const connection = {
      publish() {},
      subscribe() {
        return subscription
      }
    } as unknown as NatsConnection
    const originalSetTimeout = globalThis.setTimeout
    let timeoutCallback: (() => void) | null = null
    globalThis.setTimeout = ((
      handler: TimerHandler,
      timeout?: number,
      ...arguments_: unknown[]
    ) => {
      const timer = originalSetTimeout(handler, timeout, ...arguments_)
      if (timeout === 25_000 && typeof handler === "function") {
        timeoutCallback = () => {
          handler(...arguments_)
        }
      }
      return timer
    }) as typeof setTimeout
    try {
      const subscriptionOwner = await newNatsCoreBroker(connection).subscribe(
        background(),
        "events",
        () => {}
      )
      const stopping = subscriptionOwner.unsubscribe(background()).catch((value: unknown) => value)
      expect(timeoutCallback).not.toBeNull()
      const invokeTimeout = timeoutCallback as (() => void) | null
      invokeTimeout?.()
      const failure = await stopping
      expect(failure).toMatchObject({
        code: "LIKEGO_NATS_CORE_DRAIN_TIMEOUT",
        timeoutMs: 25_000,
        forced: true
      })
      drainGate.resolve()
      await nextTurn()
      await expect(subscriptionOwner.unsubscribe(background())).rejects.toBe(failure)
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  test("fails closed on cancellation and malformed boundaries before native I/O", async () => {
    let publishes = 0
    let subscribes = 0
    const connection = {
      publish() {
        publishes += 1
      },
      subscribe() {
        subscribes += 1
        return new FakeSubscription()
      }
    } as unknown as NatsConnection
    const broker = newNatsCoreBroker(connection)
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("canceled")
    cancel(reason)

    await expect(
      broker.publish(ctx, "events", { headers: {}, body: new Uint8Array() })
    ).rejects.toBe(reason)
    await expect(broker.subscribe(ctx, "events", () => {})).rejects.toBe(reason)
    await expect(
      broker.publish(background(), "", { headers: {}, body: new Uint8Array() })
    ).rejects.toThrow("non-empty")
    await expect(
      broker.publish(background(), "events", { headers: null as never, body: new Uint8Array() })
    ).rejects.toThrow("headers")
    await expect(
      broker.publish(background(), "events", { headers: {}, body: [] as never })
    ).rejects.toThrow("Uint8Array")
    await expect(
      broker.publish(background(), "events", {
        headers: { bad: "\ud800" },
        body: new Uint8Array()
      })
    ).rejects.toThrow("well-formed")
    await expect(broker.subscribe(background(), "events", null as never)).rejects.toThrow(
      "callable"
    )
    await expect(
      broker.subscribe(background(), "events", () => {}, { callback: () => {} } as never)
    ).rejects.toThrow("owns")
    await expect(
      newNatsCoreBroker({ publish() {}, subscribe: () => ({}) } as never).subscribe(
        background(),
        "events",
        () => {}
      )
    ).rejects.toThrow("official Subscription")
    expect(publishes).toBe(0)
    expect(subscribes).toBe(0)
    expect(() => newNatsCoreBroker(null as never)).toThrow("object")
    expect(() => newNatsCoreBroker({} as never)).toThrow("callable")
  })
})
