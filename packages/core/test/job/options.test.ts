import { expect, test } from "bun:test"

import { background, withCancelCause } from "../../src/context"
import { newIntervalSchedule, newPermanentJobError, newScheduleServer } from "../../src/job/index"
import { newMemoryJobQueue } from "../../src/job/memory"
import { retryDelay } from "../../src/job/names"
import {
  enqueue,
  enqueueOptions,
  jobHandlers,
  jobWorkerOptions,
  runJob
} from "../../src/job/provider"

test("enqueue and worker options reject values outside the documented range", () => {
  expect(enqueueOptions().attempts).toBe(1)
  expect(enqueueOptions().backoff).toEqual({ type: "fixed", delayMs: 0 })
  expect(
    enqueueOptions({ id: "one", attempts: 3, backoff: { type: "exponential", delayMs: 5 } }).id
  ).toBe("one")
  expect(() => enqueueOptions(null as never)).toThrow(TypeError)
  expect(() => enqueueOptions({ id: "" })).toThrow(TypeError)
  expect(() => enqueueOptions({ attempts: 0 })).toThrow(RangeError)
  expect(() => enqueueOptions({ backoff: { type: "fixed", delayMs: -1 } })).toThrow(RangeError)
  expect(() => enqueueOptions({ backoff: { type: "other" as "fixed", delayMs: 1 } })).toThrow(
    TypeError
  )
  expect(jobWorkerOptions().concurrency).toBe(1)
  expect(jobWorkerOptions().drainTimeoutMs).toBe(25_000)
  expect(() => jobWorkerOptions({ concurrency: 0 })).toThrow(RangeError)
  expect(() => jobWorkerOptions({ drainTimeoutMs: -1 })).toThrow(RangeError)
  expect(() => jobWorkerOptions({ drainTimeoutMs: 1.5 })).toThrow(RangeError)
  expect(() => jobWorkerOptions({ drainTimeoutMs: 2_147_483_648 })).toThrow(RangeError)
  expect(() => jobHandlers({})).toThrow(TypeError)
  expect(() => jobHandlers({ work: "no" as never })).toThrow(TypeError)
  const inherited = { hidden: () => "no" }
  const handlers = Object.create(inherited) as { work: () => void }
  handlers.work = () => {}
  const snapshot = jobHandlers(handlers)
  expect(Object.hasOwn(snapshot, "work")).toBe(true)
  expect(Object.hasOwn(snapshot, "hidden")).toBe(false)
  expect(retryDelay({ type: "fixed", delayMs: 4 }, 3)).toBe(4)
  expect(retryDelay({ type: "exponential", delayMs: 4 }, 2)).toBe(4)
  expect(retryDelay({ type: "exponential", delayMs: 4 }, 4)).toBe(16)
  expect(retryDelay({ type: "exponential", delayMs: 2_000_000_000 }, 3)).toBe(2_147_483_647)
  expect(retryDelay({ type: "exponential", delayMs: 2 }, 40)).toBe(2_147_483_647)
  expect(retryDelay({ type: "exponential", delayMs: 0 }, 33)).toBe(0)
})

test("a queued payload keeps JSON data and drops Date identity", async () => {
  const queue = newMemoryJobQueue<{ readonly n: number; readonly when?: string }>("json")
  const seen: unknown[] = []
  const worker = queue.worker({
    work(_ctx, job) {
      seen.push(job.payload)
    }
  })
  const running = worker.start(background())
  void running.catch(() => {})
  try {
    await queue.enqueue(background(), "work", {
      n: 1,
      when: new Date(0) as never
    })
    const deadline = Date.now() + 1_000
    while (seen.length === 0) {
      if (Date.now() > deadline) throw new Error("json job did not run")
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5)
      })
    }
    expect(seen[0]).toEqual({ n: 1, when: "1970-01-01T00:00:00.000Z" })
    const cycle: { n: number; self?: unknown } = { n: 1 }
    cycle.self = cycle
    await expect(queue.enqueue(background(), "work", cycle as never)).rejects.toThrow(TypeError)
    await expect(queue.enqueue(background(), "work", (() => {}) as never)).rejects.toThrow(
      TypeError
    )
    await expect(queue.enqueue(background(), "work", Symbol("x") as never)).rejects.toThrow(
      TypeError
    )
    await expect(queue.enqueue(background(), "a".repeat(257), { n: 1 })).rejects.toThrow(TypeError)
    const idle = queue.worker({
      work() {
        throw "nope"
      }
    })
    await idle.stop(background())
    await expect(idle.start(background())).rejects.toMatchObject({ state: "stopped" })
    expect(() => newMemoryJobQueue("")).toThrow(TypeError)
  } finally {
    await worker.stop(background())
    await running
  }
})

