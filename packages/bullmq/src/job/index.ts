/**
 * BullMQ job-queue plug.
 * Adopts an application-owned Queue, enqueues through the core kit, and runs each delivery
 * through `dispatchJob`. The plug builds the Worker. Permanent and unknown-name failures
 * become BullMQ unrecoverable errors so remaining attempts are not used.
 */
import type { Context } from "@go-like/core/context"
import { cause, waitForContext, withCancelCause, withoutCancel } from "@go-like/core/context"
import type { Server } from "@go-like/core/lifecycle"
import {
  dispatchJob,
  enqueue as enqueueJob,
  enqueueOptions,
  jobHandlers,
  jobWorkerOptions,
  newJobDrainTimeoutError,
  newJobStateError
} from "@go-like/core/job/provider"
import type {
  EnqueueOptions,
  EnqueuedJob,
  JobHandlers,
  JobQueue,
  JobRunnerState,
  JobWorkerOptions
} from "@go-like/core/job"
import {
  UnrecoverableError,
  Worker,
  type Job,
  type JobsOptions,
  type Queue,
  type WorkerOptions
} from "bullmq"

/** Native Worker options. go-like owns autorun, concurrency, telemetry, connection, and prefix. */
export type BullMqWorkerOptions = Omit<
  WorkerOptions,
  "autorun" | "concurrency" | "telemetry" | "connection" | "prefix"
>

/** Options for `newBullMqJobQueue`. */
export interface BullMqJobQueueOptions {
  readonly worker?: BullMqWorkerOptions
}

/**
 * A JobQueue plus the adopted Queue's resource lifecycle.
 * `start` resolves after `waitUntilReady`. `stop` closes the Queue once.
 */
export interface BullMqJobQueue<T> extends JobQueue<T>, Server {
  string(): "bullmq"
}

/** The native Worker closed without a requested stop. The interface is type-only. */
export interface BullMqUnexpectedExitError extends Error {
  readonly name: "BullMqUnexpectedExitError"
  readonly code: "GO_LIKE_BULLMQ_UNEXPECTED_EXIT"
  readonly queueName: string
  readonly cause: Error | null
}

const forbidden = new Set(["autorun", "concurrency", "telemetry", "connection", "prefix"])
const listPositionVersion = "6.0.6"
/**
 * Deletes one terminal job id, or reports that the id is still unfinished.
 * Redis runs the script atomically, so a second producer cannot delete the first producer's replacement.
 * `Job.remove` cannot do that: it removes by id after a separate state read, with no compare-and-swap.
 * `LPOS` exists only from Redis 6.0.6. Older servers use a list scan inside the same script.
 */
const terminalScriptHead = `
local id = ARGV[1]
local jobKey = KEYS[1]
if redis.call('EXISTS', jobKey) == 0 then
  return 0
end
`
const listedByPosition = `
local function listed(key)
  local pos = redis.call('LPOS', key, id)
  if pos then return 1 end
  return 0
end
`
const listedByRange = `
local function listed(key)
  local items = redis.call('LRANGE', key, 0, -1)
  for _, item in pairs(items) do
    if item == id then return 1 end
  end
  return 0
end
`
const terminalScriptTail = `
local function scored(key)
  local score = redis.call('ZSCORE', key, id)
  if score then return 1 end
  return 0
end
if listed(KEYS[2]) == 1 or listed(KEYS[3]) == 1 or listed(KEYS[4]) == 1 or scored(KEYS[5]) == 1 or scored(KEYS[6]) == 1 or scored(KEYS[9]) == 1 then
  return 1
end
if scored(KEYS[7]) == 0 and scored(KEYS[8]) == 0 then
  return 1
end
redis.call('ZREM', KEYS[7], id)
redis.call('ZREM', KEYS[8], id)
redis.call('DEL', jobKey)
redis.call('DEL', jobKey .. ':logs')
redis.call('DEL', jobKey .. ':processed')
return 0
`
const maximumNameBytes = 256
const encoder = new TextEncoder()

