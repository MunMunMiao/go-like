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
  type AcceptHandler,
  type Client,
  type DialOption,
  type DialOptions,
  type ListenOption,
  type Listener,
  type Message,
  type Option,
  type Options,
  type Socket
} from "@go-like/transport"
import {
  newTransportClosedError,
  newTransportProtocolError,
  newTransportStateError,
  newUnsupportedTransportCapabilityError,
  snapshotMessage
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

interface MemoryExchange {
  /** Settles only after the admitted handler has reached its terminal state. */
  readonly done: Promise<void>
  readonly response: Promise<Message>
  /** Terminates only this exchange. */
  close(cause: Error): void
}

interface MemoryClientControl {
  /** Terminates the owned Client and every outstanding exchange. */
  terminate(cause: Error): void
}

interface MemoryListenerState {
  readonly listener: Listener
  /** Creates one Client owned by this listener. */
  connect(options: DialOptions, timeoutMs: number, localAddress: string): Client
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

/** Preserves one primary failure before one later cleanup failure. */
function combinedBoundaryError(
  primary: Error | null,
  cleanup: Error | null,
  message: string
): Error | null {
  if (primary === null) return cleanup
  if (cleanup === null || cleanup === primary) return primary
  return Object.freeze(new AggregateError(Object.freeze([primary, cleanup]), message))
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
  return failure === null ? null : (cause(ctx) ?? failure)
}

/** Preserves the exact Context terminal cause at every operation admission. */
function checkContext(ctx: Context): void {
  const failure = contextError(ctx)
  if (failure !== null) throw failure
}

/** Waits for one internal operation while Context bounds only this caller's wait. */
function waitForContext<T>(ctx: Context, work: Promise<T>): Promise<T> {
  let initial: Error | null
  try {
    initial = contextError(ctx)
  } catch (value) {
    return Promise.reject(boundaryError(value, "memory wait Context inspection failed"))
  }
  if (initial !== null) return Promise.reject(initial)
  return new Promise<T>(function wait(resolve, reject): void {
    let settled = false
    let stop: StopFunc
    /** Rejects with the caller's exact terminal error. */
    function onAbort(): void {
      if (settled) return
      settled = true
      try {
        reject(contextError(ctx) ?? canceled)
      } catch (value) {
        reject(boundaryError(value, "memory wait cancellation observation failed"))
      }
    }
    try {
      stop = afterFunc(ctx, onAbort)
    } catch (value) {
      settled = true
      let terminal: Error | null = null
      try {
        terminal = contextError(ctx)
      } catch {
        // Registration remains the first observable boundary failure.
      }
      reject(terminal ?? boundaryError(value, "memory wait cancellation registration failed"))
      return
    }
    work.then(
      function resolved(value): void {
        if (settled || !stopWithoutReplacingWinner(stop)) return
        settled = true
        resolve(value)
      },
      function rejected(reason: unknown): void {
        if (settled || !stopWithoutReplacingWinner(stop)) return
        settled = true
        reject(reason)
      }
    )
  })
}

/** Releases a caller cancellation callback without allowing cleanup failure to stall settlement. */
function stopWithoutReplacingWinner(stop: StopFunc): boolean {
  try {
    return stop()
  } catch {
    return true
  }
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

/** Rejects common capabilities that have no truthful process-local meaning. */
function requireSupportedCommonOptions(options: Options): void {
  if (options.codec !== null) {
    throw newUnsupportedTransportCapabilityError("memory transport does not encode Message bytes")
  }
  if (options.secure || options.tlsConfig !== null) {
    throw newUnsupportedTransportCapabilityError("memory transport does not provide TLS")
  }
}

/** Returns one already-rejected exchange without retaining caller-owned Message data. */
function rejectedExchange(error: Error): MemoryExchange {
  const response = Promise.reject<Message>(error)
  observe(response)
  return Object.freeze({
    done: Promise.resolve(),
    response,
    /** The exchange is already terminal. */
    close(_cause: Error): void {}
  })
}

/** Creates one independently owned listener and its accepted unary exchanges. */
function newMemoryListener(address: string, releaseAddress: () => void): MemoryListenerState {
  let acceptHandler: AcceptHandler | null = null
  let acceptContext: Context | null = null
  let acceptTerminal: Deferred<void> | null = null
  let stopAcceptCancellation: (() => Error | null) | null = null
  let acceptUsed = false
  let closed = false
  let cleanup: Promise<void> | null = null
  const clients = new Set<MemoryClientControl>()
  const exchanges = new Set<MemoryClientControl>()
  const handlers = new Set<Promise<void>>()

  /** Starts owner cleanup once and settles accept only after every admitted handler. */
  function startCleanup(primary: Error | null): Promise<void> {
    if (cleanup !== null) return cleanup
    closed = true
    releaseAddress()
    let cancellationCleanupFailure: Error | null = null
    if (stopAcceptCancellation !== null) {
      cancellationCleanupFailure = stopAcceptCancellation()
    }
    stopAcceptCancellation = null
    const terminalFailure = combinedBoundaryError(
      primary,
      cancellationCleanupFailure,
      "memory listener cleanup failed"
    )
    const childCause = primary ?? canceled
    for (const client of clients) client.terminate(childCause)
    clients.clear()
    for (const exchange of exchanges) exchange.terminate(childCause)
    cleanup = Promise.all(Array.from(handlers)).then(function settleTerminal(): void {
      if (acceptTerminal !== null) {
        if (terminalFailure === null) acceptTerminal.resolve(undefined)
        else acceptTerminal.reject(terminalFailure)
      }
      if (cancellationCleanupFailure !== null && terminalFailure !== null) throw terminalFailure
    })
    observe(cleanup)
    return cleanup
  }

  /** Dispatches one Message through a fresh handler Socket. */
  function dispatch(
    outgoing: Message,
    remoteAddress: string,
    clientOpen: () => boolean
  ): MemoryExchange {
    if (!clientOpen()) return rejectedExchange(newTransportClosedError("memory client is closed"))
    if (closed) return rejectedExchange(newTransportClosedError("memory listener is closed"))
    const request = snapshotMessage(outgoing)
    if (!clientOpen()) return rejectedExchange(newTransportClosedError("memory client is closed"))
    if (closed) return rejectedExchange(newTransportClosedError("memory listener is closed"))
    const handler = acceptHandler
    const owner = acceptContext
    if (handler === null || owner === null) {
      return rejectedExchange(newTransportStateError("memory listener is not accepting"))
    }
    const handlerOwner = withCancelCause(owner)
    if (!clientOpen() || closed) {
      const failure = !clientOpen()
        ? newTransportClosedError("memory client is closed")
        : newTransportClosedError("memory listener is closed")
      handlerOwner[1](failure)
      return rejectedExchange(failure)
    }
    const response = deferred<Message>()
    let reply: Message | null = null
    let received = false
    let sent = false
    let socketClosed = false
    const exchangeControl: MemoryClientControl = Object.freeze({
      /** Cancels this handler and rejects an exchange that has not produced a reply. */
      terminate(terminalCause: Error): void {
        if (socketClosed) return
        socketClosed = true
        handlerOwner[1](terminalCause)
        if (!sent) response.reject(newTransportClosedError("memory socket is closed"))
      }
    })
    const socket: Socket = Object.freeze({
      /** Delivers the request exactly once. */
      recv(ctx: Context): Promise<Message> {
        try {
          checkContext(ctx)
          if (socketClosed) throw newTransportClosedError("memory socket is closed")
          if (received) throw newTransportStateError("memory request was already received")
          received = true
          return Promise.resolve(snapshotMessage(request))
        } catch (failure) {
          return Promise.reject(failure)
        }
      },
      /** Publishes the reply exactly once. */
      send(ctx: Context, incoming: Message): Promise<void> {
        try {
          checkContext(ctx)
          if (socketClosed) throw newTransportClosedError("memory socket is closed")
          if (sent) throw newTransportStateError("memory response was already sent")
          const snapshot = snapshotMessage(incoming)
          checkContext(ctx)
          if (socketClosed) throw newTransportClosedError("memory socket is closed")
          if (sent) throw newTransportStateError("memory response was already sent")
          reply = snapshot
          sent = true
          response.resolve(reply)
          return Promise.resolve()
        } catch (failure) {
          return Promise.reject(failure)
        }
      },
      /** Closes only this exchange after caller admission. */
      close(ctx: Context): Promise<void> {
        const failure = contextError(ctx)
        if (failure !== null) return Promise.reject(failure)
        exchangeControl.terminate(canceled)
        return Promise.resolve()
      },
      /** Returns the bound listener address. */
      local(): string {
        return address
      },
      /** Returns the owning Client address. */
      remote(): string {
        return remoteAddress
      }
    })
    exchanges.add(exchangeControl)
    const handlerContext = withMemoryServerTransportInfo(
      handlerOwner[0],
      address,
      request,
      function currentReply(): Message | null {
        return reply
      }
    )
    let running: Promise<void>
    running = Promise.resolve()
      .then(function invokeHandler(): void | PromiseLike<void> {
        return handler(handlerContext, socket)
      })
      .then(
        function handlerResolved(): void {
          if (!sent && !socketClosed) {
            response.reject(newTransportStateError("memory handler returned without a response"))
          }
        },
        function handlerRejected(value: unknown): void {
          response.reject(boundaryError(value, "memory handler rejected"))
        }
      )
      .finally(function releaseExchange(): void {
        handlerOwner[1](null)
        exchanges.delete(exchangeControl)
        handlers.delete(running)
      })
    handlers.add(running)
    observe(running)
    return Object.freeze({
      done: running,
      response: response.promise,
      /** Terminates only this exchange. */
      close(terminalCause: Error): void {
        exchangeControl.terminate(terminalCause)
      }
    })
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
    /** Runs the one-shot accept owner until close, cancellation, or passive failure. */
    accept(ctx: Context, handler: AcceptHandler): Promise<void> {
      let provisionalStop: (() => Error | null) | null = null
      try {
        checkContext(ctx)
        if (typeof handler !== "function")
          throw new TypeError("memory accept handler must be a function")
        if (acceptUsed) throw newTransportStateError("memory listener accept was already consumed")
        if (closed) throw newTransportClosedError("memory listener is closed")
        const terminal = deferred<void>()
        const signal = ctx.done()
        let cancellationPending = false
        let committed = false
        if (signal !== null) {
          const add = signal.addEventListener
          const remove = signal.removeEventListener
          if (typeof add !== "function" || typeof remove !== "function") {
            throw new TypeError("memory accept Context signal must implement event listeners")
          }
          /** Converts accept-owner cancellation into listener terminal cleanup. */
          function onAbort(): void {
            if (!committed) {
              cancellationPending = true
              return
            }
            let failure: Error
            try {
              failure = contextError(ctx) ?? canceled
            } catch (value) {
              failure = boundaryError(value, "memory accept cancellation observation failed")
            }
            void startCleanup(failure)
          }
          let listening = true
          provisionalStop = function stop(): Error | null {
            if (!listening) return null
            listening = false
            try {
              remove.call(signal, "abort", onAbort)
              return null
            } catch (value) {
              return boundaryError(value, "memory accept cancellation listener removal failed")
            }
          }
          add.call(signal, "abort", onAbort, { once: true })
        }
        const cancellation = contextError(ctx)
        if (cancellation !== null) throw cancellation
        if (cancellationPending) throw canceled
        if (closed) throw newTransportClosedError("memory listener is closed")

        acceptUsed = true
        acceptHandler = handler
        acceptContext = ctx
        acceptTerminal = terminal
        stopAcceptCancellation = provisionalStop
        provisionalStop = null
        committed = true
        return terminal.promise
      } catch (failure) {
        let primary = boundaryError(failure, "memory accept admission failed")
        try {
          const cancellation = contextError(ctx)
          if (cancellation !== null) primary = cancellation
        } catch {
          // The first admission failure remains authoritative when Context reinspection also fails.
        }
        let cleanupFailure: Error | null = null
        if (provisionalStop !== null) cleanupFailure = provisionalStop()
        return Promise.reject(
          combinedBoundaryError(
            primary,
            cleanupFailure,
            "memory accept admission cleanup failed"
          ) ?? primary
        )
      }
    }
  })

  /** Creates one independently closable Client bound to this listener. */
  function connect(dial: DialOptions, timeoutMs: number, localAddress: string): Client {
    if (closed) throw newTransportClosedError("memory listener is closed")
    const slots: MemoryExchange[] = []
    const active = new Set<MemoryExchange>()
    let clientClosed = false
    let client: MemoryClientControl
    /** Removes this Client from its listener after terminal cleanup. */
    function releaseClient(): void {
      clients.delete(client)
    }
    client = Object.freeze({
      /** Closes every exchange once without closing the listener. */
      terminate(terminalCause: Error): void {
        if (clientClosed) return
        clientClosed = true
        for (const exchange of active) exchange.close(terminalCause)
        slots.length = 0
        releaseClient()
      }
    })
    clients.add(client)
    /** Reports whether this exact Client can still admit one handler. */
    function clientOpen(): boolean {
      return !clientClosed
    }
    return Object.freeze({
      /** Dispatches one exchange and applies backpressure until its reply exists. */
      async send(ctx: Context, outgoing: Message): Promise<void> {
        checkContext(ctx)
        if (clientClosed) throw newTransportClosedError("memory client is closed")
        const request = snapshotMessage(outgoing)
        checkContext(ctx)
        if (clientClosed) throw newTransportClosedError("memory client is closed")
        const exchange = dispatch(request, localAddress, clientOpen)
        if (clientClosed) {
          exchange.close(newTransportClosedError("memory client is closed"))
          throw newTransportClosedError("memory client is closed")
        }
        active.add(exchange)
        observe(
          exchange.done.finally(function completed(): void {
            active.delete(exchange)
          })
        )
        slots.push(exchange)
        try {
          await waitForOperation(ctx, exchange.response, timeoutMs)
        } catch (failure) {
          const index = slots.indexOf(exchange)
          if (index >= 0) slots.splice(index, 1)
          exchange.close(boundaryError(failure, "memory send wait rejected"))
          throw failure
        }
      },
      /** Receives replies in send invocation order. */
      async recv(ctx: Context): Promise<Message> {
        checkContext(ctx)
        if (clientClosed) throw newTransportClosedError("memory client is closed")
        const exchange = slots.shift()
        if (exchange === undefined) throw newTransportStateError("memory recv occurred before send")
        try {
          return snapshotMessage(await waitForOperation(ctx, exchange.response, timeoutMs))
        } catch (failure) {
          exchange.close(boundaryError(failure, "memory receive wait rejected"))
          throw failure
        } finally {
          if (dial.connectionClose) client.terminate(canceled)
        }
      },
      /** Idempotently closes only this Client after caller admission. */
      close(ctx: Context): Promise<void> {
        const failure = contextError(ctx)
        if (failure !== null) return Promise.reject(failure)
        client.terminate(canceled)
        return Promise.resolve()
      },
      /** Returns this Client's instance-local diagnostic address. */
      local(): string {
        return localAddress
      },
      /** Returns the bound listener address. */
      remote(): string {
        return address
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
  let clientSequence = 0
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
        requireSupportedCommonOptions(common)
        const listener = listeners.get(address)
        if (listener === undefined) {
          throw newTransportStateError(`memory address is not bound: ${address}`)
        }
        clientSequence += 1
        return Promise.resolve(
          listener.connect(
            dial,
            effectiveTimeout(common.timeoutMs, dial.timeoutMs),
            `memory://client/${clientSequence}`
          )
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
        requireSupportedCommonOptions(common)
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
  if (!(cause instanceof Error))
    throw new TypeError("memory listener failure cause must be an Error")
  const fail = listenerFailures.get(listener)
  if (fail === undefined) {
    throw newTransportProtocolError("listener is not owned by @go-like/transport-memory")
  }
  fail(cause)
}
