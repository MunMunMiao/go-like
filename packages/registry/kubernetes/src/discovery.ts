import { background, cause, deadlineExceeded, type Context } from "@go-like/context"
import { waitForContext } from "@go-like/core/lifecycle"
import { type ServiceInstance, type Watcher } from "@go-like/registry"
import {
  newRegistryProtocolError,
  newWatcherOverflowError,
  newWatcherStoppedError
} from "@go-like/registry/provider"

import { boundaryError, newHttpError } from "./errors"
import { gone, retryable } from "./http"
import type { CapturedOptions, OperationOptions } from "./options"
import { listSlices, watchSlices } from "./protocol"
import { instances, sameSnapshot } from "./records"
import { contextFailure, ignoreFailure, operationLease, waitForSignal } from "./runtime"
import type { SliceSnapshot } from "./codec"

interface SnapshotWaiter {
  readonly resolve: (value: readonly ServiceInstance[]) => void
  readonly reject: (error: Error) => void
  readonly signal: AbortSignal | null
  readonly aborted: () => void
}

interface WatchStream {
  readonly reader: ReadableStreamDefaultReader<Uint8Array>
  readonly decoder: TextDecoder
  readonly encoder: TextEncoder
  buffer: string
  bufferedBytes: number
  /** Releases body ownership and resident signal linkage. */
  close(): Promise<void>
}

interface WatchFrame {
  readonly resourceVersion: string | null
  readonly changed: boolean
}

const MaximumWatchFrameBytes = 1_048_576

/** Reads Registry data and creates namespace-scoped replacement watchers. */
export interface DiscoveryManager {
  /** Reads complete instances for one service name. */
  getService(
    ctx: Context,
    name: string,
    options: OperationOptions
  ): Promise<readonly ServiceInstance[]>
  /** Opens one owned replacement-snapshot watcher. */
  watch(
    ctx: Context,
    name: string,
    provider: CapturedOptions,
    options: OperationOptions
  ): Promise<Watcher>
}

/** Reads one own data property without invoking inherited accessors. */
function property(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

/** Narrows one unknown watch carrier to a non-array object. */
function object(value: unknown, message: string): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw newRegistryProtocolError(message)
  }
  return value
}

/** Validates one non-empty service name. */
function serviceName(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Kubernetes service name must be non-empty")
  }
  return value
}

/** Reads one watch object's optional resourceVersion. */
function objectResourceVersion(value: unknown): string | null {
  if (value === undefined) return null
  const carrier = object(value, "Kubernetes watch object is invalid")
  const metadata = property(carrier, "metadata")
  if (metadata === undefined) return null
  const metadataValue = object(metadata, "Kubernetes watch object metadata is invalid")
  const resourceVersion = property(metadataValue, "resourceVersion")
  if (resourceVersion === undefined) return null
  if (typeof resourceVersion !== "string" || resourceVersion.length === 0) {
    throw newRegistryProtocolError("Kubernetes watch resourceVersion is invalid")
  }
  return resourceVersion
}

/** Parses one complete Kubernetes watch JSON line. */
function parseFrame(text: string): WatchFrame {
  let decoded: unknown
  try {
    decoded = JSON.parse(text)
  } catch {
    throw newRegistryProtocolError("Kubernetes watch frame is not valid JSON")
  }
  const envelope = object(decoded, "Kubernetes watch frame is invalid")
  const type = property(envelope, "type")
  const payload = property(envelope, "object")
  if (type === "ERROR") {
    const status = object(payload, "Kubernetes watch error Status is invalid")
    if (property(status, "code") === 410) throw newHttpError("watch", 410)
    throw newRegistryProtocolError("Kubernetes watch returned an error Status")
  }
  if (type === "BOOKMARK") {
    return Object.freeze({ resourceVersion: objectResourceVersion(payload), changed: false })
  }
  if (type === "ADDED" || type === "MODIFIED" || type === "DELETED") {
    return Object.freeze({ resourceVersion: objectResourceVersion(payload), changed: true })
  }
  throw newRegistryProtocolError("Kubernetes watch frame has an unsupported event type")
}

