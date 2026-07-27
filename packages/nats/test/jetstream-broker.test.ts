import { describe, expect, test } from "bun:test"

import { background, withCancelCause, type Context } from "@likego/context"
import type { JetStreamClient, PubAck } from "@nats-io/jetstream"
import { newNatsJetStreamBroker } from "../src/jetstream-broker"
import { FakeConsumerMessages, deferred, jetStreamMessage, nextTurn } from "./broker-helpers"

interface SubscribeOptions {
  readonly durable: string
}

describe("NATS JetStream Broker", () => {
  test("preserves PubAck, native settlement, factory options, and lifecycle ownership", async () => {
    const messages = new FakeConsumerMessages()
    const ack = Object.freeze({ stream: "EVENTS", seq: 7, duplicate: false }) satisfies PubAck
    const publishes: unknown[][] = []
    const client = {
      identity: "borrowed",
      publish(this: { identity: string }, ...args: unknown[]) {
        expect(this.identity).toBe("borrowed")
        publishes.push(args)
        return Promise.resolve(ack)
      }
    } as unknown as JetStreamClient
    const factoryCapture: {
      context: Context | null
      topic: string
      options: SubscribeOptions | undefined
    } = { context: null, topic: "", options: undefined }
    const broker = newNatsJetStreamBroker<SubscribeOptions>(client, (ctx, topic, options) => {
      factoryCapture.context = ctx
      factoryCapture.topic = topic
      factoryCapture.options = options
      return messages
    })
    const body = new Uint8Array([5, 6])
    const result = await broker.publish(
      background(),
      "events.created",
      { headers: { traceparent: "00-abc" }, body },
      { msgID: "event-1" }
    )
    const ctx = background()
    const settlement = { ack: 0, nak: 0, term: 0 }
    const native = jetStreamMessage("events.created", [8], settlement)
    let observedNative = null as typeof native | null
    const subscriptionOwner = await broker.subscribe(
      ctx,
      "events.created",
      (_deliveryContext, event) => {
        observedNative = event.native
        event.native.ack()
      },
      { durable: "worker" }
    )
    messages.push(native)
    await nextTurn()

    expect(result).toBe(ack)
    expect(broker.string()).toBe("nats-jetstream")
    expect(body).toEqual(new Uint8Array([5, 6]))
    expect(publishes[0]?.[0]).toBe("events.created")
    expect(publishes[0]?.[2]).toMatchObject({ msgID: "event-1" })
    expect(factoryCapture.context).toBe(ctx)
    expect(factoryCapture.topic).toBe("events.created")
    expect(factoryCapture.options).toEqual({ durable: "worker" })
    expect(observedNative).toBe(native)
    expect(settlement.ack).toBe(1)
    await subscriptionOwner.unsubscribe(background())
    expect(messages.closeCalls).toBe(1)
  })

  test("allows only the caller to abandon a pending PubAck wait", async () => {
    const pending = deferred<PubAck>()
    const client = {
      publish() {
        return pending.promise
      }
    } as unknown as JetStreamClient
    const broker = newNatsJetStreamBroker(client, () => new FakeConsumerMessages())
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("publish canceled")
    const publishing = broker.publish(ctx, "events", { headers: {}, body: new Uint8Array() })
    cancel(reason)
    await expect(publishing).rejects.toBe(reason)
    pending.resolve({ stream: "EVENTS", seq: 1, duplicate: false })
    await nextTurn()
  })

  test("propagates exact delivery failures and preserves native settlement access", async () => {
    const messages = new FakeConsumerMessages()
    const client = {
      publish: async () => ({ stream: "EVENTS", seq: 1, duplicate: false })
    } as unknown as JetStreamClient
    const broker = newNatsJetStreamBroker(client, () => messages)
    const failure = new Error("schema rejected")
    let retained = null as ReturnType<typeof jetStreamMessage> | null
    const subscriptionOwner = await broker.subscribe(background(), "events", (_ctx, event) => {
      retained = event.native
      throw failure
    })
    const settlement = { ack: 0, nak: 0, term: 0 }
    const native = jetStreamMessage("events", [0], settlement)
    messages.push(native)

    await nextTurn()
    await expect(subscriptionOwner.unsubscribe(background())).rejects.toBe(failure)
    expect(retained).toBe(native)
    retained?.nak()
    retained?.term()
    expect(settlement).toEqual({ ack: 0, nak: 1, term: 1 })
    expect(messages.closeCalls).toBe(1)
  })

  test("reports passive native terminal rejection through the subscription barrier", async () => {
    const messages = new FakeConsumerMessages()
    const client = {
      publish: async () => ({ stream: "EVENTS", seq: 1, duplicate: false })
    } as unknown as JetStreamClient
    const subscriptionOwner = await newNatsJetStreamBroker(client, () => messages).subscribe(
      background(),
      "events",
      () => {}
    )

    messages.queue.finish()
    messages.terminal.reject("native closed rejection")
    await nextTurn()
    const failure = await subscriptionOwner
      .unsubscribe(background())
      .catch((value: unknown) => value)

    expect(failure).toMatchObject({
      name: "NatsJetStreamUnexpectedExitError",
      code: "LIKEGO_NATS_JETSTREAM_UNEXPECTED_EXIT"
    })
    await expect(subscriptionOwner.unsubscribe(background())).rejects.toBe(failure)
  })

  test("forces only ConsumerMessages when official close rejects", async () => {
    const messages = new FakeConsumerMessages()
    const failure = new Error("close rejected")
    messages.close = () => Promise.reject(failure)
    const client = {
      publish: async () => ({ stream: "EVENTS", seq: 1, duplicate: false })
    } as unknown as JetStreamClient
    const subscriptionOwner = await newNatsJetStreamBroker(client, () => messages).subscribe(
      background(),
      "events",
      () => {}
    )

    await expect(subscriptionOwner.unsubscribe(background())).rejects.toBe(failure)
    await expect(subscriptionOwner.unsubscribe(background())).rejects.toBe(failure)
    expect(messages.stopCalls).toBe(1)
  })

  test("forces provider cleanup after the owner deadline", async () => {
    const messages = new FakeConsumerMessages()
    const closeGate = deferred<void>()
    messages.close = () => closeGate.promise
    const client = {
      publish: async () => ({ stream: "EVENTS", seq: 1, duplicate: false })
    } as unknown as JetStreamClient
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
      const subscriptionOwner = await newNatsJetStreamBroker(client, () => messages).subscribe(
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
        code: "LIKEGO_NATS_JETSTREAM_CLOSE_TIMEOUT",
        timeoutMs: 25_000,
        forced: true
      })
      closeGate.resolve()
      await nextTurn()
      await expect(subscriptionOwner.unsubscribe(background())).rejects.toBe(failure)
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  test("rolls back ConsumerMessages that arrive after subscribe cancellation", async () => {
    const messages = new FakeConsumerMessages()
    const pending = deferred<FakeConsumerMessages>()
    const client = {
      publish: async () => ({ stream: "EVENTS", seq: 1, duplicate: false })
    } as unknown as JetStreamClient
    const broker = newNatsJetStreamBroker(client, () => pending.promise)
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("subscribe canceled")
    const subscribing = broker.subscribe(ctx, "events", () => {})

    cancel(reason)
    await expect(subscribing).rejects.toBe(reason)
    pending.resolve(messages)
    await nextTurn()
    expect(messages.stopCalls).toBe(1)
  })

  test("joins provisional ConsumerMessages rollback when Context cancels in the factory", async () => {
    const messages = new FakeConsumerMessages()
    messages.stop = () => {
      messages.stopCalls += 1
    }
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("canceled during ConsumerMessages factory")
    const client = {
      publish: async () => ({ stream: "EVENTS", seq: 1, duplicate: false })
    } as unknown as JetStreamClient
    const broker = newNatsJetStreamBroker(client, () => {
      cancel(reason)
      return messages
    })
    const subscribing = broker.subscribe(ctx, "events", () => {})
    let settled = false
    void subscribing.catch(() => {
      settled = true
    })

    await nextTurn()
    expect(messages.stopCalls).toBe(1)
    expect(messages.closeCalls).toBe(0)
    expect(settled).toBe(false)

    messages.terminal.resolve()
    await expect(subscribing).rejects.toBe(reason)
  })

  test("observes a late rejected acquisition after subscribe cancellation", async () => {
    const pending = deferred<FakeConsumerMessages>()
    const client = {
      publish: async () => ({ stream: "EVENTS", seq: 1, duplicate: false })
    } as unknown as JetStreamClient
    const broker = newNatsJetStreamBroker(client, () => pending.promise)
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("subscribe canceled")
    const subscribing = broker.subscribe(ctx, "events", () => {})

    cancel(reason)
    await expect(subscribing).rejects.toBe(reason)
    pending.reject("late factory rejection")
    await nextTurn()
  })

  test("keeps post-acquisition Context and rollback failures in deterministic order", async () => {
    const messages = new FakeConsumerMessages()
    const admissionFailure = new Error("post-acquisition Context inspection failed")
    const cleanupFailure = new Error("rollback stop failed")
    let errorReads = 0
    const context: Context = {
      deadline: () => [new Date(0), false],
      done: () => null,
      err() {
        errorReads += 1
        if (errorReads >= 3) throw admissionFailure
        return null
      },
      value: () => null
    }
    messages.stop = () => {
      throw cleanupFailure
    }
    messages.closed = () => {
      throw "rollback terminal observation failed"
    }
    const client = {
      publish: async () => ({ stream: "EVENTS", seq: 1, duplicate: false })
    } as unknown as JetStreamClient
    const broker = newNatsJetStreamBroker(client, () => messages)

    const failure = await broker
      .subscribe(context, "events", () => {})
      .catch((value: unknown) => value)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors.slice(0, 2)).toEqual([
      admissionFailure,
      cleanupFailure
    ])
    expect((failure as AggregateError).errors[2]).toMatchObject({
      message: "NATS Broker closed rejected with a non-Error value",
      cause: "rollback terminal observation failed"
    })
    expect((failure as AggregateError).cause).toBe(admissionFailure)
  })

  test("fails closed on invalid construction, cancellation, and subscription boundaries", async () => {
    let publishes = 0
    let factories = 0
    const client = {
      publish: async () => {
        publishes += 1
        return { stream: "EVENTS", seq: 1, duplicate: false }
      }
    } as unknown as JetStreamClient
    const broker = newNatsJetStreamBroker(client, () => {
      factories += 1
      return new FakeConsumerMessages()
    })
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("already canceled")
    cancel(reason)

    await expect(
      broker.publish(ctx, "events", { headers: {}, body: new Uint8Array() })
    ).rejects.toBe(reason)
    await expect(broker.subscribe(ctx, "events", () => {})).rejects.toBe(reason)
    await expect(broker.subscribe(background(), "events", null as never)).rejects.toThrow(
      "callable"
    )
    await expect(
      newNatsJetStreamBroker(client, () => ({}) as never).subscribe(
        background(),
        "events",
        () => {}
      )
    ).rejects.toThrow("official ConsumerMessages")
    await expect(
      newNatsJetStreamBroker(client, () => {
        throw "factory rejection"
      }).subscribe(background(), "events", () => {})
    ).rejects.toThrow("non-Error")
    expect(publishes).toBe(0)
    expect(factories).toBe(0)
    expect(() => newNatsJetStreamBroker(null as never, () => new FakeConsumerMessages())).toThrow(
      "object"
    )
    expect(() => newNatsJetStreamBroker({} as never, () => new FakeConsumerMessages())).toThrow(
      "callable"
    )
    expect(() => newNatsJetStreamBroker(client, null as never)).toThrow("factory")
  })
})
