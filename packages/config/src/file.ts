import {
  objectSource,
  type ConfigObject,
  type ConfigSource,
  type ConfigSourceSnapshot,
  type ConfigSourceWatcher,
  type ConfigValue
} from "./config"
import { background, cause, type Context } from "@likego/context"
import { waitForContext } from "@likego/core/lifecycle"

export interface FileReadResult {
  readonly text: string
  readonly revision: string | null
}

/** Receives one source-owned dirty notification from an injected file watcher. */
export type FileChangeListener = () => void

export interface FileWatcher {
  /** Stops the native file subscription and releases its resources. */
  stop(ctx: Context): Promise<void>
  /** Returns the native subscription's stable terminal barrier. */
  done(): Promise<void>
}

export interface FileCapability {
  /** Reads one complete file document for the supplied operation Context. */
  read(ctx: Context, path: string): Promise<FileReadResult>
  /** Opens a private file change subscription and transfers its stop ownership to the source. */
  readonly watch?: (ctx: Context, path: string, changed: FileChangeListener) => Promise<FileWatcher>
}

/** Decodes complete file text into one configuration object. */
export type FileDecoder = (text: string, path: string) => ConfigObject

export interface FileSourceOptions {
  readonly name?: string
  /** Decodes complete file text; defaults to strict JSON object decoding. */
  readonly decode?: FileDecoder
}

interface CapturedFileCapability {
  readonly receiver: FileCapability
  readonly read: FileCapability["read"]
  readonly watch: FileCapability["watch"]
}

interface ChangeWaiter {
  readonly controller: AbortController
  readonly promise: Promise<void>
}

interface FileWatcherRuntime {
  readonly watcher: ConfigSourceWatcher
  readonly changed: FileChangeListener
}

const UnsafeKeys = new Set(["__proto__", "constructor", "prototype"])
const WatcherStopped = Object.freeze(new Error("file watcher has stopped"))
const FileChanged = Object.freeze({ event: "file-changed" })

/** Creates one signal-backed waiter that distinguishes change delivery from shutdown. */
function changeWaiter(): ChangeWaiter {
  const controller = new AbortController()
  /** Converts the one abort reason into notification success or terminal rejection. */
  function executor(resolve: () => void, reject: (error: unknown) => void): void {
    /** Settles the waiter from the source-owned abort reason. */
    function aborted(): void {
      if (controller.signal.reason === FileChanged) resolve()
      else reject(controller.signal.reason)
    }
    controller.signal.addEventListener("abort", aborted, { once: true })
  }
  return Object.freeze({ controller, promise: new Promise<void>(executor) })
}

/** Validates values produced by JSON.parse against the complete ConfigValue domain. */
function isJsonConfigValue(value: unknown): value is ConfigValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isJsonConfigValue(entry)) return false
    }
    return true
  }
  if (typeof value !== "object") return false
  for (const key of Object.keys(value)) {
    if (
      UnsafeKeys.has(key) ||
      !isJsonConfigValue(Object.getOwnPropertyDescriptor(value, key)?.value)
    )
      return false
  }
  return true
}

/** Narrows validated JSON to an object root rather than its array alternative. */
function isJsonConfigObject(value: unknown): value is ConfigObject {
  return (
    value !== null && !Array.isArray(value) && typeof value === "object" && isJsonConfigValue(value)
  )
}

/** Decodes strict JSON whose root is a safe configuration object. */
export function jsonFileDecoder(text: string, path: string): ConfigObject {
  const value: unknown = JSON.parse(text)
  if (!isJsonConfigObject(value)) {
    throw new TypeError(`file "${path}" must contain a JSON object`)
  }
  return value
}

/** Captures a stable filesystem capability so later caller mutation cannot replace operations. */
function captureCapability(capability: FileCapability): CapturedFileCapability {
  if (capability === null || typeof capability !== "object")
    throw new TypeError("file capability must be an object")
  const read = capability.read
  const watch = capability.watch
  if (typeof read !== "function" || (watch !== undefined && typeof watch !== "function")) {
    throw new TypeError("invalid file capability")
  }
  return Object.freeze({ receiver: capability, read, watch })
}

/** Validates one injected read result before decoding or publishing it. */
function captureReadResult(value: FileReadResult): FileReadResult {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.text !== "string" ||
    (typeof value.revision !== "string" && value.revision !== null)
  ) {
    throw new TypeError("invalid file read result")
  }
  return Object.freeze({ text: value.text, revision: value.revision })
}