/** Reads one newline-delimited watch frame or null at clean EOF. */
async function readFrame(stream: WatchStream): Promise<WatchFrame | null> {
  do {
    const newline = stream.buffer.indexOf("\n")
    if (newline >= 0) {
      const rawLine = stream.buffer.slice(0, newline)
      const consumed = stream.encoder.encode(`${rawLine}\n`).byteLength
      if (consumed - 1 > MaximumWatchFrameBytes) {
        throw newRegistryProtocolError("Kubernetes watch frame exceeds the byte limit")
      }
      const line = rawLine.trim()
      stream.buffer = stream.buffer.slice(newline + 1)
      stream.bufferedBytes -= consumed
      if (line.length !== 0) return parseFrame(line)
      continue
    }
    if (stream.bufferedBytes > MaximumWatchFrameBytes) {
      throw newRegistryProtocolError("Kubernetes watch frame exceeds the byte limit")
    }
    const chunk = await stream.reader.read()
    if (chunk.done) {
      try {
        stream.buffer += stream.decoder.decode()
      } catch {
        throw newRegistryProtocolError("Kubernetes watch stream contains invalid UTF-8")
      }
      const tail = stream.buffer.trim()
      stream.buffer = ""
      stream.bufferedBytes = 0
      return tail.length === 0 ? null : parseFrame(tail)
    }
    try {
      stream.bufferedBytes += chunk.value.byteLength
      stream.buffer += stream.decoder.decode(chunk.value, { stream: true })
    } catch {
      throw newRegistryProtocolError("Kubernetes watch stream contains invalid UTF-8")
    }
  } while (true)
}

/** Opens one resident watch whose body remains linked only to its owner after admission. */
async function residentWatch(
  options: OperationOptions,
  resourceVersion: string,
  owner: AbortSignal,
  caller: AbortSignal | null
): Promise<WatchStream> {
  const controller = new AbortController()
  /** Propagates the resident owner reason. */
  function ownerAborted(): void {
    if (!controller.signal.aborted) controller.abort(owner.reason)
  }
  /** Propagates only admission-time caller cancellation. */
  function callerAborted(): void {
    if (caller !== null && !controller.signal.aborted) controller.abort(caller.reason)
  }
  if (owner.aborted) ownerAborted()
  else owner.addEventListener("abort", ownerAborted, { once: true })
  if (caller?.aborted === true) callerAborted()
  else caller?.addEventListener("abort", callerAborted, { once: true })
  const timer = setTimeout(
    /** Bounds only Fetch response admission, not the resident body lifetime. */
    function timedOut(): void {
      if (!controller.signal.aborted) controller.abort(deadlineExceeded)
    },
    options.timeoutMs
  )
  try {
    const response = await watchSlices(options, resourceVersion, controller.signal)
    clearTimeout(timer)
    caller?.removeEventListener("abort", callerAborted)
    const body = response.body
    if (body === null) throw newRegistryProtocolError("Kubernetes watch response has no body")
    const reader = body.getReader()
    let closed = false
    return {
      reader,
      decoder: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }),
      encoder: new TextEncoder(),
      buffer: "",
      bufferedBytes: 0,
      /** Cancels exactly this body and releases owner linkage. */
      async close(): Promise<void> {
        if (closed) return
        closed = true
        owner.removeEventListener("abort", ownerAborted)
        try {
          await reader.cancel()
        } catch (value) {
          ignoreFailure(value)
        }
      }
    }
  } catch (value) {
    clearTimeout(timer)
    owner.removeEventListener("abort", ownerAborted)
    caller?.removeEventListener("abort", callerAborted)
    throw value
  }
}

