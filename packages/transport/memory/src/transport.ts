import {
  afterFunc,
  canceled,
  cause,
  withCancelCause,
  withTimeout,
  type Context,
  type StopFunc
} from "@go-like/context"
import {
  observeResponseBody,
  type Client,
  type DialOption,
  type DialOptions,
  type ListenOption,
  type Listener,
  type Option,
  type Options,
  type TransportHandler
} from "@go-like/transport"
import {
  newTransportClosedError,
  newTransportProtocolError,
  newTransportStateError,
  newUnsupportedTransportCapabilityError
} from "@go-like/transport/provider"

import {
  applyMemoryDialOptions,
  applyMemoryListenOptions,
  applyMemoryOptions,
  defaultMemoryOptions,
  effectiveTimeout,
  snapshotMemoryOptions
} from "./options"
import { withMemoryServerTransportInfo } from "./transport-info"
import type { MemoryTransport } from "./types"

interface Deferred<T> {
  readonly promise: Promise<T>
  /** Resolves the pending operation once. */
  resolve(value: T): void
  /** Rejects the pending operation once. */
  reject(reason: Error): void
}

interface LiveExchange {
  readonly response: Promise<Response>
  /** Cancels the handler Context and rejects the response when it is still pending. */
  fail(responseError: Error, ctxCause: Error): void
  /** Drops caller ownership once, immediately if the exchange already finished. */
  retain(release: () => void): void
}

interface MemoryClientControl {
  /** Stops admission and cancels every exchange still owned by this client. */
  terminate(ctxCause: Error): void
  /** Stops later fetches without canceling an exchange already handed back. */
  retire(): void
}

interface MemoryListenerState {
  readonly listener: Listener
  /** Creates one Client owned by this listener. */
  connect(options: DialOptions, timeoutMs: number): Client
}

const listenerFailures = new WeakMap<Listener, (cause: Error) => void>()

/** Recognizes standard Error objects across realms with a local fallback. */
function isError(value: unknown): value is Error {
  const candidate: unknown = Object.getOwnPropertyDescriptor(Error, "isError")?.value
  return typeof candidate === "function" ? candidate(value) === true : value instanceof Error
}

/** Normalizes a rejected provider boundary without obscuring an existing Error identity. */
function boundaryError(value: unknown, message: string): Error {
  return isError(value) ? value : new Error(message, { cause: value })
}

/** Marks one internal Promise handled without changing the Promise returned to callers. */
function observe(work: Promise<unknown>): void {
  void work.catch(function ignore(): void {})
}

/** Creates one single-settlement Promise controller. */
function deferred<T>(): Deferred<T> {
  let settled = false
  let resolvePromise: ((value: T) => void) | null = null
  let rejectPromise: ((reason: Error) => void) | null = null
  const promise = new Promise<T>(function capture(resolve, reject): void {
    resolvePromise = resolve
    rejectPromise = reject
  })
  observe(promise)
  return Object.freeze({
    promise,
    /** Resolves the controller once. */
    resolve(value: T): void {
      if (settled) return
      settled = true
      resolvePromise?.(value)
    },
    /** Rejects the controller once. */
    reject(reason: Error): void {
      if (settled) return
      settled = true
      rejectPromise?.(reason)
    }
  })
}

/** Returns the exact recorded Context cause after terminal observation. */
function contextError(ctx: Context): Error | null {
  const failure = ctx.err()
  if (failure === null) return null
  return cause(ctx) ?? failure
}

/** Preserves the exact Context terminal cause at every operation admission. */
function checkContext(ctx: Context): void {
  const failure = contextError(ctx)
  if (failure !== null) throw failure
}

/** Releases a caller cancellation callback. */
function stopCallback(stop: StopFunc): void {
  stop()
}

/** Waits for one internal operation while Context bounds only this caller's wait. */
function waitForContext<T>(ctx: Context, work: Promise<T>): Promise<T> {
  const initial = contextError(ctx)
  if (initial !== null) return Promise.reject(initial)
  return new Promise<T>(function wait(resolve, reject): void {
    const stop = afterFunc(ctx, function onAbort(): void {
      reject(contextError(ctx) ?? canceled)
    })
    work.then(
      function resolved(value): void {
        stopCallback(stop)
        resolve(value)
      },
      function rejected(reason: unknown): void {
        stopCallback(stop)
        reject(reason)
      }
    )
  })
}

