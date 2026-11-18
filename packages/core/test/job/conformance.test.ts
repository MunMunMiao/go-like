import { expect, test } from "bun:test"

import { background } from "../../src/context"
import { newIntervalSchedule, type Job } from "../../src/job/index"
import type { JobConformancePayload } from "../../src/job/testing-types"
import { newMemoryJobQueue } from "../../src/job/memory"
import {
  jobQueueConformance,
  jobTelemetryConformance,
  scheduleConformance
} from "../../src/testing/index"

const queueCases = jobQueueConformance({
  async newQueue() {
    return newMemoryJobQueue("conformance")
  },
  async close() {}
})

for (const entry of queueCases) {
  test(entry.name, async () => {
    await entry.run()
  })
}

for (const entry of scheduleConformance(() => newIntervalSchedule(1_000))) {
  test(entry.name, async () => {
    await entry.run()
  })
}

for (const entry of jobTelemetryConformance({
  queue: {
    async newQueue() {
      return newMemoryJobQueue("telemetry")
    },
    async close() {}
  }
})) {
  test(entry.name, async () => {
    await entry.run()
  })
}

test("schedule telemetry runs without a queue", async () => {
  const cases = jobTelemetryConformance({})
  expect(cases.map((entry) => entry.name)).toEqual([
    "a schedule run is a root span",
    "a thrown schedule handler is a failed run and scheduling continues"
  ])
  for (const entry of cases) await entry.run()
})

test("job conformance rejects an invalid subject", () => {
  expect(() => jobQueueConformance(null as never)).toThrow(TypeError)
  expect(() => scheduleConformance(null as never)).toThrow(TypeError)
  expect(() => jobTelemetryConformance(null as never)).toThrow(TypeError)
  expect(() => newIntervalSchedule(0)).toThrow(RangeError)
  expect(() => newIntervalSchedule(1.5)).toThrow(RangeError)
})

test("a non-settling queue factory fails inside the suite bound", async () => {
  const started = Date.now()
  const entry = jobQueueConformance({
    timeoutMs: 20,
    async newQueue() {
      await new Promise<never>(() => {})
      return newMemoryJobQueue("hung")
    },
    async close() {}
  }).find((item) => item.name === "handler sees the name payload attempt and id")
  if (entry === undefined) throw new Error("missing handler case")
  await expect(entry.run()).rejects.toThrow("bounded-rejection")
  expect(Date.now() - started).toBeLessThan(500)
})

test("a queue close failure survives a successful case", async () => {
  const entry = jobQueueConformance({
    async newQueue() {
      return newMemoryJobQueue("close-failure")
    },
    async close() {
      throw new Error("close failed")
    }
  }).find((item) => item.name === "handler sees the name payload attempt and id")
  if (entry === undefined) throw new Error("missing handler case")
  await expect(entry.run()).rejects.toThrow("close failed")
})

function deliveryQueue(onStop: () => Promise<void>, onStart: () => Promise<void> = async () => {}) {
  const handlers: Array<
    (ctx: ReturnType<typeof background>, job: Job<JobConformancePayload>) => unknown
  > = []
  return {
    name: "q",
    string: () => "q",
    async enqueue(
      _ctx: ReturnType<typeof background>,
      name: string,
      payload: JobConformancePayload,
      options?: { id?: string }
    ) {
      const handler = handlers[0]
      if (handler !== undefined) {
        await handler(background(), {
          name,
          id: options?.id ?? "1",
          attempt: 1,
          queue: "q",
          payload
        })
      }
      return { id: options?.id ?? "1" }
    },
    worker(table: { work?: (typeof handlers)[number] }) {
      return {
        async start() {
          if (table.work !== undefined) handlers.push(table.work)
          await onStart()
        },
        stop: onStop
      }
    }
  }
}

