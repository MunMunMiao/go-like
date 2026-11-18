import { expect, test } from "bun:test"

import {
  deliver,
  newBrokerEvent,
  publish as publishUnit,
  registerSubscriberTerminal
} from "../../src/broker/provider"
import { background } from "../../src/context"
import { newMemoryBroker } from "../../src/broker/memory/index"
import { brokerConformance, brokerTelemetryConformance } from "../../src/testing/index"

const cases = [
  ...brokerConformance({
    async newBroker() {
      return newMemoryBroker()
    },
    topic: "orders",
    async close() {}
  }),
  ...brokerTelemetryConformance({
    async newBroker() {
      return newMemoryBroker()
    },
    topic: "orders",
    async close() {}
  })
]

for (const entry of cases) {
  test(entry.name, async () => {
    await entry.run()
  })
}

test("broker conformance rejects an invalid subject", () => {
  expect(() => brokerConformance(null as never)).toThrow(TypeError)
  expect(() =>
    brokerTelemetryConformance({
      newBroker: background as never,
      topic: "",
      close: async () => {}
    })
  ).toThrow(TypeError)
})

test("a class subject keeps its broker methods", async () => {
  class Subject {
    readonly #broker = newMemoryBroker()
    readonly topic = "orders"
    newBroker(): Promise<ReturnType<typeof newMemoryBroker>> {
      return Promise.resolve(this.#broker)
    }
    close(): Promise<void> {
      return Promise.resolve()
    }
  }
  const entry = brokerConformance(new Subject()).find(
    (item) => item.name === "publish copies headers and bytes"
  )
  if (entry === undefined) throw new Error("missing publish case")
  await entry.run()
})

test("an overlapping broker fails without leaving its gate closed", async () => {
  const handlers: Array<
    (
      ctx: ReturnType<typeof background>,
      event: ReturnType<typeof newBrokerEvent<null>>
    ) => Promise<void>
  > = []
  const started = Date.now()
  const entry = brokerConformance({
    topic: "orders",
    timeoutMs: 200,
    async newBroker() {
      return {
        string: () => "overlap",
        async subscribe(
          _ctx: ReturnType<typeof background>,
          _topic: string,
          handler: (typeof handlers)[number]
        ) {
          handlers.push(handler)
          return { topic: "orders", async unsubscribe() {} }
        },
        async publish(
          _ctx: ReturnType<typeof background>,
          topic: string,
          message: { headers: Readonly<Record<string, string>>; body: Uint8Array }
        ) {
          const handler = handlers[0]
          if (handler === undefined) return
          await Promise.resolve()
          void handler(background(), newBrokerEvent(topic, message.headers, message.body, null))
        }
      }
    },
    async close() {}
  }).find((item) => item.name === "one subscriber receives messages serially")
  if (entry === undefined) throw new Error("missing serial case")
  await expect(entry.run()).rejects.toThrow("deliveries overlapped")
  expect(Date.now() - started).toBeLessThan(1_000)
})

test("settle and subscribe options stay on the original subject", async () => {
  const handlers: Array<
    (
      ctx: ReturnType<typeof background>,
      event: ReturnType<typeof newBrokerEvent<null>>
    ) => Promise<void>
  > = []
  let settled = false
  const entry = brokerConformance({
    topic: "orders",
    subscribeOptions: { durable: "suite" },
    settle() {
      settled = true
    },
    async newBroker() {
      return {
        string: () => "options",
        async subscribe(
          _ctx: ReturnType<typeof background>,
          _topic: string,
          handler: (typeof handlers)[number],
          options: { durable: string } | undefined
        ) {
          if (options?.durable !== "suite") throw new Error("subscribe options were dropped")
          handlers.push(handler)
          return { topic: "orders", async unsubscribe() {} }
        },
        async publish(
          _ctx: ReturnType<typeof background>,
          topic: string,
          message: { headers: Readonly<Record<string, string>>; body: Uint8Array }
        ) {
          const handler = handlers[0]
          if (handler === undefined) return
          await handler(background(), newBrokerEvent(topic, message.headers, message.body, null))
        }
      }
    },
    async close() {}
  }).find((item) => item.name === "publish copies headers and bytes")
  if (entry === undefined) throw new Error("missing publish case")
  await entry.run()
  expect(settled).toBe(true)
})

test("a broker factory failure is retained and the subject is still closed", async () => {
  let closed = false
  const entry = brokerConformance({
    topic: "orders",
    async newBroker() {
      throw new Error("factory failed")
    },
    async close() {
      closed = true
    }
  }).find((item) => item.name === "string is stable")
  if (entry === undefined) throw new Error("missing string case")
  await expect(entry.run()).rejects.toThrow("factory failed")
  expect(closed).toBe(true)
})

test("a resolved publish still observes the handler failure", async () => {
  let handler:
    | ((
        ctx: ReturnType<typeof background>,
        event: ReturnType<typeof newBrokerEvent<null>>
      ) => Promise<void>)
    | undefined
  let rejectTerminal: (error: Error) => void = () => {}
  let open = true
  const entry = brokerConformance({
    topic: "orders",
    async newBroker() {
      return {
        string: () => "async-publish",
        async subscribe(
          _ctx: ReturnType<typeof background>,
          topic: string,
          next: NonNullable<typeof handler>
        ) {
          handler = next
          open = true
          const terminal = new Promise<void>((_resolve, reject) => {
            rejectTerminal = reject
          })
          return registerSubscriberTerminal({ topic, async unsubscribe() {} }, terminal)
        },
        async publish(
          _ctx: ReturnType<typeof background>,
          topic: string,
          message: { headers: Readonly<Record<string, string>>; body: Uint8Array }
        ) {
          const current = handler
          const reject = rejectTerminal
          if (!open || current === undefined) return
          void Promise.resolve(
            current(background(), newBrokerEvent(topic, message.headers, message.body, null))
          ).then(
            () => undefined,
            (error: unknown) => {
              open = false
              const handlerError = error instanceof Error ? error : new Error("handler failed")
              reject(handlerError)
            }
          )
        }
      }
    },
    async close() {}
  }).find((item) => item.name === "handler failure terminates the subscription and the server")
  if (entry === undefined) throw new Error("missing handler failure case")
  await entry.run()
})

function handlerFailureSubject(rejectWith: (failure: Error) => unknown): {
  readonly topic: string
  readonly timeoutMs: number
  newBroker(): Promise<{
    string(): string
    subscribe(
      ctx: ReturnType<typeof background>,
      topic: string,
      handler: (
        ctx: ReturnType<typeof background>,
        event: ReturnType<typeof newBrokerEvent<null>>
      ) => Promise<void>
    ): Promise<{
      topic: string
      unsubscribe(ctx: ReturnType<typeof background>): Promise<void>
    }>
    publish(
      ctx: ReturnType<typeof background>,
      topic: string,
      message: { headers: Readonly<Record<string, string>>; body: Uint8Array }
    ): Promise<void>
  }>
  close(): Promise<void>
} {
  let handler:
    | ((
        ctx: ReturnType<typeof background>,
        event: ReturnType<typeof newBrokerEvent<null>>
      ) => Promise<void>)
    | undefined
  let rejectTerminal: (error: unknown) => void = () => {}
  let open = true
  return {
    topic: "orders",
    timeoutMs: 1_000,
    async newBroker() {
      return {
        string: () => "terminal",
        async subscribe(
          _ctx: ReturnType<typeof background>,
          topic: string,
          next: NonNullable<typeof handler>
        ) {
          handler = next
          open = true
          const terminal = new Promise<void>((_resolve, reject) => {
            rejectTerminal = reject
          })
          return registerSubscriberTerminal({ topic, async unsubscribe() {} }, terminal)
        },
        async publish(
          _ctx: ReturnType<typeof background>,
          topic: string,
          message: { headers: Readonly<Record<string, string>>; body: Uint8Array }
        ) {
          const current = handler
          const reject = rejectTerminal
          if (!open || current === undefined) return
          void Promise.resolve(
            current(background(), newBrokerEvent(topic, message.headers, message.body, null))
          ).then(
            () => undefined,
            (error: unknown) => {
              open = false
              const handlerError = error instanceof Error ? error : new Error("handler failed")
              reject(rejectWith(handlerError))
            }
          )
        }
      }
    },
    async close() {}
  }
}

test("a wrapped single handler error is not the handler failure", async () => {
  const started = Date.now()
  const entry = brokerConformance(
    handlerFailureSubject((failure) => new AggregateError([failure], "wrapped", { cause: failure }))
  ).find((item) => item.name === "handler failure terminates the subscription and the server")
  if (entry === undefined) throw new Error("missing handler failure case")
  await expect(entry.run()).rejects.toThrow("server start lost the handler error")
  expect(Date.now() - started).toBeLessThan(1_000)
})

test("a cleanup failure is retained only when the handler error is first", async () => {
  const started = Date.now()
  const cleanup = new Error("cleanup failed")
  const entry = brokerConformance(
    handlerFailureSubject(
      (failure) => new AggregateError([cleanup, failure], "cleanup first", { cause: failure })
    )
  ).find((item) => item.name === "handler failure terminates the subscription and the server")
  if (entry === undefined) throw new Error("missing handler failure case")
  await expect(entry.run()).rejects.toThrow("server start lost the handler error")
  expect(Date.now() - started).toBeLessThan(1_000)
})

test("an independent cleanup failure stays attached after the handler error", async () => {
  const cleanup = new Error("cleanup failed")
  const entry = brokerConformance(
    handlerFailureSubject(
      (failure) =>
        new AggregateError([failure, cleanup], "handler and cleanup failed", { cause: failure })
    )
  ).find((item) => item.name === "handler failure terminates the subscription and the server")
  if (entry === undefined) throw new Error("missing handler failure case")
  await entry.run()
})

test("telemetry conformance waits for an asynchronous process span to end", async () => {
  let handler:
    | ((
        ctx: ReturnType<typeof background>,
        event: ReturnType<typeof newBrokerEvent<null>>
      ) => Promise<void>)
    | undefined
  let subscription = background()
  const entry = brokerTelemetryConformance({
    topic: "orders",
    timeoutMs: 1_000,
    async settle() {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 80)
      })
    },
    async newBroker() {
      return {
        string: () => "async-span",
        async subscribe(
          ctx: ReturnType<typeof background>,
          topic: string,
          next: NonNullable<typeof handler>
        ) {
          subscription = ctx
          handler = next
          return { topic, async unsubscribe() {} }
        },
        async publish(
          ctx: ReturnType<typeof background>,
          topic: string,
          message: { headers: Readonly<Record<string, string>>; body: Uint8Array }
        ) {
          await publishUnit(ctx, "fake", topic, message, async (_unitCtx, traced) => {
            const current = handler
            if (current === undefined) return
            const event = newBrokerEvent(topic, traced.headers, traced.body, null)
            void deliver(subscription, "fake", topic, event, current).catch(() => {})
          })
        }
      }
    },
    async close() {}
  }).find(
    (item) => item.name === "publish injects traceparent into a copy and process is its child"
  )
  if (entry === undefined) throw new Error("missing telemetry case")
  await entry.run()
})