/** Creates one resident replacement-snapshot watcher from a consistent list revision. */
async function replacementWatcher(
  ctx: Context,
  provider: CapturedOptions,
  options: OperationOptions,
  name: string,
  bufferSize: number,
  initial: SliceSnapshot
): Promise<Watcher> {
  const owner = new AbortController()
  const initialInstances = instances(initial.records, name)
  const queue: (readonly ServiceInstance[])[] = []
  const waiters: SnapshotWaiter[] = []
  let current = initialInstances
  let revision = initial.resourceVersion
  let failure: Error | null = null
  let stopped = false
  let shutdown: Promise<void> | null = null

  let admitted: WatchStream
  while (true) {
    try {
      admitted = await residentWatch(options, revision, owner.signal, ctx.done())
      break
    } catch (value) {
      if (!gone(value)) throw value
      const lease = operationLease(ctx, owner.signal, options.timeoutMs)
      try {
        const fresh = await listSlices(options, lease.signal)
        current = instances(fresh.records, name)
        revision = fresh.resourceVersion
      } finally {
        lease.release()
      }
    }
  }
  const admissionFailure = contextFailure(ctx)
  if (admissionFailure !== null) {
    owner.abort(admissionFailure)
    await admitted.close()
    throw admissionFailure
  }
  if (current.length !== 0) queue.push(current)

  /** Rejects and detaches one pending next waiter. */
  function rejectWaiter(waiter: SnapshotWaiter, error: Error): void {
    waiter.signal?.removeEventListener("abort", waiter.aborted)
    waiter.reject(error)
  }

  /** Terminates the watcher with one stable failure identity. */
  function fail(error: Error): void {
    if (failure !== null || stopped) return
    failure = error
    owner.abort(error)
    queue.length = 0
    for (const waiter of waiters.splice(0)) rejectWaiter(waiter, error)
  }

  /** Enqueues or directly delivers one complete replacement snapshot. */
  function emit(value: readonly ServiceInstance[]): void {
    if (failure !== null || stopped) return
    const waiter = waiters.shift()
    if (waiter !== undefined) {
      waiter.signal?.removeEventListener("abort", waiter.aborted)
      waiter.resolve(value)
      return
    }
    if (queue.length >= bufferSize) {
      fail(newWatcherOverflowError(bufferSize))
      return
    }
    queue.push(value)
  }

  /** Relists one full namespace snapshot and publishes a logical change. */
  async function relist(): Promise<void> {
    const lease = operationLease(background(), owner.signal, options.timeoutMs)
    try {
      const snapshot = await listSlices(options, lease.signal)
      const next = instances(snapshot.records, name)
      if (!sameSnapshot(current, next)) {
        current = next
        emit(next)
      }
      revision = snapshot.resourceVersion
    } finally {
      lease.release()
    }
  }

  /** Pumps watch frames until stopped or terminally failed. */
  async function pump(): Promise<void> {
    let active: WatchStream | null = admitted
    let retryMs = provider.retryInitialMs
    while (!owner.signal.aborted) {
      try {
        if (active === null) active = await residentWatch(options, revision, owner.signal, null)
        const frame = await readFrame(active)
        if (frame === null) {
          await active.close()
          active = null
          retryMs = provider.retryInitialMs
          continue
        }
        if (frame.changed) {
          await active.close()
          active = null
          await relist()
        } else if (frame.resourceVersion !== null) {
          revision = frame.resourceVersion
        }
        retryMs = provider.retryInitialMs
      } catch (value) {
        if (active !== null) {
          await active.close()
          active = null
        }
        if (owner.signal.aborted) break
        if (gone(value)) {
          await relist()
          retryMs = provider.retryInitialMs
          continue
        }
        if (!retryable(value)) {
          fail(boundaryError(value, "Kubernetes watcher failed"))
          break
        }
        try {
          await waitForSignal(owner.signal, retryMs)
        } catch (waitFailure) {
          ignoreFailure(waitFailure)
          break
        }
        retryMs = Math.min(provider.retryMaximumMs, retryMs * 2)
      }
    }
    if (active !== null) await active.close()
  }

  const pumping = pump()

  return Object.freeze({
    /** Waits for one complete replacement snapshot under only the caller Context. */
    next(nextContext: Context): Promise<readonly ServiceInstance[]> {
      if (failure !== null) return Promise.reject(failure)
      if (stopped) return Promise.reject(newWatcherStoppedError())
      const contextError = contextFailure(nextContext)
      if (contextError !== null) return Promise.reject(contextError)
      const queued = queue.shift()
      if (queued !== undefined) return Promise.resolve(queued)
      return new Promise<readonly ServiceInstance[]>(
        /** Captures one caller-owned pending wait. */
        function wait(resolve, reject): void {
          const signal = nextContext.done()
          let waiter: SnapshotWaiter
          /** Removes only this caller wait after cancellation. */
          function aborted(): void {
            signal?.removeEventListener("abort", aborted)
            const index = waiters.indexOf(waiter)
            if (index >= 0) waiters.splice(index, 1)
            reject(
              cause(nextContext) ??
                nextContext.err() ??
                new Error("Kubernetes watcher wait was canceled")
            )
          }
          waiter = { resolve, reject, signal, aborted }
          waiters.push(waiter)
          signal?.addEventListener("abort", aborted, { once: true })
          if (signal?.aborted === true) aborted()
        }
      )
    },
    /** Stops the owner stream while only this caller may abandon its wait. */
    stop(stopContext: Context): Promise<void> {
      if (shutdown === null) {
        stopped = true
        const stoppedError = newWatcherStoppedError()
        owner.abort(stoppedError)
        queue.length = 0
        for (const waiter of waiters.splice(0)) rejectWaiter(waiter, stoppedError)
        shutdown = pumping
        void shutdown.catch(ignoreFailure)
      }
      return waitForContext(stopContext, shutdown)
    }
  })
}

