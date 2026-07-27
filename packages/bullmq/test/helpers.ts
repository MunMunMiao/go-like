import { EventEmitter } from "node:events"

import type { BullMqWorkerFactoryLike, BullMqWorkerLike } from "../src/server"

export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

/** Creates one externally controlled Promise for lifecycle interleavings. */
export function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => {
    throw new Error("deferred resolve unavailable")
  }
  let rejectPromise: (error: unknown) => void = () => {
    throw new Error("deferred reject unavailable")
  }
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return Object.freeze({ promise, resolve: resolvePromise, reject: rejectPromise })
}

export interface FakeWorkerOptions {
  readonly ready?: "resolve" | "hold"
  readonly run?: "hold" | "resolve" | "throw"
  readonly pause?: "resolve" | "hold" | "throw" | "block"
  readonly close?: "resolve" | "hold" | "throw" | "block"
  readonly cancel?: "record" | "throw"
  readonly autorun?: boolean
  readonly running?: boolean
  readonly closing?: boolean
  readonly install?: "resolve" | "throw-error" | "throw-closed"
  readonly queueName?: string
}

export interface FakeWorker {
  readonly factory: BullMqWorkerFactoryLike
  readonly worker: BullMqWorkerLike
  readonly calls: readonly unknown[][]
  /** Resolves a held readiness operation. */
  resolveReady(): void
  /** Rejects a held readiness operation. */
  rejectReady(error: unknown): void
  /** Resolves the worker run loop passively. */
  resolveRun(): void
  /** Rejects the worker run loop passively. */
  rejectRun(error: unknown): void
  /** Resolves a held pause operation. */
  resolvePause(): void
  /** Rejects a held pause operation. */
  rejectPause(error: unknown): void
  /** Resolves a held close operation and emits closed first. */
  resolveClose(): void
  /** Rejects a held close operation. */
  rejectClose(error: unknown): void
  /** Emits one raw worker error. */
  error(error: unknown): void
  /** Emits passive worker closure. */
  closed(): void
}

/** Creates one structural Worker lifecycle without replacing BullMQ's data plane. */
export function fakeWorker(options: FakeWorkerOptions = {}): FakeWorker {
  const emitter = new EventEmitter()
  const ready = deferred<unknown>()
  const run = deferred<void>()
  const pause = deferred<void>()
  const close = deferred<void>()
  const calls: unknown[][] = []
  let closed = false
  let closing: Promise<void> | undefined = options.closing === true ? Promise.resolve() : undefined
  let running = options.running === true

  const worker: BullMqWorkerLike = {
    name: options.queueName ?? "email",
    opts: Object.freeze({ autorun: options.autorun ?? false }),
    get closing(): Promise<void> | undefined {
      return closing
    },
    /** Adds a persistent native event listener. */
    on(event: "error" | "closed", listener: (...values: unknown[]) => void): BullMqWorkerLike {
      calls.push(["on", event])
      if (options.install === `throw-${event}`) throw new Error(`${event} listener install threw`)
      emitter.on(event, listener)
      return worker
    },
    /** Removes a native event listener. */
    off(event: "error" | "closed", listener: (...values: unknown[]) => void): BullMqWorkerLike {
      calls.push(["off", event])
      emitter.off(event, listener)
      return worker
    },
    /** Waits for both private BullMQ Redis connections. */
    waitUntilReady(): Promise<unknown> {
      calls.push(["waitUntilReady"])
      if (options.ready !== "hold") return Promise.resolve({})
      return ready.promise
    },
    /** Starts the native BullMQ run loop. */
    run(): Promise<void> {
      calls.push(["run"])
      running = true
      if (options.run === "throw") throw new Error("run threw")
      if (options.run === "resolve") return Promise.resolve()
      return run.promise
    },
    /** Pauses admission and optionally waits for active jobs. */
    pause(doNotWaitActive?: boolean): Promise<void> {
      calls.push(["pause", doNotWaitActive])
      if (options.pause === "throw") throw new Error("pause threw")
      if (options.pause === "block") {
        const blockedUntil = performance.now() + 30
        while (performance.now() < blockedUntil) {
          // Deliberately model an upstream synchronous pause defect.
        }
      }
      if (options.pause !== "hold") {
        running = false
        return Promise.resolve()
      }
      return pause.promise.then(() => {
        running = false
      })
    },
    /** Cancels every active native job signal. */
    cancelAllJobs(reason?: string): void {
      calls.push(["cancelAllJobs", reason])
      if (options.cancel === "throw") throw new Error("cancelAllJobs threw")
    },
    /** Closes only the Worker-owned Redis connections. */
    close(force?: boolean): Promise<void> {
      calls.push(["close", force])
      if (options.close === "throw") throw new Error("close threw")
      if (options.close === "block") {
        const blockedUntil = performance.now() + 30
        while (performance.now() < blockedUntil) {
          // Deliberately model an upstream synchronous close defect.
        }
      }
      if (options.close === "hold") {
        closing = close.promise
        return close.promise
      }
      closing = Promise.resolve()
      if (!closed) {
        closed = true
        emitter.emit("closed")
      }
      return Promise.resolve()
    },
    /** Reports the fake native main-loop state. */
    isRunning(): boolean {
      return running
    }
  }

  const factory: BullMqWorkerFactoryLike = () => {
    calls.push(["factory"])
    return worker
  }

  return Object.freeze({
    factory,
    worker,
    calls,
    /** Releases readiness. */
    resolveReady(): void {
      ready.resolve({})
    },
    /** Rejects readiness. */
    rejectReady(error: unknown): void {
      ready.reject(error)
    },
    /** Resolves the run loop. */
    resolveRun(): void {
      run.resolve()
    },
    /** Rejects the run loop. */
    rejectRun(error: unknown): void {
      run.reject(error)
    },
    /** Resolves pause. */
    resolvePause(): void {
      pause.resolve()
    },
    /** Rejects pause. */
    rejectPause(error: unknown): void {
      pause.reject(error)
    },
    /** Resolves close after emitting its native terminal event. */
    resolveClose(): void {
      if (!closed) {
        closed = true
        emitter.emit("closed")
      }
      close.resolve()
    },
    /** Rejects close. */
    rejectClose(error: unknown): void {
      close.reject(error)
    },
    /** Emits a native worker error. */
    error(error: unknown): void {
      emitter.emit("error", error)
    },
    /** Emits native closure. */
    closed(): void {
      if (closed) return
      closed = true
      emitter.emit("closed")
    }
  })
}

/** Allows queued Promise reactions to advance deterministically. */
export async function turns(count = 4): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve()
}