test("a non-Error handler failure does not stop the memory worker", async () => {
  const queue = newMemoryJobQueue<{ n: number }>("plain")
  let second = false
  const worker = queue.worker({
    work(_ctx, job) {
      if (job.payload.n === 1) throw "nope"
      second = true
    }
  })
  const running = worker.start(background())
  void running.catch(() => {})
  try {
    await queue.enqueue(background(), "work", { n: 1 })
    await queue.enqueue(background(), "work", { n: 2 })
    const deadline = Date.now() + 1_000
    while (!second) {
      if (Date.now() > deadline) throw new Error("worker stopped after a non-Error")
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5)
      })
    }
  } finally {
    await worker.stop(background())
    await running
  }
})

test("the job kit rethrows handler and send failures", async () => {
  const failure = new Error("body")
  await expect(
    runJob(
      background(),
      { system: "memory", name: "work", trigger: "schedule", id: null, attempt: 1, metadata: null },
      async () => {
        throw failure
      }
    )
  ).rejects.toBe(failure)
  await expect(
    enqueue(background(), { system: "memory", name: "work", queue: "queue" }, async () => {
      throw failure
    })
  ).rejects.toBe(failure)
  expect(newPermanentJobError(failure).code).toBe("GO_LIKE_JOB_PERMANENT")
  expect(newPermanentJobError(failure).cause).toBe(failure)
  expect(() => enqueueOptions({ backoff: 1 as never })).toThrow(TypeError)
  expect(() => jobWorkerOptions(null as never)).toThrow(TypeError)
  expect(() => jobHandlers(null as never)).toThrow(TypeError)
  expect(() => newMemoryJobQueue("a".repeat(257))).toThrow(TypeError)
  expect(() => newScheduleServer({ string: () => "interval" } as never, "job", () => {})).toThrow(
    TypeError
  )
  const idle = newScheduleServer(newIntervalSchedule(60_000), "idle", () => {})
  await idle.stop(background())
})

test("ready jobs run in due order and a canceled worker can stop", async () => {
  const queue = newMemoryJobQueue<{ n: number }>("order")
  const seen: string[] = []
  const first = queue.worker({
    work(_ctx, job) {
      seen.push(job.id)
    }
  })
  const firstRun = first.start(background())
  void firstRun.catch(() => {})
  await queue.enqueue(background(), "work", { n: 1 }, { id: "a" })
  const deadline = Date.now() + 1_000
  while (!seen.includes("a")) {
    if (Date.now() > deadline) throw new Error("first job did not finish")
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5)
    })
  }
  await first.stop(background())
  await firstRun
  const realNow = Date.now
  const frozen = realNow()
  Date.now = () => frozen
  try {
    await queue.enqueue(background(), "work", { n: 1 }, { id: "b" })
    await queue.enqueue(background(), "work", { n: 1 }, { id: "a" })
  } finally {
    Date.now = realNow
  }
  const second = queue.worker({
    work(_ctx, job) {
      seen.push(job.id)
    }
  })
  const secondRun = second.start(background())
  void secondRun.catch(() => {})
  try {
    const limit = Date.now() + 1_000
    while (seen.length < 3) {
      if (Date.now() > limit) throw new Error("reused jobs did not run")
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5)
      })
    }
    expect(seen.slice(-2)).toEqual(["b", "a"])
  } finally {
    await second.stop(background())
    await secondRun
  }

  const delayed = newMemoryJobQueue<{ n: number }>("delay")
  let attempts = 0
  const worker = delayed.worker({
    work() {
      attempts += 1
      throw new Error("later")
    }
  })
  const running = worker.start(background())
  void running.catch(() => {})
  try {
    await delayed.enqueue(
      background(),
      "work",
      { n: 1 },
      {
        attempts: 3,
        backoff: { type: "fixed", delayMs: 400 }
      }
    )
    const limit = Date.now() + 1_000
    while (attempts < 1) {
      if (Date.now() > limit) throw new Error("delayed job did not start")
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5)
      })
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30)
    })
    await worker.stop(background())
    await running
    expect(attempts).toBe(1)
  } finally {
    await worker.stop(background()).catch(() => {})
    await running.catch(() => {})
  }

  const canceledQueue = newMemoryJobQueue<{ n: number }>("canceled")
  const [ctx, cancel] = withCancelCause(background())
  const reason = new Error("worker canceled")
  cancel(reason)
  const canceled = canceledQueue.worker({
    work() {}
  })
  await expect(canceled.start(ctx)).rejects.toBe(reason)
  await canceled.stop(background())

  const ranked = newMemoryJobQueue<{ n: number }>("ranked")
  let failed = false
  const priming = ranked.worker({
    work() {
      failed = true
      throw new Error("delay")
    }
  })
  const primingRun = priming.start(background())
  void primingRun.catch(() => {})
  await ranked.enqueue(
    background(),
    "work",
    { n: 1 },
    {
      id: "slow",
      attempts: 2,
      backoff: { type: "fixed", delayMs: 30 }
    }
  )
  const rankDeadline = Date.now() + 1_000
  while (!failed) {
    if (Date.now() > rankDeadline) throw new Error("slow job did not fail")
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5)
    })
  }
  await priming.stop(background())
  await primingRun
  await ranked.enqueue(background(), "work", { n: 1 }, { id: "fast" })
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 40)
  })
  const rankedSeen: string[] = []
  const ranking = ranked.worker({
    work(_ctx, job) {
      rankedSeen.push(job.id)
    }
  })
  const rankingRun = ranking.start(background())
  void rankingRun.catch(() => {})
  try {
    const limit = Date.now() + 1_000
    while (rankedSeen.length < 2) {
      if (Date.now() > limit) throw new Error(`ranked jobs stalled: ${rankedSeen.join(",")}`)
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5)
      })
    }
    expect(rankedSeen[0]).toBe("fast")
  } finally {
    await ranking.stop(background())
    await rankingRun
  }
})

