import { background, cause, deadlineExceeded, type Context } from "@go-like/context"
import { waitForContext } from "@go-like/core/lifecycle"
import { type ServiceInstance, type Watcher } from "@go-like/registry"
import {
  newRegistryProtocolError,
  newWatcherOverflowError,
  newWatcherStoppedError
} from "@go-like/registry/provider"

import { encodeBytes, prefixRangeEnd, recordPrefix } from "./codec"
import { boundaryError, newTransportError } from "./errors"
import { postWatch, retryable } from "./http"
import type { CapturedOptions, OperationOptions } from "./options"
import { rangeRecords, type RangeSnapshot } from "./protocol"
import { decodeSnapshot, instances } from "./records"
import { contextFailure, ignoreFailure, operationLease, waitForSignal } from "./runtime"

interface SnapshotWaiter {
  /** Resolves this exact caller wait. */
  readonly resolve: (value: readonly ServiceInstance[]) => void
  /** Rejects this exact caller wait. */
  readonly reject: (error: Error) => void
  readonly signal: AbortSignal | null
  /** Removes and rejects this exact wait after caller cancellation. */
  readonly aborted: () => void
}

interface WatchStream {
  readonly reader: ReadableStreamDefaultReader<Uint8Array>
  readonly decoder: TextDecoder
  readonly encoder: TextEncoder
  readonly pending: WatchFrame[]
  buffer: string
  bufferedBytes: number
  /** Releases resident linkage and response-body ownership. */
  close(): Promise<void>
}

interface WatchFrame {
  readonly revision: bigint
  readonly created: boolean
  readonly canceled: boolean
  readonly compactRevision: bigint
  readonly events: boolean
}

const MaximumWatchFrameBytes = 1_048_576

/** Reads Registry data and creates replacement-snapshot watchers. */
export interface DiscoveryManager {
  /** Reads complete instances for one service name. */
  getService(
    ctx: Context,
    name: string,
    options: OperationOptions
  ): Promise<readonly ServiceInstance[]>
  /** Opens one owned watcher after establishing its initial snapshot. */
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

/** Narrows one unknown watch carrier to a plain object. */
function object(value: unknown, message: string): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw newRegistryProtocolError(message)
  }
  return value
}

/** Parses one optional JSON int64 watch field. */
function integer(value: unknown, name: string): bigint {
  if (value === undefined) return 0n
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw newRegistryProtocolError(`etcd watch ${name} must be a decimal int64 string`)
  }
  return BigInt(value)
}

/** Validates one non-empty service name. */
function serviceName(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("etcd service name must be non-empty")
  }
  return value
}

/** Creates one canonical prefix watch request body. */
function watchBody(options: OperationOptions, startRevision: bigint): object {
  const prefix = recordPrefix(options.prefix)
  return Object.freeze({
    create_request: {
      key: encodeBytes(prefix),
      range_end: prefixRangeEnd(prefix),
      start_revision: String(startRevision),
      progress_notify: true
    }
  })
}

/** Wraps one successful watch response in a newline-frame reader. */
function stream(response: Response, release: () => void): WatchStream {
  const body = response.body
  if (body === null) throw newRegistryProtocolError("etcd watch response has no body")
  const reader = body.getReader()
  let closed = false
  return {
    reader,
    decoder: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }),
    encoder: new TextEncoder(),
    pending: [],
    buffer: "",
    bufferedBytes: 0,
    /** Cancels exactly this body and releases its linked owner listener. */
    async close(): Promise<void> {
      if (closed) return
      closed = true
      release()
      try {
        await reader.cancel()
      } catch (value) {
        ignoreFailure(value)
      }
    }
  }
}

/** Parses one complete newline-delimited watch JSON frame. */
function parseFrame(text: string): WatchFrame {
  let decoded: unknown
  try {
    decoded = JSON.parse(text)
  } catch (error) {
    throw newRegistryProtocolError(
      "etcd watch frame is not valid JSON",
      error instanceof Error ? error : undefined
    )
  }
  const envelope = object(decoded, "etcd watch frame envelope is invalid")
  const result = object(property(envelope, "result"), "etcd watch frame omitted its result")
  const headerValue = property(result, "header")
  let revision = 0n
  if (headerValue !== undefined) {
    const header = object(headerValue, "etcd watch frame header is invalid")
    revision = integer(property(header, "revision"), "header revision")
  }
  const created = property(result, "created") === true
  const canceled = property(result, "canceled") === true
  const compactRevision = integer(property(result, "compact_revision"), "compact revision")
  const rawEvents = property(result, "events")
  if (rawEvents !== undefined && !Array.isArray(rawEvents)) {
    throw newRegistryProtocolError("etcd watch events must be an array")
  }
  return Object.freeze({
    revision,
    created,
    canceled,
    compactRevision,
    events: Array.isArray(rawEvents) && rawEvents.length > 0
  })
}

