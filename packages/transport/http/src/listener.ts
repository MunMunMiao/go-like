import { background, canceled, withCancel, type Context } from "@go-like/context"
import { type AcceptHandler, type TransportLogger } from "@go-like/transport"
import {
  newTransportClosedError,
  newTransportStateError,
  type TransportClosedError
} from "@go-like/transport/provider"
import { contextError, newHTTPTransportUnexpectedExitError, normalizeHTTPError } from "./errors"
import { defaultHTTPMaxMessageBytes } from "./options"
import { dispatchHTTPHostRequest } from "./socket"
import type {
  HTTPHandler,
  HTTPHostCapabilities,
  HTTPHostHandle,
  HTTPHostRequest,
  HTTPListener,
  HTTPServeHandle
} from "./types"

type ListenerMode = "idle" | "accepting" | "closing" | "failing" | "canceling" | "terminal"
type TerminalSource = "serve" | "host"

/** Records one observed runtime side terminal outcome. */
interface TerminalOutcome {
  readonly source: TerminalSource
  readonly error: Error | null
}

/** Dispatches one host request under the current accepted listener owner. */
type HTTPDispatch = (owner: Context, input: HTTPHostRequest) => Response | Promise<Response>

/** Creates one externally settled Promise controller. */
function deferred<T>(): {
  readonly promise: Promise<T>
  /** Resolves the controlled Promise. */
  readonly resolve: (value: T) => void
  /** Rejects the controlled Promise with an Error. */
  readonly reject: (error: Error) => void
} {
  let resolvePromise: ((value: T) => void) | null = null
  let rejectPromise: ((error: Error) => void) | null = null
  const promise = new Promise<T>(function capture(resolve, reject): void {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return Object.freeze({
    promise,
    /** Resolves the controlled Promise. */
    resolve(value: T): void {
      resolvePromise?.(value)
    },
    /** Rejects the controlled Promise. */
    reject(error: Error): void {
      rejectPromise?.(error)
    }
  })
}

/** Marks one Promise handled without changing the identity returned to callers. */
function observeUnhandled(work: Promise<unknown>): void {
  void work.catch(function ignore(): void {})
}

/** Creates a frozen AggregateError whose ordered errors cannot be mutated. */
function aggregateHTTPFailures(errors: readonly Error[]): AggregateError {
  const frozen = Object.freeze(Array.from(errors))
  const aggregate = new AggregateError(frozen, "HTTP listener terminal cleanup failed")
  Object.defineProperty(aggregate, "errors", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: frozen
  })
  return Object.freeze(aggregate)
}

/** Returns one original Error or an ordered immutable AggregateError. */
function terminalFailure(primary: Error | null, failures: readonly Error[]): Error | null {
  if (primary !== null) {
    if (failures.length === 0) return primary
    const ordered: Error[] = [primary]
    for (const failure of failures) ordered.push(failure)
    return aggregateHTTPFailures(ordered)
  }
  const first = failures[0]
  if (first === undefined) return null
  if (failures.length === 1) return first
  return aggregateHTTPFailures(failures)
}

/** Waits for terminal state while ctx bounds only the current caller. */
function waitForContext(
  ctx: Context,
  work: Promise<void>,
  onCancel: ((error: Error) => void) | null
): Promise<void> {
  const initial = contextError(ctx)
  if (initial !== null) {
    onCancel?.(initial)
    return Promise.reject(initial)
  }
  const signal = ctx.done()
  if (signal === null) return work
  const activeSignal = signal
  return new Promise<void>(function wait(resolve, reject): void {
    let settled = false
    /** Removes the caller Context observer. */
    function cleanup(): void {
      activeSignal.removeEventListener("abort", onAbort)
    }
    /** Rejects promptly with the exact Context error. */
    function onAbort(): void {
      if (settled) return
      settled = true
      cleanup()
      const failure = contextError(ctx) ?? canceled
      onCancel?.(failure)
      reject(failure)
    }
    activeSignal.addEventListener("abort", onAbort, { once: true })
    work.then(
      function terminalResolved(): void {
        if (settled) return
        settled = true
        cleanup()
        resolve()
      },
      function terminalRejected(error: unknown): void {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
    )
    if (contextError(ctx) !== null) onAbort()
  })
}

/** Calls one borrowed stable done method while preserving its receiver. */
function hostDone(handle: HTTPHostHandle): Promise<void> {
  try {
    return Promise.resolve(handle.done.call(handle))
  } catch (error) {
    return Promise.reject(normalizeHTTPError(error, "HTTP host done threw"))
  }
}

/** Creates one one-shot listener terminal arbiter around a bound host handle. */
export function newHTTPListener(
  address: string,
  handle: HTTPHostHandle,
  capabilities: HTTPHostCapabilities,
  logger: TransportLogger | null = null,
  secure = false,
  maxMessageBytes = defaultHTTPMaxMessageBytes
): HTTPListener {
  const endpoint = `${secure ? "https" : "http"}://${address}`
  const admission = deferred<void>()
  const terminal = deferred<void>()
  observeUnhandled(admission.promise)
  observeUnhandled(terminal.promise)
  const boundHostDone = hostDone(handle)
  observeUnhandled(boundHostDone)
  const closedError: TransportClosedError = newTransportClosedError("HTTP listener is closed")
  let mode: ListenerMode = "idle"
  let acceptedReady = false
  let acceptUsed = false
  let serveRequired = false
  let serveOutcome: TerminalOutcome | null = null
  let hostOutcome: TerminalOutcome | null = null
  let primary: Error | null = null
  const failures: Error[] = []
  let cancelOwner: (() => void) | null = null
  let closeStarted = false
  let closeSettled = false
  let terminalSettled = false

  /** Cancels the derived accept owner at most once without touching its parent Context. */
  function cancelAcceptOwner(): void {
    const cancel = cancelOwner
    cancelOwner = null
    cancel?.()
  }

  /** Records a cleanup failure after a primary, or as a normal-close failure. */
  function recordFailure(error: Error): void {
    if (primary === error || failures.includes(error)) return
    failures.push(error)
  }

  /** Settles terminal once all required runtime and close signals are observed. */
  function finish(): void {
    if (terminalSettled) return
    if (hostOutcome === null) return
    if (serveRequired && serveOutcome === null) return
    if (closeStarted && !closeSettled) return
    terminalSettled = true
    mode = "terminal"
    cancelAcceptOwner()
    const failure = terminalFailure(primary, failures)
    if (failure === null) terminal.resolve(undefined)
    else terminal.reject(failure)
  }

  /** Starts graceful host close once and observes its returned Promise. */
  function beginHostClose(): void {
    if (closeStarted) return
    closeStarted = true
    let work: Promise<void>
    try {
      work = Promise.resolve(handle.close.call(handle, background()))
    } catch (error) {
      work = Promise.reject(normalizeHTTPError(error, "HTTP host close threw"))
    }
    work.then(
      function closeResolved(): void {
        closeSettled = true
        finish()
      },
      function closeRejected(error: unknown): void {
        closeSettled = true
        recordFailure(normalizeHTTPError(error, "HTTP host close rejected"))
        finish()
      }
    )
  }

  /** Claims one runtime terminal as primary when it was not cleanup-driven. */
  function observeSide(source: TerminalSource, error: Error | null): void {
    const outcome = Object.freeze({ source, error })
    if (source === "serve") {
      serveOutcome = outcome
    } else {
      hostOutcome = outcome
    }
    if (mode === "accepting") {
      const failure =
        error ??
        newHTTPTransportUnexpectedExitError(source, acceptedReady ? "running" : "before-ready")
      primary = failure
      mode = "failing"
      if (!acceptedReady) admission.reject(failure)
      if (source === "serve") beginHostClose()
      else {
        cancelAcceptOwner()
        closeSettled = true
      }
    } else if (error !== null) {
      recordFailure(error)
    }
    finish()
  }

  /** Observes one stable side Promise with Error identity preservation. */
  function observeSidePromise(source: TerminalSource, work: Promise<void>): void {
    work.then(
      function sideResolved(): void {
        observeSide(source, null)
      },
      function sideRejected(error: unknown): void {
        observeSide(source, normalizeHTTPError(error, `HTTP ${source} rejected`))
      }
    )
  }

  /** Starts cleanup for external accept Context cancellation. */
  function cancelAccept(error: Error): void {
    if (mode !== "accepting") return
    mode = "canceling"
    if (!acceptedReady) admission.reject(error)
    cancelAcceptOwner()
    beginHostClose()
  }

  /** Starts the shared one-shot HTTP serve admission and terminal state machine. */
  function startAccept(ctx: Context, dispatch: HTTPDispatch): Promise<void> {
    const contextFailure = contextError(ctx)
    if (contextFailure !== null) return Promise.reject(contextFailure)
    if (acceptUsed || mode !== "idle") {
      return Promise.reject(newTransportStateError("HTTP listener accept is one-shot"))
    }
    acceptUsed = true
    mode = "accepting"
    const owner = withCancel(ctx)
    cancelOwner = owner[1]
    /** Linearizes synchronous Context cancellation ahead of later borrowed failures. */
    function synchronizeAdmission(): void {
      const failure = contextError(ctx)
      if (failure !== null) cancelAccept(failure)
    }
    /** Rejects admission and joins host rollback through the terminal arbiter. */
    function rejectServeAdmission(failure: Error): Promise<void> {
      synchronizeAdmission()
      if (mode === "accepting") {
        primary = failure
        mode = "failing"
        admission.reject(failure)
        cancelAcceptOwner()
      } else {
        recordFailure(failure)
      }
      observeSidePromise("host", boundHostDone)
      beginHostClose()
      return waitForContext(ctx, terminal.promise, cancelAccept)
    }
    let serve: HTTPServeHandle
    try {
      /** Delegates one host request through the selected protocol adapter. */
      function dispatchInput(input: HTTPHostRequest): Response | Promise<Response> {
        return dispatch(owner[0], input)
      }
      serve = handle.serve.call(handle, owner[0], dispatchInput)
    } catch (error) {
      return rejectServeAdmission(normalizeHTTPError(error, "HTTP host serve threw"))
    }
    synchronizeAdmission()
    if (typeof serve !== "object" || serve === null) {
      return rejectServeAdmission(new TypeError("HTTP serve handle must provide ready and done"))
    }
    let readyMethod: HTTPServeHandle["ready"] | null = null
    let serveDoneMethod: HTTPServeHandle["done"] | null = null
    try {
      readyMethod = serve.ready
      synchronizeAdmission()
      serveDoneMethod = serve.done
      synchronizeAdmission()
      if (typeof readyMethod !== "function" || typeof serveDoneMethod !== "function") {
        throw new TypeError("HTTP serve handle must provide ready and done")
      }
    } catch (error) {
      return rejectServeAdmission(normalizeHTTPError(error, "HTTP serve method snapshot failed"))
    }
    serveRequired = true
    let serveDone: Promise<void>
    let ready: Promise<void>
    try {
      serveDone = Promise.resolve(serveDoneMethod.call(serve))
    } catch (error) {
      serveDone = Promise.reject(normalizeHTTPError(error, "HTTP serve done threw"))
    }
    synchronizeAdmission()
    observeUnhandled(serveDone)
    observeSidePromise("serve", serveDone)
    observeSidePromise("host", boundHostDone)
    /** Records readiness failure as primary or as a later terminal cleanup failure. */
    function rejectReady(error: unknown): void {
      const failure = normalizeHTTPError(error, "HTTP serve ready rejected")
      if (mode === "accepting") {
        primary = failure
        mode = "failing"
        admission.reject(failure)
        cancelAcceptOwner()
        beginHostClose()
      } else {
        recordFailure(failure)
        finish()
      }
    }
    try {
      ready = Promise.resolve(readyMethod.call(serve))
    } catch (error) {
      synchronizeAdmission()
      rejectReady(normalizeHTTPError(error, "HTTP serve ready threw"))
      return waitForContext(ctx, terminal.promise, cancelAccept)
    }
    synchronizeAdmission()
    ready.then(
      function readyResolved(): void {
        if (mode !== "accepting") return
        acceptedReady = true
        admission.resolve(undefined)
      },
      function readyRejected(error: unknown): void {
        rejectReady(error)
      }
    )
    return waitForContext(ctx, terminal.promise, cancelAccept)
  }

  const listener: HTTPListener = Object.freeze({
    /** Returns the actual bound address captured at listen completion. */
    addr(): string {
      return address
    },
    /** Returns the identity-stable admission Promise. */
    accepted(): Promise<void> {
      return admission.promise
    },
    /** Starts the one-shot serve loop and waits for true terminal state. */
    accept(ctx: Context, handler: AcceptHandler): Promise<void> {
      if (typeof handler !== "function")
        return Promise.reject(new TypeError("HTTP accept handler must be a function"))
      /** Adapts one unary socket exchange through the shared HTTP owner. */
      function dispatchUnary(owner: Context, input: HTTPHostRequest): Promise<Response> {
        return dispatchHTTPHostRequest(
          owner,
          handler,
          input,
          capabilities.connectionMetadata,
          logger,
          endpoint,
          maxMessageBytes
        )
      }
      return startAccept(ctx, dispatchUnary)
    },
    /** Starts one graceful listener cleanup and joins the same terminal Promise. */
    close(ctx: Context): Promise<void> {
      const contextFailure = contextError(ctx)
      if (contextFailure !== null) return Promise.reject(contextFailure)
      if (mode === "idle") {
        mode = "closing"
        admission.reject(closedError)
        observeSidePromise("host", boundHostDone)
        beginHostClose()
      } else if (mode === "accepting") {
        mode = "closing"
        if (!acceptedReady) admission.reject(closedError)
        cancelAcceptOwner()
        beginHostClose()
      }
      return waitForContext(ctx, terminal.promise, null)
    }
  })
  return listener
}
