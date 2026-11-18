import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, mock, test } from "bun:test"

import { background, withCancelCause } from "@go-like/core/context"
import { newPermanentJobError } from "@go-like/core/job"
import {
  AttributeKey,
  LogEvent,
  MetricName,
  newTelemetry,
  withTelemetry
} from "@go-like/core/telemetry"
import { withRemoteSpanContext } from "@go-like/core/telemetry/provider"
import { newTelemetryRecorder } from "@go-like/core/testing"
import { spanFromContext } from "@go-like/core/trace"

class UnrecoverableError extends Error {
  constructor(message?: string) {
    super(message ?? "")
    this.name = "UnrecoverableError"
  }
}

interface FakeJob {
  name: string
  id?: string
  data: unknown
  attemptsMade: number
  opts?: { telemetry?: { metadata?: unknown } }
}

interface FakeWorker {
  readonly processor: (job: FakeJob) => Promise<unknown>
  readonly opts: {
    readonly autorun?: boolean
    readonly concurrency?: number
    readonly prefix?: string
    readonly lockDuration?: number
  }
  emit(event: "closed" | "error", error?: unknown): boolean
}

const created: FakeWorker[] = []
let ready: Promise<unknown> = Promise.resolve()
let runResult: Promise<void> = new Promise<void>(() => {})
let closeResult: (worker: FakeWorker) => Promise<void> = async (worker) => {
  worker.emit("closed")
}

class FakeWorkerEmitter extends EventEmitter {
  readonly processor: (job: FakeJob) => Promise<unknown>
  readonly opts: FakeWorker["opts"]
  constructor(
    _name: string,
    processor: (job: FakeJob) => Promise<unknown>,
    opts: FakeWorker["opts"]
  ) {
    super()
    this.processor = processor
    this.opts = opts
    created.push(this)
  }
  waitUntilReady(): Promise<unknown> {
    return ready
  }
  run(): Promise<void> {
    return runResult
  }
  close(): Promise<void> {
    return closeResult(this)
  }
  cancelAllJobs(): void {}
  pause(): Promise<void> {
    return Promise.resolve()
  }
}

mock.module("bullmq", () => ({
  Worker: FakeWorkerEmitter,
  UnrecoverableError
}))

const { newBullMqJobQueue } = await import("../src/job/index")

type AddMode = "ok" | "exists" | "exists-string" | "blank" | "numeric" | "down"

interface Stored {
  state: string
  data: unknown
  getState(): Promise<string>
  remove(): Promise<void>
}

function versionLowerThan(current: string, minimum: string): boolean {
  const left = current.split(".")
  const right = minimum.split(".")
  const width = Math.max(left.length, right.length)
  for (let index = 0; index < width; index += 1) {
    const observed = Number(left[index] ?? 0)
    const required = Number(right[index] ?? 0)
    if (!Number.isInteger(observed) || !Number.isInteger(required)) return true
    if (observed < required) return true
    if (observed > required) return false
  }
  return false
}

function fakeQueue(name = "reports") {
  const calls: unknown[][] = []
  const jobs = new Map<string, Stored>()
  const scripts: string[] = []
  let mode: AddMode = "ok"
  const queue = {
    calls,
    jobs,
    scripts,
    redisVersion: "8.10.0",
    name,
    opts: { connection: { host: "127.0.0.1" }, prefix: "go-like" } as {
      connection?: { host: string }
      prefix?: string
      telemetry?: unknown
    },
    mode(next: AddMode) {
      mode = next
    },
    async add(jobName: string, data: unknown, opts?: { jobId?: string }) {
      calls.push(["add", jobName, data, opts])
      if (mode === "exists") throw new Error("Job id already exists")
      if (mode === "exists-string") throw "Job already exists"
      if (mode === "down") throw new Error("redis down")
      if (mode === "numeric") return { id: 1 }
      if (mode === "blank") return { id: "" }
      const id = opts?.jobId ?? `id-${calls.length}`
      const current = jobs.get(id)
      if (current !== undefined && current.state !== "completed" && current.state !== "failed") {
        return { id }
      }
      const stored: Stored = {
        state: "waiting",
        data,
        async getState() {
          return stored.state
        },
        async remove() {
          jobs.delete(id)
        }
      }
      jobs.set(id, stored)
      return { id }
    },
    keys: {
      "": `go-like:${name}:`,
      wait: `go-like:${name}:wait`,
      active: `go-like:${name}:active`,
      paused: `go-like:${name}:paused`,
      delayed: `go-like:${name}:delayed`,
      prioritized: `go-like:${name}:prioritized`,
      completed: `go-like:${name}:completed`,
      failed: `go-like:${name}:failed`,
      "waiting-children": `go-like:${name}:waiting-children`
    },
    client: Promise.resolve({
      async eval(script: string, _numKeys: number, _jobKey: string, ...rest: string[]) {
        scripts.push(script)
        if (versionLowerThan(queue.redisVersion, "6.0.6") && script.includes("LPOS")) {
          throw new Error("ERR unknown command 'LPOS'")
        }
        const id = rest[rest.length - 1] ?? ""
        const stored = jobs.get(id)
        if (stored === undefined) return 0
        if (stored.state === "completed" || stored.state === "failed") {
          jobs.delete(id)
          return 0
        }
        return 1
      }
    }),
    async getJob(id: string) {
      return jobs.get(id)
    },
    async waitUntilReady() {},
    async close() {
      calls.push(["close"])
    }
  }
  return queue
}