/** Returns one Context's exact terminal cause when cancellation is already observable. */
function contextFailure(ctx: Context): Error | null {
  const failure = ctx.err()
  return failure === null ? null : (cause(ctx) ?? failure)
}

/** Adds one rollback failure once without duplicating the primary failure identity. */
function addRollbackFailure(failures: unknown[], primary: unknown, failure: unknown): void {
  if (failure === primary || failures.includes(failure)) return
  failures.push(failure)
}

/** Observes a native terminal rejection until its owning cleanup path joins it. */
function observeTerminalFailure(_error: unknown): void {}

/** Best-effort stops one provisionally transferred native watcher. */
async function rollbackAcceptedWatcher(
  watcher: FileWatcher,
  primary: unknown
): Promise<readonly unknown[]> {
  if (watcher === null || typeof watcher !== "object") return Object.freeze([])
  const failures: unknown[] = []
  let stopMethod: FileWatcher["stop"] | null = null
  let done: Promise<void> | null = null
  try {
    const supplied = watcher.stop
    if (typeof supplied === "function") stopMethod = supplied
  } catch (error) {
    addRollbackFailure(failures, primary, error)
  }
  try {
    const supplied = watcher.done
    if (typeof supplied === "function") {
      done = Promise.resolve(supplied.call(watcher))
      void done.catch(observeTerminalFailure)
    }
  } catch (error) {
    addRollbackFailure(failures, primary, error)
  }
  if (stopMethod !== null) {
    try {
      await Promise.resolve(stopMethod.call(watcher, background()))
    } catch (error) {
      addRollbackFailure(failures, primary, error)
    }
  }
  if (done !== null) {
    try {
      await done
    } catch (error) {
      addRollbackFailure(failures, primary, error)
    }
  }
  return Object.freeze(Array.from(failures))
}

/** Rejects one failed acceptance after preserving ordered watcher rollback failures. */
async function rejectAfterRollback(watcher: FileWatcher, primary: unknown): Promise<never> {
  const cleanupFailures = await rollbackAcceptedWatcher(watcher, primary)
  if (cleanupFailures.length === 0) throw primary
  const failures: unknown[] = [primary]
  for (const failure of cleanupFailures) failures.push(failure)
  throw new AggregateError(failures, "file watch acceptance and rollback failed")
}

/** Wraps one injected subscription with retained and coalesced ConfigSource notifications. */
function createWatcher(nativeWatcher: FileWatcher, initialDirty: boolean): FileWatcherRuntime {
  if (nativeWatcher === null || typeof nativeWatcher !== "object")
    throw new TypeError("invalid file watcher")
  const stopMethod = nativeWatcher.stop
  const doneMethod = nativeWatcher.done
  if (typeof stopMethod !== "function" || typeof doneMethod !== "function") {
    throw new TypeError("invalid file watcher")
  }
  const terminal = Promise.resolve(doneMethod.call(nativeWatcher))
  void terminal.catch(observeTerminalFailure)
  let dirty = initialDirty
  let stopped = false
  let waiting: ChangeWaiter | null = null
  let shutdown: Promise<void> | null = null

  /** Retains one dirty state or releases the one active waiter. */
  function changed(): void {
    if (stopped) return
    const current = waiting
    if (current === null) {
      dirty = true
      return
    }
    waiting = null
    current.controller.abort(FileChanged)
  }

  /** Starts and returns the one owner-scoped native subscription shutdown. */
  function startShutdown(): Promise<void> {
    if (shutdown !== null) return shutdown
    stopped = true
    const current = waiting
    waiting = null
    if (current !== null) current.controller.abort(WatcherStopped)
    try {
      shutdown = Promise.resolve(stopMethod.call(nativeWatcher, background())).then(
        /** Joins the native watcher's terminal fact after stop settles. */
        function joinTerminal(): Promise<void> {
          return terminal
        }
      )
    } catch (error) {
      shutdown = Promise.reject(error)
    }
    return shutdown
  }

  const watcher: ConfigSourceWatcher = Object.freeze({
    /** Waits for one retained/coalesced file change or the caller Context cancellation. */
    next(ctx: Context): Promise<void> {
      try {
        const failure = contextFailure(ctx)
        if (failure !== null) return Promise.reject(failure)
      } catch (error) {
        return Promise.reject(error)
      }
      if (stopped) return Promise.reject(WatcherStopped)
      if (dirty) {
        dirty = false
        return Promise.resolve()
      }
      if (waiting !== null) return Promise.reject(new Error("file watcher is already waiting"))
      const current = changeWaiter()
      waiting = current
      const closed = terminal.then(
        /** Treats passive native closure as an unexpected source termination. */
        function closedUnexpectedly(): never {
          throw WatcherStopped
        },
        /** Preserves the native terminal failure for the active Config watcher. */
        function failed(value: unknown): never {
          throw value
        }
      )
      /** Releases only the still-current waiter after cancellation or notification. */
      function release(): void {
        if (waiting === current) waiting = null
        current.controller.abort(WatcherStopped)
      }
      return waitForContext(ctx, Promise.race([current.promise, closed])).finally(release)
    },
    /** Joins the one private owner shutdown within only this caller's Context. */
    stop(ctx: Context): Promise<void> {
      return waitForContext(ctx, startShutdown())
    }
  })

  return Object.freeze({ watcher, changed })
}