/** Applies a resource timeout without hiding an earlier caller deadline or cancellation. */
async function waitForOperation<T>(ctx: Context, work: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs === 0) return await waitForContext(ctx, work)
  const timed = withTimeout(ctx, timeoutMs)
  try {
    return await waitForContext(timed[0], work)
  } finally {
    timed[1]()
  }
}

/** Validates and canonicalizes one explicit process-local address. */
function memoryAddress(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("memory transport address must be a non-empty string")
  }
  let address: URL
  try {
    address = new URL(value)
  } catch (cause) {
    throw new TypeError("memory transport address must be an absolute memory URL", { cause })
  }
  if (
    address.protocol !== "memory:" ||
    address.username.length > 0 ||
    address.password.length > 0 ||
    address.href.includes("#")
  ) {
    throw new TypeError("memory transport address must be an uncredentialed memory URL")
  }
  address.hostname = address.hostname.toLowerCase()
  if (address.pathname.length === 0) address.pathname = "/"
  return address.href
}

/** Rejects capabilities that have no truthful process-local meaning. */
function requireSupported(options: Options): void {
  if (options.secure || options.tlsConfig !== null) {
    throw newUnsupportedTransportCapabilityError("memory transport does not provide TLS")
  }
}

/** Returns one already-rejected exchange that no longer owns handler state. */
function rejectedExchange(error: Error): LiveExchange {
  const response = Promise.reject<Response>(error)
  observe(response)
  return Object.freeze({
    response,
    /** The exchange is already terminal. */
    fail(_responseError: Error, _ctxCause: Error): void {},
    /** Ownership never starts for an exchange that was rejected before admission. */
    retain(release: () => void): void {
      release()
    }
  })
}

/** Maps an aborted Request signal to one Error cause. */
function abortCause(request: Request): Error {
  const reason: unknown = request.signal.reason
  return isError(reason) ? reason : canceled
}