test("stop from a synchronous memory handler waits for that handler", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const queue = newMemoryJobQueue<number>("owned")
  let stopped = false
  let stopping: Promise<void> | undefined
  const worker = queue.worker(
    {
      work() {
        stopping = worker.stop(background())
        void stopping.then(() => {
          stopped = true
        })
        return gate
      }
    },
    { drainTimeoutMs: 1_000 }
  )
  const running = worker.start(background())
  try {
    await queue.enqueue(background(), "work", 1)
    const deadline = Date.now() + 1_000
    while (stopping === undefined) {
      if (Date.now() > deadline) throw new Error("handler did not stop")
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5)
      })
    }
    expect(stopped).toBe(false)
  } finally {
    release()
    await worker.stop(background())
    await running
  }
})

test("automatic ids skip an unfinished explicit memory id", async () => {
  const queue = newMemoryJobQueue<number>("ids")
  const explicit = await queue.enqueue(background(), "work", 1, { id: "memory:2" })
  const automatic = await queue.enqueue(background(), "work", 2)
  const seen: number[] = []
  const worker = queue.worker({
    work(_ctx, job) {
      seen.push(job.payload)
    }
  })
  const running = worker.start(background())
  try {
    const deadline = Date.now() + 1_000
    while (seen.length < 2) {
      if (Date.now() > deadline) throw new Error(`jobs stalled: ${seen.join(",")}`)
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5)
      })
    }
    expect(seen).toEqual([1, 2])
    expect(automatic.id).not.toBe(explicit.id)
  } finally {
    await worker.stop(background())
    await running
  }
})

test("a stopping worker wakes another worker for a zero-delay retry", async () => {
  const queue = newMemoryJobQueue<number>("retry")
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let notify!: () => void
  const entered = new Promise<void>((resolve) => {
    notify = resolve
  })
  const retried: number[] = []
  const first = queue.worker({
    async work() {
      notify()
      await gate
      throw new Error("retry")
    }
  })
  const second = queue.worker({
    work(_ctx, job) {
      retried.push(job.attempt)
    }
  })
  const firstRun = first.start(background())
  const secondRun = second.start(background())
  try {
    await queue.enqueue(background(), "work", 1, { attempts: 2 })
    await entered
    const stopping = first.stop(background())
    release()
    await stopping
    await firstRun
    const deadline = Date.now() + 1_000
    while (retried.length === 0) {
      if (Date.now() > deadline) throw new Error("retry was not claimed")
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5)
      })
    }
    expect(retried).toEqual([2])
  } finally {
    release()
    await first.stop(background())
    await second.stop(background())
    await Promise.all([firstRun, secondRun])
  }
})

test("a synchronous stop does not dispatch another concurrent memory job", async () => {
  const queue = newMemoryJobQueue<number>("pump")
  await queue.enqueue(background(), "work", 1)
  await queue.enqueue(background(), "work", 2)
  let releaseFirst!: () => void
  let releaseSecond!: () => void
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve
  })
  const seen: number[] = []
  let stopping: Promise<void> | undefined
  const worker = queue.worker(
    {
      work(_ctx, job) {
        seen.push(job.payload)
        if (job.payload === 1) {
          stopping = worker.stop(background())
          return firstGate
        }
        return secondGate
      }
    },
    { concurrency: 2, drainTimeoutMs: 1_000 }
  )
  const running = worker.start(background())
  try {
    expect(stopping).toBeDefined()
    expect(seen).toEqual([1])
    let settled = false
    void stopping?.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20)
    })
    expect(settled).toBe(false)
    releaseFirst()
    await stopping
    expect(seen).toEqual([1])
  } finally {
    releaseFirst()
    releaseSecond()
    await worker.stop(background()).catch(() => {})
    await running.catch(() => {})
  }
})