/** Creates the portable Kubernetes query and watch manager. */
export function newDiscoveryManager(): DiscoveryManager {
  return Object.freeze({
    /** Reads one verified ServiceInstance snapshot. */
    async getService(
      ctx: Context,
      name: string,
      options: OperationOptions
    ): Promise<readonly ServiceInstance[]> {
      const initialFailure = contextFailure(ctx)
      if (initialFailure !== null) throw initialFailure
      const lease = operationLease(ctx, null, options.timeoutMs)
      try {
        const snapshot = await listSlices(options, lease.signal)
        const finalFailure = contextFailure(ctx)
        if (finalFailure !== null) throw finalFailure
        return instances(snapshot.records, serviceName(name))
      } catch (value) {
        throw (
          contextFailure(ctx) ??
          boundaryError(value, "Kubernetes get rejected with a non-Error value")
        )
      } finally {
        lease.release()
      }
    },
    /** Establishes list/resourceVersion/watch ownership without a missed-event window. */
    async watch(
      ctx: Context,
      name: string,
      provider: CapturedOptions,
      options: OperationOptions
    ): Promise<Watcher> {
      const initialFailure = contextFailure(ctx)
      if (initialFailure !== null) throw initialFailure
      const validName = serviceName(name)
      const lease = operationLease(ctx, null, options.timeoutMs)
      try {
        const initial = await listSlices(options, lease.signal)
        const watcher = await replacementWatcher(
          ctx,
          provider,
          options,
          validName,
          provider.watchBufferSize,
          initial
        )
        const finalFailure = contextFailure(ctx)
        if (finalFailure !== null) {
          void watcher.stop(background()).catch(ignoreFailure)
          throw finalFailure
        }
        return watcher
      } catch (value) {
        throw (
          contextFailure(ctx) ??
          boundaryError(value, "Kubernetes watch admission rejected with a non-Error value")
        )
      } finally {
        lease.release()
      }
    }
  })
}
