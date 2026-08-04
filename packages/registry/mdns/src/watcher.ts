/// <reference lib="es2024.promise" />

import { afterFunc, canceled, cause, type Context, type StopFunc } from "@go-like/context"
import { type ServiceInstance } from "@go-like/registry"
import {
  newWatcherOverflowError,
  newWatcherStoppedError,
  snapshotServiceInstances
} from "@go-like/registry/provider"

interface Deferred<T> {
  readonly promise: Promise<T>
  /** Resolves the deferred value exactly once. */
  readonly resolve: (value: T) => void
  /** Rejects the deferred value exactly once. */
  readonly reject: (reason?: unknown) => void
}

interface SnapshotWaiter {
  readonly deferred: Deferred<readonly ServiceInstance[]>
  readonly stop: StopFunc
  /** Settles an admitted caller cancellation with its exact Context cause. */
  readonly cancel: () => void
  state: "waiting" | "claiming" | "delivered" | "abandoned"
}

/** Creates one externally settleable Promise pair. */
function deferred<T>(): Deferred<T> {
  return Object.freeze(Promise.withResolvers<T>())
}

/** Returns the exact terminal Context cause, or null while active. */
function contextFailure(ctx: Context): Error | null {
  return cause(ctx)
}

/** Releases a Context callback without replacing a delivery that already won. */
function stopWithoutReplacingWinner(stop: StopFunc): boolean {
  try {
    return stop()
  } catch {
    return true
  }
}

/** Observes an intentionally published terminal rejection. */
function observeTerminal(_value: unknown): void {}

/** Owns one bounded ServiceInstance snapshot queue independently from its network listener. */
export interface SnapshotQueue {
  /** Returns the stable queue terminal Promise. */
  settled(): Promise<void>
  /** Waits for one result under the caller Context. */
  next(ctx: Context): Promise<readonly ServiceInstance[]>
  /** Publishes one immutable result or returns the terminal overflow failure. */
  push(result: readonly ServiceInstance[]): Error | null
  /** Terminates the queue with one supplied passive failure. */
  fail(error: Error): Error
  /** Stops the queue normally and returns the stable next-call stopped error. */
  stop(): Error
}