/** Creates one independently owned listener and its Fetch exchanges. */
function newMemoryListener(address: string, releaseAddress: () => void): MemoryListenerState {
  let serveHandler: TransportHandler | null = null
  let serveContext: Context | null = null
  let serveTerminal: Deferred<void> | null = null
  let stopServeCancellation: (() => void) | null = null
  let serveUsed = false
  let closed = false
  let cleanup: Promise<void> | null = null
  const handlers = new Set<Promise<void>>()
  const live = new Set<LiveExchange>()

  /** Starts owner cleanup once and settles serve only after every admitted handler. */
  function startCleanup(primary: Error | null): Promise<void> {
    if (cleanup !== null) return cleanup
    closed = true
    releaseAddress()
    if (stopServeCancellation !== null) stopServeCancellation()
    stopServeCancellation = null
    const childCause = primary ?? canceled
    const responseError = newTransportClosedError("memory listener is closed")
    for (const exchange of live) exchange.fail(responseError, childCause)
    live.clear()
    cleanup = Promise.all(Array.from(handlers)).then(function settleTerminal(): void {
      if (serveTerminal === null) return
      if (primary === null) serveTerminal.resolve(undefined)
      else serveTerminal.reject(primary)
    })
    observe(cleanup)
    return cleanup
  }

  /** Delivers one Request and ends its Context when the Response body ends. */
  function dispatch(request: Request, caller: Context): LiveExchange {
    const handler = serveHandler
    const owner = serveContext
    if (closed || handler === null || owner === null) {
      const failure = closed
        ? newTransportClosedError("memory listener is closed")
        : newTransportStateError("memory listener is not serving")
      return rejectedExchange(failure)
    }
    const handlerOwner = withCancelCause(owner)
    const response = deferred<Response>()
    const bodyAbort = new AbortController()
    let current: Response | null = null
    let responseSettled = false
    let requestFinished = false
    let releaseOwner: (() => void) | null = null
    let stopCaller: StopFunc = function stopBeforeRegistration(): boolean {
      return true
    }
    /** Detaches this request and cancels its Context once. The first cause wins. */
    function finishRequest(ctxCause: Error): void {
      if (requestFinished) return
      requestFinished = true
      live.delete(exchange)
      const release = releaseOwner
      releaseOwner = null
      release?.()
      request.signal.removeEventListener("abort", onAbort)
      handlerOwner[1](ctxCause)
      stopCallback(stopCaller)
    }
    const exchange: LiveExchange = {
      response: response.promise,
      /** Cancels this request Context even after the Response has been published. */
      fail(responseError: Error, ctxCause: Error): void {
        finishRequest(ctxCause)
        if (!bodyAbort.signal.aborted) bodyAbort.abort(ctxCause)
        if (responseSettled) return
        responseSettled = true
        response.reject(responseError)
      },
      /** Removes this exchange from the client set now, or when the body later ends. */
      retain(release: () => void): void {
        if (requestFinished) {
          release()
          return
        }
        releaseOwner = release
      }
    }
    /** Propagates Request abortion into the handler Context. */
    function onAbort(): void {
      const failure = abortCause(request)
      exchange.fail(failure, failure)
    }
    live.add(exchange)
    if (request.signal.aborted) {
      onAbort()
      return exchange
    }
    stopCaller = afterFunc(caller, function onCallerAbort(): void {
      const failure = contextError(caller) ?? canceled
      exchange.fail(failure, failure)
    })
    request.signal.addEventListener("abort", onAbort, { once: true })
    const handlerContext = withMemoryServerTransportInfo(
      handlerOwner[0],
      address,
      request,
      function currentReply(): Response | null {
        return current
      }
    )
    let running: Promise<void>
    running = Promise.resolve()
      .then(function invokeHandler(): Response | Promise<Response> | undefined {
        if (responseSettled) return undefined
        return handler(handlerContext, request)
      })
      .then(
        function handlerResolved(value): void {
          if (responseSettled) {
            if (value instanceof Response && value.body !== null) observe(value.body.cancel())
            return
          }
          if (!(value instanceof Response)) {
            const failure = newTransportProtocolError("memory handler must return a Response")
            exchange.fail(failure, failure)
            return
          }
          current = value
          responseSettled = true
          response.resolve(
            observeResponseBody(
              value,
              function bodyEnded(): void {
                finishRequest(canceled)
              },
              { signal: bodyAbort.signal }
            )
          )
        },
        function handlerRejected(reason: unknown): void {
          if (responseSettled) return
          const failure = boundaryError(reason, "memory handler rejected")
          exchange.fail(failure, failure)
        }
      )
      .finally(function releaseHandler(): void {
        handlers.delete(running)
      })
    handlers.add(running)
    observe(running)
    return exchange
  }

  const listener: Listener = Object.freeze({
    /** Returns the stable canonical address. */
    addr(): string {
      return address
    },
    /** Starts cleanup once; ctx bounds only this caller's join. */
    close(ctx: Context): Promise<void> {
      const failure = contextError(ctx)
      if (failure !== null) return Promise.reject(failure)
      return waitForContext(ctx, startCleanup(null))
    },
    /** Runs the one-shot serve owner until close, cancellation, or passive failure. */
    serve(ctx: Context, handler: TransportHandler): Promise<void> {
      let provisionalStop: (() => void) | null = null
      try {
        checkContext(ctx)
        if (typeof handler !== "function") {
          throw new TypeError("memory serve handler must be a function")
        }
        if (serveUsed) throw newTransportStateError("memory listener serve was already consumed")
        if (closed) throw newTransportClosedError("memory listener is closed")
        const terminal = deferred<void>()
        const signal = ctx.done()
        if (signal !== null) {
          /** Converts serve-owner cancellation into listener terminal cleanup. */
          function onAbort(): void {
            const failure = contextError(ctx) ?? canceled
            void startCleanup(failure)
          }
          signal.addEventListener("abort", onAbort, { once: true })
          provisionalStop = function stop(): void {
            signal.removeEventListener("abort", onAbort)
          }
        }
        checkContext(ctx)
        if (signal !== null && signal.aborted) throw canceled
        serveUsed = true
        serveHandler = handler
        serveContext = ctx
        serveTerminal = terminal
        stopServeCancellation = provisionalStop
        provisionalStop = null
        return terminal.promise
      } catch (failure) {
        if (provisionalStop !== null) provisionalStop()
        return Promise.reject(boundaryError(failure, "memory serve admission failed"))
      }
    }
  })

  /** Creates one independently closable Client bound to this listener. */
  function connect(dial: DialOptions, timeoutMs: number): Client {
    const owned = new Set<LiveExchange>()
    let admitting = true
    let terminated = false
    const client: MemoryClientControl = Object.freeze({
      /** Closes every owned exchange once without closing the listener. */
      terminate(ctxCause: Error): void {
        admitting = false
        if (terminated) return
        terminated = true
        const responseError = newTransportClosedError("memory client is closed")
        for (const exchange of owned) exchange.fail(responseError, ctxCause)
        owned.clear()
      },
      /** Records connectionClose after this fetch returns. The current body stays readable. */
      retire(): void {
        admitting = false
      }
    })
    return Object.freeze({
      /** Invokes the listener handler with the original Request and returns its Response. */
      async fetch(ctx: Context, request: Request): Promise<Response> {
        checkContext(ctx)
        if (!admitting) throw newTransportClosedError("memory client is closed")
        if (!(request instanceof Request)) {
          throw new TypeError("memory client fetch requires a Request")
        }
        const exchange = dispatch(request, ctx)
        owned.add(exchange)
        exchange.retain(function releaseOwned(): void {
          owned.delete(exchange)
        })
        try {
          return await waitForOperation(ctx, exchange.response, timeoutMs)
        } catch (failure) {
          const error = boundaryError(failure, "memory fetch wait rejected")
          exchange.fail(error, error)
          throw failure
        } finally {
          if (dial.connectionClose) client.retire()
        }
      },
      /** Idempotently closes only this Client after caller admission. */
      close(ctx: Context): Promise<void> {
        const failure = contextError(ctx)
        if (failure !== null) return Promise.reject(failure)
        client.terminate(canceled)
        return Promise.resolve()
      }
    })
  }

  const state: MemoryListenerState = Object.freeze({
    listener,
    connect
  })
  listenerFailures.set(listener, startCleanup)
  return state
}

