import type { Context } from "@go-like/context"
import { waitForContext } from "@go-like/core/lifecycle"
import { Worker } from "bullmq"

import {
  combineBullMqErrors,
  newBullMqAlreadyStartedError,
  newBullMqWorkerShutdownTimeoutError,
  newBullMqUnexpectedExitError,
  normalizeBullMqError
} from "./errors"
import type { BullMqWorkerFactory, BullMqWorkerServer } from "./types"

type BullMqState = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed"

interface BullMqConfig {
  shutdownTimeoutMs: number
}

interface BullMqCleanupOperation {
  /** Settles at the owner deadline even when the native Worker remains live. */
  readonly owner: Promise<Error | null>
  /** Settles only after native pause, close, and closed observation are terminal. */
  readonly terminal: Promise<Error | null>
}

interface BullMqSource {
  /** Creates or returns the application-configured native Worker. */
  create(): unknown
  /** Reports whether a failed pre-transfer candidate was created inside start. */
  readonly factoryOwnedUntilTransfer: boolean
  /** Requires the public boundary to return an official BullMQ Worker instance. */
  readonly officialOnly: boolean
}

/** Applies one construction-time lifecycle option. */
type BullMqOption = (config: BullMqConfig) => void

/** Minimal native Worker lifecycle used only by package-internal tests. */
export interface BullMqWorkerLike {
  readonly name: string
  readonly opts: { readonly autorun?: boolean }
  readonly closing: Promise<void> | undefined
  /** Adds one persistent native lifecycle listener. */
  on(
    event: "error" | "closed",
    listener: (
      ...values: unknown[] /* go-like-typed-rest: matches the official EventEmitter listener shape without narrowing native values. */
    ) => void
  ): this
  /** Removes one adapter-installed native lifecycle listener. */
  off(
    event: "error" | "closed",
    listener: (
      ...values: unknown[] /* go-like-typed-rest: matches the official EventEmitter listener shape without narrowing native values. */
    ) => void
  ): this
  /** Waits for the official Worker connections. */
  waitUntilReady(): Promise<unknown>
  /** Runs the official Worker main loop after explicit startup acceptance. */
  run(): Promise<void>
  /** Stops admission and optionally waits for active jobs. */
  pause(doNotWaitActive?: boolean): Promise<void>
  /** Cancels every active job through BullMQ's native processor AbortSignal. */
  cancelAllJobs(reason?: string): void
  /** Closes the Worker and its Redis connections. */
  close(force?: boolean): Promise<void>
  /** Reports whether the native Worker main loop is already running. */
  isRunning(): boolean
}

/** Creates one structural native lifecycle for package and published-boundary tests. */
export type BullMqWorkerFactoryLike = () => BullMqWorkerLike

const MaximumTimerDelay = 2_147_483_647

/**
 * Configures the provider shutdown boundary before native job cancellation.
 *
 * This boundary is necessary because Worker.pause(false) and Worker.close(true) do not accept an
 * AbortSignal; the adapter can only request cancellation through Worker.cancelAllJobs().
 */
export function bullMqWorkerShutdownTimeout(timeoutMs: number): BullMqOption {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MaximumTimerDelay) {
    throw new RangeError(
      `BullMQ Worker shutdown timeout must be an integer between zero and ${MaximumTimerDelay} milliseconds`
    )
  }
  return (config) => {
    config.shutdownTimeoutMs = timeoutMs
  }
}

/** Reports whether one unknown value exposes exactly the lifecycle operations consumed here. */
function workerLifecycle(value: unknown): value is BullMqWorkerLike {
  if (value === null || typeof value !== "object") return false
  const opts: unknown = Reflect.get(value, "opts")
  return (
    typeof Reflect.get(value, "name") === "string" &&
    opts !== null &&
    typeof opts === "object" &&
    typeof Reflect.get(value, "on") === "function" &&
    typeof Reflect.get(value, "off") === "function" &&
    typeof Reflect.get(value, "waitUntilReady") === "function" &&
    typeof Reflect.get(value, "run") === "function" &&
    typeof Reflect.get(value, "pause") === "function" &&
    typeof Reflect.get(value, "cancelAllJobs") === "function" &&
    typeof Reflect.get(value, "close") === "function" &&
    typeof Reflect.get(value, "isRunning") === "function"
  )
}