interface AdoptedQueue<T> {
  readonly name: string
  readonly opts: {
    readonly connection?: WorkerOptions["connection"]
    readonly prefix?: string
    readonly telemetry?: unknown
  }
  add(name: string, data: T, opts?: JobsOptions): Promise<{ readonly id?: string | undefined }>
  getJob(id: string): Promise<NativeJob<T> | undefined>
  waitUntilReady(): Promise<unknown>
  close(): Promise<void>
}

interface NativeJob<T> {
  getState(): Promise<string>
  remove(): Promise<void>
  readonly opts?: { readonly telemetry?: { readonly metadata?: string } } | undefined
  readonly id?: string | undefined
  readonly name: string
  readonly data: T
  readonly attemptsMade: number
}

/** Returns the caller's cancellation cause when the context is already terminal. */
function contextFailure(ctx: Context): Error | null {
  const failure = ctx.err()
  return failure === null ? null : (cause(ctx) ?? failure)
}

/** Preserves Error identity. */
function asError(value: unknown, message: string): Error {
  if (value instanceof Error) return value
  return new Error(message, { cause: value })
}

/** Reports whether `current` is older than `minimum`. An unreadable version is treated as older. */
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

/** Reads a Redis version from the queue or its backend. A missing version stays unknown. */
function readRedisVersion(
  queue: { readonly redisVersion?: unknown },
  backend: { readonly redisVersion?: unknown } | undefined
): string | null {
  const nested = backend?.redisVersion
  if (typeof nested === "string" && nested.length > 0) return nested
  const own = queue.redisVersion
  if (typeof own === "string" && own.length > 0) return own
  return null
}

/** Selects the atomic terminal-id script. Redis older than 6.0.6 cannot run `LPOS`. */
function terminalScript(version: string | null): string {
  const listed =
    version !== null && !versionLowerThan(version, listPositionVersion)
      ? listedByPosition
      : listedByRange
  return `${terminalScriptHead}${listed}${terminalScriptTail}`
}

/** Aggregates this plug created. A foreign aggregate stays one error. */
const plugAggregates = new WeakSet<AggregateError>()

/** Flattens aggregates this plug created and keeps every other Error's identity. */
function combineErrors(errors: readonly Error[]): Error | null {
  const flat: Error[] = []
  for (const error of errors) appendError(flat, error)
  const first = flat[0]
  if (first === undefined) return null
  if (flat.length === 1) return first
  const aggregate = new AggregateError(flat, first.message, { cause: first })
  plugAggregates.add(aggregate)
  return aggregate
}

/** Appends one Error, or each error inside an aggregate this plug created. */
function appendError(errors: Error[], error: Error): void {
  if (error instanceof AggregateError && plugAggregates.has(error)) {
    for (const item of error.errors) {
      if (item instanceof Error) appendError(errors, item)
    }
    return
  }
  if (!errors.includes(error)) errors.push(error)
}

/** Validates a code-defined job or queue name. */
function requiredName(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()) {
    throw new TypeError(`${label} must be a non-empty well-formed string`)
  }
  if (encoder.encode(value).byteLength > maximumNameBytes) {
    throw new TypeError(`${label} must be at most 256 UTF-8 bytes`)
  }
  return value
}

/** Rejects options the schedule and queue servers own. */
function rejectOwned(value: object, label: string): void {
  for (const key of Object.keys(value)) {
    if (forbidden.has(key)) {
      throw new TypeError(`bullmq ${label} option ${key} is owned by go-like`)
    }
  }
}

/** Round-trips a payload through JSON before any queue I/O. */
function jsonPayload<T>(payload: T): T {
  let text: string | undefined
  try {
    text = JSON.stringify(payload)
  } catch (error) {
    throw new TypeError("job payload must be JSON serializable", { cause: error })
  }
  if (typeof text !== "string") throw new TypeError("job payload must be JSON serializable")
  return JSON.parse(text) as T
}

