/// <reference lib="es2024.promise" />

import { createHash } from "node:crypto"
import { watch as nativeWatch } from "node:fs"
import { readFile as nativeReadFile } from "node:fs/promises"
import { basename, dirname } from "node:path"

import { cause, type Context } from "@go-like/context"
import { waitForContext } from "@go-like/core/lifecycle"

import type { FileCapability, FileWatcher } from "./file"

/** Receives normalized events from one privately owned Node filesystem watcher. */
export interface NodeFileWatchCallbacks {
  /** Reports a directory entry change, or an unscoped change when Node omits the filename. */
  changed(fileName: string | null): void
  /** Reports one passive native watcher failure. */
  failed(error: unknown): void
  /** Reports native watcher closure. */
  closed(): void
}

/** Owns one captured native filesystem watcher. */
export interface NodeFileWatchResource {
  /** Requests native watcher closure exactly once at the owner boundary. */
  close(): void
  /** Removes the exact native listeners retained by this resource. */
  detach(): void
}

/** Supplies the narrow Node filesystem operations used by the public capability. */
export interface NodeFileIO {
  /** Reads one complete file, honoring the supplied Context signal when present. */
  readFile(path: string, signal: AbortSignal | null): Promise<Uint8Array>
  /** Starts one parent-directory watcher and returns its private owner resource. */
  watch(directory: string, callbacks: NodeFileWatchCallbacks): NodeFileWatchResource
}

interface CapturedIO {
  readonly receiver: NodeFileIO
  readonly readFile: NodeFileIO["readFile"]
  readonly watch: NodeFileIO["watch"]
}

interface CapturedWatchResource {
  readonly receiver: NodeFileWatchResource
  readonly close: NodeFileWatchResource["close"]
  readonly detach: NodeFileWatchResource["detach"]
}

interface Deferred {
  readonly promise: Promise<void>
  /** Resolves the controlled Promise once. */
  resolve(): void
  /** Rejects the controlled Promise once. */
  reject(error: Error): void
}

interface BoundaryCarrier {
  readonly then?: unknown
}

type WatchState = "starting" | "running" | "stopping" | "failing" | "terminal"

type PendingWatchEvent =
  | Readonly<{ readonly kind: "change"; readonly fileName: string | null }>
  | Readonly<{ readonly kind: "error"; readonly error: unknown }>
  | Readonly<{ readonly kind: "close" }>

const decoder = new TextDecoder("utf-8", { fatal: true })
const nativePromiseThen = Promise.prototype.then

/** Creates one externally settled Promise controller. */
function deferred(): Deferred {
  return Object.freeze(Promise.withResolvers<void>())
}

/** Marks one terminal Promise as observed without changing its owner-facing identity. */
function observe(operation: Promise<unknown>): void {
  void operation.catch(ignoreObservedFailure)
}

/** Intentionally consumes one already owner-visible terminal rejection. */
function ignoreObservedFailure(_error: unknown): void {}

/** Reports whether a value may expose a Promise-like settlement member. */
function isBoundaryCarrier(value: unknown): value is BoundaryCarrier {
  return (typeof value === "object" && value !== null) || typeof value === "function"
}

/** Attaches observers through the native Promise brand without reading hostile own members. */
function observeNativeSettlement(
  value: BoundaryCarrier,
  fulfilled: (result: unknown) => void,
  rejected: (reason: unknown) => void
): boolean {
  try {
    Function.prototype.call.call(nativePromiseThen, value, fulfilled, rejected)
    return true
  } catch {
    return false
  }
}