/** Validates the native identity and dormant handoff contract without mutating it. */
function validateWorker(value: unknown, officialOnly: boolean): BullMqWorkerLike {
  if (officialOnly && !(value instanceof Worker)) {
    throw new TypeError("BullMQ worker factory must return an official Worker")
  }
  if (!workerLifecycle(value))
    throw new TypeError("BullMQ server requires a native Worker lifecycle")
  if (value.name.length === 0) throw new TypeError("BullMQ Worker queue name is required")
  if (value.opts.autorun !== false) {
    throw new TypeError("BullMQ Worker must be constructed with autorun: false")
  }
  if (value.closing !== undefined) throw new TypeError("BullMQ Worker is already closing or closed")
  if (value.isRunning()) throw new TypeError("BullMQ Worker is already running")
  return value
}

/** Deliberately consumes a Promise whose effect is exposed through another stable barrier. */
function consumePromise(_value?: unknown): void {}

/** Records one Error identity only once and in observation order. */
function recordError(errors: Error[], error: Error): void {
  if (!errors.includes(error)) errors.push(error)
}

/** Settles one immutable terminal barrier from its abort reason. */
function terminalPromise(controller: AbortController, succeeded: object): Promise<void> {
  const promise = new Promise<void>((resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => {
        const reason: unknown = controller.signal.reason
        if (reason === succeeded) resolve()
        else reject(reason)
      },
      { once: true }
    )
  })
  void promise.catch(consumePromise)
  return promise
}

/** Best-effort closes one factory-created candidate that never transferred ownership. */
async function closeProvisionalWorker(value: unknown): Promise<Error | null> {
  if (!workerLifecycle(value)) return null
  try {
    await value.close(true)
    return null
  } catch (failure) {
    return normalizeBullMqError("BullMQ provisional Worker close", failure)
  }
}