/** Reads one complete newline-delimited frame or null at clean EOF. */
async function readFrame(value: WatchStream): Promise<WatchFrame | null> {
  const pending = value.pending.shift()
  if (pending !== undefined) return pending
  const newline = value.buffer.indexOf("\n")
  if (newline >= 0) {
    const line = value.buffer.slice(0, newline)
    const consumed = value.encoder.encode(`${line}\n`).byteLength
    if (consumed - 1 > MaximumWatchFrameBytes) {
      throw newRegistryProtocolError("etcd watch frame exceeds the byte limit")
    }
    value.buffer = value.buffer.slice(newline + 1)
    value.bufferedBytes -= consumed
    const frame = line.startsWith("\uFEFF") ? line.slice(1) : line
    if (frame.length === 0) return readFrame(value)
    return parseFrame(frame)
  }
  if (value.bufferedBytes > MaximumWatchFrameBytes) {
    throw newRegistryProtocolError("etcd watch frame exceeds the byte limit")
  }
  const chunk = await value.reader.read()
  if (chunk.done) {
    try {
      value.buffer += value.decoder.decode()
    } catch (error) {
      throw newRegistryProtocolError(
        "etcd watch stream contains invalid UTF-8",
        error instanceof Error ? error : undefined
      )
    }
    const tail = value.buffer.startsWith("\uFEFF") ? value.buffer.slice(1) : value.buffer
    value.buffer = ""
    value.bufferedBytes = 0
    if (tail.length === 0) return null
    return parseFrame(tail)
  }
  try {
    value.bufferedBytes += chunk.value.byteLength
    value.buffer += value.decoder.decode(chunk.value, { stream: true })
  } catch (error) {
    throw newRegistryProtocolError(
      "etcd watch stream contains invalid UTF-8",
      error instanceof Error ? error : undefined
    )
  }
  return readFrame(value)
}

/** Opens one resident watch and transfers its admitted connection to owner lifetime. */
async function residentWatch(
  options: OperationOptions,
  startRevision: bigint,
  owner: AbortSignal
): Promise<WatchStream> {
  const controller = new AbortController()
  /** Propagates the resident owner reason. */
  function ownerAborted(): void {
    if (!controller.signal.aborted) controller.abort(owner.reason)
  }
  if (owner.aborted) ownerAborted()
  else owner.addEventListener("abort", ownerAborted, { once: true })
  const timer = setTimeout(
    /** Bounds watch connection admission, not its resident lifetime. */
    function timedOut(): void {
      if (!controller.signal.aborted) controller.abort(deadlineExceeded)
    },
    options.timeoutMs
  )
  try {
    const response = await postWatch(options, watchBody(options, startRevision), controller.signal)
    const value = stream(response, function release(): void {
      owner.removeEventListener("abort", ownerAborted)
    })
    const first = await readFrame(value)
    if (first === null) {
      await value.close()
      throw newTransportError(
        "watch",
        new Error("etcd watch ended before creation"),
        options.token !== undefined
      )
    }
    if (!first.created && !first.canceled) {
      await value.close()
      throw newRegistryProtocolError("etcd watch first frame is neither created nor canceled")
    }
    if (first.canceled && first.compactRevision === 0n) {
      await value.close()
      throw newRegistryProtocolError("etcd watch was canceled without compaction")
    }
    clearTimeout(timer)
    value.pending.push(first)
    return value
  } catch (value) {
    clearTimeout(timer)
    owner.removeEventListener("abort", ownerAborted)
    throw value
  }
}