/** Observes rejected Promise/thenable carriers without changing boundary identity. */
function observeBoundaryCarrier(value: unknown, capturedThen: unknown = null): void {
  const seen = new WeakSet<object>()
  const pending: unknown[] = []
  let cursor = 0
  let draining = false
  let useCapturedThen = typeof capturedThen === "function"
  /** Follows every queued settlement, thrown value, and returned continuation iteratively. */
  function drain(): void {
    if (draining) return
    draining = true
    while (cursor < pending.length) {
      const candidate = pending[cursor]
      cursor += 1
      if (!isBoundaryCarrier(candidate)) continue
      if (seen.has(candidate)) continue
      seen.add(candidate)
      if (observeNativeSettlement(candidate, enqueue, enqueue)) continue
      let then: unknown
      if (useCapturedThen && candidate === value) {
        useCapturedThen = false
        then = capturedThen
      } else {
        try {
          then = candidate.then
        } catch (failure) {
          enqueue(failure)
          continue
        }
      }
      if (typeof then !== "function") {
        enqueue(then)
        continue
      }
      try {
        const continuation: unknown = Function.prototype.call.call(
          then,
          candidate,
          enqueue,
          enqueue
        )
        enqueue(continuation)
      } catch (failure) {
        enqueue(failure)
      }
    }
    pending.length = 0
    cursor = 0
    draining = false
  }
  /** Queues one boundary candidate and drains synchronously without recursive stack growth. */
  function enqueue(candidate: unknown): void {
    pending.push(candidate)
    drain()
  }
  enqueue(value)
}

/** Validates and observes one genuine Promise returned by the Node I/O contract. */
function isObservedNativePromise(value: unknown): value is Promise<unknown> {
  if (!isBoundaryCarrier(value)) return false
  return observeNativeSettlement(value, observeBoundaryCarrier, observeBoundaryCarrier)
}

/** Observes one callback result exactly once and routes its first rejection to owner failure. */
function observeCallbackResult(value: unknown, rejected: (reason: unknown) => void): void {
  const seen = new WeakSet<object>()
  let terminal = false
  /** Observes a discarded carrier without reinvoking one already adopted by this result. */
  function observeDiscarded(candidate: unknown): void {
    if (isBoundaryCarrier(candidate) && seen.has(candidate)) return
    observeBoundaryCarrier(candidate)
  }
  /** Routes the one adopted rejection and only observes settlements that arrive later. */
  function rejectResult(reason: unknown): void {
    if (terminal) return observeDiscarded(reason)
    observeDiscarded(reason)
    terminal = true
    rejected(reason)
  }
  /** Recursively adopts one result without recursively growing the JavaScript call stack. */
  function resolveResult(candidate: unknown): void {
    if (terminal) return observeDiscarded(candidate)
    if (!isBoundaryCarrier(candidate)) {
      terminal = true
      return
    }
    if (seen.has(candidate))
      return rejectResult(new TypeError("Node file change listener returned a cyclic thenable"))
    seen.add(candidate)
    if (observeNativeSettlement(candidate, resolveResult, rejectResult)) return
    let then: unknown
    try {
      then = candidate.then
    } catch (failure) {
      rejectResult(failure)
      return
    }
    if (typeof then !== "function") {
      observeDiscarded(then)
      terminal = true
      return
    }
    let called = false
    /** Adopts only the first structural fulfillment. */
    function fulfilled(result: unknown): void {
      if (called) {
        observeDiscarded(result)
        return
      }
      called = true
      /** Adopts one deferred structural fulfillment. */
      function adoptFulfillment(): void {
        resolveResult(result)
      }
      queueMicrotask(adoptFulfillment)
    }
    /** Adopts only the first structural rejection. */
    function rejectedOnce(reason: unknown): void {
      if (called) {
        observeDiscarded(reason)
        return
      }
      called = true
      rejectResult(reason)
    }
    try {
      const continuation: unknown = Function.prototype.call.call(
        then,
        candidate,
        fulfilled,
        rejectedOnce
      )
      observeDiscarded(continuation)
    } catch (failure) {
      if (called) observeDiscarded(failure)
      else rejectedOnce(failure)
    }
  }
  resolveResult(value)
}

/** Rejects an asynchronous result from one contractually synchronous owner method. */
function synchronousResultFailure(value: unknown, message: string): Error | null {
  if (!isBoundaryCarrier(value)) return null
  if (observeNativeSettlement(value, observeBoundaryCarrier, observeBoundaryCarrier)) {
    return new TypeError(message)
  }
  let then: unknown
  try {
    then = value.then
  } catch (failure) {
    return normalizeError(failure, `${message} then inspection failed`)
  }
  if (typeof then !== "function") {
    observeBoundaryCarrier(then)
    return null
  }
  observeBoundaryCarrier(value, then)
  return new TypeError(message)
}