/** Creates the one-shot lifecycle Server shared by production and package-internal tests. */
function newBullMqLifecycleServer(
  source: BullMqSource,
  options: readonly BullMqOption[]
): BullMqWorkerServer {
  const config: BullMqConfig = { shutdownTimeoutMs: 25_000 }
  for (const option of options) {
    if (typeof option !== "function") throw new TypeError("BullMQ server option must be a function")
    option(config)
  }

  let state: BullMqState = "idle"
  let admission: Promise<void> | null = null
  let ownerShutdown: Promise<void> | null = null
  let ownerWaiter: Promise<void> | null = null
  let worker: BullMqWorkerLike | null = null
  let closed = false
  let collecting = false
  let errorListenerInstalled = false
  let closedListenerInstalled = false
  const shutdownErrors: Error[] = []
  const completion = new AbortController()
  const succeeded = Object.freeze({ kind: "succeeded" })
  const done = terminalPromise(completion, succeeded)
  /** Publishes the native Worker closed event to every cleanup path. */
  let resolveNativeClosed: () => void = consumePromise
  const nativeClosed = new Promise<void>((resolve) => {
    resolveNativeClosed = resolve
  })

  /** Settles the stable terminal barrier successfully. */
  function succeed(): void {
    state = "stopped"
    completion.abort(succeeded)
  }

  /** Settles the stable terminal barrier with one lifecycle failure. */
  function fail(error: Error): void {
    state = "failed"
    completion.abort(error)
  }

  /** Reports native operational errors and retains only shutdown-period failures. */
  function workerErrored(value?: unknown): void {
    if (!collecting) return
    recordError(shutdownErrors, normalizeBullMqError("BullMQ worker error event", value))
  }

  /** Removes only listeners installed by this adapter. */
  function removeLifecycleListeners(): void {
    const accepted = worker
    if (accepted === null) return
    if (errorListenerInstalled) {
      errorListenerInstalled = false
      accepted.off("error", workerErrored)
    }
    if (closedListenerInstalled) {
      closedListenerInstalled = false
      accepted.off("closed", workerClosed)
    }
  }

  /** Removes observation after native close and detects passive closure. */
  function workerClosed(): void {
    if (closed) return
    closed = true
    resolveNativeClosed()
    removeLifecycleListeners()
    const accepted = worker
    if (state === "running" && accepted !== null) beginPassiveExit(accepted, null)
  }

  /** Atomically installs the two native lifecycle listeners consumed here. */
  function installLifecycleListeners(accepted: BullMqWorkerLike): void {
    try {
      errorListenerInstalled = true
      accepted.on("error", workerErrored)
      closedListenerInstalled = true
      accepted.on("closed", workerClosed)
    } catch (failure) {
      removeLifecycleListeners()
      throw failure
    }
  }

  /** Closes the accepted native Worker once from the single terminal cleanup operation. */
  function closeAcceptedWorker(accepted: BullMqWorkerLike): Promise<void> {
    if (closed) return Promise.resolve()
    return (async () => {
      try {
        await accepted.close(true)
      } catch (value) {
        recordError(shutdownErrors, normalizeBullMqError("BullMQ worker close", value))
      }
    })()
  }

  /** Combines one primary failure with cleanup evidence observed before settlement. */
  function cleanupFailure(primary: Error | null, message: string): Error | null {
    const errors: Error[] = []
    if (primary !== null) errors.push(primary)
    for (const error of shutdownErrors) errors.push(error)
    return combineBullMqErrors(errors, message)
  }

  /**
   * Starts one cleanup with separate owner-wait and true-terminal barriers.
   *
   * The owner deadline may abandon waiting and request native cancellation, but
   * terminal remains pending until pause, close, and closed observation settle.
   */
  function boundedCleanup(
    current: BullMqWorkerLike,
    primary: Error | null,
    pauseFirst: boolean,
    cancelActiveWhenForced: boolean,
    message: string
  ): BullMqCleanupOperation {
    collecting = true
    let activeJobsCanceled = false

    /** Requests BullMQ-native AbortSignal cancellation exactly once. */
    function forceActiveJobs(reason: Error): void {
      if (!cancelActiveWhenForced || activeJobsCanceled) return
      activeJobsCanceled = true
      try {
        current.cancelAllJobs(reason.message)
      } catch (value) {
        recordError(shutdownErrors, normalizeBullMqError("BullMQ active job cancellation", value))
      }
    }

    const deadline = performance.now() + config.shutdownTimeoutMs
    let ownerPublished = false
    let terminalPublished = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let resolveOwner: (failure: Error | null) => void = consumePromise
    const owner = new Promise<Error | null>((resolve) => {
      resolveOwner = resolve
    })
    /** Releases a cleanup that is still waiting for graceful pause. */
    let releaseDeadline: () => void = consumePromise
    const deadlineReached = new Promise<void>((resolve) => {
      releaseDeadline = resolve
    })

    /** Publishes the immutable owner-wait result exactly once. */
    function publishOwner(): void {
      if (ownerPublished) return
      ownerPublished = true
      resolveOwner(cleanupFailure(primary, message))
    }

    /** Requests force and releases owner wait without claiming native terminal. */
    function deadlineExceeded(): void {
      if (terminalPublished || ownerPublished) return
      const timeout = newBullMqWorkerShutdownTimeoutError(current.name, config.shutdownTimeoutMs)
      recordError(shutdownErrors, timeout)
      forceActiveJobs(timeout)
      publishOwner()
      releaseDeadline()
    }

    if (config.shutdownTimeoutMs > 0) {
      timer = setTimeout(deadlineExceeded, config.shutdownTimeoutMs)
    }

    const terminal = (async (): Promise<Error | null> => {
      if (closed) {
        if (!pauseFirst && primary !== null) forceActiveJobs(primary)
      } else if (pauseFirst) {
        let pause: Promise<void> | null = null
        try {
          pause = Promise.resolve(current.pause(false)).catch((value: unknown) => {
            const pauseFailure = normalizeBullMqError("BullMQ worker pause", value)
            recordError(shutdownErrors, pauseFailure)
            forceActiveJobs(pauseFailure)
          })
        } catch (value) {
          const pauseFailure = normalizeBullMqError("BullMQ worker pause", value)
          recordError(shutdownErrors, pauseFailure)
          forceActiveJobs(pauseFailure)
        }
        if (performance.now() >= deadline) deadlineExceeded()
        if (pause !== null && !ownerPublished) {
          await Promise.race([pause, deadlineReached])
        }
        if (pause !== null) await pause
      } else if (primary !== null) {
        forceActiveJobs(primary)
      }

      if (performance.now() >= deadline) deadlineExceeded()
      const closing = closeAcceptedWorker(current)
      if (performance.now() >= deadline) deadlineExceeded()
      await closing
      if (performance.now() >= deadline) deadlineExceeded()
      await nativeClosed
      if (performance.now() >= deadline) deadlineExceeded()
      terminalPublished = true
      if (timer !== null) clearTimeout(timer)
      publishOwner()
      return cleanupFailure(primary, message)
    })()

    return Object.freeze({ owner, terminal })
  }

  /** Converts one cleanup failure value into the shared stop Promise contract. */
  function stopResult(result: Promise<Error | null>): Promise<void> {
    return result.then((failure) => {
      if (failure !== null) throw failure
    })
  }

  /** Finalizes one cleanup only after its true native terminal barrier settles. */
  function finishCleanup(failure: Error | null): void {
    if (failure === null) succeed()
    else fail(failure)
  }

  /** Closes after a passive run or closed terminal and preserves the exit cause. */
  function beginPassiveExit(current: BullMqWorkerLike, exitCause: unknown): void {
    if (state !== "running" || ownerShutdown !== null) return
    state = "stopping"
    collecting = true
    const cause = exitCause === null ? null : normalizeBullMqError("BullMQ worker run", exitCause)
    const queueName = current.name
    const unexpected = newBullMqUnexpectedExitError(queueName, cause)
    const cleanup = boundedCleanup(
      current,
      unexpected,
      false,
      true,
      `BullMQ worker for "${queueName}" passive-exit cleanup failed`
    )
    ownerWaiter = stopResult(cleanup.owner)
    ownerShutdown = cleanup.terminal.then(finishCleanup)
    void ownerWaiter.catch(consumePromise)
    void ownerShutdown.catch(consumePromise)
  }

  /** Starts the only graceful-to-cancel owner shutdown independently of caller cancellation. */
  function beginOwnerShutdown(current: BullMqWorkerLike): Promise<void> {
    if (ownerWaiter !== null) return ownerWaiter
    state = "stopping"
    const queueName = current.name
    const cleanup = boundedCleanup(
      current,
      null,
      true,
      true,
      `BullMQ worker for "${queueName}" shutdown failed`
    )
    ownerWaiter = stopResult(cleanup.owner)
    ownerShutdown = cleanup.terminal.then(finishCleanup)
    void ownerWaiter.catch(consumePromise)
    void ownerShutdown.catch(consumePromise)
    return ownerWaiter
  }

  return Object.freeze({
    /** Accepts one dormant native Worker and starts only its official run loop. */
    start(ctx: Context): Promise<void> {
      if (state !== "idle") {
        return Promise.reject(newBullMqAlreadyStartedError(worker?.name ?? "unknown", state))
      }
      state = "starting"
      admission = (async (): Promise<void> => {
        let candidate: unknown = null
        let accepted: BullMqWorkerLike
        try {
          await waitForContext(ctx, Promise.resolve())
          candidate = source.create()
          accepted = validateWorker(candidate, source.officialOnly)
          worker = accepted
          await waitForContext(ctx, Promise.resolve())
          installLifecycleListeners(accepted)
        } catch (value) {
          const primary = normalizeBullMqError("BullMQ worker startup", value)
          removeLifecycleListeners()
          const rollback = source.factoryOwnedUntilTransfer
            ? await closeProvisionalWorker(candidate)
            : null
          const failure =
            combineBullMqErrors(
              rollback === null ? [primary] : [primary, rollback],
              "BullMQ Worker startup and provisional cleanup failed"
            ) ?? primary
          fail(failure)
          throw failure
        }

        try {
          const nativeReady = accepted.waitUntilReady()
          let rejectClosed: (error: Error) => void = consumePromise
          const closedBeforeReady = new Promise<never>((_resolve, reject) => {
            rejectClosed = reject
          })
          /** Rejects startup if native close occurs before readiness. */
          function rejectClosedBeforeReady(): void {
            rejectClosed(newBullMqUnexpectedExitError(accepted.name, null))
          }
          accepted.on("closed", rejectClosedBeforeReady)
          try {
            await waitForContext(ctx, Promise.race([nativeReady, closedBeforeReady]))
          } finally {
            accepted.off("closed", rejectClosedBeforeReady)
          }
        } catch (value) {
          const primary = normalizeBullMqError("BullMQ worker startup", value)
          if (!source.factoryOwnedUntilTransfer) {
            removeLifecycleListeners()
            fail(primary)
            throw primary
          }
          state = "stopping"
          const queueName = accepted.name
          const cleanup = boundedCleanup(
            accepted,
            primary,
            false,
            false,
            `BullMQ worker for "${queueName}" startup and cleanup failed`
          )
          ownerWaiter = stopResult(cleanup.owner)
          ownerShutdown = cleanup.terminal.then(finishCleanup)
          void ownerWaiter.catch(consumePromise)
          void ownerShutdown.catch(consumePromise)
          const failure = await cleanup.owner
          // Startup always contributes the primary Error.
          throw failure ?? primary
        }

        state = "running"
        let nativeRunning: Promise<void>
        try {
          nativeRunning = Promise.resolve(accepted.run())
        } catch (value) {
          nativeRunning = Promise.reject(value)
        }
        void nativeRunning.then(
          () => {
            beginPassiveExit(accepted, null)
          },
          (value: unknown) => {
            beginPassiveExit(accepted, value)
          }
        )
      })()
      void admission.catch(consumePromise)
      const running = admission.then(() => done)
      void running.catch(consumePromise)
      return running
    },
    /** Joins Worker shutdown while allowing only this caller to abandon its wait. */
    stop(stopCtx: Context): Promise<void> {
      if (state === "idle") return Promise.resolve()
      const starting = admission
      if (starting === null) return waitForContext(stopCtx, done)
      const stopping = starting.then(() => {
        if (state === "failed" || state === "stopped") return done
        const accepted = worker
        if (accepted === null) return done
        return beginOwnerShutdown(accepted)
      })
      void stopping.catch(consumePromise)
      return waitForContext(stopCtx, stopping)
    }
  })
}

