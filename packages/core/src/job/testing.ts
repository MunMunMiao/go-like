/**
 * Job conformance suites.
 * Callers run the returned cases. Cases may be added in a minor release.
 */
import { background, withCancel, withCancelCause } from "../context/index"
import type { Server } from "../lifecycle/index"
import { newTelemetry, withTelemetry } from "../telemetry/index"
import { withRemoteSpanContext } from "../telemetry/provider"
import { AttributeKey, LogEvent, MetricName, SemconvValue } from "../telemetry/semconv"
import { inSpan, spanFromContext } from "../trace/index"
import type { ConformanceCase } from "../testing/case"
import { newTelemetryRecorder } from "../testing/recorder"

import {
  newIntervalSchedule,
  newPermanentJobError,
  newScheduleServer,
  type Job,
  type JobQueue,
  type Schedule
} from "./index"
import type {
  JobConformancePayload,
  JobQueueConformanceSubject,
  JobTelemetrySubject
} from "./testing-types"

export type {
  JobConformancePayload,
  JobQueueConformanceSubject,
  JobTelemetrySubject
} from "./testing-types"

/** Throws when a conformance assertion fails. */
function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Observes either settlement of an owner operation. */
function settled(): undefined {
  return undefined
}

/** Waits for a wall-clock gap. */
async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Waits until `predicate` holds or the bound expires. */
async function until(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(message)
    await sleep(10)
  }
}

/** Returns the rejection, or throws when the operation fulfills. */
async function rejection(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation
  } catch (error) {
    return error
  }
  throw new Error("job operation fulfilled")
}

/** Reads the stable job error code. */
function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return ""
  const code = (error as { readonly code?: unknown }).code
  return typeof code === "string" ? code : ""
}

/** Rejects a queue subject that cannot host the suite. */
function captureQueue(subject: JobQueueConformanceSubject): JobQueueConformanceSubject & {
  readonly timeoutMs: number
} {
  if (
    typeof subject !== "object" ||
    subject === null ||
    typeof subject.newQueue !== "function" ||
    typeof subject.close !== "function"
  ) {
    throw new TypeError("job queue conformance subject is invalid")
  }
  return {
    timeoutMs: subject.timeoutMs ?? 10_000,
    newQueue: (ctx) => subject.newQueue(ctx),
    close: (ctx) => subject.close(ctx)
  }
}

let suiteTimeoutMs = 10_000

/** Timeout errors created by this suite. A provider error is never a member. */
const suiteBounds = new WeakSet<Error>()

/** Reports the suite's own bound, which must not replace a contract failure. */
function isBounded(error: unknown): boolean {
  return error instanceof Error && suiteBounds.has(error)
}

/** Keeps one observed failure. Null and undefined are real rejections. */
function remember(failures: unknown[], error: unknown): void {
  failures.push(error)
}

/** Throws one original failure, or an aggregate whose first error is the primary failure. */
function throwFailures(failures: readonly unknown[]): void {
  if (failures.length === 0) return
  const first = failures[0]
  if (failures.length === 1) throw first
  const message = first instanceof Error ? first.message : "job conformance failed"
  throw new AggregateError(failures, message, {
    cause: first instanceof Error ? first : undefined
  })
}

/** Observes settlement without letting a rejection escape this helper. */
async function capture<T>(
  operation: Promise<T>
): Promise<
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }
> {
  try {
    return { ok: true, value: await operation }
  } catch (error) {
    return { ok: false, error }
  }
}