/** Compares two complete replacement snapshots by canonical public bytes. */
function sameSnapshot(
  left: readonly ServiceInstance[],
  right: readonly ServiceInstance[]
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Creates one replacement watcher after asynchronously decoding its initial range. */
async function createReplacementWatcher(
  provider: CapturedOptions,
  options: OperationOptions,
  name: string,
  bufferSize: number,
  initial: RangeSnapshot
): Promise<Watcher> {
  const decoded = await decodeSnapshot(options, initial)
  const initialValues = instances(decoded, name)
  return replacementWatcher(provider, options, name, bufferSize, initial, initialValues)
}

/** Creates the synchronous watcher state after initial decoding has completed. */
function replacementWatcher(
  provider: CapturedOptions,
  options: OperationOptions,
  name: string,
  bufferSize: number,
  initial: RangeSnapshot,
  initialValues: readonly ServiceInstance[]
): Watcher {
  const owner = new AbortController()
  const queue: (readonly ServiceInstance[])[] = initialValues.length === 0 ? [] : [initialValues]
  const waiters: SnapshotWaiter[] = []
  let current = initialValues
  let revision = initial.revision
  let failure: Error | null = null
  let stopped = false
  let shutdown: Promise<void> | null = null

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

  /** Relists one full snapshot and reconciles it against watcher state. */
  async function relist(): Promise<void> {
    const lease = operationLease(background(), owner.signal, options.timeoutMs)
    try {
      const snapshot = await rangeRecords(options, lease.signal)
      const next = instances(await decodeSnapshot(options, snapshot), name)
      revision = snapshot.revision
      if (!sameSnapshot(current, next)) {
        current = next
        emit(current)
      }
    } finally {
      lease.release()
    }
  }

  /** Pumps revisioned prefix watches, relisting on events and compaction. */
  async function pump(): Promise<void> {
    let retryMs = provider.retryInitialMs
    while (!owner.signal.aborted) {
      let active: WatchStream | null = null
      try {
        active = await residentWatch(options, revision + 1n, owner.signal)
        while (!owner.signal.aborted) {
          const frame = await readFrame(active)
          if (frame === null) {
            throw newTransportError(
              "watch",
              new Error("etcd watch stream ended"),
              options.token !== undefined
            )
          }
          if (frame.canceled) {
            if (frame.compactRevision === 0n) {
              throw newRegistryProtocolError("etcd watch was canceled without compaction")
            }
            await relist()
            break
          }
          if (frame.events) await relist()
          else if (frame.revision > revision) revision = frame.revision
          retryMs = provider.retryInitialMs
        }
      } catch (value) {
        if (owner.signal.aborted) break
        if (!retryable(value)) {
          fail(boundaryError(value, "etcd watcher rejected with a non-Error value"))
          break
        }
        try {
          await waitForSignal(owner.signal, retryMs)
        } catch {
          break
        }
        retryMs = Math.min(provider.retryMaximumMs, retryMs * 2)
      } finally {
        if (active !== null) await active.close()
      }
    }
  }

  const pumping = pump()
  void pumping.catch(ignoreFailure)

  return Object.freeze({
    /** Waits for one complete replacement snapshot under only the caller Context. */
    next(ctx: Context): Promise<readonly ServiceInstance[]> {
      if (failure !== null) return Promise.reject(failure)
      if (stopped) return Promise.reject(newWatcherStoppedError())
      const contextError = contextFailure(ctx)
      if (contextError !== null) return Promise.reject(contextError)
      const queued = queue.shift()
      if (queued !== undefined) return Promise.resolve(queued)
      return new Promise<readonly ServiceInstance[]>(
        /** Captures one caller-owned pending wait. */
        function wait(resolve, reject): void {
          const signal = ctx.done()
          let waiter: SnapshotWaiter
          /** Removes only this caller wait after cancellation. */
          function aborted(): void {
            signal?.removeEventListener("abort", aborted)
            const index = waiters.indexOf(waiter)
            if (index >= 0) waiters.splice(index, 1)
            reject(cause(ctx) ?? ctx.err() ?? new Error("etcd watcher wait was canceled"))
          }
          waiter = { resolve, reject, signal, aborted }
          waiters.push(waiter)
          signal?.addEventListener("abort", aborted, { once: true })
          if (signal?.aborted === true) aborted()
        }
      )
    },
    /** Stops the owner pump while only this caller can abandon its wait. */
    stop(ctx: Context): Promise<void> {
      if (shutdown === null) {
        stopped = true
        const stoppedError = newWatcherStoppedError()
        owner.abort(stoppedError)
        queue.length = 0
        for (const waiter of waiters.splice(0)) rejectWaiter(waiter, stoppedError)
        shutdown = pumping
      }
      return waitForContext(ctx, shutdown)
    }
  })
}

/** Creates the portable etcd query and watch manager. */
export function newDiscoveryManager(): DiscoveryManager {
  return Object.freeze({
    /** Reads one complete ServiceInstance snapshot. */
    async getService(
      ctx: Context,
      name: string,
      options: OperationOptions
    ): Promise<readonly ServiceInstance[]> {
      const initialFailure = contextFailure(ctx)
      if (initialFailure !== null) throw initialFailure
      const lease = operationLease(ctx, null, options.timeoutMs)
      try {
        const snapshot = await rangeRecords(options, lease.signal)
        const values = instances(await decodeSnapshot(options, snapshot), serviceName(name))
        const finalFailure = contextFailure(ctx)
        if (finalFailure !== null) throw finalFailure
        return values
      } catch (value) {
        throw (
          contextFailure(ctx) ?? boundaryError(value, "etcd get rejected with a non-Error value")
        )
      } finally {
        lease.release()
      }
    },
    /** Establishes a consistent snapshot before transferring watcher ownership. */
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
        const initial = await rangeRecords(options, lease.signal)
        const watcher = await createReplacementWatcher(
          provider,
          options,
          validName,
          provider.watchBufferSize,
          initial
        )
        const finalFailure = contextFailure(ctx)
        if (finalFailure !== null) {
          await watcher.stop(background())
          throw finalFailure
        }
        return watcher
      } catch (value) {
        throw (
          contextFailure(ctx) ??
          boundaryError(value, "etcd watch admission rejected with a non-Error value")
        )
      } finally {
        lease.release()
      }
    }
  })
}