/** Reads a stored carrier. A missing or corrupt carrier stays null. */
function readMetadata(value: unknown): Readonly<Record<string, string>> | null {
  if (typeof value !== "string" || value.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
  const record: Record<string, string> = {}
  for (const key of Object.keys(parsed)) {
    const entry: unknown = Reflect.get(parsed, key)
    if (typeof entry !== "string") return null
    record[key] = entry
  }
  return Object.freeze(record)
}

/** Gives BullMQ an Error. Null, undefined, and throwing message getters keep their cause. */
function handlerError(error: unknown): Error {
  if (error instanceof Error) {
    try {
      if (typeof error.message === "string") return error
    } catch (access) {
      return new Error("bullmq job handler failed", { cause: access })
    }
  }
  return new Error("bullmq job handler failed", { cause: error })
}

/** Reports a failure BullMQ must not retry. */
function terminalJob(error: unknown): error is Error {
  if (!(error instanceof Error)) return false
  const code = (error as { readonly code?: unknown }).code
  return code === "GO_LIKE_JOB_PERMANENT" || code === "GO_LIKE_JOB_UNKNOWN_NAME"
}

/** Reports a duplicate-id rejection from Queue.add. */
function alreadyExists(error: unknown): boolean {
  const message = error instanceof Error ? error.message : ""
  const text = message.toLowerCase()
  return text.includes("exists") || text.includes("already")
}

/** Checks the Queue surface and rejects plug-owned Queue telemetry. */
function adoptQueue<T>(
  value: Queue<T, unknown, string, T, unknown, string>
): Queue<T, unknown, string, T, unknown, string> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("bullmq queue must be an object")
  }
  const queue = value as unknown as AdoptedQueue<T>
  if (typeof queue.add !== "function" || typeof queue.getJob !== "function") {
    throw new TypeError("bullmq queue must provide add and getJob")
  }
  if (typeof queue.waitUntilReady !== "function" || typeof queue.close !== "function") {
    throw new TypeError("bullmq queue must provide waitUntilReady and close")
  }
  if (typeof queue.opts !== "object" || queue.opts === null) {
    throw new TypeError("bullmq queue options must be an object")
  }
  if (queue.opts.telemetry !== undefined) {
    throw new TypeError("bullmq queue telemetry is owned by go-like")
  }
  requiredName(queue.name, "job queue name")
  return value
}

/** Creates the unexpected-exit error inside the package. It is not a runtime export. */
function unexpectedExit(queueName: string, exitCause: Error | null): BullMqUnexpectedExitError {
  const error = new Error("BullMQ worker closed outside its owner stop", { cause: exitCause })
  return Object.assign(error, {
    name: "BullMqUnexpectedExitError" as const,
    code: "GO_LIKE_BULLMQ_UNEXPECTED_EXIT" as const,
    queueName,
    cause: exitCause
  })
}

/**
 * Adopts an application-owned Queue.
 * `worker()` builds a Worker with `autorun: false`. Connection and prefix come from the Queue.
 */