test("a nonconforming serial subject fails without leaving its handler subscribed", async () => {
  let active = 0
  let unsubscribed = 0
  let publishes = 0
  const started = Date.now()
  const entry = brokerConformance({
    topic: "orders",
    timeoutMs: 300,
    async newBroker() {
      let handler:
        | ((
            ctx: ReturnType<typeof background>,
            event: ReturnType<typeof newBrokerEvent<null>>
          ) => Promise<void>)
        | undefined
      return {
        string: () => "serial-leak",
        async subscribe(
          _ctx: ReturnType<typeof background>,
          _topic: string,
          next: NonNullable<typeof handler>
        ) {
          handler = next
          return {
            topic: "orders",
            async unsubscribe() {
              unsubscribed += 1
            }
          }
        },
        publish(
          _ctx: ReturnType<typeof background>,
          topic: string,
          message: { headers: Readonly<Record<string, string>>; body: Uint8Array }
        ) {
          publishes += 1
          const current = handler
          if (current === undefined) return Promise.resolve()
          if (publishes > 1) throw new Error("second publish failed")
          active += 1
          void Promise.resolve(
            current(background(), newBrokerEvent(topic, message.headers, message.body, null))
          ).finally(() => {
            active -= 1
          })
          return Promise.resolve()
        }
      }
    },
    async close() {}
  }).find((item) => item.name === "one subscriber receives messages serially")
  if (entry === undefined) throw new Error("missing serial case")
  await expect(entry.run()).rejects.toThrow("second publish failed")
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
  expect(active).toBe(0)
  expect(unsubscribed).toBeGreaterThan(0)
  expect(Date.now() - started).toBeLessThan(1_000)
})