/** Returns the caller's exact Context terminal cause when cancellation is observable. */
function contextFailure(ctx: Context): Error | null {
  const failure = ctx.err()
  return failure === null ? null : (cause(ctx) ?? failure)
}

/** Throws the caller's exact cancellation cause before native I/O. */
function checkContext(ctx: Context): void {
  const failure = contextFailure(ctx)
  if (failure !== null) throw failure
}

/** Preserves native Error identity after its boundary value has been observed. */
function preservedError(value: unknown, message: string): Error {
  return value instanceof Error ? value : Object.freeze(new Error(message, { cause: value }))
}

/** Observes one boundary value before preserving or normalizing its Error. */
function normalizeError(value: unknown, message: string): Error {
  observeBoundaryCarrier(value)
  return preservedError(value, message)
}

/** Extracts one framework aggregate without losing its established failure order. */
function containedFailures(value: unknown, message: string): readonly Error[] {
  const failure = normalizeError(value, message)
  if (!(failure instanceof AggregateError)) return Object.freeze([failure])
  const failures: Error[] = []
  for (const nested of failure.errors) {
    const normalized = normalizeError(nested, message)
    if (!failures.includes(normalized)) failures.push(normalized)
  }
  if (failures.length === 0) failures.push(failure)
  return Object.freeze(failures)
}

/** Returns one primary Error or an ordered immutable cleanup aggregate. */
function combinedFailure(
  primary: Error | null,
  cleanup: readonly Error[],
  message: string
): Error | null {
  if (primary === null && cleanup.length === 0) return null
  if (primary !== null && cleanup.length === 0) return primary
  if (primary === null && cleanup.length === 1) return cleanup[0] ?? null
  const failures: Error[] = []
  if (primary !== null) failures.push(primary)
  for (const failure of cleanup) {
    if (!failures.includes(failure)) failures.push(failure)
  }
  return Object.freeze(new AggregateError(Object.freeze(failures), message))
}

/** Validates one direct Node filesystem path without rewriting caller intent. */
function filePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError("Node configuration file path is invalid")
  }
  const name = basename(value)
  if (name.length === 0 || name === "." || name === "..") {
    throw new TypeError("Node configuration file path must identify a file")
  }
  return value
}

/** Captures stable I/O methods so caller mutation cannot replace admitted behavior. */
function captureIO(value: NodeFileIO): CapturedIO {
  if (value === null || typeof value !== "object") {
    throw new TypeError("Node file I/O must be an object")
  }
  let readFile: NodeFileIO["readFile"] | null = null
  let watch: NodeFileIO["watch"] | null = null
  let primary: Error | null = null
  try {
    const supplied = value.readFile
    if (typeof supplied === "function") readFile = supplied
    else {
      observeBoundaryCarrier(supplied)
      primary = new TypeError("Node file I/O must implement readFile and watch")
    }
  } catch (failure) {
    primary = normalizeError(failure, "Node file I/O readFile capture failed")
  }
  try {
    const supplied = value.watch
    if (typeof supplied === "function") watch = supplied
    else {
      observeBoundaryCarrier(supplied)
      if (primary === null)
        primary = new TypeError("Node file I/O must implement readFile and watch")
    }
  } catch (value) {
    const failure = normalizeError(value, "Node file I/O watch capture failed")
    if (primary === null) primary = failure
  }
  if (primary !== null) throw primary
  if (readFile === null || watch === null)
    throw new TypeError("Node file I/O must implement readFile and watch")
  return Object.freeze({ receiver: value, readFile, watch })
}