/** Creates one portable Transport with a private address namespace and no global routing state. */
export function newMemoryTransport(): MemoryTransport {
  let common = snapshotMemoryOptions(defaultMemoryOptions())
  const listeners = new Map<string, MemoryListenerState>()
  const transport: MemoryTransport = Object.freeze({
    /** Returns the stable provider kind. */
    kind(): "memory" {
      return "memory"
    },
    /** Applies common options only to resources created afterwards. */
    init(...options: readonly Option[]): void {
      common = applyMemoryOptions(common, options)
    },
    /** Returns a new immutable defensive common option snapshot. */
    options(): Options {
      return snapshotMemoryOptions(common)
    },
    /** Creates one Client only when this exact Transport instance owns the target. */
    dial(ctx: Context, target: string, ...options: readonly DialOption[]): Promise<Client> {
      try {
        checkContext(ctx)
        const address = memoryAddress(target)
        const dial = applyMemoryDialOptions(options)
        checkContext(ctx)
        requireSupported(common)
        const listener = listeners.get(address)
        if (listener === undefined) {
          throw newTransportStateError(`memory address is not bound: ${address}`)
        }
        return Promise.resolve(
          listener.connect(dial, effectiveTimeout(common.timeoutMs, dial.timeoutMs))
        )
      } catch (failure) {
        return Promise.reject(failure)
      }
    },
    /** Binds one canonical address exclusively inside this Transport instance. */
    listen(ctx: Context, target: string, ...options: readonly ListenOption[]): Promise<Listener> {
      try {
        checkContext(ctx)
        const address = memoryAddress(target)
        applyMemoryListenOptions(options)
        checkContext(ctx)
        requireSupported(common)
        if (listeners.has(address)) {
          throw newTransportStateError(`memory address is already bound: ${address}`)
        }
        let state: MemoryListenerState | null = null
        /** Releases only this listener's exact address-map ownership. */
        function releaseAddress(): void {
          if (state !== null && listeners.get(address) === state) listeners.delete(address)
        }
        state = newMemoryListener(address, releaseAddress)
        listeners.set(address, state)
        return Promise.resolve(state.listener)
      } catch (failure) {
        return Promise.reject(failure)
      }
    },
    /** Returns the stable implementation name. */
    string(): string {
      return "memory"
    }
  })
  return transport
}

/** Injects one passive listener failure without exposing network ownership in the public package. */
export function failMemoryListener(ctx: Context, listener: Listener, cause: Error): void {
  checkContext(ctx)
  if (!(cause instanceof Error)) {
    throw new TypeError("memory listener failure cause must be an Error")
  }
  const fail = listenerFailures.get(listener)
  if (fail === undefined) {
    throw newTransportProtocolError("listener is not owned by @go-like/transport-memory")
  }
  fail(cause)
}