test("a nonconforming unsubscribe subject fails without leaving its handler running", async () => {
  let active = 0
  let unsubscribed = 0
  const started = Date.now()
  const entry = brokerConformance({
    topic: "orders",
    timeoutMs: 300,
    async newBroker() {
      let handler:
        | ((
            ctx: ReturnType<typeof background>,
            event: ReturnType<typeof newBrokerEvent<null>>
          ) => Promise<void>)
        | undefined
      return {
        string: () => "unsubscribe-leak",
        async subscribe(
          _ctx: ReturnType<typeof background>,
          _topic: string,
          next: NonNullable<typeof handler>
        ) {
          handler = next
          return {
            topic: "orders",
            async unsubscribe() {
              unsubscribed += 1
            }
          }
        },
        async publish(
          _ctx: ReturnType<typeof background>,
          topic: string,
          message: { headers: Readonly<Record<string, string>>; body: Uint8Array }
        ) {
          const current = handler
          if (current === undefined) return
          active += 1
          void Promise.resolve(
            current(background(), newBrokerEvent(topic, message.headers, message.body, null))
          ).finally(() => {
            active -= 1
          })
        }
      }
    },
    async close() {}
  }).find(
    (item) => item.name === "unsubscribe drains admitted handlers without following the caller"
  )
  if (entry === undefined) throw new Error("missing unsubscribe case")
  await expect(entry.run()).rejects.toThrow("broker operation fulfilled")
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
  expect(active).toBe(0)
  expect(unsubscribed).toBeGreaterThan(0)
  expect(Date.now() - started).toBeLessThan(1_000)
})