/** Captures one watcher owner or rolls back every method captured before rejection. */
function captureWatchResource(value: NodeFileWatchResource): CapturedWatchResource {
  if (value === null || typeof value !== "object") {
    throw new TypeError("Node file watcher resource must be an object")
  }
  let close: NodeFileWatchResource["close"] | null = null
  let detach: NodeFileWatchResource["detach"] | null = null
  let primary: Error | null = null
  const cleanup: Error[] = []
  try {
    const supplied = value.close
    if (typeof supplied === "function") close = supplied
    else {
      observeBoundaryCarrier(supplied)
      primary = new TypeError("Node file watcher resource close must be callable")
    }
  } catch (failure) {
    primary = normalizeError(failure, "Node file watcher resource close capture failed")
  }
  try {
    const supplied = value.detach
    if (typeof supplied === "function") detach = supplied
    else {
      observeBoundaryCarrier(supplied)
      const failure = new TypeError("Node file watcher resource detach must be callable")
      if (primary === null) primary = failure
      else cleanup.push(failure)
    }
  } catch (value) {
    const failure = normalizeError(value, "Node file watcher resource detach capture failed")
    if (primary === null) primary = failure
    else cleanup.push(failure)
  }
  if (primary === null && close !== null && detach !== null) {
    return Object.freeze({ receiver: value, close, detach })
  }
  if (close !== null) {
    try {
      const result = close.call(value)
      const asyncFailure = synchronousResultFailure(
        result,
        "Node file watcher admission close must settle synchronously"
      )
      if (asyncFailure !== null) cleanup.push(asyncFailure)
    } catch (failure) {
      cleanup.push(normalizeError(failure, "Node file watcher admission close failed"))
    }
  }
  if (detach !== null) {
    try {
      const result = detach.call(value)
      const asyncFailure = synchronousResultFailure(
        result,
        "Node file watcher admission detach must settle synchronously"
      )
      if (asyncFailure !== null) cleanup.push(asyncFailure)
    } catch (failure) {
      cleanup.push(normalizeError(failure, "Node file watcher admission detach failed"))
    }
  }
  const failure = primary ?? new TypeError("Node file watcher resource is incomplete")
  throw combinedFailure(failure, cleanup, "Node file watcher admission cleanup failed") ?? failure
}