/** Opens a gate the test settles later. */
function gate<T = void>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("BullMQ job queue", () => {
  beforeEach(() => {
    created.splice(0)
    ready = Promise.resolve()
    runResult = new Promise<void>(() => {})
    closeResult = async (worker) => {
      worker.emit("closed")
    }
  })

  test("rejects a queue or option go-like does not own", () => {
    expect(() => newBullMqJobQueue(null as never)).toThrow("object")
    expect(() => newBullMqJobQueue({} as never)).toThrow("add and getJob")
    const surface = fakeQueue()
    expect(() =>
      newBullMqJobQueue({
        ...surface,
        getJob: undefined,
        waitUntilReady() {},
        close() {}
      } as never)
    ).toThrow("add and getJob")
    expect(() =>
      newBullMqJobQueue({ ...surface, waitUntilReady: undefined, close: undefined } as never)
    ).toThrow("waitUntilReady")
    expect(() => newBullMqJobQueue({ ...surface, opts: null } as never)).toThrow("options")
    expect(() => newBullMqJobQueue({ ...surface, opts: { telemetry: {} } } as never)).toThrow(
      "telemetry is owned"
    )
    expect(() => newBullMqJobQueue({ ...surface, name: "" } as never)).toThrow("well-formed")
    expect(() => newBullMqJobQueue({ ...surface, name: "\uD800" } as never)).toThrow("well-formed")
    expect(() => newBullMqJobQueue({ ...surface, name: "n".repeat(257) } as never)).toThrow("256")
    expect(() => newBullMqJobQueue({ ...surface, name: 1 } as never)).toThrow("well-formed")
    expect(() => newBullMqJobQueue(surface as never, null as never)).toThrow("object")
    expect(() => newBullMqJobQueue(surface as never, { telemetry: {} } as never)).toThrow("owned")
    expect(() => newBullMqJobQueue(surface as never, { extra: true } as never)).toThrow("owned")
    expect(() =>
      newBullMqJobQueue(surface as never, { worker: { connection: {} } } as never)
    ).toThrow("worker option connection")
    expect(() => newBullMqJobQueue(surface as never, { worker: null } as never)).toThrow(
      "worker options"
    )
    expect(newBullMqJobQueue(surface as never).string()).toBe("bullmq")
  })

  test("starts once, enqueues through the kit, and deduplicates unfinished ids", async () => {
    const queue = fakeQueue()
    const canceledQueue = newBullMqJobQueue(queue as never)
    const [canceled, cancel] = withCancelCause(background())
    const reason = new Error("queue canceled")
    cancel(reason)
    await expect(canceledQueue.start(canceled)).rejects.toBe(reason)
    await canceledQueue.stop(background())

    const racing = newBullMqJobQueue(queue as never)
    const readyGate = gate()
    queue.waitUntilReady = () => readyGate.promise
    const starting = racing.start(background())
    const stopping = racing.stop(background())
    readyGate.resolve()
    await starting
    await stopping
    expect(queue.calls.some((call) => call[0] === "close")).toBe(true)

    const idle = newBullMqJobQueue(fakeQueue() as never)
    await idle.stop(background())
    await expect(idle.start(background())).rejects.toMatchObject({ code: "GO_LIKE_JOB_STATE" })

    const broken = fakeQueue()
    broken.waitUntilReady = async () => {
      throw "not ready"
    }
    const failing = newBullMqJobQueue(broken as never)
    await expect(failing.start(background())).rejects.toBe("not ready")
    await expect(failing.start(background())).rejects.toMatchObject({ code: "GO_LIKE_JOB_STATE" })

    const jobs = newBullMqJobQueue(queue as never)
    queue.waitUntilReady = async () => {}
    await jobs.start(background())
    await expect(jobs.start(background())).rejects.toMatchObject({ code: "GO_LIKE_JOB_STATE" })
    await expect(jobs.enqueue(canceled, "work", { n: 1 })).rejects.toBe(reason)
    await expect(jobs.enqueue(background(), "", { n: 1 })).rejects.toThrow("well-formed")
    await expect(jobs.enqueue(background(), "work", { n: 1 }, { attempts: 0 })).rejects.toThrow()
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    await expect(jobs.enqueue(background(), "work", cycle)).rejects.toThrow("JSON")
    await expect(jobs.enqueue(background(), "work", (() => {}) as never)).rejects.toThrow("JSON")
    await expect(jobs.enqueue(background(), "work", Symbol("n") as never)).rejects.toThrow()
    expect(queue.calls.some((call) => call[0] === "add")).toBe(false)

    const propagated = withTelemetry(background(), newTelemetry({}))
    const remote = withRemoteSpanContext(propagated, {
      traceId: "fedcba9876543210fedcba9876543210",
      spanId: "fedcba9876543210",
      traceFlags: 1,
      traceState: "",
      isRemote: true
    })
    const traced = await jobs.enqueue(remote, "work", { n: 1 }, { id: "job-1", attempts: 3 })
    expect(traced.id).toBe("job-1")
    const added = queue.calls.find((call) => call[0] === "add")
    const options = added?.[3] as {
      attempts: number
      backoff: { type: string; delay: number }
      jobId: string
      telemetry: { metadata: string; omitContext: boolean }
    }
    expect(options.attempts).toBe(3)
    expect(options.backoff).toEqual({ type: "fixed", delay: 0 })
    expect(options.jobId).toBe("job-1")
    expect(options.telemetry.omitContext).toBe(true)
    expect(options.telemetry.metadata).toContain("fedcba9876543210fedcba9876543210")
    const duplicate = await jobs.enqueue(background(), "work", { n: 2 }, { id: "job-1" })
    expect(duplicate.id).toBe("job-1")
    expect(queue.calls.filter((call) => call[0] === "add")).toHaveLength(1)

    const stored = queue.jobs.get("job-1")
    if (stored === undefined) throw new Error("missing job")
    stored.state = "completed"
    const replaced = await jobs.enqueue(
      background(),
      "work",
      { n: 3 },
      { id: "job-1", backoff: { type: "exponential", delayMs: 30 } }
    )
    expect(replaced.id).toBe("job-1")
    const second = queue.calls.filter((call) => call[0] === "add").at(-1)?.[3] as {
      backoff: { type: string; delay: number }
    }
    expect(second.backoff).toEqual({ type: "exponential", delay: 30 })

    queue.mode("exists")
    await expect(jobs.enqueue(background(), "work", { n: 4 }, { id: "fresh" })).resolves.toEqual({
      id: "fresh"
    })
    queue.mode("exists-string")
    await expect(jobs.enqueue(background(), "work", { n: 5 }, { id: "other" })).rejects.toBe(
      "Job already exists"
    )
    queue.mode("down")
    await expect(jobs.enqueue(background(), "work", { n: 6 }, { id: "down" })).rejects.toThrow(
      "redis down"
    )
    queue.mode("blank")
    await expect(jobs.enqueue(background(), "work", { n: 7 }, { id: "kept" })).resolves.toEqual({
      id: "kept"
    })
    await expect(jobs.enqueue(background(), "work", { n: 8 })).rejects.toThrow("job id")
    queue.mode("numeric")
    await expect(jobs.enqueue(background(), "work", { n: 9 })).rejects.toThrow("job id")
    queue.mode("ok")

    queue.close = async () => {
      throw "nope"
    }
    await expect(jobs.stop(background())).rejects.toThrow("bullmq queue close failed")
    await expect(jobs.stop(background())).rejects.toThrow("bullmq queue close failed")
  })

  test("a worker records the job unit and maps permanent failures", async () => {
    const queue = fakeQueue()
    const jobs = newBullMqJobQueue(queue as never, { worker: { lockDuration: 1_000 } })
    await jobs.start(background())
    expect(() => jobs.worker({ work: 1 as never })).toThrow()
    const recorder = newTelemetryRecorder()
    const ctx = withTelemetry(background(), recorder.telemetry)
    let attempt = 0
    let seenTrace = ""
    const worker = jobs.worker(
      {
        work(jobCtx, job) {
          attempt = job.attempt
          seenTrace = spanFromContext(jobCtx).spanContext().traceId
          if (job.payload === "boom") {
            const error = new Error("handler-secret-text")
            error.name = "Boom"
            throw error
          }
          if (job.payload === "permanent")
            throw newPermanentJobError(new Error("handler-secret-text"))
          if (job.payload === "string") throw "nope"
          if (job.payload === "null") throw null
          if (job.payload === "undefined") throw undefined
          if (job.payload === "bad-message") {
            const error = new Error("secret")
            Object.defineProperty(error, "message", {
              get() {
                throw new Error("message threw")
              }
            })
            throw error
          }
          return job.payload
        }
      },
      { concurrency: 2 }
    )
    const running = worker.start(ctx)
    await Promise.resolve()
    const native = created[0]
    if (native === undefined) throw new Error("worker was not created")
    expect(native.opts.autorun).toBe(false)
    expect(native.opts.concurrency).toBe(2)
    expect(native.opts.prefix).toBe("go-like")
    expect(native.opts.lockDuration).toBe(1_000)

    const enqueued = await jobs.enqueue(ctx, "work", { n: 7 })
    const added = queue.calls.find((call) => call[0] === "add")
    const recorded = added?.[3] as { telemetry: { metadata: string } } | undefined
    if (recorded === undefined) throw new Error("enqueue was not recorded")
    const metadata = recorded.telemetry.metadata
    await expect(
      native.processor({
        name: "work",
        id: enqueued.id,
        data: { n: 7 },
        attemptsMade: 1,
        opts: { telemetry: { metadata } }
      })
    ).resolves.toEqual({ n: 7 })
    expect(attempt).toBe(2)
    const enqueueSpan = recorder.spans().find((span) => span.name === "enqueue work")
    const run = recorder.spans().find((span) => span.name === "run work")
    expect(enqueueSpan?.kind).toBe("producer")
    expect(enqueueSpan?.root).toBe(false)
    expect(enqueueSpan?.attributes[AttributeKey.jobSystem]).toBe("bullmq")
    expect(run?.kind).toBe("consumer")
    expect(run?.root).toBe(false)
    expect(run?.parent?.spanId).toBe(enqueueSpan?.context.spanId)
    expect(run?.links).toEqual([])
    expect(run?.status).toBe("unset")
    const traceId = enqueueSpan?.context.traceId
    expect(typeof traceId).toBe("string")
    if (typeof traceId === "string") expect(seenTrace).toBe(traceId)
    expect(
      recorder.measurements().some((item) => item.descriptor.name === MetricName.jobRunDuration)
    ).toBe(true)
    expect(recorder.measurements().some((item) => item.descriptor.name.includes("enqueue"))).toBe(
      false
    )
    expect(
      recorder.logs().find((item) => item.record.event === LogEvent.jobEnqueueCompleted)?.record
        .level
    ).toBe("debug")
    expect(
      recorder.logs().find((item) => item.record.event === LogEvent.jobRunCompleted)?.record.level
    ).toBe("info")

    for (const carrier of ["{", "[]", "null", "", "{}", '{"n":1}', '{"a":"b","c":1}']) {
      await expect(
        native.processor({
          name: "work",
          data: { n: 1 },
          attemptsMade: 0,
          opts: { telemetry: { metadata: carrier } }
        })
      ).resolves.toEqual({ n: 1 })
    }
    await expect(
      native.processor({
        name: "work",
        data: { n: 1 },
        attemptsMade: 0,
        opts: { telemetry: { metadata: 1 } }
      })
    ).resolves.toEqual({ n: 1 })
    await expect(
      native.processor({ name: "work", data: { n: 1 }, attemptsMade: 0 })
    ).resolves.toEqual({ n: 1 })

    await expect(
      native.processor({
        name: "work",
        data: "boom",
        attemptsMade: 0,
        opts: { telemetry: { metadata } }
      })
    ).rejects.toMatchObject({ name: "Boom" })
    const failed = recorder
      .spans()
      .find((span) => span.attributes[AttributeKey.errorType] === "Boom")
    expect(failed?.status).toBe("error")
    expect(
      recorder
        .logs()
        .some(
          (item) => item.record.event === LogEvent.jobRunCompleted && item.record.level === "error"
        )
    ).toBe(true)
    await expect(
      native.processor({ name: "missing", data: {}, attemptsMade: 0 })
    ).rejects.toMatchObject({ name: "UnrecoverableError", message: "JobUnknownNameError" })
    await expect(
      native.processor({ name: "work", data: "permanent", attemptsMade: 0 })
    ).rejects.toMatchObject({ name: "UnrecoverableError", message: "JobPermanentError" })
    await expect(
      native.processor({ name: "work", data: "string", attemptsMade: 0 })
    ).rejects.toMatchObject({
      message: "bullmq job handler failed",
      cause: "nope"
    })
    await expect(
      native.processor({ name: "work", data: "null", attemptsMade: 0 })
    ).rejects.toMatchObject({
      message: "bullmq job handler failed",
      cause: null
    })
    await expect(
      native.processor({ name: "work", data: "undefined", attemptsMade: 0 })
    ).rejects.toMatchObject({
      message: "bullmq job handler failed"
    })
    await expect(
      native.processor({ name: "work", data: "bad-message", attemptsMade: 0 })
    ).rejects.toMatchObject({
      message: "bullmq job handler failed"
    })
    const dumped = JSON.stringify({ spans: recorder.spans(), logs: recorder.logs() })
    expect(dumped.includes("handler-secret-text")).toBe(false)

    await worker.stop(background())
    await running
    await jobs.stop(background())
  })

  test("drains, reports unexpected exit, and rejects invalid worker operations", async () => {
    const queue = fakeQueue()
    const jobs = newBullMqJobQueue(queue as never)
    await jobs.start(background())
    const idle = jobs.worker({ work() {} })
    await idle.stop(background())
    await expect(idle.start(background())).rejects.toMatchObject({ code: "GO_LIKE_JOB_STATE" })

    const [canceled, cancel] = withCancelCause(background())
    cancel(new Error("worker canceled"))
    const refused = jobs.worker({ work() {} })
    await expect(refused.start(canceled)).rejects.toThrow("worker canceled")
    await expect(refused.start(background())).rejects.toMatchObject({ code: "GO_LIKE_JOB_STATE" })

    const readyGate = gate()
    ready = readyGate.promise
    const racing = jobs.worker({ work() {} })
    const racingRun = racing.start(background())
    const racingStop = racing.stop(background())
    readyGate.resolve()
    await racingStop
    await racingRun

    const hungReady = gate()
    const hungClose = gate<void>()
    ready = hungReady.promise
    closeResult = () => hungClose.promise
    const blocked = jobs.worker({ work() {} })
    const blockedRun = blocked.start(background())
    hungReady.reject(new Error("redis down"))
    await Promise.resolve()
    await Promise.resolve()
    hungClose.reject(new Error("close during start"))
    const blockedStarted = await blockedRun.then(
      () => null,
      (error: unknown) => error
    )
    expect(blockedStarted).toBeInstanceOf(AggregateError)
    if (blockedStarted instanceof AggregateError) {
      expect(blockedStarted.message).toBe("redis down")
      expect(
        blockedStarted.errors.map((error: unknown) => (error instanceof Error ? error.message : ""))
      ).toEqual(["redis down", "close during start"])
    }
    await expect(blocked.start(background())).rejects.toMatchObject({ code: "GO_LIKE_JOB_STATE" })

    ready = Promise.reject(new Error("redis down"))
    closeResult = async (worker) => {
      worker.emit("closed")
    }
    const rolled = jobs.worker({ work() {} })
    await expect(rolled.start(background())).rejects.toThrow("redis down")

    ready = Promise.resolve()
    closeResult = async (worker) => {
      worker.emit("closed")
    }
    const runGate = gate<void>()
    runResult = runGate.promise
    const exiting = jobs.worker({ work() {} })
    const exitingRun = exiting.start(background())
    await Promise.resolve()
    created.at(-1)?.emit("error", new Error("recoverable redis error"))
    created.at(-1)?.emit("closed")
    runGate.reject(new Error("run failed"))
    await expect(exitingRun).rejects.toMatchObject({
      code: "GO_LIKE_BULLMQ_UNEXPECTED_EXIT",
      queueName: "reports"
    })
    await exiting.stop(background())

    const failure = gate<void>()
    runResult = failure.promise
    const replacement = jobs.worker({ work() {} })
    const replacementRun = replacement.start(background())
    await Promise.resolve()
    failure.reject(new Error("run failed"))
    await expect(replacementRun).rejects.toThrow("run failed")
    await replacement.stop(background())

    runResult = new Promise<void>(() => {})
    closeResult = async () => {
      throw new Error("worker close failed")
    }
    const closing = jobs.worker({ work() {} })
    const closingRun = closing.start(background())
    await Promise.resolve()
    const stopped = await closing.stop(background()).then(
      () => null,
      (error: unknown) => error
    )
    const started = await closingRun.then(
      () => null,
      (error: unknown) => error
    )
    expect(stopped).toBeInstanceOf(Error)
    expect(started).toBeInstanceOf(Error)
    if (stopped instanceof Error) expect(stopped.message).toBe("worker close failed")
    if (started instanceof Error) expect(started.message).toBe("worker close failed")

    runResult = new Promise<void>(() => {})
    closeResult = async (worker) => {
      worker.emit("error", new Error("cleanup failed"))
      worker.emit("closed")
    }
    const cleanup = jobs.worker({ work() {} })
    const cleanupRun = cleanup.start(background())
    await Promise.resolve()
    const cleanupStopped = await cleanup.stop(background()).then(
      () => null,
      (error: unknown) => error
    )
    const cleanupStarted = await cleanupRun.then(
      () => null,
      (error: unknown) => error
    )
    expect(cleanupStopped).toBeInstanceOf(Error)
    expect(cleanupStarted).toBeInstanceOf(Error)
    if (cleanupStopped instanceof Error) expect(cleanupStopped.message).toBe("cleanup failed")
    if (cleanupStarted instanceof Error) expect(cleanupStarted.message).toBe("cleanup failed")

    const runAndClose = gate<void>()
    runResult = runAndClose.promise
    closeResult = async () => {
      throw new Error("close after run")
    }
    const both = jobs.worker({ work() {} })
    const bothRun = both.start(background())
    await Promise.resolve()
    runAndClose.reject(new Error("run failed"))
    const bothStarted = await bothRun.then(
      () => null,
      (error: unknown) => error
    )
    expect(bothStarted).toBeInstanceOf(AggregateError)
    if (bothStarted instanceof AggregateError) {
      expect(bothStarted.message).toBe("run failed")
      expect(
        bothStarted.errors.map((error: unknown) => (error instanceof Error ? error.message : ""))
      ).toEqual(["run failed", "close after run"])
    }
    await expect(both.stop(background())).rejects.toThrow("close after run")

    runResult = new Promise<void>(() => {})
    const release = gate<void>()
    closeResult = () => release.promise
    let entered = false
    let canceledRun = false
    const slow = jobs.worker(
      {
        async work(jobCtx) {
          entered = true
          while (jobCtx.err() === null) await Bun.sleep(5)
          canceledRun = true
        }
      },
      { drainTimeoutMs: 0 }
    )
    const slowRun = slow.start(background())
    await Promise.resolve()
    const native = created.at(-1)
    if (native === undefined) throw new Error("slow worker missing")
    const delivery = native.processor({ name: "work", data: { n: 1 }, attemptsMade: 0 })
    const deadline = Date.now() + 1_000
    while (!entered) {
      if (Date.now() > deadline) throw new Error("handler did not start")
      await Bun.sleep(5)
    }
    await expect(slow.stop(background())).rejects.toMatchObject({
      code: "GO_LIKE_JOB_DRAIN_TIMEOUT"
    })
    await delivery
    expect(canceledRun).toBe(true)
    release.resolve()
    await expect(slowRun).rejects.toMatchObject({ code: "GO_LIKE_JOB_DRAIN_TIMEOUT" })
    await jobs.stop(background())
  })

  test("a second producer does not delete an unfinished replacement", async () => {
    const queue = fakeQueue()
    const first = newBullMqJobQueue(queue as never)
    const second = newBullMqJobQueue(queue as never)
    await first.start(background())
    await second.start(background())
    queue.jobs.set("same", {
      state: "completed",
      data: "old",
      async getState() {
        return "completed"
      },
      async remove() {
        queue.jobs.delete("same")
      }
    })
    await Promise.all([
      first.enqueue(background(), "work", "A", { id: "same" }),
      second.enqueue(background(), "work", "B", { id: "same" })
    ])
    const survivor = queue.jobs.get("same")
    expect(survivor?.state).toBe("waiting")
    expect(survivor?.data === "A" || survivor?.data === "B").toBe(true)
    await first.enqueue(background(), "work", "C", { id: "same" })
    expect(queue.jobs.get("same")?.data).toBe(survivor?.data)
    await first.stop(background())
    await second.stop(background())
  })

  test("an identified enqueue requires the queue Redis client and keys", async () => {
    const hidden = {
      name: "reports",
      opts: {},
      async add() {
        return { id: "unused" }
      },
      async getJob() {
        return null
      },
      async waitUntilReady() {},
      async close() {}
    }
    const jobs = newBullMqJobQueue(hidden as never)
    await jobs.start(background())
    await expect(jobs.enqueue(background(), "work", "A", { id: "same" })).rejects.toThrow(
      "bullmq queue must expose its Redis client and keys"
    )
    await jobs.stop(background())
  })

  test("an identified enqueue uses the backend Redis client", async () => {
    const queue = fakeQueue()
    const surface = {
      name: queue.name,
      opts: queue.opts,
      keys: queue.keys,
      jobs: queue.jobs,
      async add(jobName: string, data: unknown, opts?: { jobId?: string }) {
        return queue.add(jobName, data, opts)
      },
      async getJob(id: string) {
        return queue.getJob(id)
      },
      async waitUntilReady() {},
      async close() {},
      getBackend() {
        return { client: queue.client, keys: queue.keys }
      }
    }
    const jobs = newBullMqJobQueue(surface as never)
    await jobs.start(background())
    await jobs.enqueue(background(), "work", "A", { id: "backend" })
    expect(queue.jobs.get("backend")?.state).toBe("waiting")
    expect(queue.jobs.get("backend")?.data).toBe("A")
    await jobs.stop(background())
  })

  test("a failed worker stop honors drainTimeoutMs when close hangs", async () => {
    const queue = fakeQueue()
    const jobs = newBullMqJobQueue(queue as never)
    await jobs.start(background())
    const hungReady = gate()
    const hungClose = gate<void>()
    let closeStarted = false
    ready = hungReady.promise
    closeResult = () => {
      closeStarted = true
      return hungClose.promise
    }
    const worker = jobs.worker({ work() {} }, { drainTimeoutMs: 0 })
    const starting = worker.start(background())
    void starting.catch(() => {})
    hungReady.reject(new Error("redis down"))
    const deadline = Date.now() + 1_000
    while (!closeStarted) {
      if (Date.now() > deadline) throw new Error("close did not start")
      await Bun.sleep(5)
    }
    let stopError: unknown
    try {
      stopError = await Promise.race([
        worker.stop(background()).then(
          () => "resolved",
          (error: unknown) => error
        ),
        Bun.sleep(300).then(() => "hung")
      ])
    } finally {
      hungClose.resolve()
    }
    expect(stopError).toMatchObject({ code: "GO_LIKE_JOB_DRAIN_TIMEOUT" })
    await expect(starting).rejects.toThrow("redis down")
    await jobs.stop(background())
  })

  test("stop waits for an active processor when close resolves early", async () => {
    const queue = fakeQueue()
    const jobs = newBullMqJobQueue(queue as never)
    await jobs.start(background())
    const release = gate<void>()
    let entered = false
    let stopSettled = false
    const disconnect = new Error("blocking disconnect failed")
    closeResult = async (worker) => {
      worker.emit("error", disconnect)
      worker.emit("closed")
    }
    const worker = jobs.worker(
      {
        async work() {
          entered = true
          await release.promise
        }
      },
      { drainTimeoutMs: 5_000 }
    )
    const running = worker.start(background())
    void running.catch(() => {})
    await Promise.resolve()
    const native = created.at(-1)
    if (native === undefined) throw new Error("missing worker")
    const delivery = native.processor({ name: "work", data: { n: 1 }, attemptsMade: 0 })
    void delivery.catch(() => {})
    const deadline = Date.now() + 1_000
    while (!entered) {
      if (Date.now() > deadline) throw new Error("handler did not start")
      await Bun.sleep(5)
    }
    const stopping = worker.stop(background())
    void stopping.then(
      () => {
        stopSettled = true
      },
      () => {
        stopSettled = true
      }
    )
    await Bun.sleep(40)
    expect(stopSettled).toBe(false)
    release.resolve()
    await delivery
    await expect(stopping).rejects.toBe(disconnect)
    await expect(running).rejects.toBe(disconnect)
    await jobs.stop(background())
  })

  test("one close failure keeps its Error identity", async () => {
    const queue = fakeQueue()
    const jobs = newBullMqJobQueue(queue as never)
    await jobs.start(background())
    const cleanup = new Error("cleanup failed")
    runResult = new Promise<void>(() => {})
    closeResult = async (worker) => {
      worker.emit("error", cleanup)
      worker.emit("closed")
    }
    const worker = jobs.worker({ work() {} })
    const running = worker.start(background())
    void running.catch(() => {})
    await Promise.resolve()
    await expect(worker.stop(background())).rejects.toBe(cleanup)
    await expect(running).rejects.toBe(cleanup)
    await jobs.stop(background())
  })

  test("close keeps every error event and a following rejection", async () => {
    const queue = fakeQueue()
    const jobs = newBullMqJobQueue(queue as never)
    await jobs.start(background())
    const first = new Error("first close")
    const second = new Error("second close")
    runResult = new Promise<void>(() => {})
    closeResult = async (worker) => {
      worker.emit("error", first)
      worker.emit("error", second)
      worker.emit("closed")
    }
    const repeated = jobs.worker({ work() {} })
    const repeatedRun = repeated.start(background())
    void repeatedRun.catch(() => {})
    await Promise.resolve()
    const repeatedFailure = await repeated.stop(background()).then(
      () => null,
      (error: unknown) => error
    )
    expect(repeatedFailure).toBeInstanceOf(AggregateError)
    if (repeatedFailure instanceof AggregateError) {
      expect(repeatedFailure.errors).toEqual([first, second])
      expect(repeatedFailure.message).toBe(first.message)
    }
    await expect(repeatedRun).rejects.toBe(repeatedFailure)

    const emitted = new Error("emitted during close")
    const rejected = new Error("close rejected")
    closeResult = async (worker) => {
      worker.emit("error", emitted)
      throw rejected
    }
    const followed = jobs.worker({ work() {} })
    const followedRun = followed.start(background())
    void followedRun.catch(() => {})
    await Promise.resolve()
    const followedFailure = await followed.stop(background()).then(
      () => null,
      (error: unknown) => error
    )
    expect(followedFailure).toBeInstanceOf(AggregateError)
    if (followedFailure instanceof AggregateError) {
      expect(followedFailure.errors).toEqual([emitted, rejected])
      expect(followedFailure.message).toBe(emitted.message)
    }
    await expect(followedRun).rejects.toBe(followedFailure)
    await jobs.stop(background())
  })

  test("a drain timeout keeps a later cleanup failure", async () => {
    const queue = fakeQueue()
    const jobs = newBullMqJobQueue(queue as never)
    await jobs.start(background())
    const cleanup = new Error("cleanup after timeout")
    const release = gate<void>()
    runResult = new Promise<void>(() => {})
    closeResult = async (worker) => {
      await release.promise
      worker.emit("error", cleanup)
      worker.emit("closed")
    }
    const worker = jobs.worker({ work() {} }, { drainTimeoutMs: 0 })
    const running = worker.start(background())
    void running.catch(() => {})
    await Promise.resolve()
    const stopError = await worker.stop(background()).then(
      () => null,
      (error: unknown) => error
    )
    expect(stopError).toMatchObject({ code: "GO_LIKE_JOB_DRAIN_TIMEOUT" })
    release.resolve()
    const started = await running.then(
      () => null,
      (error: unknown) => error
    )
    expect(started).toBeInstanceOf(AggregateError)
    if (started instanceof AggregateError) {
      expect(started.errors[0]).toBe(stopError)
      expect(started.errors[1]).toBe(cleanup)
    }
    await jobs.stop(background())
  })

  test("a drain timeout keeps every later close error", async () => {
    const queue = fakeQueue()
    const jobs = newBullMqJobQueue(queue as never)
    await jobs.start(background())
    const first = new Error("first cleanup")
    const second = new Error("second cleanup")
    const release = gate<void>()
    runResult = new Promise<void>(() => {})
    closeResult = async (worker) => {
      await release.promise
      worker.emit("error", first)
      worker.emit("error", second)
      worker.emit("closed")
    }
    const worker = jobs.worker({ work() {} }, { drainTimeoutMs: 0 })
    const running = worker.start(background())
    void running.catch(() => {})
    await Promise.resolve()
    const stopError = await worker.stop(background()).then(
      () => null,
      (error: unknown) => error
    )
    expect(stopError).toMatchObject({ code: "GO_LIKE_JOB_DRAIN_TIMEOUT" })
    release.resolve()
    const started = await running.then(
      () => null,
      (error: unknown) => error
    )
    expect(started).toBeInstanceOf(AggregateError)
    if (started instanceof AggregateError) {
      expect(started.errors).toEqual([stopError, first, second])
      expect(started.message).toBe(
        stopError instanceof Error ? stopError.message : "missing drain timeout"
      )
    }
    await jobs.stop(background())
  })

  test("terminal id replacement works below and above the LPOS Redis version", async () => {
    for (const version of ["5.0.0", "6.0.5", "6.0", "not-a-version"] as const) {
      const queue = fakeQueue()
      queue.redisVersion = version
      queue.jobs.set("same", {
        state: "completed",
        data: "old",
        async getState() {
          return "completed"
        },
        async remove() {
          queue.jobs.delete("same")
        }
      })
      const jobs = newBullMqJobQueue(queue as never)
      await jobs.start(background())
      await jobs.enqueue(background(), "work", "A", { id: "same" })
      const script = queue.scripts.at(-1) ?? ""
      expect(script.includes("LPOS")).toBe(false)
      expect(script.includes("LRANGE")).toBe(true)
      expect(queue.jobs.get("same")?.data).toBe("A")
      queue.jobs.set("live", {
        state: "active",
        data: "kept",
        async getState() {
          return "active"
        },
        async remove() {
          queue.jobs.delete("live")
        }
      })
      await jobs.enqueue(background(), "work", "B", { id: "live" })
      expect(queue.jobs.get("live")?.data).toBe("kept")
      await jobs.stop(background())
    }

    const modern = fakeQueue()
    modern.redisVersion = "6.0.6"
    modern.jobs.set("same", {
      state: "completed",
      data: "old",
      async getState() {
        return "completed"
      },
      async remove() {
        modern.jobs.delete("same")
      }
    })
    const jobs = newBullMqJobQueue(modern as never)
    await jobs.start(background())
    await jobs.enqueue(background(), "work", "A", { id: "same" })
    const script = modern.scripts.at(-1) ?? ""
    expect(script.includes("LPOS")).toBe(true)
    expect(modern.jobs.get("same")?.data).toBe("A")
    await jobs.stop(background())

    const hidden = fakeQueue()
    hidden.redisVersion = "5.0.0"
    const surface = {
      name: hidden.name,
      opts: hidden.opts,
      async add(jobName: string, data: unknown, opts?: { jobId?: string }) {
        return hidden.add(jobName, data, opts)
      },
      async getJob(id: string) {
        return hidden.getJob(id)
      },
      async waitUntilReady() {},
      async close() {},
      getBackend() {
        return { client: hidden.client, keys: hidden.keys, redisVersion: "5.0.0" }
      }
    }
    hidden.jobs.set("backend", {
      state: "failed",
      data: "old",
      async getState() {
        return "failed"
      },
      async remove() {
        hidden.jobs.delete("backend")
      }
    })
    const backendJobs = newBullMqJobQueue(surface as never)
    await backendJobs.start(background())
    await backendJobs.enqueue(background(), "work", "C", { id: "backend" })
    expect(hidden.scripts.at(-1)?.includes("LPOS")).toBe(false)
    expect(hidden.jobs.get("backend")?.data).toBe("C")
    await backendJobs.stop(background())
  })

  test("a foreign startup aggregate is returned by identity", async () => {
    const queue = fakeQueue()
    const jobs = newBullMqJobQueue(queue as never)
    await jobs.start(background())
    const foreign = new AggregateError(
      [new Error("connect ECONNREFUSED ::1"), new Error("connect ECONNREFUSED 127.0.0.1")],
      "connect ECONNREFUSED"
    )
    const readyGate = gate()
    ready = readyGate.promise
    const worker = jobs.worker({ work() {} })
    const starting = worker.start(background())
    void starting.catch(() => {})
    readyGate.reject(foreign)
    await expect(starting).rejects.toBe(foreign)
    await jobs.stop(background())
  })

  test("a foreign close aggregate is returned by identity", async () => {
    const queue = fakeQueue()
    const jobs = newBullMqJobQueue(queue as never)
    await jobs.start(background())
    const foreign = new AggregateError(
      [new Error("connect ECONNREFUSED 127.0.0.1")],
      "connect ECONNREFUSED"
    )
    closeResult = async () => {
      throw foreign
    }
    const worker = jobs.worker({ work() {} })
    const running = worker.start(background())
    void running.catch(() => {})
    await Promise.resolve()
    await expect(worker.stop(background())).rejects.toBe(foreign)
    await expect(running).rejects.toBe(foreign)
    await jobs.stop(background())
  })

  test("a foreign aggregate stays first when cleanup also fails", async () => {
    const queue = fakeQueue()
    const jobs = newBullMqJobQueue(queue as never)
    await jobs.start(background())
    const foreign = new AggregateError(
      [new Error("connect ECONNREFUSED ::1"), new Error("connect ECONNREFUSED 127.0.0.1")],
      "connect ECONNREFUSED"
    )
    const cleanup = new Error("close failed")
    const readyGate = gate()
    ready = readyGate.promise
    closeResult = async () => {
      throw cleanup
    }
    const worker = jobs.worker({ work() {} })
    const starting = worker.start(background())
    void starting.catch(() => {})
    readyGate.reject(foreign)
    const failure = await starting.then(
      () => null,
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(AggregateError)
    if (failure instanceof AggregateError) {
      expect(failure.errors).toEqual([foreign, cleanup])
      expect(failure.message).toBe(foreign.message)
    }
    await jobs.stop(background())
  })

  test("a plug aggregate flattens without duplicating an error", async () => {
    const queue = fakeQueue()
    const jobs = newBullMqJobQueue(queue as never)
    await jobs.start(background())
    const primary = new Error("run failed")
    const extra = new Error("extra close")
    const runGate = gate<void>()
    runResult = runGate.promise
    closeResult = async (worker) => {
      worker.emit("error", primary)
      worker.emit("error", extra)
      worker.emit("error", primary)
      worker.emit("closed")
    }
    const worker = jobs.worker({ work() {} })
    const running = worker.start(background())
    void running.catch(() => {})
    await Promise.resolve()
    runGate.reject(primary)
    const failure = await running.then(
      () => null,
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(AggregateError)
    if (failure instanceof AggregateError) {
      expect(failure.errors).toEqual([primary, extra])
    }
    await jobs.stop(background())
  })
})