export function newBullMqJobQueue<T>(
  queue: Queue<T, unknown, string, T, unknown, string>,
  options?: BullMqJobQueueOptions
): BullMqJobQueue<T> {
  const adopted = adoptQueue(queue)
  if (options !== undefined && (typeof options !== "object" || options === null)) {
    throw new TypeError("bullmq queue options must be an object")
  }
  if (options !== undefined) rejectOwned(options, "queue")
  if (
    options?.worker === null ||
    (options?.worker !== undefined && typeof options.worker !== "object")
  ) {
    throw new TypeError("bullmq worker options must be an object")
  }
  const nativeWorkerOptions = options?.worker ?? {}
  rejectOwned(nativeWorkerOptions, "worker")
  for (const key of Object.keys(options ?? {})) {
    if (key !== "worker") throw new TypeError(`bullmq queue option ${key} is owned by go-like`)
  }

  let state: JobRunnerState = "idle"
  let closing: Promise<void> | null = null

  /** Closes the adopted Queue once. */
  function beginClose(): Promise<void> {
    if (closing !== null) return closing
    if (state === "idle") {
      state = "stopped"
      closing = Promise.resolve()
      return closing
    }
    if (state === "failed" || state === "stopped") {
      closing = Promise.resolve()
      return closing
    }
    state = "stopping"
    closing = Promise.resolve(adopted.close()).then(
      () => {
        state = "stopped"
      },
      (error: unknown) => {
        state = "failed"
        throw asError(error, "bullmq queue close failed")
      }
    )
    void closing.catch(() => {})
    return closing
  }

  const server: BullMqJobQueue<T> = {
    name: adopted.name,
    /** Waits until the Queue is ready. A second call is rejected. */
    async start(ctx: Context): Promise<void> {
      if (state !== "idle") throw newJobStateError("start", state)
      const failure = contextFailure(ctx)
      if (failure !== null) {
        state = "failed"
        throw failure
      }
      state = "starting"
      try {
        await waitForContext(ctx, Promise.resolve(adopted.waitUntilReady()))
      } catch (error) {
        if (state === "starting") state = "failed"
        throw error
      }
      if (state === "starting") state = "running"
    },
    /** Closes the Queue. This caller's context bounds only its wait. */
    stop(ctx: Context): Promise<void> {
      return waitForContext(ctx, beginClose())
    },
    /** Enqueues one JSON payload. An unfinished id is returned without a second add. */
    async enqueue(
      ctx: Context,
      name: string,
      payload: T,
      enqueueConfig?: EnqueueOptions
    ): Promise<EnqueuedJob> {
      const failure = contextFailure(ctx)
      if (failure !== null) throw failure
      if (state !== "running") throw newJobStateError("enqueue", state)
      const selectedName = requiredName(name, "job name")
      const resolved = enqueueOptions(enqueueConfig)
      const body = jsonPayload(payload)
      return await enqueueJob(
        ctx,
        { system: "bullmq", name: selectedName, queue: adopted.name },
        async (_unitCtx, metadata) => {
          const id = resolved.id
          if (id !== null) {
            const redis = adopted as unknown as {
              readonly redisVersion?: unknown
              readonly keys?: Record<string, string>
              readonly client?: Promise<{
                eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>
              }>
              getBackend?(): {
                readonly redisVersion?: unknown
                readonly client?: Promise<{
                  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>
                }>
                readonly keys?: Record<string, string>
              }
            }
            // BullMQ 6.7.5 keeps the raw client on the backend. Older queues expose it directly.
            const backend = typeof redis.getBackend === "function" ? redis.getBackend() : undefined
            const keys = redis.keys ?? backend?.keys
            const clientPromise = redis.client ?? backend?.client
            if (
              clientPromise === undefined ||
              keys === undefined ||
              keys[""] === undefined ||
              keys.wait === undefined ||
              keys.active === undefined ||
              keys.paused === undefined ||
              keys.delayed === undefined ||
              keys.prioritized === undefined ||
              keys.completed === undefined ||
              keys.failed === undefined ||
              keys["waiting-children"] === undefined
            ) {
              throw new TypeError("bullmq queue must expose its Redis client and keys")
            }
            const client = await clientPromise
            const replaced = await client.eval(
              terminalScript(readRedisVersion(redis, backend)),
              9,
              `${keys[""]}${id}`,
              keys.wait,
              keys.active,
              keys.paused,
              keys.delayed,
              keys.prioritized,
              keys.completed,
              keys.failed,
              keys["waiting-children"],
              id
            )
            if (Number(replaced) === 1) return { id }
          }
          const jobOptions: JobsOptions = {
            attempts: resolved.attempts,
            backoff: { type: resolved.backoff.type, delay: resolved.backoff.delayMs },
            telemetry: { metadata: JSON.stringify(metadata), omitContext: true }
          }
          if (id !== null) jobOptions.jobId = id
          try {
            const added = await adopted.add(selectedName, body, jobOptions)
            const addedId = added.id
            if (typeof addedId === "string" && addedId.length > 0) return { id: addedId }
            if (id !== null) return { id }
            throw new TypeError("bullmq add must return a job id")
          } catch (error) {
            if (id !== null && alreadyExists(error)) return { id }
            throw error
          }
        }
      )
    },
    /** Builds a one-shot Worker server. Handler checks happen before start. */
    worker(handlers: JobHandlers<T>, workerConfig?: JobWorkerOptions): Server {
      const table = jobHandlers(handlers)
      const resolved = jobWorkerOptions(workerConfig)
      let workerState: JobRunnerState = "idle"
      let native: Worker<T> | null = null
      let activeRunner!: Context
      let cancelRunner: ((cause: Error | null) => void) | null = null
      let ownerStop: Promise<void> | null = null
      let drainError: Error | null = null
      let closeOnce: Promise<Error | null> | null = null
      let closing = false
      const closeErrors: Error[] = []
      const activeRuns = new Set<Promise<void>>()
      let settleStart: ((error: Error | null) => void) | null = null
      const runtime = new Promise<void>((resolve, reject) => {
        settleStart = (error) => {
          settleStart = null
          if (error === null) resolve()
          else reject(error)
        }
      })
      void runtime.catch(() => {})

      /** Settles start once. */
      function settle(error: Error | null): void {
        settleStart?.(error)
      }

      /** Fails a running worker that closed on its own. */
      function fail(error: Error): void {
        if (workerState !== "running" && workerState !== "starting") return
        workerState = "failed"
        cancelRunner?.(error)
        settle(error)
      }

      /** Closes the native Worker once and keeps every close-period error. */
      function closeNative(): Promise<Error | null> {
        if (closeOnce !== null) return closeOnce
        const worker = native
        closeOnce = (async () => {
          if (worker === null) return null
          closing = true
          let thrown: Error | null = null
          try {
            await worker.close()
          } catch (error) {
            thrown = asError(error, "bullmq worker close failed")
          } finally {
            closing = false
          }
          const recorded = closeErrors.splice(0)
          return combineErrors(thrown === null ? recorded : [...recorded, thrown])
        })()
        return closeOnce
      }

      /** Waits for processor runs that native close may have stopped observing. */
      function whenActiveSettled(): Promise<void> {
        const pending = [...activeRuns]
        if (pending.length === 0) return Promise.resolve()
        return Promise.all(pending).then(() => whenActiveSettled())
      }

      /** Bounds one owner wait. The budget applies in every state that still has work. */
      function withOwnerBudget(operation: Promise<void>): Promise<void> {
        const timeoutError = newJobDrainTimeoutError(adopted.name, resolved.drainTimeoutMs)
        let timer: ReturnType<typeof setTimeout> | null = null
        const timed = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            drainError = timeoutError
            cancelRunner?.(timeoutError)
            native?.cancelAllJobs("GO_LIKE_JOB_DRAIN_TIMEOUT")
            reject(timeoutError)
          }, resolved.drainTimeoutMs)
        })
        void operation.catch(() => {})
        return Promise.race([operation, timed]).finally(() => {
          if (timer !== null) clearTimeout(timer)
        })
      }

      /** Runs one BullMQ delivery inside the job kit and keeps ownership of that run. */
      async function processor(job: Job<T>): Promise<unknown> {
        let release!: () => void
        const owned = new Promise<void>((resolve) => {
          release = resolve
        })
        activeRuns.add(owned)
        try {
          const metadata = readMetadata(job.opts?.telemetry?.metadata)
          return await dispatchJob(
            activeRunner,
            "bullmq",
            table,
            {
              queue: adopted.name,
              name: job.name,
              id: job.id ?? "",
              attempt: job.attemptsMade + 1,
              payload: job.data
            },
            metadata
          )
        } catch (error) {
          if (terminalJob(error)) throw new UnrecoverableError(error.name)
          throw handlerError(error)
        } finally {
          release()
          activeRuns.delete(owned)
        }
      }

      /** Closes the Worker and drains active processor runs within the owner budget. */
      function beginStop(): Promise<void> {
        if (ownerStop !== null) return ownerStop
        if (workerState === "idle") {
          workerState = "stopped"
          settle(null)
          ownerStop = Promise.resolve()
          return ownerStop
        }
        const terminal = workerState === "failed" || workerState === "stopped"
        if (!terminal) workerState = "stopping"
        const settled = (): undefined => undefined
        const operation = (async () => {
          const closeFailure = await (terminal
            ? (closeOnce ?? Promise.resolve(null))
            : closeNative())
          if (drainError === null) await whenActiveSettled()
          if (terminal) {
            if (drainError === null && closeFailure !== null) throw closeFailure
            await runtime.then(settled, settled)
            return
          }
          if (drainError !== null) {
            settle(
              closeFailure === null
                ? drainError
                : (combineErrors([drainError, closeFailure]) ?? drainError)
            )
            return
          }
          if (closeFailure !== null) {
            workerState = "failed"
            settle(closeFailure)
            throw closeFailure
          }
          workerState = "stopped"
          settle(null)
        })()
        ownerStop = withOwnerBudget(operation)
        void ownerStop.catch(() => {})
        return ownerStop
      }

      return Object.freeze({
        /** Opens the Worker and stays pending until stop. */
        async start(ctx: Context): Promise<void> {
          if (workerState !== "idle") throw newJobStateError("start", workerState)
          const failure = contextFailure(ctx)
          if (failure !== null) {
            workerState = "failed"
            settle(failure)
            throw failure
          }
          workerState = "starting"
          const [runner, cancel] = withCancelCause(withoutCancel(ctx))
          activeRunner = runner
          cancelRunner = cancel
          const created = new Worker<T, unknown, string>(adopted.name, processor, {
            ...nativeWorkerOptions,
            autorun: false,
            concurrency: resolved.concurrency,
            connection: adopted.opts.connection,
            ...(typeof adopted.opts.prefix === "string" ? { prefix: adopted.opts.prefix } : {})
          })
          native = created
          created.on("error", (error: unknown) => {
            if (!closing) return
            closeErrors.push(asError(error, "bullmq worker close failed"))
          })
          created.on("closed", () => {
            if (workerState === "running" && closeOnce === null) {
              fail(unexpectedExit(adopted.name, null))
            }
          })
          try {
            await created.waitUntilReady()
          } catch (error) {
            if (workerState === "starting") {
              workerState = "failed"
              const primary = asError(error, "bullmq worker failed to start")
              const closeFailure = await closeNative()
              settle(combineErrors(closeFailure === null ? [primary] : [primary, closeFailure]))
            }
            return runtime
          }
          if (workerState !== "starting") return runtime
          workerState = "running"
          void created.run().catch((error: unknown) => {
            if (workerState !== "running") return
            const primary = asError(error, "bullmq worker run failed")
            workerState = "failed"
            cancelRunner?.(primary)
            void closeNative().then((closeFailure) => {
              settle(combineErrors(closeFailure === null ? [primary] : [primary, closeFailure]))
            })
          })
          return runtime
        },
        /** Drains active jobs. This caller's context bounds only its wait. */
        stop(ctx: Context): Promise<void> {
          return waitForContext(ctx, beginStop())
        }
      })
    },
    /** Returns the provider name recorded on job units. */
    string(): "bullmq" {
      return "bullmq"
    }
  }
  return Object.freeze(server)
}