/**
 * Creates a complete-file configuration source from a runtime-neutral injected capability.
 *
 * Read and optional watch operations receive Context first. The accepted watch subscription is
 * private, its change callbacks are retained/coalesced, and its stop lifecycle is owned by LikeGo.
 */
export function fileSource(
  capability: FileCapability,
  path: string,
  options: FileSourceOptions = {}
): ConfigSource {
  const captured = captureCapability(capability)
  const name = options.name ?? "file"
  const decode = options.decode ?? jsonFileDecoder
  if (typeof path !== "string" || path.length === 0)
    throw new TypeError("file path must be non-empty")
  if (typeof name !== "string" || name.length === 0)
    throw new TypeError("file source name must be non-empty")
  if (typeof decode !== "function") throw new TypeError("file decoder must be callable")

  /** Reads, decodes, validates, and snapshots one complete file revision. */
  async function load(ctx: Context): Promise<ConfigSourceSnapshot> {
    try {
      const initialFailure = contextFailure(ctx)
      if (initialFailure !== null) throw initialFailure
      const supplied = await captured.read.call(captured.receiver, ctx, path)
      const readFailure = contextFailure(ctx)
      if (readFailure !== null) throw readFailure
      const result = captureReadResult(supplied)
      const decoded = decode(result.text, path)
      const stable = await objectSource(name, decoded).load(ctx)
      const finalFailure = contextFailure(ctx)
      if (finalFailure !== null) throw finalFailure
      return Object.freeze({ value: stable.value, revision: result.revision })
    } catch (error) {
      throw contextFailure(ctx) ?? error
    }
  }

  if (captured.watch === undefined) return Object.freeze({ name, load })
  const watchCapability = captured.watch
  return Object.freeze({
    name,
    load,
    /** Opens and validates one injected subscription while retaining startup-gap changes. */
    async watch(ctx: Context, revision: string | null): Promise<ConfigSourceWatcher> {
      const initialFailure = contextFailure(ctx)
      if (initialFailure !== null) throw initialFailure
      let changed = false
      let accepted = false
      let runtime: FileWatcherRuntime | null = null
      /** Retains pre-acceptance changes and forwards later changes into the wrapper. */
      function changedListener(): void {
        if (!accepted || runtime === null) changed = true
        else runtime.changed()
      }
      let nativeWatcher: FileWatcher
      try {
        nativeWatcher = await watchCapability.call(captured.receiver, ctx, path, changedListener)
      } catch (error) {
        throw contextFailure(ctx) ?? error
      }
      let acceptanceFailure: Error | null
      try {
        acceptanceFailure = contextFailure(ctx)
      } catch (error) {
        return rejectAfterRollback(nativeWatcher, error)
      }
      if (acceptanceFailure !== null) return rejectAfterRollback(nativeWatcher, acceptanceFailure)
      let current: FileReadResult
      try {
        current = captureReadResult(await captured.read.call(captured.receiver, ctx, path))
        const readFailure = contextFailure(ctx)
        if (readFailure !== null) return rejectAfterRollback(nativeWatcher, readFailure)
      } catch (error) {
        let failure = error
        try {
          failure = contextFailure(ctx) ?? error
        } catch (inspectionFailure) {
          failure = inspectionFailure
        }
        return rejectAfterRollback(nativeWatcher, failure)
      }
      const retained = changed || current.revision !== revision
      changed = false
      try {
        runtime = createWatcher(nativeWatcher, retained)
      } catch (error) {
        return rejectAfterRollback(nativeWatcher, error)
      }
      accepted = true
      if (changed) runtime.changed()
      return runtime.watcher
    }
  })
}