test("a subject that rejects with null is reported", async () => {
  const factory = brokerConformance({
    topic: "orders",
    async newBroker() {
      return Promise.reject(null)
    },
    async close() {}
  }).find((item) => item.name === "string is stable")
  const closed = brokerConformance({
    topic: "orders",
    async newBroker() {
      return newMemoryBroker()
    },
    async close() {
      return Promise.reject(null)
    }
  }).find((item) => item.name === "string is stable")
  if (factory === undefined || closed === undefined) throw new Error("missing string case")
  await expect(factory.run()).rejects.toBeNull()
  await expect(closed.run()).rejects.toBeNull()
})

test("a hung publish stays inside the suite bound", async () => {
  const started = Date.now()
  const entry = brokerConformance({
    topic: "orders",
    timeoutMs: 30,
    async newBroker() {
      return {
        string: () => "hung",
        async subscribe() {
          return { topic: "orders", async unsubscribe() {} }
        },
        async publish() {
          await new Promise<void>(() => {})
        }
      }
    },
    async close() {}
  }).find((item) => item.name === "publish copies headers and bytes")
  if (entry === undefined) throw new Error("missing publish case")
  await expect(entry.run()).rejects.toThrow("bounded-rejection")
  expect(Date.now() - started).toBeLessThan(500)
})