test("a worker stop failure survives a successful case", async () => {
  const entry = jobQueueConformance({
    async newQueue() {
      return deliveryQueue(async () => {
        throw new Error("stop failed")
      })
    },
    async close() {}
  }).find((item) => item.name === "handler sees the name payload attempt and id")
  if (entry === undefined) throw new Error("missing handler case")
  await expect(entry.run()).rejects.toThrow("stop failed")
})

test("a worker runtime failure survives a successful case", async () => {
  const entry = jobQueueConformance({
    async newQueue() {
      return deliveryQueue(
        async () => {},
        async () => {
          throw new Error("runtime failed")
        }
      )
    },
    async close() {}
  }).find((item) => item.name === "handler sees the name payload attempt and id")
  if (entry === undefined) throw new Error("missing handler case")
  await expect(entry.run()).rejects.toThrow("runtime failed")
})

test("an overlapping worker fails without leaving its gate closed", async () => {
  const handlers: Array<
    (ctx: ReturnType<typeof background>, job: Job<JobConformancePayload>) => unknown
  > = []
  const pending: Promise<unknown>[] = []
  const started = Date.now()
  const entry = jobQueueConformance({
    timeoutMs: 1_000,
    async newQueue() {
      return {
        name: "overlap",
        string: () => "overlap",
        async enqueue(_ctx, name, payload) {
          const handler = handlers[0]
          if (handler !== undefined) {
            pending.push(
              Promise.resolve(
                handler(background(), {
                  name,
                  id: "1",
                  attempt: 1,
                  queue: "overlap",
                  payload
                })
              )
            )
          }
          return { id: "1" }
        },
        worker(table) {
          return {
            async start() {
              const handler = table.work
              if (handler !== undefined) handlers.push(handler)
            },
            async stop() {
              await Promise.all(pending)
            }
          }
        }
      }
    },
    async close() {}
  }).find((item) => item.name === "concurrency bounds active runs")
  if (entry === undefined) throw new Error("missing concurrency case")
  await expect(entry.run()).rejects.toThrow("concurrency did not hold the third job")
  expect(Date.now() - started).toBeLessThan(500)
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

test("a wrong dedup id releases its handler gate", async () => {
  const handlers: Array<
    (ctx: ReturnType<typeof background>, job: Job<JobConformancePayload>) => unknown
  > = []
  const pending: Promise<unknown>[] = []
  let enqueued = 0
  const started = Date.now()
  const entry = jobQueueConformance({
    timeoutMs: 400,
    async newQueue() {
      return {
        name: "dedup",
        string: () => "dedup",
        async enqueue(
          _ctx: ReturnType<typeof background>,
          name: string,
          payload: JobConformancePayload,
          options?: { id?: string }
        ) {
          enqueued += 1
          const handler = handlers[0]
          if (handler !== undefined) {
            pending.push(
              Promise.resolve(
                handler(background(), {
                  name,
                  id: options?.id ?? String(enqueued),
                  attempt: 1,
                  queue: "dedup",
                  payload
                })
              )
            )
          }
          const id = options?.id === "same" && enqueued > 1 ? "different" : (options?.id ?? "1")
          return { id }
        },
        worker(table: { work?: (typeof handlers)[number] }) {
          return {
            async start() {
              if (table.work !== undefined) handlers.push(table.work)
            },
            async stop() {
              await Promise.all(pending)
            }
          }
        }
      }
    },
    async close() {}
  }).find((item) => item.name === "an unfinished id is not enqueued twice")
  if (entry === undefined) throw new Error("missing dedup case")
  await expect(entry.run()).rejects.toThrow("unfinished id was not deduplicated")
  expect(Date.now() - started).toBeLessThan(250)
})

test("an enqueue failure before the concurrency assertion releases its gate", async () => {
  const handlers: Array<
    (ctx: ReturnType<typeof background>, job: Job<JobConformancePayload>) => unknown
  > = []
  const pending: Promise<unknown>[] = []
  let enqueued = 0
  const started = Date.now()
  const entry = jobQueueConformance({
    timeoutMs: 400,
    async newQueue() {
      return {
        name: "early",
        string: () => "early",
        async enqueue(
          _ctx: ReturnType<typeof background>,
          name: string,
          payload: JobConformancePayload
        ) {
          enqueued += 1
          if (enqueued === 3) throw new Error("enqueue failed")
          const handler = handlers[0]
          if (handler !== undefined) {
            pending.push(
              Promise.resolve(
                handler(background(), {
                  name,
                  id: String(enqueued),
                  attempt: 1,
                  queue: "early",
                  payload
                })
              )
            )
          }
          return { id: String(enqueued) }
        },
        worker(table: { work?: (typeof handlers)[number] }) {
          return {
            async start() {
              if (table.work !== undefined) handlers.push(table.work)
            },
            async stop() {
              await Promise.all(pending)
            }
          }
        }
      }
    },
    async close() {}
  }).find((item) => item.name === "concurrency bounds active runs")
  if (entry === undefined) throw new Error("missing concurrency case")
  await expect(entry.run()).rejects.toThrow("enqueue failed")
  expect(Date.now() - started).toBeLessThan(250)
})

test("a bounded case keeps the contract error and finishes worker cleanup", async () => {
  const contract = new Error("contract-broken")
  let cleanupFinished = false
  let closedEarly = false
  const entry = jobQueueConformance({
    timeoutMs: 80,
    async newQueue() {
      return {
        name: "bound",
        string: () => "bound",
        async enqueue() {
          await sleep(40)
          throw contract
        },
        worker() {
          return {
            async start() {},
            async stop() {
              await sleep(60)
              cleanupFinished = true
            }
          }
        }
      }
    },
    async close() {
      closedEarly = !cleanupFinished
    }
  }).find((item) => item.name === "handler sees the name payload attempt and id")
  if (entry === undefined) throw new Error("missing handler case")
  const failure = await entry.run().then(
    () => null,
    (error: unknown) => error
  )
  expect(closedEarly).toBe(false)
  expect(failure).toBe(contract)
})

test("worker cleanup failure stays attached to the contract error", async () => {
  const contract = new Error("contract-broken")
  const cleanup = new Error("cleanup-broken")
  const entry = jobQueueConformance({
    async newQueue() {
      return {
        name: "both",
        string: () => "both",
        async enqueue() {
          throw contract
        },
        worker() {
          return {
            async start() {},
            async stop() {
              throw cleanup
            }
          }
        }
      }
    },
    async close() {}
  }).find((item) => item.name === "handler sees the name payload attempt and id")
  if (entry === undefined) throw new Error("missing handler case")
  const failure = await entry.run().then(
    () => null,
    (error: unknown) => error
  )
  expect(failure).toBeInstanceOf(AggregateError)
  if (!(failure instanceof AggregateError)) return
  expect(failure.errors[0]).toBe(contract)
  expect(failure.errors[1]).toBe(cleanup)
})

test("a worker start rejection is the case failure without an unhandled rejection", async () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on("unhandledRejection", onUnhandled)
  const startFailure = new Error("start failed")
  try {
    const entry = jobQueueConformance({
      timeoutMs: 300,
      async newQueue() {
        return {
          name: "start",
          string: () => "start",
          async enqueue() {
            await sleep(1_000)
            return { id: "1" }
          },
          worker() {
            return {
              start() {
                return Promise.reject(startFailure)
              },
              async stop() {}
            }
          }
        }
      },
      async close() {}
    }).find((item) => item.name === "handler sees the name payload attempt and id")
    if (entry === undefined) throw new Error("missing handler case")
    await expect(entry.run()).rejects.toBe(startFailure)
    await sleep(20)
    expect(unhandled).toEqual([])
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
})

test("usingQueue does not swallow a null rejection", async () => {
  const opened = jobQueueConformance({
    async newQueue() {
      return Promise.reject(null)
    },
    async close() {}
  }).find((item) => item.name === "handler sees the name payload attempt and id")
  if (opened === undefined) throw new Error("missing handler case")
  const openedFailure = await opened.run().then(
    () => "resolved",
    (error: unknown) => error
  )
  expect(openedFailure).toBeNull()

  const contract = new Error("contract-broken")
  const closed = jobQueueConformance({
    async newQueue() {
      return {
        name: "null-close",
        string: () => "null-close",
        async enqueue() {
          throw contract
        },
        worker() {
          return {
            async start() {},
            async stop() {}
          }
        }
      }
    },
    async close() {
      return Promise.reject(null)
    }
  }).find((item) => item.name === "handler sees the name payload attempt and id")
  if (closed === undefined) throw new Error("missing handler case")
  const closedFailure = await closed.run().then(
    () => "resolved",
    (error: unknown) => error
  )
  expect(closedFailure).toBeInstanceOf(AggregateError)
  if (!(closedFailure instanceof AggregateError)) return
  expect(closedFailure.errors[0]).toBe(contract)
  expect(closedFailure.errors[1]).toBeNull()
})

test("usingQueue reports an undefined rejection", async () => {
  const opened = jobQueueConformance({
    async newQueue() {
      return Promise.reject(undefined)
    },
    async close() {}
  }).find((item) => item.name === "handler sees the name payload attempt and id")
  if (opened === undefined) throw new Error("missing handler case")
  const openedFailure = await opened.run().then(
    () => "resolved",
    (error: unknown) => error
  )
  expect(openedFailure).toBeUndefined()

  const body = jobQueueConformance({
    async newQueue() {
      return {
        name: "undefined-body",
        string: () => "undefined-body",
        async enqueue() {
          throw undefined
        },
        worker() {
          return {
            async start() {},
            async stop() {}
          }
        }
      }
    },
    async close() {}
  }).find((item) => item.name === "handler sees the name payload attempt and id")
  if (body === undefined) throw new Error("missing handler case")
  const bodyFailure = await body.run().then(
    () => "resolved",
    (error: unknown) => error
  )
  expect(bodyFailure).toBeUndefined()

  const handlers: Array<(ctx: ReturnType<typeof background>, job: unknown) => unknown> = []
  const closed = jobQueueConformance({
    async newQueue() {
      return {
        name: "undefined-close",
        string: () => "undefined-close",
        async enqueue(
          _ctx: ReturnType<typeof background>,
          name: string,
          payload: { readonly n: number },
          options?: { id?: string }
        ) {
          const handler = handlers[0]
          if (handler !== undefined) {
            await handler(background(), {
              name,
              id: options?.id ?? "1",
              attempt: 1,
              queue: "undefined-close",
              payload
            })
          }
          return { id: options?.id ?? "1" }
        },
        worker(table: { work?: (typeof handlers)[number] }) {
          return {
            async start() {
              if (table.work !== undefined) handlers.push(table.work)
            },
            async stop() {}
          }
        }
      }
    },
    async close() {
      return Promise.reject(undefined)
    }
  }).find((item) => item.name === "handler sees the name payload attempt and id")
  if (closed === undefined) throw new Error("missing handler case")
  const closedFailure = await closed.run().then(
    () => "resolved",
    (error: unknown) => error
  )
  expect(closedFailure).toBeUndefined()
})

test("a provider bounded-rejection error is not the suite bound", async () => {
  const provider = new Error("bounded-rejection")
  let cleanupFinished = false
  const entry = jobQueueConformance({
    timeoutMs: 80,
    async newQueue() {
      return {
        name: "bound-message",
        string: () => "bound-message",
        async enqueue() {
          await sleep(40)
          throw provider
        },
        worker() {
          return {
            async start() {},
            async stop() {
              await sleep(60)
              cleanupFinished = true
            }
          }
        }
      }
    },
    async close() {
      if (!cleanupFinished) throw new Error("closed before cleanup")
    }
  }).find((item) => item.name === "handler sees the name payload attempt and id")
  if (entry === undefined) throw new Error("missing handler case")
  const failure = await entry.run().then(
    () => null,
    (error: unknown) => error
  )
  expect(failure).toBe(provider)
})
