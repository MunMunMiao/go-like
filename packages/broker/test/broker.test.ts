import { describe, expect, test } from "bun:test"

import { newBrokerServer, type Broker, type BrokerEvent, type Subscriber } from "../src/index"
import { registerSubscriberTerminal } from "../src/provider"
import { background, withCancelCause, type Context } from "@go-like/context"

interface NativeEvent {
  readonly sequence: number
}

interface SubscribeOptions {
  readonly queue: string
}

/** Creates one upstream-style subscription with observable unsubscribe calls. */
function nativeSubscription(topic: string, calls: string[] = []): Subscriber {
  return Object.freeze({
    topic,
    /** Records one provider unsubscribe. */
    async unsubscribe(): Promise<void> {
      calls.push(topic)
    }
  })
}

/** Requires one operation to reject with an Error and returns its exact value. */
async function rejected(operation: PromiseLike<unknown>): Promise<Error> {
  try {
    await operation
  } catch (value) {
    if (value instanceof Error) return value
    throw new Error("subscription operation rejected with a non-Error value")
  }
  throw new Error("subscription operation unexpectedly fulfilled")
}

describe("broker subscription Server", () => {
  test("captures receiver, topic, handler, options, and unsubscribes through stop", async () => {
    const unsubscribeCalls: string[] = []
    const native = nativeSubscription("orders.created", unsubscribeCalls)
    const calls: unknown[] = []
    const captured: {
      handler: ((ctx: Context, event: BrokerEvent<NativeEvent>) => void | PromiseLike<void>) | null
    } = { handler: null }
    const broker = {
      identity: "captured-receiver",
      /** Captures one subscription through its receiver. */
      async subscribe(
        ctx: Context,
        topic: string,
        handler: (ctx: Context, event: BrokerEvent<NativeEvent>) => void | PromiseLike<void>,
        options?: SubscribeOptions
      ) {
        calls.push([this.identity, ctx, topic, options])
        captured.handler = handler
        return native
      }
    }
    const delivered: BrokerEvent<NativeEvent>[] = []
    const server = newBrokerServer(
      broker,
      "orders.created",
      function receive(_ctx, event) {
        delivered.push(event)
      },
      { queue: "workers" }
    )
    broker.subscribe = async function mutated() {
      throw new Error("mutated subscribe must not run")
    }

    const ctx = background()
    const running = server.start(ctx)
    await Promise.resolve()
    expect(calls).toEqual([["captured-receiver", ctx, "orders.created", { queue: "workers" }]])
    const event: BrokerEvent<NativeEvent> = Object.freeze({
      topic: "orders.created",
      message: Object.freeze({ headers: Object.freeze({}), body: new Uint8Array([1]) }),
      native: Object.freeze({ sequence: 1 })
    })
    if (captured.handler === null) throw new Error("handler missing")
    await captured.handler(ctx, event)
    expect(delivered).toEqual([event])
    await server.stop(background())
    await running
    expect(unsubscribeCalls).toEqual(["orders.created"])
    await expect(server.start(background())).rejects.toThrow("already started")
  })

  test("omits absent options and rejects pre-cancellation without subscribing", async () => {
    let argumentCount = 0
    const broker: Broker<void, void, void, NativeEvent> = {
      async publish() {},
      /** Records the exact optional-argument count. */
      async subscribe() {
        argumentCount = arguments.length
        return nativeSubscription("topic")
      },
      string() {
        return "controlled"
      }
    }
    const omitted = newBrokerServer(broker, "topic", function receive() {})
    const running = omitted.start(background())
    await Promise.resolve()
    expect(argumentCount).toBe(3)
    await omitted.stop(background())
    await running

    let subscriptions = 0
    const canceledBroker: Broker<void, void, void, NativeEvent> = {
      async publish() {},
      async subscribe() {
        subscriptions += 1
        return nativeSubscription("topic")
      },
      string() {
        return "controlled"
      }
    }
    const canceledServer = newBrokerServer(canceledBroker, "topic", function receive() {})
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("subscription canceled")
    cancel(reason)
    await expect(canceledServer.start(ctx)).rejects.toBe(reason)
    expect(subscriptions).toBe(0)
  })

  test("validates the complete construction boundary including surrogate topics", () => {
    const broker: Broker<void, void, void, NativeEvent> = {
      async publish() {},
      async subscribe() {
        return nativeSubscription("topic")
      },
      string() {
        return "controlled"
      }
    }
    expect(() => newBrokerServer(null as never, "topic", function receive() {})).toThrow("object")
    expect(() => newBrokerServer({} as never, "topic", function receive() {})).toThrow("callable")
    expect(() => newBrokerServer(broker, "", function receive() {})).toThrow("non-empty")
    expect(() => newBrokerServer(broker, "\ud800", function receive() {})).toThrow("well-formed")
    expect(() => newBrokerServer(broker, "\udc00", function receive() {})).toThrow("well-formed")
    expect(() => newBrokerServer(broker, "猫-\ud83d\udc08", function receive() {})).not.toThrow()
    expect(() => newBrokerServer(broker, "topic", null as never)).toThrow("callable")
  })

  test("preserves Error identity and normalizes hostile lifecycle boundaries", async () => {
    const synchronous = newBrokerServer(
      {
        subscribe(): Promise<Subscriber> {
          throw "synchronous subscribe failure"
        }
      },
      "topic",
      function receive() {}
    )
    expect(await rejected(synchronous.start(background()))).toMatchObject({
      message: "subscription subscribe rejected with a non-Error value",
      cause: "synchronous subscribe failure"
    })

    const asynchronousFailure = new Error("asynchronous subscribe failure")
    const asynchronous = newBrokerServer(
      {
        async subscribe(): Promise<Subscriber> {
          throw asynchronousFailure
        }
      },
      "topic",
      function receive() {}
    )
    await expect(asynchronous.start(background())).rejects.toBe(asynchronousFailure)

    const invalid = newBrokerServer(
      {
        async subscribe(): Promise<Subscriber> {
          return null as never
        }
      },
      "topic",
      function receive() {}
    )
    await expect(invalid.start(background())).rejects.toThrow(
      "broker subscribe must return a Subscriber"
    )

    const unsubscribeFailure = new Error("unsubscribe failed")
    const failingStop = newBrokerServer(
      {
        async subscribe(): Promise<Subscriber> {
          return Object.freeze({
            topic: "topic",
            async unsubscribe(): Promise<void> {
              throw unsubscribeFailure
            }
          })
        }
      },
      "topic",
      function receive() {}
    )
    const running = failingStop.start(background())
    await expect(failingStop.stop(background())).rejects.toBe(unsubscribeFailure)
    await expect(running).rejects.toBe(unsubscribeFailure)

    const nonErrorStop = newBrokerServer(
      {
        async subscribe(): Promise<Subscriber> {
          return Object.freeze({
            topic: "topic",
            async unsubscribe(): Promise<void> {
              throw "non-Error unsubscribe failure"
            }
          })
        }
      },
      "topic",
      function receive() {}
    )
    const nonErrorRunning = nonErrorStop.start(background())
    expect(await rejected(nonErrorStop.stop(background()))).toMatchObject({
      message: "subscription unsubscribe rejected with a non-Error value",
      cause: "non-Error unsubscribe failure"
    })
    expect(await rejected(nonErrorRunning)).toMatchObject({
      message: "subscription unsubscribe rejected with a non-Error value",
      cause: "non-Error unsubscribe failure"
    })

    const hostile = Object.freeze({
      err(): never {
        throw "hostile Context"
      }
    }) as unknown as Context
    let calls = 0
    const hostileStartup = newBrokerServer(
      {
        async subscribe(): Promise<Subscriber> {
          calls += 1
          return nativeSubscription("topic")
        }
      },
      "topic",
      function receive() {}
    )
    expect(await rejected(hostileStartup.start(hostile))).toMatchObject({
      message: "subscription startup rejected with a non-Error value",
      cause: "hostile Context"
    })
    expect(calls).toBe(0)
  })

  test("rolls captured subscriptions back for malformed or mismatched topics", async () => {
    const cases: readonly (readonly [unknown, string])[] = [
      [42, "broker subscribe must return a Subscriber"],
      ["other", "broker subscribe returned a Subscriber for a different topic"]
    ]
    for (const [returnedTopic, message] of cases) {
      const [ctx, cancel] = withCancelCause(background())
      const callerFailure = new Error("caller canceled after provider admission")
      const rollbackContexts: Context[] = []
      const server = newBrokerServer(
        {
          async subscribe(): Promise<Subscriber> {
            cancel(callerFailure)
            return {
              topic: returnedTopic,
              async unsubscribe(ctx: Context): Promise<void> {
                rollbackContexts.push(ctx)
              }
            } as unknown as Subscriber
          }
        },
        "topic",
        function receive() {}
      )

      const failure = await rejected(server.start(ctx))
      expect(failure.message).toBe(message)
      expect(rollbackContexts).toHaveLength(1)
      expect(rollbackContexts[0]).not.toBe(ctx)
      expect(rollbackContexts[0]?.err()).toBeNull()
      await expect(server.stop(background())).rejects.toBe(failure)
    }
  })

  test("captures unsubscribe before reading hostile provider metadata", async () => {
    const topicFailure = new Error("hostile topic getter")
    let rollbacks = 0
    const hostileTopic = newBrokerServer(
      {
        async subscribe(): Promise<Subscriber> {
          return {
            get topic(): string {
              throw topicFailure
            },
            async unsubscribe(): Promise<void> {
              rollbacks += 1
            }
          }
        }
      },
      "topic",
      function receive() {}
    )
    await expect(hostileTopic.start(background())).rejects.toBe(topicFailure)
    expect(rollbacks).toBe(1)

    const unsubscribeFailure = new Error("hostile unsubscribe getter")
    const hostileUnsubscribe = newBrokerServer(
      {
        async subscribe(): Promise<Subscriber> {
          return {
            topic: "topic",
            get unsubscribe(): Subscriber["unsubscribe"] {
              throw unsubscribeFailure
            }
          }
        }
      },
      "topic",
      function receive() {}
    )
    await expect(hostileUnsubscribe.start(background())).rejects.toBe(unsubscribeFailure)

    const missingUnsubscribe = newBrokerServer(
      {
        async subscribe(): Promise<Subscriber> {
          return { topic: "topic" } as Subscriber
        }
      },
      "topic",
      function receive() {}
    )
    await expect(missingUnsubscribe.start(background())).rejects.toThrow(
      "broker subscribe must return a Subscriber"
    )
  })

  test("orders admission primary before provider rollback failure", async () => {
    const primary = new Error("hostile topic getter")
    const rollback = new Error("provider rollback failed")
    const server = newBrokerServer(
      {
        async subscribe(): Promise<Subscriber> {
          return {
            get topic(): string {
              throw primary
            },
            async unsubscribe(): Promise<void> {
              throw rollback
            }
          }
        }
      },
      "topic",
      function receive() {}
    )

    const failure = await rejected(server.start(background()))
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([primary, rollback])
    expect(failure.cause).toBe(primary)
    await expect(server.stop(background())).rejects.toBe(failure)
  })

  test("reports a provider passive terminal without changing Subscriber", async () => {
    let rejectTerminal: (reason: Error) => void = () => {}
    const terminal = new Promise<void>((_resolve, reject) => {
      rejectTerminal = reject
    })
    const native = registerSubscriberTerminal(nativeSubscription("topic"), terminal)
    const server = newBrokerServer(
      {
        async subscribe(): Promise<Subscriber> {
          return native
        }
      },
      "topic",
      function receive() {}
    )
    const running = server.start(background())
    await Promise.resolve()
    const failure = new Error("provider terminal failed")
    rejectTerminal(failure)

    await expect(running).rejects.toBe(failure)
    await server.stop(background())
  })

  test("fails closed when a provider terminal resolves outside owner stop", async () => {
    let resolveTerminal: () => void = () => {}
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve
    })
    const native = registerSubscriberTerminal(nativeSubscription("topic"), terminal)
    const server = newBrokerServer(
      {
        async subscribe(): Promise<Subscriber> {
          return native
        }
      },
      "topic",
      function receive() {}
    )
    const running = server.start(background())
    await Promise.resolve()
    resolveTerminal()

    await expect(running).rejects.toThrow("outside its owner stop")
    await server.stop(background())
  })
})