test("serial cleanup reports an unsubscribe failure after the deliveries", async () => {
  const entry = brokerConformance({
    topic: "orders",
    async newBroker() {
      const memory = newMemoryBroker()
      return {
        string: () => memory.string(),
        publish: (
          ctx: ReturnType<typeof background>,
          topic: string,
          message: { headers: Readonly<Record<string, string>>; body: Uint8Array }
        ) => memory.publish(ctx, topic, message),
        async subscribe(
          ctx: ReturnType<typeof background>,
          topic: string,
          handler: (
            ctx: ReturnType<typeof background>,
            event: ReturnType<typeof newBrokerEvent<null>>
          ) => Promise<void>
        ) {
          const subscriber = await memory.subscribe(ctx, topic, handler)
          return {
            topic: subscriber.topic,
            unsubscribe() {
              return Promise.reject(new Error("unsubscribe failed"))
            }
          }
        }
      }
    },
    async close() {}
  }).find((item) => item.name === "one subscriber receives messages serially")
  if (entry === undefined) throw new Error("missing serial case")
  await expect(entry.run()).rejects.toThrow("unsubscribe failed")
})

test("unsubscribe cleanup keeps a later unsubscribe failure", async () => {
  let stops = 0
  const entry = brokerConformance({
    topic: "orders",
    async newBroker() {
      const memory = newMemoryBroker()
      return {
        string: () => memory.string(),
        publish: (
          ctx: ReturnType<typeof background>,
          topic: string,
          message: { headers: Readonly<Record<string, string>>; body: Uint8Array }
        ) => memory.publish(ctx, topic, message),
        async subscribe(
          ctx: ReturnType<typeof background>,
          topic: string,
          handler: (
            ctx: ReturnType<typeof background>,
            event: ReturnType<typeof newBrokerEvent<null>>
          ) => Promise<void>
        ) {
          const subscriber = await memory.subscribe(ctx, topic, handler)
          return {
            topic: subscriber.topic,
            unsubscribe(stopCtx: ReturnType<typeof background>) {
              stops += 1
              if (stops >= 4) return Promise.reject(new Error("unsubscribe failed"))
              return subscriber.unsubscribe(stopCtx)
            }
          }
        }
      }
    },
    async close() {}
  }).find(
    (item) => item.name === "unsubscribe drains admitted handlers without following the caller"
  )
  if (entry === undefined) throw new Error("missing unsubscribe case")
  await expect(entry.run()).rejects.toThrow("unsubscribe failed")
})

test("a non-settling close fails inside the suite bound", async () => {
  const started = Date.now()
  const entry = brokerConformance({
    topic: "orders",
    timeoutMs: 20,
    async newBroker() {
      return newMemoryBroker()
    },
    async close() {
      await new Promise<void>(() => {})
    }
  }).find((item) => item.name === "string is stable")
  if (entry === undefined) throw new Error("missing string case")
  await expect(entry.run()).rejects.toThrow("bounded-rejection")
  expect(Date.now() - started).toBeLessThan(500)
})

test("a subject bounded-rejection error is reported by identity", async () => {
  const immediate = new Error("bounded-rejection")
  const immediateCase = brokerConformance({
    timeoutMs: 80,
    topic: "orders",
    async newBroker() {
      return {
        string(): string {
          throw immediate
        },
        async publish() {
          throw new Error("unused")
        },
        async subscribe() {
          return { topic: "orders", async unsubscribe() {} }
        }
      }
    },
    async close() {}
  }).find((item) => item.name === "string is stable")
  const provider = new Error("bounded-rejection")
  let cleanupFinished = false
  const delayed = brokerConformance({
    timeoutMs: 80,
    topic: "orders",
    async newBroker() {
      return {
        string: () => "bound-message",
        async subscribe() {
          return { topic: "orders", async unsubscribe() {} }
        },
        async publish() {
          try {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 40)
            })
            throw provider
          } finally {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 60)
            })
            cleanupFinished = true
          }
        }
      }
    },
    async close() {
      if (!cleanupFinished) throw new Error("closed before cleanup")
    }
  }).find((item) => item.name === "publish copies headers and bytes")
  if (immediateCase === undefined || delayed === undefined) throw new Error("missing broker case")
  await expect(immediateCase.run()).rejects.toBe(immediate)
  await expect(delayed.run()).rejects.toBe(provider)
})
