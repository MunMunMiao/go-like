import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"

import { newBrokerServer } from "@go-like/broker"
import { subscriberTerminal } from "@go-like/broker/provider"
import { background, canceled, withCancelCause, type Context } from "@go-like/context"
import type {
  Channel,
  ChannelModel,
  ConfirmChannel,
  ConsumeMessage,
  RecoveringChannelModel
} from "amqplib"
import {
  newConfirmRabbitMqBroker,
  newRabbitMqBroker,
  newRecoveringRabbitMqBroker
} from "../src/index"
import { delivery, fakeChannel, fakeConfirmChannel, nextTurn } from "./helpers"

describe("RabbitMQ Broker", () => {
  test("publishes detached bytes, portable headers, and all native properties", async () => {
    const channel = fakeChannel()
    channel.publishResult = false
    const broker = newRabbitMqBroker(channel.native)
    const body = new Uint8Array([7, 8])
    const accepted = await broker.publish(
      background(),
      "ignored.topic",
      { headers: { trace: "abc" }, body },
      {
        exchange: "events",
        routingKey: "created",
        properties: {
          expiration: 1000,
          userId: "app",
          CC: ["copy.one"],
          mandatory: true,
          persistent: true,
          deliveryMode: 2,
          BCC: "copy.hidden",
          contentType: "application/json",
          contentEncoding: "utf-8",
          priority: 3,
          correlationId: "correlation",
          replyTo: "replies",
          messageId: "message",
          timestamp: 123,
          type: "created",
          appId: "go-like"
        }
      }
    )

    expect(accepted).toBe(false)
    expect(body).toEqual(new Uint8Array([7, 8]))
    expect(broker.string()).toBe("rabbitmq")
    expect(channel.calls.publish).toHaveLength(1)
    expect(channel.calls.publish[0]?.slice(0, 2)).toEqual(["events", "created"])
    expect(channel.calls.publish[0]?.[2]).toEqual(Buffer.from([99, 8]))
    expect(channel.calls.publish[0]?.[3]).toEqual({
      expiration: 1000,
      userId: "app",
      CC: ["copy.one"],
      mandatory: true,
      persistent: true,
      deliveryMode: 2,
      BCC: "copy.hidden",
      contentType: "application/json",
      contentEncoding: "utf-8",
      headers: { trace: "abc" },
      priority: 3,
      correlationId: "correlation",
      replyTo: "replies",
      messageId: "message",
      timestamp: 123,
      type: "created",
      appId: "go-like"
    })

    await broker.publish(background(), "default.😀", {
      headers: { "trace-😀": "value-😀" },
      body: new Uint8Array()
    })
    expect(channel.calls.publish[1]?.slice(0, 2)).toEqual(["", "default.😀"])
    expect(channel.calls.publish[1]?.[3]).toEqual({ headers: { "trace-😀": "value-😀" } })
  })

  test("waits for a publisher ack and preserves the flow-control result", async () => {
    const channel = fakeConfirmChannel()
    channel.publishResult = false
    const publishing = newConfirmRabbitMqBroker(channel.native).publish(background(), "events", {
      headers: {},
      body: new Uint8Array([7])
    })
    let settled = false
    void publishing.then(() => {
      settled = true
    })

    await nextTurn()
    expect(settled).toBe(false)
    expect(channel.pendingConfirms).toBe(1)
    channel.confirm(0)

    await expect(publishing).resolves.toBe(false)
  })

  test("rejects a plain Channel at the confirm factory boundary", () => {
    expect(() => newConfirmRabbitMqBroker(fakeChannel().native as ConfirmChannel)).toThrow(
      "must be an amqplib ConfirmChannel"
    )
  })

  test("preserves a synchronous ConfirmChannel publish failure", async () => {
    const channel = fakeConfirmChannel()
    const failure = new Error("confirm channel is closed")
    channel.native.publish = () => {
      throw failure
    }

    await expect(
      newConfirmRabbitMqBroker(channel.native).publish(background(), "events", {
        headers: {},
        body: new Uint8Array()
      })
    ).rejects.toBe(failure)
  })

  test("rejects the exact publisher nack and channel-close failures", async () => {
    const channel = fakeConfirmChannel()
    const broker = newConfirmRabbitMqBroker(channel.native)
    const nacked = broker.publish(background(), "nacked", {
      headers: {},
      body: new Uint8Array()
    })
    const closed = broker.publish(background(), "closed", {
      headers: {},
      body: new Uint8Array()
    })
    const nackFailure = new Error("message nacked")
    const nackOutcome = nacked.catch((value: unknown) => value)
    const closeOutcome = closed.catch((value: unknown) => value)

    channel.confirm(0, nackFailure)
    await expect(nackOutcome).resolves.toBe(nackFailure)
    await channel.native.close()
    await expect(closeOutcome).resolves.toBe(channel.closeFailure)
    expect(channel.pendingConfirms).toBe(0)
  })

  test("lets Context abandon confirm waiting and observes a late nack", async () => {
    const channel = fakeConfirmChannel()
    const [ctx, cancel] = withCancelCause(background())
    const cancellation = new Error("publisher wait canceled")
    const lateNack = new Error("late publisher nack")
    const unhandled: unknown[] = []
    const recordUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on("unhandledRejection", recordUnhandled)
    try {
      const publishing = newConfirmRabbitMqBroker(channel.native).publish(ctx, "events", {
        headers: {},
        body: new Uint8Array()
      })
      cancel(cancellation)
      await expect(publishing).rejects.toBe(cancellation)

      channel.confirm(0, lateNack)
      await nextTurn()
      await nextTurn()
      expect(channel.pendingConfirms).toBe(0)
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", recordUnhandled)
    }
  })

  test("keeps 100 concurrent publisher confirms isolated", async () => {
    const channel = fakeConfirmChannel()
    const broker = newConfirmRabbitMqBroker(channel.native)
    const expected: boolean[] = []
    const publishing: Array<Promise<boolean>> = []
    for (let index = 0; index < 100; index += 1) {
      const accepted = index % 3 !== 0
      channel.publishResult = accepted
      expected.push(accepted)
      publishing.push(
        broker.publish(background(), `events.${index}`, {
          headers: {},
          body: new Uint8Array([index])
        })
      )
    }

    expect(channel.pendingConfirms).toBe(100)
    for (let index = 99; index >= 0; index -= 1) channel.confirm(index)
    await expect(Promise.all(publishing)).resolves.toEqual(expected)
  })

  test("creates a ConfirmChannel for every recovery generation", async () => {
    const first = fakeConfirmChannel()
    const second = fakeConfirmChannel()
    const channels = [first, second]
    let selected = 0
    let createChannelCalls = 0
    let createConfirmChannelCalls = 0
    let setup: (model: ChannelModel) => Promise<void> = async () => {}
    const recovering = new EventEmitter() as RecoveringChannelModel
    Object.defineProperty(recovering, "close", { value: async () => {} })
    const model = new EventEmitter() as ChannelModel
    Object.defineProperties(model, {
      createChannel: {
        value: async () => {
          createChannelCalls += 1
          const channel = channels[selected]
          if (channel === undefined) throw new Error("missing recovery channel")
          return channel.native
        }
      },
      createConfirmChannel: {
        value: async () => {
          createConfirmChannelCalls += 1
          const channel = channels[selected]
          if (channel === undefined) throw new Error("missing recovery confirm channel")
          return channel.native
        }
      }
    })
    const provider = await newRecoveringRabbitMqBroker(background(), async (provided) => {
      setup = provided
      await provided(model)
      return recovering
    })

    expect(createChannelCalls).toBe(0)
    expect(createConfirmChannelCalls).toBe(1)
    first.publishResult = false
    const firstPublish = provider.broker.publish(background(), "first", {
      headers: {},
      body: new Uint8Array()
    })
    first.confirm(0)
    await expect(firstPublish).resolves.toBe(false)

    recovering.emit("disconnect", new Error("lost first generation"))
    selected = 1
    await setup(model)
    expect(createChannelCalls).toBe(0)
    expect(createConfirmChannelCalls).toBe(2)
    const secondPublish = provider.broker.publish(background(), "second", {
      headers: {},
      body: new Uint8Array()
    })
    second.confirm(0)
    await expect(secondPublish).resolves.toBe(true)
  })

  test("rejects invalid contexts, topics, routing values, messages, and channels", async () => {
    expect(() => newRabbitMqBroker(null as unknown as Channel)).toThrow(TypeError)
    expect(() => newRabbitMqBroker({} as Channel)).toThrow(TypeError)
    const broker = newRabbitMqBroker(fakeChannel().native)
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("stopped")
    cancel(reason)
    await expect(
      broker.publish(ctx, "events", { headers: {}, body: new Uint8Array() })
    ).rejects.toBe(reason)
    await expect(
      broker.publish(background(), "", { headers: {}, body: new Uint8Array() })
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      broker.publish(
        background(),
        "events",
        { headers: {}, body: new Uint8Array() },
        { exchange: "\ud800" }
      )
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      broker.publish(
        background(),
        "events",
        { headers: {}, body: new Uint8Array() },
        { routingKey: "\udc00" }
      )
    ).rejects.toBeInstanceOf(TypeError)
    await expect(broker.publish(background(), "events", null as never)).rejects.toBeInstanceOf(
      TypeError
    )
    await expect(
      broker.publish(background(), "events", { headers: {}, body: [] as never })
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      broker.publish(background(), "events", {
        headers: [] as never,
        body: new Uint8Array()
      })
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      broker.publish(background(), "events", {
        headers: { "": "bad" },
        body: new Uint8Array()
      })
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      broker.publish(background(), "events", {
        headers: { bad: "\ud800" },
        body: new Uint8Array()
      })
    ).rejects.toBeInstanceOf(TypeError)
  })

  test("declares topology, serializes delivery, preserves native ack, and cancels exactly once", async () => {
    const channel = fakeChannel()
    channel.consumeTag = "consumer-exact"
    const broker = newRabbitMqBroker(channel.native)
    const first = delivery("orders.created", [1, 2], {
      trace: "one",
      count: 2,
      malformed: ["ignored"]
    })
    const second = delivery("orders.created", [3, 4])
    const nativeSeen: ConsumeMessage[] = []
    const bodies: Uint8Array[] = []
    let releaseFirst: () => void = () => {}
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const subscriber = await broker.subscribe(
      background(),
      "orders.*",
      async (_ctx, event) => {
        nativeSeen.push(event.native)
        const body = event.message.body
        bodies.push(body)
        body[0] = 88
        expect(event.message.body[0]).toBe(event.native === first ? 1 : 3)
        expect(event.topic).toBe("orders.created")
        if (event.native === first) await firstBlocked
        broker.ack(event.native)
      },
      {
        exchange: {
          name: "orders",
          type: "topic",
          options: { durable: true },
          bindingArguments: { tenant: "one" }
        },
        queue: { options: { exclusive: true, autoDelete: true } },
        routingKey: "orders.*",
        prefetch: { count: 5, global: false },
        consume: { noAck: false, exclusive: true }
      }
    )

    expect(channel.calls.assertExchange).toEqual([["orders", "topic", { durable: true }]])
    expect(channel.calls.prefetch).toEqual([[5, false]])
    expect(channel.calls.assertQueue).toEqual([["", { exclusive: true, autoDelete: true }]])
    expect(channel.calls.bindQueue).toEqual([
      ["generated-queue", "orders", "orders.*", { tenant: "one" }]
    ])
    expect(channel.calls.consume).toEqual([["generated-queue", { noAck: false, exclusive: true }]])

    channel.onMessage?.(first)
    channel.onMessage?.(second)
    await nextTurn()
    expect(nativeSeen).toEqual([first])
    expect(first.content).toEqual(Buffer.from([1, 2]))
    expect(bodies[0]).toEqual(new Uint8Array([88, 2]))
    releaseFirst()
    await subscriber.unsubscribe(background())
    expect(nativeSeen).toEqual([first, second])
    expect(channel.calls.ack).toEqual([first, second])
    broker.nack(second, false, true)
    broker.reject(second, false)
    expect(channel.calls.nack).toEqual([[second, false, true]])
    expect(channel.calls.reject).toEqual([[second, false]])
    expect(channel.calls.cancel).toEqual(["consumer-exact"])
    await subscriber.unsubscribe(background())
    expect(channel.calls.cancel).toEqual(["consumer-exact"])
  })

  test("uses a same-name queue without exchange and validates subscribe inputs", async () => {
    const channel = fakeChannel()
    const broker = newRabbitMqBroker(channel.native)
    const subscriber = await broker.subscribe(background(), "jobs", () => {})
    expect(channel.calls.assertExchange).toEqual([])
    expect(channel.calls.assertQueue).toEqual([["jobs", undefined]])
    expect(channel.calls.bindQueue).toEqual([])
    expect(subscriber.topic).toBe("jobs")
    await subscriber.unsubscribe(background())

    await expect(broker.subscribe(background(), "", () => {})).rejects.toBeInstanceOf(TypeError)
    await expect(broker.subscribe(background(), "jobs", null as never)).rejects.toBeInstanceOf(
      TypeError
    )
    await expect(
      broker.subscribe(background(), "jobs", () => {}, {
        exchange: { name: "\ud800", type: "topic" }
      })
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      broker.subscribe(background(), "jobs", () => {}, {
        exchange: { name: "events", type: "" }
      })
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      broker.subscribe(background(), "jobs", () => {}, { routingKey: "\ud800" })
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      broker.subscribe(background(), "jobs", () => {}, { queue: { name: "\ud800" } })
    ).rejects.toBeInstanceOf(TypeError)
  })

  test("uses safe transient defaults for an implicit server-named exchange queue", async () => {
    const omitted = fakeChannel()
    const omittedSubscriber = await newRabbitMqBroker(omitted.native).subscribe(
      background(),
      "events.*",
      () => {},
      { exchange: { name: "events", type: "topic" } }
    )
    expect(omitted.calls.assertQueue).toEqual([
      ["", { durable: false, exclusive: true, autoDelete: true }]
    ])
    await omittedSubscriber.unsubscribe(background())

    const empty = fakeChannel()
    const emptySubscriber = await newRabbitMqBroker(empty.native).subscribe(
      background(),
      "events.*",
      () => {},
      { exchange: { name: "events", type: "topic" }, queue: {} }
    )
    expect(empty.calls.assertQueue).toEqual([
      ["", { durable: false, exclusive: true, autoDelete: true }]
    ])
    await emptySubscriber.unsubscribe(background())
  })

  test("cancels after handler failure and preserves the exact Error", async () => {
    const channel = fakeChannel()
    const failure = new Error("handler failed")
    const subscriber = await newRabbitMqBroker(channel.native).subscribe(
      background(),
      "jobs",
      () => {
        throw failure
      }
    )
    channel.onMessage?.(delivery("jobs", [1]))
    await nextTurn()
    await expect(subscriber.unsubscribe(background())).rejects.toBe(failure)
    expect(channel.calls.cancel).toEqual(["consumer-1"])
  })

  test("combines non-Error handler and cancel failures", async () => {
    const channel = fakeChannel()
    channel.cancelFailure = "cancel rejected"
    const subscriber = await newRabbitMqBroker(channel.native).subscribe(background(), "jobs", () =>
      Promise.reject("handler rejected")
    )
    channel.onMessage?.(delivery("jobs", [1]))
    await nextTurn()
    const failure = await subscriber.unsubscribe(background()).catch((value: unknown) => value)
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new Error("expected AggregateError")
    expect(failure.errors).toHaveLength(2)
    expect(failure.errors[0]).toMatchObject({
      message: "RabbitMQ Broker cancel rejected with a non-Error value",
      cause: "cancel rejected"
    })
    expect(failure.errors[1]).toMatchObject({
      message: "RabbitMQ Broker handler rejected with a non-Error value",
      cause: "handler rejected"
    })
  })

  test("reattaches the stable consumer after transient server-cancellation failures", async () => {
    const channel = fakeChannel()
    const assertQueue = channel.native.assertQueue.bind(channel.native)
    let failures = 2
    channel.native.assertQueue = async (name, options) => {
      if (channel.calls.consume.length > 0 && failures > 0) {
        failures -= 1
        throw new Error("transient queue declaration failure")
      }
      return await assertQueue(name, options)
    }
    const seen: ConsumeMessage[] = []
    const subscriber = await newRabbitMqBroker(channel.native).subscribe(
      background(),
      "jobs",
      (_ctx, event) => {
        seen.push(event.native)
      }
    )
    channel.onMessage?.(null)
    while (channel.calls.consume.length < 2) await Bun.sleep(10)
    expect(channel.calls.consume).toHaveLength(2)
    expect(failures).toBe(0)
    const recovered = delivery("jobs", [2])
    channel.onMessage?.(recovered)
    await nextTurn()
    expect(seen).toEqual([recovered])
    await subscriber.unsubscribe(background())
    expect(channel.calls.cancel).toEqual(["consumer-1"])
  })

  test("replays recovery when the replacement consumer is canceled during recovery", async () => {
    const channel = fakeChannel()
    const nativeConsume = channel.native.consume.bind(channel.native)
    let consumeCalls = 0
    channel.native.consume = async (queue, callback, options) => {
      consumeCalls += 1
      await nativeConsume(queue, callback, options)
      if (consumeCalls === 2) callback(null)
      return { consumerTag: `consumer-${consumeCalls}` }
    }
    const subscriber = await newRabbitMqBroker(channel.native).subscribe(
      background(),
      "jobs",
      () => {}
    )

    channel.onMessage?.(null)
    for (let turn = 0; turn < 20 && consumeCalls < 3; turn += 1) await nextTurn()

    expect(consumeCalls).toBe(3)
    await subscriber.unsubscribe(background())
    expect(channel.calls.cancel).toEqual(["consumer-3"])
  })

  test("admits a delivery sent immediately by the replacement consumer", async () => {
    const channel = fakeChannel()
    const nativeConsume = channel.native.consume.bind(channel.native)
    const recovered = delivery("jobs", [2])
    let consumeCalls = 0
    channel.native.consume = async (queue, callback, options) => {
      consumeCalls += 1
      await nativeConsume(queue, callback, options)
      if (consumeCalls === 2) callback(recovered)
      return { consumerTag: `consumer-${consumeCalls}` }
    }
    const seen: ConsumeMessage[] = []
    const subscriber = await newRabbitMqBroker(channel.native).subscribe(
      background(),
      "jobs",
      (_ctx, event) => {
        seen.push(event.native)
      }
    )

    channel.onMessage?.(null)
    for (let turn = 0; turn < 20 && consumeCalls < 2; turn += 1) await nextTurn()
    await nextTurn()

    expect(consumeCalls).toBe(2)
    expect(seen).toEqual([recovered])
    await subscriber.unsubscribe(background())
    expect(channel.calls.cancel).toEqual(["consumer-2"])
  })

  test("keeps a failed native consumer closed to late deliveries", async () => {
    const channel = fakeChannel()
    const failure = new Error("native consume failed")
    let callback: ((message: ConsumeMessage | null) => void) | undefined
    channel.native.consume = async (_queue, handler) => {
      callback = handler
      throw failure
    }
    const seen: ConsumeMessage[] = []

    await expect(
      newRabbitMqBroker(channel.native).subscribe(background(), "jobs", (_ctx, event) => {
        seen.push(event.native)
      })
    ).rejects.toBe(failure)
    callback?.(delivery("jobs", [3]))
    await nextTurn()

    expect(callback).toBeDefined()
    expect(seen).toEqual([])
  })

  test("ignores a stale basic.cancel after a replacement consumer is active", async () => {
    const channel = fakeChannel()
    const nativeConsume = channel.native.consume.bind(channel.native)
    const callbacks: Array<(message: ConsumeMessage | null) => void> = []
    channel.native.consume = async (queue, callback, options) => {
      callbacks.push(callback)
      await nativeConsume(queue, callback, options)
      return { consumerTag: `consumer-${callbacks.length}` }
    }
    const seen: ConsumeMessage[] = []
    const subscriber = await newRabbitMqBroker(channel.native).subscribe(
      background(),
      "jobs",
      (_ctx, event) => {
        seen.push(event.native)
      }
    )

    callbacks[0]?.(null)
    for (let turn = 0; turn < 20 && callbacks.length < 2; turn += 1) await nextTurn()
    callbacks[0]?.(null)
    await nextTurn()
    await nextTurn()

    expect(callbacks).toHaveLength(2)
    const recovered = delivery("jobs", [3])
    callbacks[1]?.(recovered)
    await nextTurn()
    expect(seen).toEqual([recovered])
    await subscriber.unsubscribe(background())
    expect(channel.calls.cancel).toEqual(["consumer-2"])
  })

  test("reports exhausted server-cancellation recovery through Server.start", async () => {
    const channel = fakeChannel()
    const recoveryFailure = new Error("consumer reattach failed")
    const broker = newRabbitMqBroker(channel.native)
    const server = newBrokerServer(broker, "jobs", () => {})
    const running = server.start(background())
    await nextTurn()
    channel.native.assertQueue = async () => {
      throw recoveryFailure
    }

    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((
      handler: TimerHandler,
      timeout?: number,
      ...arguments_: unknown[]
    ) => {
      const selected =
        timeout === 25 || timeout === 50 || timeout === 100 || timeout === 200 || timeout === 400
          ? 0
          : timeout
      return originalSetTimeout(handler, selected, ...arguments_)
    }) as typeof setTimeout
    try {
      channel.onMessage?.(null)
      const failure = await running.catch((value: unknown) => value)
      expect(failure).toMatchObject({
        name: "RabbitMqConsumerRecoveryError",
        cause: recoveryFailure
      })
      await expect(server.stop(background())).rejects.toBe(failure)
      expect(channel.calls.cancel).toEqual([])
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  test("owner stop interrupts a pending recovery delay", async () => {
    const channel = fakeChannel()
    const subscriber = await newRabbitMqBroker(channel.native).subscribe(
      background(),
      "jobs",
      () => {}
    )
    let recoveryCalls = 0
    channel.native.assertQueue = async () => {
      recoveryCalls += 1
      throw new Error("queue declaration failed")
    }
    const originalSetTimeout = globalThis.setTimeout
    let retryScheduled = false
    globalThis.setTimeout = ((
      handler: TimerHandler,
      timeout?: number,
      ...arguments_: unknown[]
    ) => {
      if (timeout === 25) {
        retryScheduled = true
        return originalSetTimeout(handler, 10_000, ...arguments_)
      }
      return originalSetTimeout(handler, timeout, ...arguments_)
    }) as typeof setTimeout
    try {
      channel.onMessage?.(null)
      while (!retryScheduled) await nextTurn()
      const outcome = await Promise.race([
        subscriber.unsubscribe(background()),
        Bun.sleep(50).then(() => "timed out")
      ])
      expect(outcome).toBeUndefined()
      expect(recoveryCalls).toBe(1)
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  test("owner Context cancellation terminates server-cancel recovery", async () => {
    const channel = fakeChannel()
    const selected = withCancelCause(background())
    const subscriber = await newRabbitMqBroker(channel.native).subscribe(
      selected[0],
      "jobs",
      () => {}
    )
    const terminal = subscriberTerminal(subscriber)
    if (terminal === null) throw new Error("RabbitMQ provider terminal missing")
    const reason = new Error("subscription owner canceled")
    selected[1](reason)
    channel.onMessage?.(null)

    await expect(terminal).rejects.toBe(reason)
    await expect(subscriber.unsubscribe(background())).rejects.toBe(reason)
  })

  test("post-recovery owner cancellation rolls back the acquired consumer", async () => {
    const channel = fakeChannel()
    const nativeConsume = channel.native.consume.bind(channel.native)
    let canceledAfterAcquire = false
    channel.native.consume = async (queue, callback, options) => {
      const result = await nativeConsume(queue, callback, options)
      if (channel.calls.consume.length > 1) canceledAfterAcquire = true
      return result
    }
    const ctx: Context = {
      deadline: () => [new Date(0), false],
      done: () => null,
      err: () => (canceledAfterAcquire ? canceled : null),
      value: () => null
    }
    const subscriber = await newRabbitMqBroker(channel.native).subscribe(ctx, "jobs", () => {})
    const terminal = subscriberTerminal(subscriber)
    if (terminal === null) throw new Error("RabbitMQ provider terminal missing")
    channel.onMessage?.(null)

    await expect(terminal).rejects.toBe(canceled)
    expect(channel.calls.cancel).toEqual(["consumer-1"])
  })

  test("normalizes a hostile owner Context during recovery delay", async () => {
    const channel = fakeChannel()
    const failure = new Error("owner Context inspection failed")
    let hostile = false
    const ctx: Context = {
      deadline: () => [new Date(0), false],
      done: () => null,
      err() {
        if (hostile) throw failure
        return null
      },
      value: () => null
    }
    const subscriber = await newRabbitMqBroker(channel.native).subscribe(ctx, "jobs", () => {})
    const terminal = subscriberTerminal(subscriber)
    if (terminal === null) throw new Error("RabbitMQ provider terminal missing")
    channel.native.assertQueue = async () => {
      hostile = true
      throw new Error("queue declaration failed")
    }
    channel.onMessage?.(null)

    await expect(terminal).rejects.toBe(failure)
    await expect(subscriber.unsubscribe(background())).rejects.toBe(failure)
  })

  test("rolls back a provisional consumer when Context terminates during consume", async () => {
    const channel = fakeChannel()
    let reads = 0
    const ctx: Context = {
      deadline: () => [new Date(0), false],
      done: () => null,
      err() {
        reads += 1
        return reads > 2 ? canceled : null
      },
      value: () => null
    }
    await expect(newRabbitMqBroker(channel.native).subscribe(ctx, "jobs", () => {})).rejects.toBe(
      canceled
    )
    expect(channel.calls.cancel).toEqual(["consumer-1"])
  })

  test("returns on Context cancellation and cleans a consumer admitted later", async () => {
    const channel = fakeChannel()
    const nativeConsume = channel.native.consume.bind(channel.native)
    let resolveConsume: (value: { consumerTag: string }) => void = () => {}
    const consumeBarrier = new Promise<{ consumerTag: string }>((resolve) => {
      resolveConsume = resolve
    })
    channel.native.consume = async (queue, callback, options) => {
      await nativeConsume(queue, callback, options)
      return await consumeBarrier
    }
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("subscribe canceled")
    const subscribing = newRabbitMqBroker(channel.native).subscribe(ctx, "jobs", () => {})
    await nextTurn()
    cancel(reason)
    const outcome = await Promise.race([
      subscribing.catch((value: unknown) => value),
      Bun.sleep(50).then(() => "timed out")
    ])
    resolveConsume({ consumerTag: "late-consumer" })
    await nextTurn()
    await nextTurn()

    expect(outcome).toBe(reason)
    expect(channel.calls.cancel).toEqual(["late-consumer"])
  })

  test("replays one stable consumer per official recovery generation and never revives unsubscribe", async () => {
    const first = fakeConfirmChannel()
    const second = fakeConfirmChannel()
    const third = fakeConfirmChannel()
    const channels = [first, second, third]
    let selected = 0
    let setup: (model: ChannelModel) => Promise<void> = async () => {
      throw new Error("recovery setup was not captured")
    }
    let closeCalls = 0
    const recovering = new EventEmitter() as RecoveringChannelModel
    Object.defineProperty(recovering, "close", {
      value: async () => {
        closeCalls += 1
      }
    })
    const model = {
      async createConfirmChannel() {
        const channel = channels[selected]
        if (channel === undefined) throw new Error("missing recovery channel")
        return channel.native
      }
    } as ChannelModel
    const provider = await newRecoveringRabbitMqBroker(background(), async (provided) => {
      setup = provided
      await provided(model)
      return recovering
    })
    expect(provider.connection).toBe(recovering)
    expect(closeCalls).toBe(0)
    expect(provider.broker.string()).toBe("rabbitmq")

    const seen: ConsumeMessage[] = []
    const subscriber = await provider.broker.subscribe(background(), "jobs", (_ctx, event) => {
      seen.push(event.native)
      provider.broker.ack(event.native)
    })
    expect(first.calls.consume).toHaveLength(1)
    const firstDelivery = delivery("jobs", [1])
    first.onMessage?.(firstDelivery)
    await nextTurn()

    recovering.emit("disconnect", new Error("connection lost"))
    expect(() => provider.broker.ack(firstDelivery)).toThrow("current channel generation")
    await expect(
      provider.broker.publish(background(), "jobs", {
        headers: {},
        body: new Uint8Array()
      })
    ).rejects.toThrow("disconnected")
    selected = 1
    await setup(model)
    expect(second.calls.consume).toHaveLength(1)
    const recoveredPublish = provider.broker.publish(background(), "jobs", {
      headers: {},
      body: new Uint8Array([2])
    })
    second.confirm(0)
    await recoveredPublish
    const secondDelivery = delivery("jobs", [2])
    second.onMessage?.(secondDelivery)
    await nextTurn()
    expect(seen).toEqual([firstDelivery, secondDelivery])
    expect(first.calls.ack).toEqual([firstDelivery])
    expect(second.calls.ack).toEqual([secondDelivery])
    provider.broker.nack(secondDelivery, false, true)
    provider.broker.reject(secondDelivery, false)
    expect(second.calls.nack).toEqual([[secondDelivery, false, true]])
    expect(second.calls.reject).toEqual([[secondDelivery, false]])

    await subscriber.unsubscribe(background())
    expect(second.calls.cancel).toEqual(["consumer-1"])
    selected = 2
    await setup(model)
    expect(third.calls.consume).toEqual([])
    expect(closeCalls).toBe(0)
    await provider.connection.close()
    expect(closeCalls).toBe(1)
  })

  test("validates and rolls back recovery construction Context", async () => {
    const [preCanceled, cancel] = withCancelCause(background())
    cancel(new Error("pre-canceled"))
    await expect(
      newRecoveringRabbitMqBroker(preCanceled, async () => {
        throw new Error("must not connect")
      })
    ).rejects.toThrow("pre-canceled")
    await expect(newRecoveringRabbitMqBroker(background(), null as never)).rejects.toBeInstanceOf(
      TypeError
    )
    const malformedChannel = fakeConfirmChannel()
    const malformedModel = {
      createConfirmChannel: async () => malformedChannel.native
    } as ChannelModel
    await expect(
      newRecoveringRabbitMqBroker(background(), async (setup) => {
        await setup(malformedModel)
        return {} as RecoveringChannelModel
      })
    ).rejects.toThrow("must return a RecoveringChannelModel")
    expect(malformedChannel.calls.close).toBe(1)
    const rejectedChannel = fakeConfirmChannel()
    const rejectedModel = {
      createConfirmChannel: async () => rejectedChannel.native
    } as ChannelModel
    const connectorFailure = new Error("connector rejected after setup")
    await expect(
      newRecoveringRabbitMqBroker(background(), async (setup) => {
        await setup(rejectedModel)
        throw connectorFailure
      })
    ).rejects.toBe(connectorFailure)
    expect(rejectedChannel.calls.close).toBe(1)

    let reads = 0
    let closeCalls = 0
    const context: Context = {
      deadline: () => [new Date(0), false],
      done: () => null,
      err() {
        reads += 1
        return reads > 2 ? canceled : null
      },
      value: () => null
    }
    const recovering = new EventEmitter() as RecoveringChannelModel
    Object.defineProperty(recovering, "close", {
      value: async () => {
        closeCalls += 1
      }
    })
    const model = {
      createConfirmChannel: async () => fakeConfirmChannel().native
    } as ChannelModel
    await expect(
      newRecoveringRabbitMqBroker(context, async (setup) => {
        await setup(model)
        return recovering
      })
    ).rejects.toBe(canceled)
    expect(closeCalls).toBe(1)
  })

  test("lets construction Context cancel its wait and closes a late recovered connection", async () => {
    const channel = fakeConfirmChannel()
    const [ctx, cancel] = withCancelCause(background())
    const failure = new Error("construction canceled")
    let setup: (model: ChannelModel) => Promise<void> = async () => {}
    let resolveConnection: (connection: RecoveringChannelModel) => void = () => {}
    let closeCalls = 0
    let reportClosed: () => void = () => {}
    const closed = new Promise<void>((resolve) => {
      reportClosed = resolve
    })
    const connection = new EventEmitter() as RecoveringChannelModel
    Object.defineProperty(connection, "close", {
      value: async () => {
        closeCalls += 1
        reportClosed()
      }
    })
    const supplied = new Promise<RecoveringChannelModel>((resolve) => {
      resolveConnection = resolve
    })
    const constructing = newRecoveringRabbitMqBroker(ctx, async (provided) => {
      setup = provided
      return await supplied
    })

    await nextTurn()
    cancel(failure)
    await expect(constructing).rejects.toBe(failure)

    await setup({
      createConfirmChannel: async () => channel.native
    } as ChannelModel)
    resolveConnection(connection)
    await closed
    await nextTurn()
    expect(closeCalls).toBe(1)
    expect(channel.calls.close).toBe(1)
  })

  test("rejects a recovery connector that did not complete initial setup", async () => {
    let closeCalls = 0
    const connection = new EventEmitter() as RecoveringChannelModel
    Object.defineProperty(connection, "close", {
      value: async () => {
        closeCalls += 1
      }
    })

    await expect(newRecoveringRabbitMqBroker(background(), async () => connection)).rejects.toThrow(
      "must complete its initial setup"
    )
    expect(closeCalls).toBe(1)
  })

  test("lets stable admission Context abandon setup recovery without retaining its descriptor", async () => {
    const first = fakeConfirmChannel()
    const second = fakeConfirmChannel()
    let selected = first
    let blockRecovery = false
    let releaseRecovery: () => void = () => {}
    const recoveryBarrier = new Promise<void>((resolve) => {
      releaseRecovery = resolve
    })
    let setup: (model: ChannelModel) => Promise<void> = async () => {}
    const recovering = new EventEmitter() as RecoveringChannelModel
    Object.defineProperty(recovering, "close", { value: async () => {} })
    const model = {
      async createConfirmChannel() {
        if (blockRecovery) await recoveryBarrier
        return selected.native
      }
    } as ChannelModel
    const provider = await newRecoveringRabbitMqBroker(background(), async (provided) => {
      setup = provided
      await provided(model)
      return recovering
    })

    recovering.emit("disconnect", new Error("lost"))
    selected = second
    blockRecovery = true
    const rebuilding = setup(model)
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("stable setup wait canceled")
    const subscribing = provider.broker.subscribe(ctx, "jobs", () => {})
    await nextTurn()
    cancel(reason)
    const outcome = await Promise.race([
      subscribing.catch((value: unknown) => value),
      Bun.sleep(50).then(() => "timed out")
    ])

    releaseRecovery()
    await rebuilding
    await subscribing.catch(() => {})
    expect(outcome).toBe(reason)
    expect(second.calls.consume).toEqual([])
  })

  test("returns on stable admission cancellation and cleans a consumer attached later", async () => {
    const first = fakeConfirmChannel()
    const second = fakeConfirmChannel()
    const nativeConsume = first.native.consume.bind(first.native)
    let resolveConsume: (value: { consumerTag: string }) => void = () => {}
    const consumeBarrier = new Promise<{ consumerTag: string }>((resolve) => {
      resolveConsume = resolve
    })
    first.native.consume = async (queue, callback, options) => {
      await nativeConsume(queue, callback, options)
      return await consumeBarrier
    }
    const nativeCancel = first.native.cancel.bind(first.native)
    let reportCanceled: (consumerTag: string) => void = () => {}
    const canceledTag = new Promise<string>((resolve) => {
      reportCanceled = resolve
    })
    first.native.cancel = async (consumerTag) => {
      const result = await nativeCancel(consumerTag)
      reportCanceled(consumerTag)
      return result
    }
    let selected = first
    let setup: (model: ChannelModel) => Promise<void> = async () => {}
    const recovering = new EventEmitter() as RecoveringChannelModel
    Object.defineProperty(recovering, "close", { value: async () => {} })
    const model = {
      createConfirmChannel: async () => selected.native
    } as ChannelModel
    const provider = await newRecoveringRabbitMqBroker(background(), async (provided) => {
      setup = provided
      await provided(model)
      return recovering
    })
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("stable attachment canceled")
    const subscribing = provider.broker.subscribe(ctx, "jobs", () => {})
    await nextTurn()
    expect(first.calls.consume).toHaveLength(1)

    cancel(reason)
    const outcome = await Promise.race([
      subscribing.catch((value: unknown) => value),
      Bun.sleep(50).then(() => "timed out")
    ])
    expect(first.calls.cancel).toEqual([])

    resolveConsume({ consumerTag: "late-stable-consumer" })
    const cleanup = await Promise.race([canceledTag, Bun.sleep(50).then(() => "cleanup timed out")])
    expect(outcome).toBe(reason)
    expect(cleanup).toBe("late-stable-consumer")
    expect(first.calls.cancel).toEqual(["late-stable-consumer"])

    recovering.emit("disconnect", new Error("lost"))
    selected = second
    await setup(model)
    expect(second.calls.consume).toEqual([])
  })

  test("continues recovery after canceling its current descriptor and never replays unsubscribe", async () => {
    const first = fakeConfirmChannel()
    const second = fakeConfirmChannel()
    const third = fakeConfirmChannel()
    const nativeConsume = first.native.consume.bind(first.native)
    let resolveFirst: (value: { consumerTag: string }) => void = () => {}
    const firstBarrier = new Promise<{ consumerTag: string }>((resolve) => {
      resolveFirst = resolve
    })
    first.native.consume = async (queue, callback, options) => {
      await nativeConsume(queue, callback, options)
      if (queue === "a") return await firstBarrier
      return { consumerTag: "first-b" }
    }
    second.consumeTag = "second-b"
    let selected = first
    let setup: (model: ChannelModel) => Promise<void> = async () => {}
    const recovering = new EventEmitter() as RecoveringChannelModel
    Object.defineProperty(recovering, "close", { value: async () => {} })
    const model = {
      createConfirmChannel: async () => selected.native
    } as ChannelModel
    const provider = await newRecoveringRabbitMqBroker(background(), async (provided) => {
      setup = provided
      await provided(model)
      return recovering
    })

    const [aContext, cancelA] = withCancelCause(background())
    const aFailure = new Error("cancel current recovery descriptor")
    const subscribingA = provider.broker.subscribe(aContext, "a", () => {})
    await nextTurn()
    const subscriberB = await provider.broker.subscribe(background(), "b", () => {})
    expect(first.calls.consume.map(([queue]) => queue)).toEqual(["a", "b"])

    recovering.emit("disconnect", new Error("lost"))
    selected = second
    const rebuilding = setup(model)
    await nextTurn()
    expect(second.calls.consume).toEqual([])

    cancelA(aFailure)
    const outcome = await Promise.race([
      subscribingA.catch((value: unknown) => value),
      Bun.sleep(50).then(() => "timed out")
    ])
    resolveFirst({ consumerTag: "late-first-a" })
    await rebuilding

    expect(outcome).toBe(aFailure)
    expect(first.calls.cancel).toEqual(["late-first-a"])
    expect(second.calls.consume.map(([queue]) => queue)).toEqual(["b"])

    await subscriberB.unsubscribe(background())
    expect(second.calls.cancel).toEqual(["second-b"])
    recovering.emit("disconnect", new Error("lost again"))
    selected = third
    await setup(model)
    expect(third.calls.consume).toEqual([])
  })

  test("serializes a subscribe racing official recovery and discards the stale consumer", async () => {
    const first = fakeConfirmChannel()
    const second = fakeConfirmChannel()
    first.cancelFailure = "stale channel already closed"
    let resolveConsume: (value: { consumerTag: string }) => void = () => {}
    const consumeBarrier = new Promise<{ consumerTag: string }>((resolve) => {
      resolveConsume = resolve
    })
    const nativeConsume = first.native.consume.bind(first.native)
    first.native.consume = async (queue, callback, options) => {
      await nativeConsume(queue, callback, options)
      return consumeBarrier
    }
    let selected = first
    let setup: (model: ChannelModel) => Promise<void> = async () => {}
    const recovering = new EventEmitter() as RecoveringChannelModel
    Object.defineProperty(recovering, "close", { value: async () => {} })
    const model = {
      createConfirmChannel: async () => selected.native
    } as ChannelModel
    const provider = await newRecoveringRabbitMqBroker(background(), async (provided) => {
      setup = provided
      await provided(model)
      return recovering
    })

    const subscribing = provider.broker.subscribe(background(), "jobs", () => {})
    await nextTurn()
    selected = second
    const recoveringSetup = setup(model)
    resolveConsume({ consumerTag: "stale-consumer" })
    const subscriber = await subscribing
    await recoveringSetup
    expect(first.calls.cancel).toEqual(["stale-consumer"])
    expect(second.calls.consume).toHaveLength(1)
    await subscriber.unsubscribe(background())
  })

  test("keeps a stable descriptor when an old generation handler fails in flight", async () => {
    const first = fakeConfirmChannel()
    const second = fakeConfirmChannel()
    const third = fakeConfirmChannel()
    let selected = first
    let setup: (model: ChannelModel) => Promise<void> = async () => {}
    const recovering = new EventEmitter() as RecoveringChannelModel
    Object.defineProperty(recovering, "close", { value: async () => {} })
    const model = {
      createConfirmChannel: async () => selected.native
    } as ChannelModel
    const provider = await newRecoveringRabbitMqBroker(background(), async (provided) => {
      setup = provided
      await provided(model)
      return recovering
    })
    let releaseOld: () => void = () => {}
    const oldBlocked = new Promise<void>((resolve) => {
      releaseOld = resolve
    })
    let reportOldStarted: () => void = () => {}
    const oldStarted = new Promise<void>((resolve) => {
      reportOldStarted = resolve
    })
    const oldDelivery = delivery("jobs", [1])
    const subscriber = await provider.broker.subscribe(
      background(),
      "jobs",
      async (_ctx, event) => {
        if (event.native !== oldDelivery) return
        reportOldStarted()
        await oldBlocked
        throw new Error("old generation handler failed")
      }
    )

    first.onMessage?.(oldDelivery)
    await oldStarted
    recovering.emit("disconnect", new Error("lost first generation"))
    selected = second
    await setup(model)
    releaseOld()
    await nextTurn()
    await nextTurn()

    recovering.emit("disconnect", new Error("lost second generation"))
    selected = third
    await setup(model)
    expect(third.calls.consume).toHaveLength(1)
    await subscriber.unsubscribe(background())
  })

  test("stops a stable descriptor after handler failure and validates stable admission", async () => {
    const first = fakeConfirmChannel()
    const second = fakeConfirmChannel()
    let selected = first
    let setup: (model: ChannelModel) => Promise<void> = async () => {}
    const recovering = new EventEmitter() as RecoveringChannelModel
    Object.defineProperty(recovering, "close", { value: async () => {} })
    const model = {
      createConfirmChannel: async () => selected.native
    } as ChannelModel
    const provider = await newRecoveringRabbitMqBroker(background(), async (provided) => {
      setup = provided
      await provided(model)
      return recovering
    })
    await expect(provider.broker.subscribe(background(), "", () => {})).rejects.toBeInstanceOf(
      TypeError
    )
    await expect(
      provider.broker.subscribe(background(), "jobs", null as never)
    ).rejects.toBeInstanceOf(TypeError)
    const [canceledContext, cancel] = withCancelCause(background())
    cancel(new Error("subscription canceled"))
    await expect(provider.broker.subscribe(canceledContext, "jobs", () => {})).rejects.toThrow(
      "subscription canceled"
    )

    const failure = new Error("stable handler failed")
    const subscriber = await provider.broker.subscribe(background(), "jobs", () => {
      throw failure
    })
    first.onMessage?.(delivery("jobs", [1]))
    await nextTurn()
    selected = second
    await setup(model)
    expect(second.calls.consume).toEqual([])
    await expect(subscriber.unsubscribe(background())).rejects.toBe(failure)

    let reads = 0
    const cancelDuringAdmission: Context = {
      deadline: () => [new Date(0), false],
      done: () => null,
      err() {
        reads += 1
        return reads > 1 ? canceled : null
      },
      value: () => null
    }
    await expect(provider.broker.subscribe(cancelDuringAdmission, "later", () => {})).rejects.toBe(
      canceled
    )
  })

  test("closes a failed replay generation and remains disconnected", async () => {
    const first = fakeConfirmChannel()
    const failing = fakeConfirmChannel()
    const topologyFailure = new Error("queue declaration failed")
    failing.native.assertQueue = async () => {
      throw topologyFailure
    }
    let selected = first
    let setup: (model: ChannelModel) => Promise<void> = async () => {}
    const recovering = new EventEmitter() as RecoveringChannelModel
    Object.defineProperty(recovering, "close", { value: async () => {} })
    const model = {
      createConfirmChannel: async () => selected.native
    } as ChannelModel
    const provider = await newRecoveringRabbitMqBroker(background(), async (provided) => {
      setup = provided
      await provided(model)
      return recovering
    })
    await provider.broker.subscribe(background(), "jobs", () => {})
    recovering.emit("disconnect", new Error("lost"))
    selected = failing
    await expect(setup(model)).rejects.toBe(topologyFailure)
    expect(failing.calls.close).toBe(1)
    await expect(
      provider.broker.publish(background(), "jobs", {
        headers: {},
        body: new Uint8Array()
      })
    ).rejects.toThrow("disconnected")
  })

  test("does not replay a descriptor whose initial native attachment failed", async () => {
    const first = fakeConfirmChannel()
    const second = fakeConfirmChannel()
    const attachFailure = new Error("initial queue declaration failed")
    let selected = first
    let setup: (model: ChannelModel) => Promise<void> = async () => {}
    const recovering = new EventEmitter() as RecoveringChannelModel
    Object.defineProperty(recovering, "close", { value: async () => {} })
    const model = {
      createConfirmChannel: async () => selected.native
    } as ChannelModel
    const provider = await newRecoveringRabbitMqBroker(background(), async (provided) => {
      setup = provided
      await provided(model)
      return recovering
    })
    first.native.assertQueue = async () => {
      throw attachFailure
    }

    await expect(provider.broker.subscribe(background(), "ghost", () => {})).rejects.toBe(
      attachFailure
    )
    recovering.emit("disconnect", new Error("lost"))
    selected = second
    await setup(model)
    expect(second.calls.consume).toEqual([])
  })

  test("combines post-attachment cancellation with native rollback failure", async () => {
    const channel = fakeConfirmChannel()
    const rollbackFailure = new Error("consumer rollback failed")
    channel.cancelFailure = rollbackFailure
    const recovering = new EventEmitter() as RecoveringChannelModel
    Object.defineProperty(recovering, "close", { value: async () => {} })
    const provider = await newRecoveringRabbitMqBroker(background(), async (setup) => {
      await setup({
        createConfirmChannel: async () => channel.native
      } as ChannelModel)
      return recovering
    })
    let reads = 0
    const admissionContext: Context = {
      deadline: () => [new Date(0), false],
      done: () => null,
      err() {
        reads += 1
        return reads > 2 ? canceled : null
      },
      value: () => null
    }

    const failure = await provider.broker
      .subscribe(admissionContext, "jobs", () => {})
      .catch((value: unknown) => value)
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new Error("expected AggregateError")
    expect(failure.errors).toEqual([canceled, rollbackFailure])
  })

  test("reattaches after the admitted handler Context is canceled", async () => {
    const first = fakeConfirmChannel()
    const second = fakeConfirmChannel()
    let selected = first
    let setup: (model: ChannelModel) => Promise<void> = async () => {}
    const recovering = new EventEmitter() as RecoveringChannelModel
    Object.defineProperty(recovering, "close", { value: async () => {} })
    const model = {
      createConfirmChannel: async () => selected.native
    } as ChannelModel
    const provider = await newRecoveringRabbitMqBroker(background(), async (provided) => {
      setup = provided
      await provided(model)
      return recovering
    })
    const [handlerContext, cancel] = withCancelCause(background())
    let observedContext: Context | null = null
    const subscriber = await provider.broker.subscribe(
      handlerContext,
      "jobs",
      (deliveryContext, event) => {
        observedContext = deliveryContext
        provider.broker.ack(event.native)
      }
    )
    cancel(new Error("handler context ended after admission"))
    recovering.emit("disconnect", new Error("lost"))
    selected = second
    await setup(model)
    expect(second.calls.consume).toHaveLength(1)
    const recoveredDelivery = delivery("jobs", [2])
    second.onMessage?.(recoveredDelivery)
    await nextTurn()
    expect(observedContext === handlerContext).toBe(true)
    expect(handlerContext.err()).not.toBeNull()
    expect(second.calls.ack).toEqual([recoveredDelivery])
    await subscriber.unsubscribe(background())
  })
})