/** Computes one content-addressed revision from the complete detached file bytes. */
function contentRevision(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

/** Converts one native filename into the UTF-8 name used for parent-directory filtering. */
function nativeFileName(value: string | Buffer | null): string | null {
  return value === null || typeof value === "string" ? value : value.toString("utf8")
}

const DefaultIO: NodeFileIO = Object.freeze({
  /** Reads complete raw bytes without retaining the native Buffer. */
  async readFile(path: string, signal: AbortSignal | null): Promise<Uint8Array> {
    const bytes =
      signal === null ? await nativeReadFile(path) : await nativeReadFile(path, { signal })
    return new Uint8Array(bytes)
  },
  /** Watches a parent directory so atomic replacement keeps producing target events. */
  watch(directory: string, callbacks: NodeFileWatchCallbacks): NodeFileWatchResource {
    const watcher = nativeWatch(directory, { encoding: "utf8", persistent: false })
    /** Projects one Node directory event into a normalized filename callback. */
    function changed(_eventType: string, fileName: string | Buffer | null): void {
      callbacks.changed(nativeFileName(fileName))
    }
    watcher.on("change", changed)
    watcher.on("error", callbacks.failed)
    watcher.on("close", callbacks.closed)
    return Object.freeze({
      /** Closes the native watcher. */
      close(): void {
        watcher.close()
      },
      /** Removes the exact listeners installed by this capability. */
      detach(): void {
        watcher.off("change", changed)
        watcher.off("error", callbacks.failed)
        watcher.off("close", callbacks.closed)
      }
    })
  }
})

/** Creates one strict FileWatcher around a captured parent-directory watcher. */
async function watchFile(
  io: CapturedIO,
  ctx: Context,
  path: string,
  changed: () => void
): Promise<FileWatcher> {
  checkContext(ctx)
  if (typeof changed !== "function") throw new TypeError("file change listener must be callable")
  const selectedPath = filePath(path)
  const target = basename(selectedPath)
  const pending: PendingWatchEvent[] = []
  const terminal = deferred()
  observe(terminal.promise)
  let resource: CapturedWatchResource | null = null
  let state: WatchState = "starting"
  let settled = false
  let closeInProgress = false
  let closePending = false
  let primaryFailure: Error | null = null
  const cleanupFailures: Error[] = []

  /** Settles the stable terminal after detaching every retained native listener. */
  function finish(): void {
    if (settled) return
    settled = true
    state = "terminal"
    if (resource !== null) {
      try {
        const result = resource.detach.call(resource.receiver)
        const asyncFailure = synchronousResultFailure(
          result,
          "Node file watcher listener cleanup must settle synchronously"
        )
        if (asyncFailure !== null) cleanupFailures.push(asyncFailure)
      } catch (value) {
        cleanupFailures.push(normalizeError(value, "Node file watcher listener cleanup failed"))
      }
    }
    const finalFailure = combinedFailure(
      primaryFailure,
      cleanupFailures,
      "Node file watcher terminal cleanup failed"
    )
    if (finalFailure === null) {
      terminal.resolve()
    } else {
      terminal.reject(finalFailure)
    }
  }

  /** Calls close without letting its synchronous close event settle before it returns. */
  function closeResource(owned: CapturedWatchResource, message: string): void {
    closeInProgress = true
    let closeFailed = false
    try {
      const result = owned.close.call(owned.receiver)
      const asyncFailure = synchronousResultFailure(
        result,
        "Node file watcher close must settle synchronously"
      )
      if (asyncFailure !== null) {
        closeFailed = true
        cleanupFailures.push(asyncFailure)
      }
    } catch (value) {
      closeFailed = true
      cleanupFailures.push(normalizeError(value, message))
    }
    closeInProgress = false
    if (closePending || closeFailed) {
      closePending = false
      finish()
    }
  }

  /** Closes the native watcher after one operational or callback failure. */
  function fail(value: unknown, message: string, observed = false): void {
    if (!observed) observeBoundaryCarrier(value)
    if (settled || state === "failing") return
    const previous = state
    if (primaryFailure === null) primaryFailure = preservedError(value, message)
    state = "failing"
    if (resource !== null && previous === "running") {
      closeResource(resource, "Node file watcher failure close failed")
    }
  }

  /** Routes one returned change-listener thenable rejection into watcher failure. */
  function changeRejected(value: unknown): void {
    fail(value, "Node file change listener failed")
  }

  /** Routes one rejection already observed by the callback result adopter. */
  function observedChangeRejected(value: unknown): void {
    fail(value, "Node file change listener failed", true)
  }

  /** Applies one normalized native event after the watcher resource has been captured. */
  function apply(event: PendingWatchEvent): void {
    if (event.kind === "error") {
      fail(event.error, "Node file watcher failed")
      return
    }
    if (event.kind === "close") {
      if (closeInProgress) {
        closePending = true
        return
      }
      if (state === "stopping" || state === "failing") finish()
      else if (state === "running") {
        primaryFailure = new Error("Node file watcher closed unexpectedly")
        state = "failing"
        finish()
      }
      return
    }
    if (state !== "running") return
    if (event.fileName !== null && event.fileName !== target) return
    try {
      const result = changed()
      observeCallbackResult(result, observedChangeRejected)
    } catch (value) {
      changeRejected(value)
    }
  }

  /** Queues synchronous admission events and applies later native events immediately. */
  function dispatch(event: PendingWatchEvent): void {
    if (resource === null) pending.push(event)
    else apply(event)
  }

  const callbacks: NodeFileWatchCallbacks = Object.freeze({
    /** Receives one possibly unscoped directory change. */
    changed(fileName: string | null): void {
      dispatch(Object.freeze({ kind: "change", fileName }))
    },
    /** Receives one passive native failure. */
    failed(error: unknown): void {
      dispatch(Object.freeze({ kind: "error", error }))
    },
    /** Receives native closure. */
    closed(): void {
      dispatch(Object.freeze({ kind: "close" }))
    }
  })

  /** Rolls one captured admission back while retaining Context as the primary cause. */
  async function rollbackCancellation(
    cancellation: Error,
    admittedResource: CapturedWatchResource
  ): Promise<never> {
    if (state === "running") {
      state = "stopping"
      closeResource(admittedResource, "Node file watcher cancellation close failed")
    }
    try {
      await terminal.promise
    } catch (value) {
      throw combinedFailure(
        cancellation,
        containedFailures(value, "Node file watcher cancellation cleanup failed"),
        "Node file watcher admission cancellation cleanup failed"
      )
    }
    throw cancellation
  }

  let admittedResource: CapturedWatchResource
  let supplied: NodeFileWatchResource
  try {
    supplied = io.watch.call(io.receiver, dirname(selectedPath), callbacks)
    observeBoundaryCarrier(supplied)
  } catch (value) {
    const admissionFailure = normalizeError(value, "Node file watcher admission failed")
    throw contextFailure(ctx) ?? admissionFailure
  }
  try {
    admittedResource = captureWatchResource(supplied)
    resource = admittedResource
  } catch (value) {
    const cancellation = contextFailure(ctx)
    if (cancellation === null)
      throw normalizeError(value, "Node file watcher resource capture failed")
    throw combinedFailure(
      cancellation,
      containedFailures(value, "Node file watcher resource capture failed"),
      "Node file watcher capture cancellation cleanup failed"
    )
  }
  state = "running"
  const cancellation = contextFailure(ctx)
  if (cancellation !== null) await rollbackCancellation(cancellation, admittedResource)
  for (const event of pending) apply(event)
  const replayCancellation = contextFailure(ctx)
  if (replayCancellation !== null) await rollbackCancellation(replayCancellation, admittedResource)
  if (state !== "running") await terminal.promise

  /** Starts the one native owner shutdown and joins its close event. */
  function startShutdown(): Promise<void> {
    if (state !== "running") return terminal.promise
    state = "stopping"
    closeResource(admittedResource, "Node file watcher close failed")
    return terminal.promise
  }

  const handle: FileWatcher = Object.freeze({
    /** Starts idempotent owner shutdown while ctx bounds only this caller's wait. */
    async stop(stopContext: Context): Promise<void> {
      checkContext(stopContext)
      await waitForContext(stopContext, startShutdown())
    },
    /** Returns the stable native watcher terminal barrier. */
    done(): Promise<void> {
      return terminal.promise
    }
  })

  return handle
}

/** Creates the Node FileCapability over an injected deterministic filesystem boundary. */
export function newNodeFileCapabilityWithIO(io: NodeFileIO): FileCapability {
  const captured = captureIO(io)
  return Object.freeze({
    /** Reads and hashes one complete file under the caller-owned Context. */
    async read(ctx: Context, path: string) {
      checkContext(ctx)
      const selectedPath = filePath(path)
      let supplied: Uint8Array
      try {
        const operation = captured.readFile.call(captured.receiver, selectedPath, ctx.done())
        if (!isObservedNativePromise(operation)) {
          observeBoundaryCarrier(operation)
          throw new TypeError("Node file read must return a native Promise")
        }
        supplied = await operation
      } catch (value) {
        const readFailure = normalizeError(value, "Node configuration file read failed")
        throw contextFailure(ctx) ?? readFailure
      }
      checkContext(ctx)
      if (!(supplied instanceof Uint8Array)) {
        throw new TypeError("Node file read must return Uint8Array")
      }
      const bytes = new Uint8Array(supplied)
      return Object.freeze({ text: decoder.decode(bytes), revision: contentRevision(bytes) })
    },
    /** Watches the target's parent directory so rename replacement remains observable. */
    watch(ctx: Context, path: string, changed: () => void): Promise<FileWatcher> {
      return watchFile(captured, ctx, path, changed)
    }
  })
}

/** Creates the production Node FileCapability without performing filesystem I/O. */
export function newNodeFileCapability(): FileCapability {
  return newNodeFileCapabilityWithIO(DefaultIO)
}