/** Rejects when an operation stays pending past the suite bound. */
function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutError = new Error("bounded-rejection")
  suiteBounds.add(timeoutError)
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(timeoutError)
    }, timeoutMs)
  })
  return Promise.race([operation, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/** Opens one queue and always closes it. */
async function usingQueue(
  subject: JobQueueConformanceSubject & { readonly timeoutMs: number },
  run: (queue: JobQueue<JobConformancePayload>, timeoutMs: number) => Promise<void>
): Promise<void> {
  const ctx = background()
  const limit = subject.timeoutMs
  suiteTimeoutMs = limit
  const failures: unknown[] = []
  let queue: JobQueue<JobConformancePayload> | undefined
  try {
    queue = await bounded(subject.newQueue(ctx), limit)
  } catch (error) {
    remember(failures, error)
  }
  if (queue !== undefined) {
    const operation = run(queue, limit)
    const first = await capture(bounded(operation, limit))
    if (!first.ok) {
      const finished = await capture(bounded(operation, limit))
      if (!finished.ok) {
        const reported =
          isBounded(first.error) && !isBounded(finished.error) ? finished.error : first.error
        remember(failures, reported)
      }
    }
  }
  try {
    await bounded(subject.close(ctx), limit)
  } catch (error) {
    remember(failures, error)
  }
  throwFailures(failures)
}

/** Starts one worker and stops it when `run` settles. Stop and the runtime share the suite bound. */
async function usingWorker(
  queue: JobQueue<JobConformancePayload>,
  handlers: Parameters<JobQueue<JobConformancePayload>["worker"]>[0],
  options: Parameters<JobQueue<JobConformancePayload>["worker"]>[1],
  run: (worker: Server, running: Promise<void>) => Promise<void>
): Promise<void> {
  const worker = queue.worker(handlers, options)
  const running = worker.start(background())
  const startFailure = new Promise<never>((_resolve, reject) => {
    void running.then(
      () => {},
      (error: unknown) => {
        reject(error)
      }
    )
  })
  const body = run(worker, running)
  void body.catch(() => {})
  void startFailure.catch(() => {})
  const failures: unknown[] = []
  try {
    await bounded(Promise.race([body, startFailure]), suiteTimeoutMs)
  } catch (error) {
    remember(failures, error)
  }
  try {
    await bounded(worker.stop(background()), suiteTimeoutMs)
  } catch (error) {
    remember(failures, error)
  }
  try {
    await bounded(running, suiteTimeoutMs)
  } catch (error) {
    if (!failures.includes(error)) remember(failures, error)
  }
  throwFailures(failures)
}

/** Builds the portable JobQueue suite. */
export function jobQueueConformance(
  subject: JobQueueConformanceSubject
): readonly ConformanceCase[] {
  const selected = captureQueue(subject)
  return Object.freeze([
    Object.freeze({
      name: "handler sees the name payload attempt and id",
      /** Enqueues one job and reads the delivery. */
      async run(): Promise<void> {
        await usingQueue(selected, async (queue, timeoutMs) => {
          ensure(queue.string() === queue.string() && queue.string().length > 0, "string()")
          let fulfilled = false
          try {
            await rejection(Promise.resolve())
          } catch (error) {
            fulfilled = error instanceof Error
          }
          ensure(fulfilled, "a completed enqueue is not reported as a rejection")
          const seen: Job<JobConformancePayload>[] = []
          await usingWorker(
            queue,
            {
              /** Records the only delivery. */
              work(_ctx, job) {
                seen.push(job)
              }
            },
            undefined,
            async () => {
              const enqueued = await queue.enqueue(background(), "work", { n: 7 }, { id: "job-7" })
              ensure(enqueued.id === "job-7", "enqueue did not keep the caller id")
              await until(() => seen.length === 1, timeoutMs, "job was not delivered")
              const job = seen[0]
              ensure(job !== undefined, "missing job")
              ensure(job.name === "work" && job.queue === queue.name, "job identity")
              ensure(job.id === "job-7" && job.attempt === 1 && job.payload.n === 7, "job fields")
            }
          )
        })
      }
    }),
    Object.freeze({
      name: "an unfinished id is not enqueued twice",
      /** Holds the first job and checks a second enqueue with the same id is deduplicated. */
      async run(): Promise<void> {
        await usingQueue(selected, async (queue, timeoutMs) => {
          let release!: () => void
          const gate = new Promise<void>((resolve) => {
            release = resolve
          })
          const seen: number[] = []
          let finished = false
          await usingWorker(
            queue,
            {
              /** Blocks the first delivery. */
              async work(_ctx, job) {
                seen.push(job.payload.n)
                if (job.payload.n === 1) await gate
                if (job.payload.n === 1) finished = true
              }
            },
            undefined,
            async () => {
              try {
                const first = await queue.enqueue(background(), "work", { n: 1 }, { id: "same" })
                await until(() => seen.length === 1, timeoutMs, "first job did not start")
                const second = await queue.enqueue(background(), "work", { n: 2 }, { id: "same" })
                ensure(second.id === first.id, "unfinished id was not deduplicated")
                await sleep(40)
                ensure(seen.length === 1 && seen[0] === 1, "deduplicated id ran twice")
                release()
                await until(() => finished, timeoutMs, "first job did not finish")
                await queue.enqueue(background(), "work", { n: 3 }, { id: "same" })
                await until(() => seen.includes(3), timeoutMs, "finished id was not reusable")
              } finally {
                release()
              }
            }
          )
        })
      }
    }),
    Object.freeze({
      name: "retries follow the attempt count and backoff",
      /** Records attempt numbers and the delay before each retry. */
      async run(): Promise<void> {
        await usingQueue(selected, async (queue, timeoutMs) => {
          const attempts: number[] = []
          const times: number[] = []
          await usingWorker(
            queue,
            {
              /** Fails the first two attempts. */
              work(_ctx, job) {
                attempts.push(job.attempt)
                times.push(Date.now())
                if (job.attempt < 3) throw new Error("retry")
              }
            },
            undefined,
            async () => {
              await queue.enqueue(
                background(),
                "work",
                { n: 1 },
                {
                  attempts: 3,
                  backoff: { type: "fixed", delayMs: 30 }
                }
              )
              await until(() => attempts.length === 3, timeoutMs, "fixed retries did not finish")
              ensure(attempts.join(",") === "1,2,3", "attempt numbers")
              const firstGap = (times[1] ?? 0) - (times[0] ?? 0)
              const secondGap = (times[2] ?? 0) - (times[1] ?? 0)
              ensure(firstGap >= 20 && secondGap >= 20, "fixed backoff was shorter than delayMs")
            }
          )
          const exponential: number[] = []
          await usingWorker(
            queue,
            {
              /** Fails until the third attempt and records delays. */
              work(_ctx, job) {
                exponential.push(Date.now())
                if (job.attempt < 3) throw new Error("retry")
              }
            },
            undefined,
            async () => {
              await queue.enqueue(
                background(),
                "work",
                { n: 1 },
                {
                  attempts: 3,
                  backoff: { type: "exponential", delayMs: 30 }
                }
              )
              await until(
                () => exponential.length === 3,
                timeoutMs,
                "exponential retries did not finish"
              )
              const firstGap = (exponential[1] ?? 0) - (exponential[0] ?? 0)
              const secondGap = (exponential[2] ?? 0) - (exponential[1] ?? 0)
              ensure(firstGap >= 20, "exponential first delay")
              ensure(secondGap >= 50 && secondGap > firstGap, "exponential delay did not grow")
            }
          )
        })
      }
    }),
    Object.freeze({
      name: "an unknown name and a permanent error are not retried",
      /** Reuses the id after each terminal failure. */
      async run(): Promise<void> {
        await usingQueue(selected, async (queue, timeoutMs) => {
          const seen: string[] = []
          await usingWorker(
            queue,
            {
              /** Records jobs that have a handler. */
              work(_ctx, job) {
                seen.push(`${job.name}:${job.id}`)
              }
            },
            undefined,
            async () => {
              await queue.enqueue(background(), "missing", { n: 1 }, { id: "unknown", attempts: 4 })
              await until(
                async () => {
                  await queue.enqueue(background(), "work", { n: 1 }, { id: "unknown" })
                  return seen.includes("work:unknown")
                },
                timeoutMs,
                "unknown name kept the id"
              )
            }
          )
          const permanent: string[] = []
          await usingWorker(
            queue,
            {
              /** Declares a permanent failure once, then accepts the reused id. */
              work(_ctx, job) {
                permanent.push(`${job.attempt}:${job.payload.n}`)
                if (job.payload.n === 1) throw newPermanentJobError(new Error("permanent-secret"))
              }
            },
            undefined,
            async () => {
              await queue.enqueue(
                background(),
                "work",
                { n: 1 },
                { id: "permanent-2", attempts: 4 }
              )
              await until(
                async () => {
                  await queue.enqueue(background(), "work", { n: 2 }, { id: "permanent-2" })
                  return permanent.some((item) => item.endsWith(":2"))
                },
                timeoutMs,
                "permanent error kept the id"
              )
              ensure(
                permanent.filter((item) => item === "1:1").length === 1,
                "permanent error was retried"
              )
              ensure(
                !permanent.some((item) => item.startsWith("2:")),
                "permanent error used a later attempt"
              )
            }
          )
        })
      }
    }),
    Object.freeze({
      name: "a handler failure does not stop the worker",
      /** Fails one job and then runs another. */
      async run(): Promise<void> {
        await usingQueue(selected, async (queue, timeoutMs) => {
          const seen: number[] = []
          await usingWorker(
            queue,
            {
              /** Fails payload 1 and records payload 2. */
              work(_ctx, job) {
                if (job.payload.n === 1) throw new Error("once")
                seen.push(job.payload.n)
              }
            },
            undefined,
            async () => {
              await queue.enqueue(background(), "work", { n: 1 })
              await queue.enqueue(background(), "work", { n: 2 })
              await until(
                () => seen.includes(2),
                timeoutMs,
                "worker stopped after a handler failure"
              )
            }
          )
        })
      }
    }),
    Object.freeze({
      name: "concurrency bounds active runs",
      /** Holds two runs and checks a third waits. */
      async run(): Promise<void> {
        await usingQueue(selected, async (queue, timeoutMs) => {
          let entered = 0
          let release!: () => void
          const gate = new Promise<void>((resolve) => {
            release = resolve
          })
          await usingWorker(
            queue,
            {
              /** Counts entries and waits. */
              async work() {
                entered += 1
                await gate
              }
            },
            { concurrency: 2 },
            async () => {
              try {
                await queue.enqueue(background(), "work", { n: 1 })
                await queue.enqueue(background(), "work", { n: 2 })
                await until(() => entered === 2, timeoutMs, "two jobs did not run together")
                await queue.enqueue(background(), "work", { n: 3 })
                await sleep(40)
                ensure(entered === 2, "concurrency did not hold the third job")
                release()
                await until(() => entered === 3, timeoutMs, "third job did not start")
              } finally {
                release()
              }
            }
          )
        })
      }
    }),
    Object.freeze({
      name: "stop drains or times out and a second start is rejected",
      /** Cancels the caller wait, times out the owner, and rejects a second start. */
      async run(): Promise<void> {
        await usingQueue(selected, async (queue, timeoutMs) => {
          let release!: () => void
          const gate = new Promise<void>((resolve) => {
            release = resolve
          })
          let started = false
          const worker = queue.worker(
            {
              /** Holds the active run. */
              async work() {
                started = true
                await gate
              }
            },
            { drainTimeoutMs: 5_000 }
          )
          const running = worker.start(background())
          void running.then(settled, settled)
          try {
            const again = await rejection(worker.start(background()))
            ensure(errorCode(again) === "GO_LIKE_JOB_STATE", "second start was allowed")
            await queue.enqueue(background(), "work", { n: 1 })
            await until(() => started, timeoutMs, "job did not start")
            const [stopCtx, cancel] = withCancelCause(background())
            const reason = new Error("stop waiter canceled")
            const waiting = worker.stop(stopCtx)
            cancel(reason)
            ensure(
              (await rejection(waiting)) === reason,
              "stop followed the owner instead of the caller"
            )
            ensure(started, "caller cancellation stopped the run")
            release()
            await running
          } finally {
            release()
            await worker.stop(background()).then(settled, settled)
            await running.then(settled, settled)
          }

          let held = false
          let releaseDrain!: () => void
          const drainGate = new Promise<void>((resolve) => {
            releaseDrain = resolve
          })
          const draining = queue.worker(
            {
              /** Holds the run past the drain budget. */
              async work() {
                held = true
                await drainGate
              }
            },
            { drainTimeoutMs: 40 }
          )
          const drainRun = draining.start(background())
          void drainRun.then(settled, settled)
          try {
            await queue.enqueue(background(), "work", { n: 1 })
            await until(() => held, timeoutMs, "drain job did not start")
            const timed = await rejection(draining.stop(background()))
            ensure(
              errorCode(timed) === "GO_LIKE_JOB_DRAIN_TIMEOUT",
              "drain timeout was not reported"
            )
            releaseDrain()
            ensure(
              errorCode(await rejection(drainRun)) === "GO_LIKE_JOB_DRAIN_TIMEOUT",
              "start did not settle with the drain error"
            )
          } finally {
            releaseDrain()
          }
        })
      }
    }),
    Object.freeze({
      name: "invalid enqueue is rejected before a handler runs",
      /** Rejects a canceled context and an illegal name without a delivery. */
      async run(): Promise<void> {
        await usingQueue(selected, async (queue, timeoutMs) => {
          let calls = 0
          await usingWorker(
            queue,
            {
              /** Counts deliveries that should not happen for rejected enqueues. */
              work() {
                calls += 1
              }
            },
            undefined,
            async () => {
              const [canceled, cancel] = withCancel(background())
              cancel()
              ensure(
                (await rejection(queue.enqueue(canceled, "work", { n: 1 }))) instanceof Error,
                "canceled enqueue"
              )
              ensure(
                (await rejection(queue.enqueue(background(), "", { n: 1 }))) instanceof TypeError,
                "empty name"
              )
              ensure(
                (await rejection(
                  queue.enqueue(background(), "work", undefined as never)
                )) instanceof TypeError,
                "undefined payload"
              )
              await queue.enqueue(background(), "work", { n: 4 })
              await until(() => calls === 1, timeoutMs, "valid job did not run")
            }
          )
        })
      }
    })
  ])
}

/** Builds the pure timetable suite. */
export function scheduleConformance(newSchedule: () => Schedule): readonly ConformanceCase[] {
  if (typeof newSchedule !== "function") {
    throw new TypeError("schedule conformance factory must be a function")
  }
  return Object.freeze([
    Object.freeze({
      name: "next is pure, monotonic, and stable",
      /** Checks the due time, purity, order, the diagnostic name, and illegal input. */
      async run(): Promise<void> {
        const schedule = newSchedule()
        const first = schedule.next(1_000)
        ensure(
          typeof first === "number" && Number.isSafeInteger(first) && first > 1_000,
          "next(t) > t"
        )
        ensure(schedule.next(1_000) === first, "next was not pure")
        const second = schedule.next(first)
        if (second !== null) {
          ensure(Number.isSafeInteger(second) && second > first, "next was not monotonic")
        }
        const name = schedule.string()
        ensure(
          typeof name === "string" && name.length > 0 && schedule.string() === name,
          "string()"
        )
        let rejected = false
        try {
          schedule.next(-1)
        } catch (error) {
          rejected = error instanceof RangeError
        }
        ensure(rejected, "illegal afterMs did not throw RangeError")
        rejected = false
        try {
          schedule.next(1.5)
        } catch (error) {
          rejected = error instanceof RangeError
        }
        ensure(rejected, "fractional afterMs did not throw RangeError")
      }
    })
  ])
}

/** Builds the job telemetry suite. Queue cases are omitted when no queue is supplied. */
export function jobTelemetryConformance(subject: JobTelemetrySubject): readonly ConformanceCase[] {
  if (typeof subject !== "object" || subject === null) {
    throw new TypeError("job telemetry subject is invalid")
  }
  const schedule = subject.schedule ?? newIntervalSchedule(50)
  const cases: ConformanceCase[] = []
  if (subject.queue !== undefined) {
    const selected = captureQueue(subject.queue)
    cases.push(
      Object.freeze({
        name: "queue enqueue and run are parent and child",
        /** Records names, kinds, the parent, the metric, and the completion logs. */
        async run(): Promise<void> {
          await usingQueue(selected, async (queue, timeoutMs) => {
            const recorder = newTelemetryRecorder()
            const ctx = withTelemetry(background(), recorder.telemetry)
            let done = false
            const worker = queue.worker({
              /** Completes one successful run. */
              work() {
                done = true
              }
            })
            const running = worker.start(ctx)
            void running.then(settled, settled)
            try {
              await queue.enqueue(ctx, "work", { n: 1 })
              await until(() => done, timeoutMs, "telemetry job did not run")
              const enqueue = recorder.spans().find((span) => span.name === "enqueue work")
              const run = recorder.spans().find((span) => span.name === "run work")
              ensure(enqueue?.kind === "producer" && enqueue.root === false, "enqueue span")
              ensure(run?.kind === "consumer" && run.root === false, "queue run span")
              ensure(run?.parent?.spanId === enqueue?.context.spanId, "run parent was not enqueue")
              ensure(
                (run?.links.length ?? 1) === 0 && (enqueue?.links.length ?? 1) === 0,
                "job spans recorded links"
              )
              ensure(run?.status === "unset", "success status")
              ensure(
                run?.attributes[AttributeKey.jobTrigger] === SemconvValue.jobTriggerQueue,
                "trigger"
              )
              ensure(
                run?.attributes[AttributeKey.outcome] === SemconvValue.outcomeSuccess,
                "outcome"
              )
              ensure(
                recorder
                  .measurements()
                  .some((item) => item.descriptor.name === MetricName.jobRunDuration),
                "job metric missing"
              )
              ensure(
                !recorder.measurements().some((item) => item.descriptor.name.includes("enqueue")),
                "enqueue recorded a metric"
              )
              ensure(
                recorder.logs().find((item) => item.record.event === LogEvent.jobEnqueueCompleted)
                  ?.record.level === "debug",
                "enqueue log"
              )
              ensure(
                recorder.logs().find((item) => item.record.event === LogEvent.jobRunCompleted)
                  ?.record.level === "info",
                "run log"
              )
            } finally {
              await worker.stop(background()).then(settled, settled)
              await running.then(settled, settled)
            }
          })
        }
      }),
      Object.freeze({
        name: "queue propagation, thrown handlers, and cancellation",
        /** Covers a tracerless parent, a thrown handler, and a canceled run. */
        async run(): Promise<void> {
          await usingQueue(selected, async (queue, timeoutMs) => {
            const propagated = withTelemetry(background(), newTelemetry({}))
            const remote = withRemoteSpanContext(propagated, {
              traceId: "fedcba9876543210fedcba9876543210",
              spanId: "fedcba9876543210",
              traceFlags: 1,
              traceState: "",
              isRemote: true
            })
            let trace = ""
            const plain = queue.worker({
              /** Reads the extracted parent. */
              work(ctx) {
                trace = spanFromContext(ctx).spanContext().traceId
              }
            })
            const plainRun = plain.start(propagated)
            void plainRun.then(settled, settled)
            try {
              await queue.enqueue(remote, "work", { n: 1 })
              await until(() => trace.length > 0, timeoutMs, "tracerless job did not run")
              ensure(
                trace === "fedcba9876543210fedcba9876543210",
                "metadata parent was not extracted"
              )
            } finally {
              await plain.stop(background()).then(settled, settled)
              await plainRun.then(settled, settled)
            }

            const recorder = newTelemetryRecorder()
            const ctx = withTelemetry(background(), recorder.telemetry)
            const failure = new Error("job-secret-text")
            failure.name = "Boom"
            let threw = false
            const failing = queue.worker({
              /** Throws one named error. */
              work() {
                threw = true
                throw failure
              }
            })
            const failingRun = failing.start(ctx)
            void failingRun.then(settled, settled)
            try {
              await queue.enqueue(ctx, "work", { n: 1 })
              await until(() => threw, timeoutMs, "throwing job did not run")
              await sleep(30)
              const run = recorder.spans().find((span) => span.name === "run work")
              ensure(run?.status === "error", "thrown job status")
              ensure(run?.attributes[AttributeKey.errorType] === "Boom", "thrown job error.type")
              const logged = recorder
                .logs()
                .find((item) => item.record.event === LogEvent.jobRunCompleted)
              ensure(logged?.record.level === "error", "thrown job log")
              ensure(
                !logged?.record.message.includes("job-secret-text"),
                "job log contained error text"
              )
              ensure(
                !JSON.stringify(run?.attributes).includes("job-secret-text"),
                "job attributes contained error text"
              )
            } finally {
              await failing.stop(background()).then(settled, settled)
              await failingRun.then(settled, settled)
            }

            recorder.reset()
            let canceled = false
            const stopping = queue.worker(
              {
                /** Returns after the run context is canceled. */
                async work(jobCtx) {
                  const deadline = Date.now() + timeoutMs
                  while (jobCtx.err() === null && Date.now() < deadline) await sleep(5)
                  canceled = jobCtx.err() !== null
                }
              },
              { drainTimeoutMs: 40 }
            )
            const stoppingRun = stopping.start(ctx)
            void stoppingRun.then(settled, settled)
            try {
              await queue.enqueue(ctx, "work", { n: 1 })
              await until(
                async () => {
                  const spans = recorder.spans().filter((span) => span.name === "run work")
                  return spans.length > 0
                },
                timeoutMs,
                "canceled job did not start"
              )
              ensure(
                errorCode(await rejection(stopping.stop(background()))) ===
                  "GO_LIKE_JOB_DRAIN_TIMEOUT",
                "cancel drain"
              )
              await until(
                () =>
                  recorder
                    .spans()
                    .some(
                      (span) =>
                        span.name === "run work" &&
                        span.ended &&
                        span.attributes[AttributeKey.outcome] === SemconvValue.outcomeCanceled
                    ),
                timeoutMs,
                "canceled job span did not finish"
              )
              ensure(canceled, "job context was not canceled")
              const run = recorder.spans().find((span) => span.name === "run work" && span.ended)
              ensure(
                run?.attributes[AttributeKey.outcome] === SemconvValue.outcomeCanceled,
                "canceled outcome"
              )
              ensure(
                run?.attributes[AttributeKey.errorType] === SemconvValue.errorCanceled,
                "canceled error.type"
              )
              ensure(run?.status === "unset", "canceled span status")
              ensure(
                recorder
                  .logs()
                  .find(
                    (item) =>
                      item.record.event === LogEvent.jobRunCompleted && item.record.level === "info"
                  ) !== undefined,
                "canceled job log"
              )
            } finally {
              await stopping.stop(background()).then(settled, settled)
              await stoppingRun.then(settled, settled)
            }
          })
        }
      })
    )
  }
  cases.push(
    Object.freeze({
      name: "a schedule run is a root span",
      /** Ignores the caller's span and records trigger=schedule. */
      async run(): Promise<void> {
        const recorder = newTelemetryRecorder()
        const ctx = withTelemetry(background(), recorder.telemetry)
        let ran = false
        const server = newScheduleServer(schedule, "tick", () => {
          ran = true
        })
        let running: Promise<void> = Promise.resolve()
        try {
          await inSpan(ctx, "outer", async (spanCtx) => {
            running = server.start(spanCtx)
            void running.then(settled, settled)
            await until(() => ran, 2_000, "schedule did not run")
          })
          const run = recorder.spans().find((span) => span.name === "run tick")
          ensure(
            run?.kind === "internal" && run.root === true && run.parent === null,
            "schedule root"
          )
          ensure(
            run?.attributes[AttributeKey.jobTrigger] === SemconvValue.jobTriggerSchedule,
            "schedule trigger"
          )
          ensure(run?.links.length === 0, "schedule links")
          ensure(run?.attributes[AttributeKey.jobSystem] === schedule.string(), "schedule system")
        } finally {
          await server.stop(background()).then(settled, settled)
          await running.then(settled, settled)
        }
      }
    }),
    Object.freeze({
      name: "a thrown schedule handler is a failed run and scheduling continues",
      /** Records the failure, then observes a later run. */
      async run(): Promise<void> {
        const recorder = newTelemetryRecorder()
        const ctx = withTelemetry(background(), recorder.telemetry)
        let runs = 0
        const failure = new Error("schedule-secret-text")
        failure.name = "Boom"
        const server = newScheduleServer(schedule, "tick", () => {
          runs += 1
          if (runs === 1) throw failure
        })
        const running = server.start(ctx)
        void running.then(settled, settled)
        try {
          await until(() => runs >= 2, 2_000, "schedule stopped after a handler error")
          const failed = recorder
            .spans()
            .find((span) => span.name === "run tick" && span.status === "error")
          ensure(failed?.attributes[AttributeKey.errorType] === "Boom", "schedule error.type")
          ensure(
            recorder
              .logs()
              .some(
                (item) =>
                  item.record.event === LogEvent.jobRunCompleted && item.record.level === "error"
              ),
            "schedule failure log"
          )
          ensure(
            !JSON.stringify(failed?.attributes).includes("schedule-secret-text"),
            "schedule attributes contained error text"
          )
        } finally {
          await server.stop(background()).then(settled, settled)
          await running.then(settled, settled)
        }
      }
    })
  )
  return Object.freeze(cases)
}