/** Creates one bounded ServiceInstance snapshot queue. */
export function newSnapshotQueue(_bufferSize: number): SnapshotQueue {
  if (!Number.isInteger(_bufferSize) || _bufferSize < 1 || _bufferSize > 4_096) {
    throw new RangeError("mDNS watcher bufferSize must be an integer from 1 through 4096")
  }
  const values: (readonly ServiceInstance[])[] = []
  const waiters: SnapshotWaiter[] = []
  const ownedWaiters = new Set<SnapshotWaiter>()
  const terminal = deferred<void>()
  void terminal.promise.catch(observeTerminal)
  const stoppedError = newWatcherStoppedError()
  let state: "running" | "stopped" | "failed" = "running"
  let failure: Error | null = null
  let activeOperations = 0
  let publishingTerminal = false
  let terminalPublished = false

  /** Returns the stable owner terminal error, or null while the queue is running. */
  function ownerError(): Error | null {
    if (failure !== null) return failure
    return state === "stopped" ? stoppedError : null
  }

  /** Rejects one waiter after its caller cancellation has already won admission. */
  function abandonWaiter(waiter: SnapshotWaiter, error: unknown): boolean {
    if (waiter.state !== "waiting") return false
    waiter.state = "abandoned"
    ownedWaiters.delete(waiter)
    waiter.deferred.reject(error)
    return true
  }

  /** Rejects one waiter only when queue termination wins its Context race. */
  function rejectWaiter(waiter: SnapshotWaiter, error: Error): boolean {
    if (waiter.state !== "waiting") return false
    waiter.state = "claiming"
    if (!stopWithoutReplacingWinner(waiter.stop)) {
      waiter.state = "waiting"
      waiter.cancel()
      return false
    }
    waiter.state = "abandoned"
    ownedWaiters.delete(waiter)
    waiter.deferred.reject(error)
    return true
  }

  /** Delivers one immutable readonly ServiceInstance[] only when the waiter still owns its wait. */
  function deliverWaiter(waiter: SnapshotWaiter, value: readonly ServiceInstance[]): boolean {
    if (waiter.state !== "waiting") return false
    waiter.state = "claiming"
    if (!stopWithoutReplacingWinner(waiter.stop)) {
      waiter.state = "waiting"
      waiter.cancel()
      return false
    }
    const terminalError = ownerError()
    if (terminalError !== null) {
      waiter.state = "abandoned"
      ownedWaiters.delete(waiter)
      waiter.deferred.reject(terminalError)
      return false
    }
    waiter.state = "delivered"
    ownedWaiters.delete(waiter)
    waiter.deferred.resolve(value)
    return true
  }

  /** Settles every owned next waiter before publishing the queue terminal. */
  function rejectWaiters(error: Error): void {
    waiters.splice(0)
    for (const waiter of Array.from(ownedWaiters)) rejectWaiter(waiter, error)
  }

  /** Publishes owner termination only after the current synchronous queue operation exits. */
  function publishTerminal(): void {
    if (state === "running" || terminalPublished || publishingTerminal || activeOperations !== 0)
      return
    publishingTerminal = true
    const terminalError = failure ?? stoppedError
    rejectWaiters(terminalError)
    terminalPublished = true
    if (state === "failed") terminal.reject(terminalError)
    else terminal.resolve(undefined)
    publishingTerminal = false
  }

  const queue: SnapshotQueue = Object.freeze({
    /** Returns the stable terminal Promise for this queue. */
    settled(): Promise<void> {
      return terminal.promise
    },
    /** Waits for one queued readonly ServiceInstance[] under a caller-owned Context. */
    next(ctx: Context): Promise<readonly ServiceInstance[]> {
      activeOperations += 1
      try {
        const entryError = ownerError()
        if (entryError !== null) return Promise.reject(entryError)
        let cancellation: Error | null
        try {
          cancellation = contextFailure(ctx)
        } catch (error) {
          return Promise.reject(ownerError() ?? error)
        }
        const inspectedOwnerError = ownerError()
        if (inspectedOwnerError !== null) return Promise.reject(inspectedOwnerError)
        if (cancellation !== null) return Promise.reject(cancellation)
        const pending = deferred<readonly ServiceInstance[]>()
        let waiter: SnapshotWaiter | null = null
        /** Rejects and removes only this caller wait after cancellation admission. */
        function canceledWaiter(): void {
          activeOperations += 1
          try {
            const selected = waiter
            if (selected === null || selected.state !== "waiting") return
            const index = waiters.indexOf(selected)
            if (index >= 0) waiters.splice(index, 1)
            try {
              abandonWaiter(selected, contextFailure(ctx) ?? canceled)
            } catch (error) {
              abandonWaiter(selected, error)
            }
          } finally {
            activeOperations -= 1
            publishTerminal()
          }
        }
        let stop: StopFunc
        try {
          stop = afterFunc(ctx, canceledWaiter)
        } catch (error) {
          pending.reject(ownerError() ?? error)
          return pending.promise
        }
        waiter = {
          deferred: pending,
          stop,
          cancel: canceledWaiter,
          state: "waiting"
        }
        ownedWaiters.add(waiter)
        if (waiter.state !== "waiting" || ownerError() !== null) return pending.promise
        const value = values[0]
        if (value !== undefined) {
          if (deliverWaiter(waiter, value)) values.shift()
          return pending.promise
        }
        if (ownerError() === null) waiters.push(waiter)
        return pending.promise
      } finally {
        activeOperations -= 1
        publishTerminal()
      }
    },
    /** Publishes one readonly ServiceInstance[] or transitions to stable overflow failure. */
    push(value: readonly ServiceInstance[]): Error | null {
      activeOperations += 1
      try {
        const entryError = ownerError()
        if (entryError !== null) return entryError
        let snapshot: readonly ServiceInstance[]
        try {
          snapshot = snapshotServiceInstances(value)
        } catch (error) {
          const snapshotOwnerError = ownerError()
          if (snapshotOwnerError !== null) return snapshotOwnerError
          throw error
        }
        const snapshotOwnerError = ownerError()
        if (snapshotOwnerError !== null) return snapshotOwnerError
        for (;;) {
          const waiter = waiters.shift()
          if (waiter === undefined) break
          if (deliverWaiter(waiter, snapshot)) return null
          const deliveryOwnerError = ownerError()
          if (deliveryOwnerError !== null) return deliveryOwnerError
        }
        if (values.length >= _bufferSize) {
          const overflow = newWatcherOverflowError(_bufferSize)
          failure = overflow
          state = "failed"
          values.splice(0)
          return overflow
        }
        values.push(snapshot)
        return null
      } finally {
        activeOperations -= 1
        publishTerminal()
      }
    },
    /** Transitions the queue to one supplied passive terminal failure. */
    fail(error: Error): Error {
      const existingError = ownerError()
      if (existingError !== null) return existingError
      if (!(error instanceof Error)) throw new TypeError("mDNS watcher failure must be an Error")
      failure = error
      state = "failed"
      values.splice(0)
      publishTerminal()
      return error
    },
    /** Stops the queue normally and settles its owner terminal. */
    stop(): Error {
      if (state === "running") {
        state = "stopped"
        values.splice(0)
        publishTerminal()
      }
      return stoppedError
    }
  })
  return queue
}