/** Creates a Server from a structural native lifecycle exclusively for package-internal tests. */
export function newBullMqWorkerServerWithFactory(
  factory: BullMqWorkerFactoryLike,
  options: readonly BullMqOption[] = []
): BullMqWorkerServer {
  if (typeof factory !== "function") throw new TypeError("BullMQ worker factory must be a function")
  return newBullMqLifecycleServer(
    Object.freeze({
      create: factory,
      factoryOwnedUntilTransfer: true,
      officialOnly: false
    }),
    options
  )
}

/** Creates a lifecycle Server around one application-configured official Worker. */
export function newBullMqWorkerServer<
  DataType = unknown,
  ResultType = unknown,
  NameType extends string = string
>(
  worker: Worker<DataType, ResultType, NameType>,
  ...options: readonly BullMqOption[] /* go-like-typed-rest: preserves the Go-style functional-option ABI without coercion. */
): BullMqWorkerServer

/** Creates an application-configured official Worker lazily inside Server startup. */
export function newBullMqWorkerServer<
  DataType = unknown,
  ResultType = unknown,
  NameType extends string = string
>(
  factory: BullMqWorkerFactory<DataType, ResultType, NameType>,
  ...options: readonly BullMqOption[] /* go-like-typed-rest: preserves the Go-style functional-option ABI without coercion. */
): BullMqWorkerServer

/** Implements the official Worker and factory overloads without owning the data plane. */
export function newBullMqWorkerServer<
  DataType = unknown,
  ResultType = unknown,
  NameType extends string = string
>(
  workerOrFactory:
    | Worker<DataType, ResultType, NameType>
    | BullMqWorkerFactory<DataType, ResultType, NameType>,
  ...options: readonly BullMqOption[] /* go-like-typed-rest: preserves the Go-style functional-option ABI without coercion. */
): BullMqWorkerServer {
  if (workerOrFactory instanceof Worker) {
    const worker = workerOrFactory
    return newBullMqLifecycleServer(
      Object.freeze({
        /** Returns the exact application-created official Worker once start accepts it. */
        create(): Worker<DataType, ResultType, NameType> {
          return worker
        },
        factoryOwnedUntilTransfer: false,
        officialOnly: true
      }),
      options
    )
  }
  if (typeof workerOrFactory !== "function") {
    throw new TypeError("BullMQ server requires an official Worker or Worker factory")
  }
  return newBullMqLifecycleServer(
    Object.freeze({
      create: workerOrFactory,
      factoryOwnedUntilTransfer: true,
      officialOnly: true
    }),
    options
  )
}
