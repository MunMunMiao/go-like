import { expect, test } from "bun:test"

import { background, canceled, withCancel } from "@go-like/context"
import type { Context } from "@go-like/context"

import {
  newTransportClosedError,
  newTransportProtocolError,
  newTransportStateError,
  snapshotMessage
} from "../src/provider"
import { codec, logger, secure, timeout, tlsConfig } from "../src/options"
import type {
  AcceptHandler,
  Client,
  DialOption,
  DialOptions,
  Listener,
  ListenOption,
  Message,
  Option,
  Options,
  Socket,
  Transport
} from "../src/types"
import * as TransportTesting from "../src/testing"
import type {
  TransportConformanceCase,
  TransportConformanceFaultHarness,
  TransportConformanceOptions,
  TransportFactory
} from "../src/testing"
import { defaultTestOptions } from "./options-fixture"

const transportConformanceCases: (
  factory: TransportFactory,
  options: TransportConformanceOptions
) => readonly TransportConformanceCase[] = Reflect.get(
  TransportTesting,
  "transportConformanceCases"
)
interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | null = null
  let rejectPromise: ((reason: unknown) => void) | null = null
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    resolve(value): void {
      if (resolvePromise === null) throw new Error("deferred resolve is missing")
      resolvePromise(value)
    },
    reject(reason): void {
      if (rejectPromise === null) throw new Error("deferred reject is missing")
      rejectPromise(reason)
    }
  }
}

async function settlesWithin(operation: PromiseLike<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  try {
    return await Promise.race([
      Promise.resolve(operation).then(
        () => true,
        () => true
      ),
      timeout
    ])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

type CapturedTestOutcome<T> =
  | Readonly<{ rejected: false; value: T }>
  | Readonly<{ rejected: true; value: unknown }>

async function captureTestOutcome<T>(operation: PromiseLike<T>): Promise<CapturedTestOutcome<T>> {
  try {
    return Object.freeze({ rejected: false, value: await operation })
  } catch (failure) {
    return Object.freeze({ rejected: true, value: failure })
  }
}

function checkContext(ctx: Context): void {
  const failure = ctx.err()
  if (failure !== null) throw failure
}

function waitForContext<T>(ctx: Context, operation: PromiseLike<T>): Promise<T> {
  checkContext(ctx)
  const signal = ctx.done()
  if (signal === null) return Promise.resolve(operation)
  const activeSignal = signal
  return new Promise<T>((resolve, reject) => {
    let settled = false
    function finish(action: () => void): void {
      if (settled) return
      settled = true
      activeSignal.removeEventListener("abort", onAbort)
      action()
    }
    function onAbort(): void {
      finish(() => reject(ctx.err() ?? canceled))
    }
    activeSignal.addEventListener("abort", onAbort, { once: true })
    void Promise.resolve(operation).then(
      (value) => finish(() => resolve(value)),
      (failure: unknown) => finish(() => reject(failure))
    )
  })
}

interface MemoryExchange {
  readonly response: Promise<Message>
  close(): void
}

interface MemoryListener extends Listener {
  dispatch(message: Message): MemoryExchange
  fail(cause: Error): void
}

interface MemorySocketControl {
  close(): void
}

const MemoryListenerFailures = new WeakMap<Listener, (cause: Error) => void>()

const MemoryFaultHarness: TransportConformanceFaultHarness = Object.freeze({
  failListener(ctx: Context, listener: Listener, cause: Error): void {
    checkContext(ctx)
    const failListener = MemoryListenerFailures.get(listener)
    if (failListener === undefined) throw new Error("memory listener fault control is missing")
    failListener(cause)
  }
})

function newMemoryListener(address: string): MemoryListener {
  let handler: AcceptHandler | null = null
  let acceptContext: Context | null = null
  let terminal: Deferred<void> | null = null
  let terminalSettled = false
  let consumed = false
  let closed = false
  let cleanup: Promise<void> | null = null
  let stopCancellation: (() => void) | null = null
  const sockets = new Set<MemorySocketControl>()
  const handlers = new Set<Promise<void>>()

  function cancelSockets(): void {
    for (const socket of sockets) socket.close()
  }

  function resolveTerminal(): void {
    if (terminalSettled || terminal === null) return
    terminalSettled = true
    terminal.resolve(undefined)
  }

  function rejectTerminal(failure: unknown): void {
    if (terminalSettled || terminal === null) return
    terminalSettled = true
    terminal.reject(failure)
  }

  function startCleanup(failure: unknown | null): Promise<void> {
    if (cleanup !== null) return cleanup
    closed = true
    if (stopCancellation !== null) stopCancellation()
    cancelSockets()
    cleanup = Promise.allSettled(Array.from(handlers)).then(() => {
      if (failure === null) resolveTerminal()
      else rejectTerminal(failure)
    })
    return cleanup
  }

  const listener: MemoryListener = {
    addr(): string {
      return address
    },
    close(closeCtx: Context): Promise<void> {
      const failure = closeCtx.err()
      if (failure !== null) return Promise.reject(failure)
      return startCleanup(null)
    },
    accept(ctx: Context, acceptedHandler: AcceptHandler): Promise<void> {
      checkContext(ctx)
      if (consumed) return Promise.reject(newTransportStateError("accept already consumed"))
      if (closed) return Promise.reject(newTransportClosedError("listener closed"))
      consumed = true
      handler = acceptedHandler
      acceptContext = ctx
      terminal = deferred<void>()
      const signal = ctx.done()
      if (signal !== null) {
        function onAbort(): void {
          startCleanup(ctx.err() ?? canceled)
        }
        signal.addEventListener("abort", onAbort, { once: true })
        stopCancellation = () => signal.removeEventListener("abort", onAbort)
      }
      return terminal.promise
    },
    dispatch(outgoing: Message): MemoryExchange {
      if (closed) {
        return {
          response: Promise.reject(newTransportClosedError("listener closed")),
          close(): void {}
        }
      }
      if (handler === null || acceptContext === null) {
        return {
          response: Promise.reject(newTransportStateError("listener is not accepting")),
          close(): void {}
        }
      }
      const request = snapshotMessage(outgoing)
      const response = deferred<Message>()
      const [handlerContext, cancelHandler] = withCancel(acceptContext)
      let received = false
      let sent = false
      let socketClosed = false
      let socketCleanup: Promise<void> | null = null
      const socketControl: MemorySocketControl = {
        close(): void {
          if (socketClosed) return
          socketClosed = true
          cancelHandler()
          if (!sent) response.reject(newTransportClosedError("socket closed"))
        }
      }
      const serverSocket: Socket = {
        async recv(serverCtx: Context): Promise<Message> {
          checkContext(serverCtx)
          if (socketClosed) throw newTransportClosedError("socket closed")
          if (received) throw newTransportStateError("request already received")
          received = true
          return snapshotMessage(request)
        },
        async send(serverCtx: Context, incoming: Message): Promise<void> {
          checkContext(serverCtx)
          if (socketClosed) throw newTransportClosedError("socket closed")
          if (sent) throw newTransportStateError("response already sent")
          sent = true
          response.resolve(snapshotMessage(incoming))
        },
        close(serverCtx: Context): Promise<void> {
          const failure = serverCtx.err()
          if (failure !== null) return Promise.reject(failure)
          if (socketCleanup === null) {
            socketControl.close()
            socketCleanup = Promise.resolve()
          }
          return socketCleanup
        },
        local(): string {
          return address
        },
        remote(): string {
          return "memory://client"
        }
      }
      sockets.add(socketControl)
      const running = Promise.resolve(handler(handlerContext, serverSocket))
        .then(
          () => {
            if (!sent && !socketClosed)
              response.reject(newTransportStateError("handler returned without send"))
          },
          (failure: unknown) => {
            response.reject(failure)
          }
        )
        .finally(() => {
          cancelHandler()
          sockets.delete(socketControl)
        })
      handlers.add(running)
      void running.finally(() => handlers.delete(running))
      return {
        response: response.promise,
        close(): void {
          socketControl.close()
        }
      }
    },
    fail(cause: Error): void {
      startCleanup(cause)
    }
  }
  MemoryListenerFailures.set(listener, listener.fail)
  return listener
}

function newMemoryClient(listener: MemoryListener): Client {
  const slots: MemoryExchange[] = []
  let closed = false
  let cleanup: Promise<void> | null = null

  function startCleanup(): Promise<void> {
    if (cleanup !== null) return cleanup
    closed = true
    for (const slot of slots) slot.close()
    cleanup = Promise.resolve()
    return cleanup
  }

  return {
    async send(ctx: Context, outgoing: Message): Promise<void> {
      checkContext(ctx)
      if (closed) throw newTransportClosedError("client closed")
      const exchange = listener.dispatch(snapshotMessage(outgoing))
      slots.push(exchange)
      try {
        await waitForContext(ctx, exchange.response)
      } catch (failure) {
        const index = slots.indexOf(exchange)
        if (index >= 0) slots.splice(index, 1)
        exchange.close()
        throw failure
      }
    },
    async recv(ctx: Context): Promise<Message> {
      checkContext(ctx)
      if (closed) throw newTransportClosedError("client closed")
      const exchange = slots.shift()
      if (exchange === undefined) throw newTransportStateError("recv before send")
      try {
        return snapshotMessage(await waitForContext(ctx, exchange.response))
      } catch (failure) {
        exchange.close()
        throw failure
      }
    },
    close(ctx: Context): Promise<void> {
      const failure = ctx.err()
      if (failure !== null) return Promise.reject(failure)
      return startCleanup()
    },
    local(): string {
      return "memory://client"
    },
    remote(): string {
      return listener.addr()
    }
  }
}

/** Validates one complete option state at the structural provider boundary. */
function snapshotMemoryOptions(value: Options): Options {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("memory transport options must be an object")
  }
  let snapshot = defaultTestOptions()
  const reducers: readonly Option[] = [
    codec(value.codec),
    logger(value.logger),
    timeout(value.timeoutMs),
    secure(value.secure),
    tlsConfig(value.tlsConfig)
  ]
  for (const reducer of reducers) snapshot = reducer(snapshot)
  return snapshot
}

function newMemoryTransport(): Transport {
  let common = snapshotMemoryOptions(defaultTestOptions())
  let activeListener: MemoryListener | null = null
  let listenerSequence = 0

  const transport: Transport = {
    init(...options: readonly Option[]): void {
      let next = common
      for (const option of options) next = option(next)
      common = snapshotMemoryOptions(next)
    },
    options(): Options {
      return snapshotMemoryOptions(common)
    },
    async listen(
      ctx: Context,
      _address: string,
      ...listenOptions: readonly ListenOption[]
    ): Promise<Listener> {
      checkContext(ctx)
      let listenState = Object.freeze({})
      for (const option of listenOptions) listenState = option(listenState)
      void listenState
      listenerSequence += 1
      const listener = newMemoryListener(`memory://bound/${listenerSequence}`)
      activeListener = listener
      return listener
    },
    async dial(
      ctx: Context,
      _address: string,
      ...dialOptions: readonly DialOption[]
    ): Promise<Client> {
      checkContext(ctx)
      let dialState: DialOptions = Object.freeze({
        timeoutMs: 5_000,
        connectionClose: false
      })
      for (const option of dialOptions) dialState = option(dialState)
      void dialState
      if (activeListener === null) throw newTransportStateError("listener is unavailable")
      return newMemoryClient(activeListener)
    },
    string(): string {
      return "memory"
    }
  }
  return transport
}

const ConformanceOptions: TransportConformanceOptions = Object.freeze({
  listenAddress: "memory://requested",
  faultHarness: null
})

function implementationAvailable(): boolean {
  const available =
    typeof transportConformanceCases === "function" && typeof snapshotMessage === "function"
  expect(available).toBe(true)
  return available
}

function conformanceCase(name: string, factory: TransportFactory): TransportConformanceCase {
  const found = transportConformanceCases(factory, ConformanceOptions).find(
    (entry) => entry.name === name
  )
  if (found === undefined) throw new Error(`missing transport conformance case: ${name}`)
  return found
}

type StartedCancellationMutation =
  | "listen"
  | "dial"
  | "client-send"
  | "client-recv"
  | "client-close"
  | "handler-recv"
  | "handler-send"
  | "handler-close"

function rejectAfterCancelOrRelease<T>(
  ctx: Context,
  cancellationFailure: Error,
  release: Deferred<void>
): Promise<T> {
  const releaseFailure = new Error("started cancellation mutation released")
  return new Promise<T>((_resolve, reject) => {
    let settled = false
    const signal = ctx.done()
    function finish(failure: Error): void {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", onAbort)
      reject(failure)
    }
    function onAbort(): void {
      finish(cancellationFailure)
    }
    if (ctx.err() !== null) onAbort()
    else signal?.addEventListener("abort", onAbort, { once: true })
    void release.promise.then(() => finish(releaseFailure))
  })
}

function rejectCanceledAfterAction<T>(
  ctx: Context,
  action: () => void | PromiseLike<void>,
  release: Deferred<void>
): Promise<T> {
  const releaseFailure = new Error("started ownership mutation released")
  return new Promise<T>((_resolve, reject) => {
    let settled = false
    const signal = ctx.done()
    function finish(failure: unknown): void {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", onAbort)
      reject(failure)
    }
    function onAbort(): void {
      void Promise.resolve(action()).then(
        () => finish(canceled),
        (failure: unknown) => finish(failure)
      )
    }
    if (ctx.err() !== null) onAbort()
    else signal?.addEventListener("abort", onAbort, { once: true })
    void release.promise.then(() => finish(releaseFailure))
  })
}

function mutateStartedCancellation(
  mutation: StartedCancellationMutation,
  wrongFailure: Error,
  release: Deferred<void>
): Transport {
  const base = newMemoryTransport()
  let listens = 0
  let dials = 0
  let clientCloseCalls = 0
  let handlerRecvCalls = 0
  let handlerCloseCalls = 0
  return {
    ...base,
    async listen(ctx, address, ...options): Promise<Listener> {
      listens += 1
      if (mutation === "listen" && listens === 1) {
        return await rejectAfterCancelOrRelease(ctx, wrongFailure, release)
      }
      const listener = await base.listen(ctx, address, ...options)
      if (!mutation.startsWith("handler-")) return listener
      return {
        ...listener,
        accept(acceptCtx, handler): Promise<void> {
          return listener.accept(acceptCtx, async (handlerCtx, socket) => {
            const wrapped: Socket = {
              ...socket,
              recv(operationCtx): Promise<Message> {
                handlerRecvCalls += 1
                if (mutation === "handler-recv" && handlerRecvCalls === 5) {
                  return rejectAfterCancelOrRelease(operationCtx, wrongFailure, release)
                }
                return socket.recv(operationCtx)
              },
              send(operationCtx, message): Promise<void> {
                if (mutation === "handler-send" && message.header.topic === "handler-send-cancel")
                  return rejectAfterCancelOrRelease(operationCtx, wrongFailure, release)
                return socket.send(operationCtx, message)
              },
              close(operationCtx): Promise<void> {
                handlerCloseCalls += 1
                if (mutation === "handler-close" && handlerCloseCalls === 1) {
                  return rejectAfterCancelOrRelease(operationCtx, wrongFailure, release)
                }
                return socket.close(operationCtx)
              }
            }
            await handler(handlerCtx, wrapped)
          })
        }
      }
    },
    async dial(ctx, address, ...options): Promise<Client> {
      dials += 1
      if (mutation === "dial" && dials === 1) {
        return await rejectAfterCancelOrRelease(ctx, wrongFailure, release)
      }
      const client = await base.dial(ctx, address, ...options)
      const dialSequence = dials
      return {
        ...client,
        send(operationCtx, message): Promise<void> {
          if (mutation === "client-send" && message.header.topic === "client-send-cancel")
            return rejectAfterCancelOrRelease(operationCtx, wrongFailure, release)
          return client.send(operationCtx, message)
        },
        recv(operationCtx): Promise<Message> {
          if (mutation === "client-recv" && dialSequence === 2) {
            return rejectAfterCancelOrRelease(operationCtx, wrongFailure, release)
          }
          return client.recv(operationCtx)
        },
        close(operationCtx): Promise<void> {
          if (mutation === "client-close" && dialSequence === 3) {
            clientCloseCalls += 1
            if (clientCloseCalls === 1) {
              return rejectAfterCancelOrRelease(operationCtx, wrongFailure, release)
            }
          }
          return client.close(operationCtx)
        }
      }
    }
  }
}

function mutateHandlerSocket(base: Transport, mutate: (socket: Socket) => Socket): Transport {
  return {
    ...base,
    async listen(ctx, address, ...options): Promise<Listener> {
      const listener = await base.listen(ctx, address, ...options)
      return {
        ...listener,
        accept(acceptCtx, handler): Promise<void> {
          return listener.accept(acceptCtx, async (handlerCtx, socket) => {
            await handler(handlerCtx, mutate(socket))
          })
        }
      }
    }
  }
}

function mutateHandlerContext(
  base: Transport,
  mutate: (ctx: Context, acceptCtx: Context) => Context
): Transport {
  return {
    ...base,
    async listen(ctx, address, ...options): Promise<Listener> {
      const listener = await base.listen(ctx, address, ...options)
      return {
        ...listener,
        accept(acceptCtx, handler): Promise<void> {
          return listener.accept(acceptCtx, async (handlerCtx, socket) => {
            await handler(mutate(handlerCtx, acceptCtx), socket)
          })
        }
      }
    }
  }
}

function mutateListeners(
  base: Transport,
  mutate: (listener: Listener, sequence: number) => Listener
): Transport {
  let sequence = 0
  return {
    ...base,
    async listen(ctx, address, ...options): Promise<Listener> {
      sequence += 1
      return mutate(await base.listen(ctx, address, ...options), sequence)
    }
  }
}

function mutateClients(
  base: Transport,
  mutate: (client: Client, sequence: number) => Client
): Transport {
  let sequence = 0
  return {
    ...base,
    async dial(ctx, address, ...options): Promise<Client> {
      sequence += 1
      return mutate(await base.dial(ctx, address, ...options), sequence)
    }
  }
}

type PreCanceledCloseMutation = "client" | "handler" | "listener"
type PreCanceledCleanupTiming = "immediate" | "task"

function startMutatedCleanup(timing: PreCanceledCleanupTiming, cleanup: () => Promise<void>): void {
  if (timing === "task") {
    setTimeout(() => {
      void cleanup().catch(() => {})
    }, 0)
    return
  }
  void cleanup().catch(() => {})
}

function mutatePreCanceledClose(
  mutation: PreCanceledCloseMutation,
  timing: PreCanceledCleanupTiming = "immediate"
): Transport {
  const base = newMemoryTransport()
  return {
    ...base,
    async listen(ctx, address, ...options): Promise<Listener> {
      const listener = await base.listen(ctx, address, ...options)
      const close =
        mutation === "listener"
          ? (closeCtx: Context): Promise<void> => {
              const failure = closeCtx.err()
              if (failure === null) return listener.close(closeCtx)
              startMutatedCleanup(timing, () => listener.close(background()))
              return Promise.reject(failure)
            }
          : (closeCtx: Context): Promise<void> => listener.close(closeCtx)
      if (mutation !== "handler") return { ...listener, close }
      return {
        ...listener,
        close,
        accept(acceptCtx, handler): Promise<void> {
          return listener.accept(acceptCtx, async (handlerCtx, socket) => {
            const wrapped: Socket = {
              ...socket,
              close(closeCtx): Promise<void> {
                const failure = closeCtx.err()
                if (failure === null) return socket.close(closeCtx)
                startMutatedCleanup(timing, () => socket.close(background()))
                return Promise.reject(failure)
              }
            }
            await handler(handlerCtx, wrapped)
          })
        }
      }
    },
    async dial(ctx, address, ...options): Promise<Client> {
      const client = await base.dial(ctx, address, ...options)
      if (mutation !== "client") return client
      return {
        ...client,
        close(closeCtx): Promise<void> {
          const failure = closeCtx.err()
          if (failure === null) return client.close(closeCtx)
          startMutatedCleanup(timing, () => client.close(background()))
          return Promise.reject(failure)
        }
      }
    }
  }
}

const StartedCancellationMutations = Object.freeze([
  Object.freeze({
    mutation: "listen" as const,
    caseName: "started dial and listen cancellation preserves identity and later admission",
    diagnostic: "started Transport.listen must preserve context canceled"
  }),
  Object.freeze({
    mutation: "dial" as const,
    caseName: "started dial and listen cancellation preserves identity and later admission",
    diagnostic: "started Transport.dial must preserve context canceled"
  }),
  Object.freeze({
    mutation: "client-send" as const,
    caseName: "started client and handler Socket cancellation preserves identity and ownership",
    diagnostic: "started client Socket.send must preserve context canceled"
  }),
  Object.freeze({
    mutation: "client-recv" as const,
    caseName: "started client and handler Socket cancellation preserves identity and ownership",
    diagnostic: "started client Socket.recv must preserve context canceled"
  }),
  Object.freeze({
    mutation: "client-close" as const,
    caseName: "started client and handler Socket cancellation preserves identity and ownership",
    diagnostic: "started client Socket.close must preserve context canceled"
  }),
  Object.freeze({
    mutation: "handler-recv" as const,
    caseName: "started client and handler Socket cancellation preserves identity and ownership",
    diagnostic: "started handler Socket.recv failed conformance"
  }),
  Object.freeze({
    mutation: "handler-send" as const,
    caseName: "started client and handler Socket cancellation preserves identity and ownership",
    diagnostic: "started handler Socket.send failed conformance"
  }),
  Object.freeze({
    mutation: "handler-close" as const,
    caseName: "started client and handler Socket cancellation preserves identity and ownership",
    diagnostic: "started handler Socket.close failed conformance"
  })
])

for (const mutation of StartedCancellationMutations) {
  test(`reports wrong cancellation identity for ${mutation.mutation}`, async () => {
    if (!implementationAvailable()) return
    const release = deferred<void>()
    const wrongFailure = new Error(`wrong ${mutation.mutation} cancellation identity`)
    const broken = mutateStartedCancellation(mutation.mutation, wrongFailure, release)
    const found = transportConformanceCases(() => broken, {
      listenAddress: "memory://requested",
      faultHarness: null,
      operationTimeoutMs: 50
    }).find((entry) => entry.name === mutation.caseName)
    if (found === undefined)
      throw new Error(`missing started cancellation case: ${mutation.caseName}`)
    try {
      await expect(found.run()).rejects.toThrow(mutation.diagnostic)
    } finally {
      release.resolve(undefined)
    }
  })
}

for (const operation of ["send", "recv"] as const) {
  test(`reports client ${operation} cancellation that closes its owning client`, async () => {
    if (!implementationAvailable()) return
    const release = deferred<void>()
    const base = newMemoryTransport()
    let dials = 0
    const broken: Transport = {
      ...base,
      async dial(ctx, address, ...options): Promise<Client> {
        const client = await base.dial(ctx, address, ...options)
        dials += 1
        const dialSequence = dials
        return {
          ...client,
          send(operationCtx, message): Promise<void> {
            if (operation === "send" && message.header.topic === "client-send-cancel") {
              return rejectCanceledAfterAction(
                operationCtx,
                () => client.close(background()),
                release
              )
            }
            return client.send(operationCtx, message)
          },
          recv(operationCtx): Promise<Message> {
            if (operation === "recv" && dialSequence === 2) {
              return rejectCanceledAfterAction(
                operationCtx,
                () => client.close(background()),
                release
              )
            }
            return client.recv(operationCtx)
          }
        }
      }
    }
    const found = transportConformanceCases(() => broken, {
      listenAddress: "memory://requested",
      faultHarness: null,
      operationTimeoutMs: 50
    }).find(
      (entry) =>
        entry.name ===
        "started client and handler Socket cancellation preserves identity and ownership"
    )
    if (found === undefined) throw new Error("missing started Socket cancellation case")
    try {
      await expect(found.run()).rejects.toThrow(
        `client Socket.${operation} cancellation closed its owning client`
      )
    } finally {
      release.resolve(undefined)
    }
  })
}

for (const topic of ["handler-recv-cancel", "handler-send-cancel"] as const) {
  test(`reports a completed ${topic} operation whose client send rejects`, async () => {
    if (!implementationAvailable()) return
    const base = newMemoryTransport()
    const responseFailure = new Error(`${topic} client response failed`)
    const broken: Transport = {
      ...base,
      async dial(ctx, address, ...options): Promise<Client> {
        const client = await base.dial(ctx, address, ...options)
        return {
          ...client,
          async send(sendCtx, message): Promise<void> {
            await client.send(sendCtx, message)
            if (message.header.topic === topic) throw responseFailure
          }
        }
      }
    }
    const found = transportConformanceCases(() => broken, ConformanceOptions).find(
      (entry) =>
        entry.name ===
        "started client and handler Socket cancellation preserves identity and ownership"
    )
    if (found === undefined) throw new Error("missing started Socket cancellation case")
    await expect(found.run()).rejects.toThrow(
      topic === "handler-recv-cancel"
        ? "completed handler Socket.recv did not preserve its response"
        : "completed handler Socket.send did not preserve its response"
    )
  })
}

test("reports handler close cancellation that terminates the unrelated listener", async () => {
  if (!implementationAvailable()) return
  const release = deferred<void>()
  const base = newMemoryTransport()
  const broken: Transport = {
    ...base,
    async listen(ctx, address, ...options): Promise<Listener> {
      const original = await base.listen(ctx, address, ...options)
      const wrapped: Listener = {
        ...original,
        accept(acceptCtx, handler): Promise<void> {
          return original.accept(acceptCtx, async (handlerCtx, socket) => {
            const wrappedSocket: Socket = {
              ...socket,
              close(operationCtx): Promise<void> {
                return rejectCanceledAfterAction(
                  operationCtx,
                  () => {
                    MemoryFaultHarness.failListener(
                      background(),
                      original,
                      new Error("handler close terminated listener")
                    )
                  },
                  release
                )
              }
            }
            await handler(handlerCtx, wrappedSocket)
          })
        }
      }
      return wrapped
    }
  }
  const found = transportConformanceCases(() => broken, ConformanceOptions).find(
    (entry) =>
      entry.name ===
      "started client and handler Socket cancellation preserves identity and ownership"
  )
  if (found === undefined) throw new Error("missing started Socket cancellation case")
  try {
    await expect(found.run()).rejects.toThrow(
      "handler Socket cancellation closed its unrelated listener"
    )
  } finally {
    release.resolve(undefined)
  }
})

test("publishes only the transport conformance factory", () => {
  expect(Object.keys(TransportTesting)).toEqual(["transportConformanceCases"])
})

test("publishes the frozen provider-neutral conformance inventory", () => {
  if (!implementationAvailable()) return
  const cases = transportConformanceCases(newMemoryTransport, ConformanceOptions)
  expect(Object.isFrozen(cases)).toBe(true)
  expect(cases.every((entry) => Object.isFrozen(entry))).toBe(true)
  expect(cases.map((entry) => entry.name)).toEqual([
    "transport applies options in order and returns defensive snapshots",
    "transport exposes defaults and rejects invalid public options",
    "transport init preserves resources created from an earlier option snapshot",
    "pre-canceled dial and listen stop before resource admission",
    "started dial and listen cancellation preserves identity and later admission",
    "listener exposes its bound address and closes a pending accept",
    "accept cancellation preserves the Context terminal error",
    "pre-canceled accept remains reusable and pre-canceled or started close is caller-scoped",
    "socket Context admission, close ownership, and closed errors are stable",
    "started client and handler Socket cancellation preserves identity and ownership",
    "handler Context is derived and canceled by accept termination",
    "handler Context is canceled by listener and socket termination",
    "socket rejects recv-before-send and preserves invocation order",
    "concurrent handlers isolate one handler failure",
    "client and listener exchange a defensively copied Message"
  ])
})

test("requires an explicit unexpected-host-failure capability declaration", () => {
  expect(() =>
    Reflect.apply(transportConformanceCases, undefined, [
      newMemoryTransport,
      { listenAddress: "memory://requested" }
    ])
  ).toThrow("transport conformance faultHarness must be an object or null")
})

test("captures conformance option getters and the fault callable exactly once", async () => {
  if (!implementationAvailable()) return
  const reads = {
    listenAddress: 0,
    faultHarness: 0,
    operationTimeoutMs: 0,
    failListener: 0
  }
  const receiverCalls: string[] = []
  const harness = {
    receiver: "original",
    get failListener(): TransportConformanceFaultHarness["failListener"] {
      reads.failListener += 1
      return function capturedFailListener(this: { receiver: string }, ctx, listener, cause): void {
        receiverCalls.push(this.receiver)
        MemoryFaultHarness.failListener(ctx, listener, cause)
      }
    }
  }
  const options = {
    get listenAddress(): string {
      reads.listenAddress += 1
      return "memory://requested"
    },
    get faultHarness(): TransportConformanceFaultHarness {
      reads.faultHarness += 1
      return harness
    },
    get operationTimeoutMs(): number {
      reads.operationTimeoutMs += 1
      return 100
    }
  }
  const cases = transportConformanceCases(newMemoryTransport, options)
  Object.defineProperty(harness, "failListener", {
    configurable: true,
    value(): never {
      throw new Error("replacement fault callable must not run")
    }
  })
  const hostFailure = cases.find(
    (entry) => entry.name === "unexpected listener failure preserves its original cause"
  )
  if (hostFailure === undefined) throw new Error("missing snapshotted host-failure case")
  await hostFailure.run()
  expect(reads).toEqual({
    listenAddress: 1,
    faultHarness: 1,
    operationTimeoutMs: 1,
    failListener: 1
  })
  expect(receiverCalls).toEqual(["original"])
})

test("rejects a malformed unexpected-host-failure harness", () => {
  expect(() =>
    Reflect.apply(transportConformanceCases, undefined, [
      newMemoryTransport,
      { listenAddress: "memory://requested", faultHarness: { failListener: null } }
    ])
  ).toThrow("transport conformance faultHarness must be an object or null")

  expect(() =>
    Reflect.apply(transportConformanceCases, undefined, [
      newMemoryTransport,
      { listenAddress: "memory://requested", faultHarness: "invalid" }
    ])
  ).toThrow("transport conformance faultHarness must be an object or null")
})

test("runs unexpected listener failure through an explicit structural fault harness", async () => {
  const cases = transportConformanceCases(newMemoryTransport, {
    listenAddress: "memory://requested",
    faultHarness: MemoryFaultHarness
  })
  const found = cases.find(
    (entry) => entry.name === "unexpected listener failure preserves its original cause"
  )
  expect(found).toBeDefined()
  if (found === undefined) return
  await expect(found.run()).resolves.toBeUndefined()
})

test("accepts a structural host-failure wrapper that preserves the injected cause", async () => {
  const originals = new WeakMap<Listener, Listener>()
  const factory: TransportFactory = () => {
    const base = newMemoryTransport()
    return {
      ...base,
      async listen(ctx, address, ...options): Promise<Listener> {
        const original = await base.listen(ctx, address, ...options)
        const wrapped: Listener = {
          addr: original.addr.bind(original),
          close: original.close.bind(original),
          async accept(acceptCtx, handler): Promise<void> {
            try {
              await original.accept(acceptCtx, handler)
            } catch (failure) {
              if (!(failure instanceof Error)) throw failure
              throw newTransportProtocolError("wrapped host failure", failure)
            }
          }
        }
        originals.set(wrapped, original)
        return wrapped
      }
    }
  }
  const harness: TransportConformanceFaultHarness = {
    failListener(ctx, listener, cause): void {
      const original = originals.get(listener)
      if (original === undefined) throw new Error("wrapped listener mapping is missing")
      MemoryFaultHarness.failListener(ctx, original, cause)
    }
  }
  const found = transportConformanceCases(factory, {
    listenAddress: "memory://requested",
    faultHarness: harness
  }).find((entry) => entry.name === "unexpected listener failure preserves its original cause")
  expect(found).toBeDefined()
  if (found === undefined) return
  await expect(found.run()).resolves.toBeUndefined()
})

test("accepts a nested structural host-failure wrapper that preserves the injected cause", async () => {
  const originals = new WeakMap<Listener, Listener>()
  const factory: TransportFactory = () => {
    const base = newMemoryTransport()
    return {
      ...base,
      async listen(ctx, address, ...options): Promise<Listener> {
        const original = await base.listen(ctx, address, ...options)
        const wrapped: Listener = {
          addr: original.addr.bind(original),
          close: original.close.bind(original),
          async accept(acceptCtx, handler): Promise<void> {
            try {
              await original.accept(acceptCtx, handler)
            } catch (failure) {
              if (!(failure instanceof Error)) throw failure
              const inner = newTransportProtocolError("inner host failure", failure)
              throw newTransportProtocolError("outer host failure", inner)
            }
          }
        }
        originals.set(wrapped, original)
        return wrapped
      }
    }
  }
  const harness: TransportConformanceFaultHarness = {
    failListener(ctx, listener, cause): void {
      const original = originals.get(listener)
      if (original === undefined) throw new Error("wrapped listener mapping is missing")
      MemoryFaultHarness.failListener(ctx, original, cause)
    }
  }
  const found = transportConformanceCases(factory, {
    listenAddress: "memory://requested",
    faultHarness: harness
  }).find((entry) => entry.name === "unexpected listener failure preserves its original cause")
  expect(found).toBeDefined()
  if (found === undefined) return
  await expect(found.run()).resolves.toBeUndefined()
})

test("reports a structural host-failure wrapper that discards the injected cause", async () => {
  const originals = new WeakMap<Listener, Listener>()
  const factory: TransportFactory = () => {
    const base = newMemoryTransport()
    return {
      ...base,
      async listen(ctx, address, ...options): Promise<Listener> {
        const original = await base.listen(ctx, address, ...options)
        const wrapped: Listener = {
          addr: original.addr.bind(original),
          close: original.close.bind(original),
          async accept(acceptCtx, handler): Promise<void> {
            try {
              await original.accept(acceptCtx, handler)
            } catch {
              throw new Error("discarded host failure")
            }
          }
        }
        originals.set(wrapped, original)
        return wrapped
      }
    }
  }
  const harness: TransportConformanceFaultHarness = {
    failListener(ctx, listener, cause): void {
      const original = originals.get(listener)
      if (original === undefined) throw new Error("wrapped listener mapping is missing")
      MemoryFaultHarness.failListener(ctx, original, cause)
    }
  }
  const found = transportConformanceCases(factory, {
    listenAddress: "memory://requested",
    faultHarness: harness
  }).find((entry) => entry.name === "unexpected listener failure preserves its original cause")
  expect(found).toBeDefined()
  if (found === undefined) return
  await expect(found.run()).rejects.toThrow(
    "unexpected listener failure must preserve its original cause"
  )
})

for (const malformedCause of ["primitive", "throwing-getter", "cycle"] as const) {
  test(`reports a ${malformedCause} host-failure cause chain without hanging`, async () => {
    const originals = new WeakMap<Listener, Listener>()
    const factory: TransportFactory = () => {
      const base = newMemoryTransport()
      return {
        ...base,
        async listen(ctx, address, ...options): Promise<Listener> {
          const original = await base.listen(ctx, address, ...options)
          const wrapped: Listener = {
            addr: original.addr.bind(original),
            close: original.close.bind(original),
            async accept(acceptCtx, handler): Promise<void> {
              try {
                await original.accept(acceptCtx, handler)
              } catch {
                if (malformedCause === "primitive") throw "discarded primitive host failure"
                if (malformedCause === "throwing-getter") {
                  const hostile = Object.create(null) as object
                  Object.defineProperty(hostile, "cause", {
                    get(): never {
                      throw new Error("hostile cause getter")
                    }
                  })
                  throw hostile
                }
                const cyclic = new Error("cyclic host failure")
                Object.defineProperty(cyclic, "cause", { value: cyclic })
                throw cyclic
              }
            }
          }
          originals.set(wrapped, original)
          return wrapped
        }
      }
    }
    const harness: TransportConformanceFaultHarness = {
      failListener(ctx, listener, cause): void {
        const original = originals.get(listener)
        if (original === undefined) throw new Error("wrapped listener mapping is missing")
        MemoryFaultHarness.failListener(ctx, original, cause)
      }
    }
    const found = transportConformanceCases(factory, {
      listenAddress: "memory://requested",
      faultHarness: harness
    }).find((entry) => entry.name === "unexpected listener failure preserves its original cause")
    if (found === undefined) throw new Error("missing host failure case")
    await expect(found.run()).rejects.toThrow(
      "unexpected listener failure must preserve its original cause"
    )
  })
}

test("passes every transport case for a structural implementation", async () => {
  if (!implementationAvailable()) return
  let factories = 0
  const cases = transportConformanceCases(() => {
    factories += 1
    return newMemoryTransport()
  }, ConformanceOptions)

  for (const entry of cases) {
    try {
      await entry.run()
    } catch (failure) {
      throw new Error(`transport conformance case failed: ${entry.name}`, { cause: failure })
    }
  }
  expect(factories).toBe(cases.length)
})

for (const subject of ["handler Socket", "Client"] as const) {
  test(`accepts side-effect-free pre-canceled close for ${subject}`, async () => {
    if (!implementationAvailable()) return
    await expect(
      conformanceCase(
        "socket Context admission, close ownership, and closed errors are stable",
        newMemoryTransport
      ).run()
    ).resolves.toBeUndefined()
  })
}

test("accepts side-effect-free pre-canceled close for Listener", async () => {
  if (!implementationAvailable()) return
  await expect(
    conformanceCase(
      "pre-canceled accept remains reusable and pre-canceled or started close is caller-scoped",
      newMemoryTransport
    ).run()
  ).resolves.toBeUndefined()
})

const PreCanceledCloseMutations = Object.freeze([
  Object.freeze({
    mutation: "handler" as const,
    caseName: "socket Context admission, close ownership, and closed errors are stable",
    diagnostic: "pre-canceled handler Socket.close must not close the Socket"
  }),
  Object.freeze({
    mutation: "client" as const,
    caseName: "socket Context admission, close ownership, and closed errors are stable",
    diagnostic: "pre-canceled Socket.close must not close the Client"
  }),
  Object.freeze({
    mutation: "listener" as const,
    caseName:
      "pre-canceled accept remains reusable and pre-canceled or started close is caller-scoped",
    diagnostic: "pre-canceled Listener.close must not start owner cleanup"
  })
])

for (const mutation of PreCanceledCloseMutations) {
  test(`reports pre-canceled ${mutation.mutation} close that starts owner cleanup`, async () => {
    if (!implementationAvailable()) return
    await expect(
      conformanceCase(mutation.caseName, () => mutatePreCanceledClose(mutation.mutation)).run()
    ).rejects.toThrow(mutation.diagnostic)
  })

  test(`reports pre-canceled ${mutation.mutation} close that starts owner cleanup in the next task`, async () => {
    if (!implementationAvailable()) return
    await expect(
      conformanceCase(mutation.caseName, () =>
        mutatePreCanceledClose(mutation.mutation, "task")
      ).run()
    ).rejects.toThrow(mutation.diagnostic)
  })
}

test("reports a started Listener.close that returns canceled before its Context is canceled", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const subject: Transport = {
    ...base,
    async listen(ctx, address, ...options): Promise<Listener> {
      const listener = await base.listen(ctx, address, ...options)
      let activeCloseCalls = 0
      return {
        ...listener,
        close(closeCtx): Promise<void> {
          const failure = closeCtx.err()
          if (failure !== null) return Promise.reject(failure)
          activeCloseCalls += 1
          if (activeCloseCalls === 1) return Promise.reject(canceled)
          return listener.close(closeCtx)
        }
      }
    }
  }
  await expect(
    conformanceCase(
      "pre-canceled accept remains reusable and pre-canceled or started close is caller-scoped",
      () => subject
    ).run()
  ).rejects.toBe(canceled)
})

test("accepts a started Listener.close that fulfills before caller cancellation", async () => {
  if (!implementationAvailable()) return
  await expect(
    conformanceCase(
      "pre-canceled accept remains reusable and pre-canceled or started close is caller-scoped",
      newMemoryTransport
    ).run()
  ).resolves.toBeUndefined()
})

test("reports a started Transport.listen that returns canceled before caller cancellation", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  let listenCalls = 0
  const broken: Transport = {
    ...base,
    listen(ctx, address, ...options): Promise<Listener> {
      listenCalls += 1
      if (listenCalls === 1) return Promise.reject(canceled)
      return base.listen(ctx, address, ...options)
    }
  }
  await expect(
    conformanceCase(
      "started dial and listen cancellation preserves identity and later admission",
      () => broken
    ).run()
  ).rejects.toBe(canceled)
})

test("reports a started Client.close that returns canceled before caller cancellation", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  let dials = 0
  const broken: Transport = {
    ...base,
    async dial(ctx, address, ...options): Promise<Client> {
      const client = await base.dial(ctx, address, ...options)
      dials += 1
      if (dials !== 3) return client
      let closeCalls = 0
      return {
        ...client,
        close(closeCtx): Promise<void> {
          closeCalls += 1
          if (closeCalls === 1 && closeCtx.err() === null) return Promise.reject(canceled)
          return client.close(closeCtx)
        }
      }
    }
  }
  await expect(
    conformanceCase(
      "started client and handler Socket cancellation preserves identity and ownership",
      () => broken
    ).run()
  ).rejects.toBe(canceled)
})

test("reports a started handler Socket.close that returns canceled before caller cancellation", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  let closeCalls = 0
  const broken = mutateHandlerSocket(base, (socket) => ({
    ...socket,
    close(closeCtx): Promise<void> {
      closeCalls += 1
      if (closeCalls === 1 && closeCtx.err() === null) return Promise.reject(canceled)
      return socket.close(closeCtx)
    }
  }))
  await expect(
    conformanceCase(
      "started client and handler Socket cancellation preserves identity and ownership",
      () => broken
    ).run()
  ).rejects.toThrow("started handler Socket.close failed conformance")
})

test("reports a Listener that cannot dial after side-effect-free pre-canceled close", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const dialFailure = new Error("listener health dial failed")
  const broken: Transport = {
    ...base,
    dial(): Promise<Client> {
      return Promise.reject(dialFailure)
    }
  }
  await expect(
    conformanceCase(
      "pre-canceled accept remains reusable and pre-canceled or started close is caller-scoped",
      () => broken
    ).run()
  ).rejects.toThrow("pre-canceled Listener.close must not start owner cleanup")
})

test("reports a Listener whose health exchange fails after pre-canceled close", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const healthFailure = new Error("listener health exchange failed")
  const broken: Transport = {
    ...base,
    async dial(ctx, address, ...options): Promise<Client> {
      const client = await base.dial(ctx, address, ...options)
      return {
        ...client,
        send(sendCtx, message): Promise<void> {
          if (message.header.topic === "listener-close-health") {
            return Promise.reject(healthFailure)
          }
          return client.send(sendCtx, message)
        }
      }
    }
  }
  await expect(
    conformanceCase(
      "pre-canceled accept remains reusable and pre-canceled or started close is caller-scoped",
      () => broken
    ).run()
  ).rejects.toThrow("pre-canceled Listener.close must not start owner cleanup")
})

test("reports a handler Socket that cannot send after side-effect-free pre-canceled close", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const healthFailure = new Error("handler health send failed")
  const broken = mutateHandlerSocket(base, (socket) => ({
    ...socket,
    send(sendCtx, message): Promise<void> {
      return sendCtx.err() === null ? Promise.reject(healthFailure) : socket.send(sendCtx, message)
    }
  }))
  await expect(
    conformanceCase(
      "socket Context admission, close ownership, and closed errors are stable",
      () => broken
    ).run()
  ).rejects.toThrow("pre-canceled handler Socket.close must not close the Socket")
})

test("reports a Client that cannot recv after side-effect-free pre-canceled close", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const healthFailure = new Error("client health recv failed")
  const broken: Transport = {
    ...base,
    async dial(ctx, address, ...options): Promise<Client> {
      const client = await base.dial(ctx, address, ...options)
      return {
        ...client,
        recv(recvCtx): Promise<Message> {
          return recvCtx.err() === null ? Promise.reject(healthFailure) : client.recv(recvCtx)
        }
      }
    }
  }
  await expect(
    conformanceCase(
      "socket Context admission, close ownership, and closed errors are stable",
      () => broken
    ).run()
  ).rejects.toThrow("pre-canceled Socket.close must not close the Client")
})

test("reports a transport that leaks its mutable option snapshot", async () => {
  if (!implementationAvailable()) return
  const subject = newMemoryTransport()
  const shared = subject.options()
  const broken: Transport = {
    ...subject,
    options(): Options {
      return shared
    }
  }
  await expect(
    conformanceCase(
      "transport applies options in order and returns defensive snapshots",
      () => broken
    ).run()
  ).rejects.toThrow("Transport.options must return a new defensive snapshot")
})

test("reports a provider that accepts malformed structural Option output", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const broken: Transport = {
    ...base,
    init(...options): void {
      const defaults = base.options()
      for (const option of options) option(defaults)
    }
  }
  await expect(
    conformanceCase(
      "transport exposes defaults and rejects invalid public options",
      () => broken
    ).run()
  ).rejects.toThrow("Transport.init must reject malformed structural Option output")
})

test("reports a Transport.init implementation that returns asynchronous I/O", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const broken: Transport = {
    ...base,
    init(...options): Promise<void> {
      base.init(...options)
      return Promise.resolve()
    }
  }
  await expect(
    conformanceCase(
      "transport init preserves resources created from an earlier option snapshot",
      () => broken
    ).run()
  ).rejects.toThrow("Transport.init must complete synchronously without returning I/O")
})

test("reports asynchronous Transport.init replacement after resource creation", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  let initializations = 0
  const broken: Transport = {
    ...base,
    init(...options) {
      initializations += 1
      base.init(...options)
      if (initializations > 1) return Promise.resolve()
    }
  }
  await expect(
    conformanceCase(
      "transport init preserves resources created from an earlier option snapshot",
      () => broken
    ).run()
  ).rejects.toThrow("Transport.init must complete synchronously without returning I/O")
})

test("reports a dial implementation that admits a pre-canceled Context", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const leaked: Client = {
    recv(): Promise<Message> {
      return Promise.reject(newTransportStateError("no message"))
    },
    send(): Promise<void> {
      return Promise.resolve()
    },
    close(): Promise<void> {
      return Promise.resolve()
    },
    local(): string {
      return "memory://leaked"
    },
    remote(): string {
      return "memory://requested"
    }
  }
  const broken: Transport = {
    ...base,
    dial(): Promise<Client> {
      return Promise.resolve(leaked)
    }
  }
  await expect(
    conformanceCase(
      "pre-canceled dial and listen stop before resource admission",
      () => broken
    ).run()
  ).rejects.toThrow("Transport.dial accepted a pre-canceled Context")
})

test("reports a listen implementation that admits a pre-canceled Context", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const broken: Transport = {
    ...base,
    listen(_ctx, address, ...options): Promise<Listener> {
      return base.listen(background(), address, ...options)
    }
  }
  await expect(
    conformanceCase(
      "pre-canceled dial and listen stop before resource admission",
      () => broken
    ).run()
  ).rejects.toThrow("Transport.listen accepted a pre-canceled Context")
})

test("reports a handler Socket implementation that ignores a pre-canceled Context", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const broken = mutateHandlerSocket(base, (socket) => ({
    ...socket,
    recv(_recvCtx): Promise<Message> {
      return socket.recv(background())
    }
  }))
  await expect(
    conformanceCase(
      "socket Context admission, close ownership, and closed errors are stable",
      () => broken
    ).run()
  ).rejects.toThrow("pre-canceled handler Socket.recv must preserve context canceled")
})

test("reports a handler Socket.send implementation that ignores a pre-canceled Context", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const broken = mutateHandlerSocket(base, (socket) => ({
    ...socket,
    send(_sendCtx, message): Promise<void> {
      return socket.send(background(), message)
    }
  }))
  await expect(
    conformanceCase(
      "socket Context admission, close ownership, and closed errors are stable",
      () => broken
    ).run()
  ).rejects.toThrow("pre-canceled handler Socket.send must preserve context canceled")
})

test("reports a handler Socket.close implementation that ignores a pre-canceled Context", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const broken = mutateHandlerSocket(base, (socket) => ({
    ...socket,
    close(_closeCtx): Promise<void> {
      return socket.close(background())
    }
  }))
  await expect(
    conformanceCase(
      "socket Context admission, close ownership, and closed errors are stable",
      () => broken
    ).run()
  ).rejects.toThrow("pre-canceled handler Socket.close must preserve context canceled")
})

test("reports a handler Context that drops values from the accept Context", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const broken = mutateHandlerContext(base, (ctx) => ({
    deadline: () => ctx.deadline(),
    done: () => ctx.done(),
    err: () => ctx.err(),
    value: () => null
  }))
  await expect(
    conformanceCase(
      "handler Context is derived and canceled by accept termination",
      () => broken
    ).run()
  ).rejects.toThrow("handler Context must preserve accept Context values")
})

test("reports a handler Context that reuses the accept Context", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const broken = mutateHandlerContext(base, (_ctx, acceptCtx) => acceptCtx)
  await expect(
    conformanceCase(
      "handler Context is derived and canceled by accept termination",
      () => broken
    ).run()
  ).rejects.toThrow("AcceptHandler Context must be derived, not reused")
})

test("reports a handler Context that drops the accept Context deadline", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const broken = mutateHandlerContext(base, (ctx) => ({
    deadline: () => [new Date(0), false],
    done: () => ctx.done(),
    err: () => ctx.err(),
    value: (key) => ctx.value(key)
  }))
  await expect(
    conformanceCase(
      "handler Context is derived and canceled by accept termination",
      () => broken
    ).run()
  ).rejects.toThrow("handler Context must preserve the accept Context deadline")
})

test("continues Transport cleanup after an earlier client close failure", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const cleanupFailure = new Error("client cleanup failed")
  let listenerCloseCalls = 0
  const broken: Transport = {
    ...base,
    async listen(ctx, address, ...options): Promise<Listener> {
      const listener = await base.listen(ctx, address, ...options)
      return {
        ...listener,
        async close(closeCtx): Promise<void> {
          listenerCloseCalls += 1
          await listener.close(closeCtx)
        }
      }
    },
    async dial(ctx, address, ...options): Promise<Client> {
      const client = await base.dial(ctx, address, ...options)
      return {
        ...client,
        async close(closeCtx): Promise<void> {
          await client.close(closeCtx)
          throw cleanupFailure
        }
      }
    }
  }
  let observed: unknown = null
  try {
    await conformanceCase(
      "pre-canceled dial and listen stop before resource admission",
      () => broken
    ).run()
  } catch (failure) {
    observed = failure
  }
  expect(observed).toBe(cleanupFailure)
  expect(listenerCloseCalls).toBeGreaterThan(0)
})

test("aggregates multiple Transport cleanup failures in declaration order", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const clientFailure = new Error("client cleanup failed")
  const listenerFailure = new Error("listener cleanup failed")
  const broken: Transport = {
    ...base,
    async listen(ctx, address, ...options): Promise<Listener> {
      const listener = await base.listen(ctx, address, ...options)
      return {
        ...listener,
        async close(closeCtx): Promise<void> {
          await listener.close(closeCtx)
          throw listenerFailure
        }
      }
    },
    async dial(ctx, address, ...options): Promise<Client> {
      const client = await base.dial(ctx, address, ...options)
      return {
        ...client,
        async close(closeCtx): Promise<void> {
          await client.close(closeCtx)
          throw clientFailure
        }
      }
    }
  }
  let observed: unknown = null
  try {
    await conformanceCase(
      "pre-canceled dial and listen stop before resource admission",
      () => broken
    ).run()
  } catch (failure) {
    observed = failure
  }
  expect(observed).toBeInstanceOf(AggregateError)
  if (!(observed instanceof AggregateError)) throw new Error("expected cleanup AggregateError")
  expect(observed.errors).toEqual([clientFailure, listenerFailure])
})

test("bounds a stuck Transport cleanup and continues later cleanup", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const release = deferred<void>()
  const cleanupCanceled = deferred<void>()
  const originalClients: Client[] = []
  let listenerCloseCalls = 0
  const broken: Transport = {
    ...base,
    async listen(ctx, address, ...options): Promise<Listener> {
      const listener = await base.listen(ctx, address, ...options)
      return {
        ...listener,
        async close(closeCtx): Promise<void> {
          listenerCloseCalls += 1
          await listener.close(closeCtx)
        }
      }
    },
    async dial(ctx, address, ...options): Promise<Client> {
      const client = await base.dial(ctx, address, ...options)
      originalClients.push(client)
      return {
        ...client,
        close(closeCtx): Promise<void> {
          const signal = closeCtx.done()
          return new Promise<void>((resolve, reject) => {
            if (signal !== null) {
              function onAbort(): void {
                cleanupCanceled.resolve(undefined)
                reject(closeCtx.err() ?? canceled)
              }
              signal.addEventListener("abort", onAbort, { once: true })
            }
            void release.promise.then(() => client.close(background())).then(resolve, reject)
          })
        }
      }
    }
  }
  const found = transportConformanceCases(() => broken, {
    listenAddress: "memory://requested",
    faultHarness: null,
    operationTimeoutMs: 10
  }).find((entry) => entry.name === "pre-canceled dial and listen stop before resource admission")
  if (found === undefined) throw new Error("missing bounded cleanup conformance case")
  try {
    await expect(found.run()).rejects.toThrow(
      "canceled creation admission cleanup 1 did not settle within 10ms"
    )
    expect(await settlesWithin(cleanupCanceled.promise, 50)).toBe(true)
    expect(listenerCloseCalls).toBeGreaterThan(0)
  } finally {
    release.resolve(undefined)
    await Promise.allSettled(originalClients.map((client) => client.close(background())))
  }
})

test("passes the bounded scenario Context into provider I/O", async () => {
  if (!implementationAvailable()) return
  const release = deferred<void>()
  const scenarioCanceled = deferred<void>()
  const releaseFailure = new Error("scenario probe released")
  const base = newMemoryTransport()
  const broken: Transport = {
    ...base,
    listen(ctx): Promise<Listener> {
      const signal = ctx.done()
      return new Promise<Listener>((_resolve, reject) => {
        if (signal !== null) {
          function onAbort(): void {
            scenarioCanceled.resolve(undefined)
            reject(ctx.err() ?? canceled)
          }
          signal.addEventListener("abort", onAbort, { once: true })
        }
        void release.promise.then(() => reject(releaseFailure))
      })
    }
  }
  const found = transportConformanceCases(() => broken, {
    listenAddress: "memory://requested",
    faultHarness: null,
    operationTimeoutMs: 10
  }).find(
    (entry) => entry.name === "listener exposes its bound address and closes a pending accept"
  )
  if (found === undefined) throw new Error("missing bounded scenario conformance case")
  try {
    await expect(found.run()).rejects.toThrow("pending accept close did not settle within 10ms")
    expect(await settlesWithin(scenarioCanceled.promise, 50)).toBe(true)
  } finally {
    release.resolve(undefined)
  }
})

test("reports wrong last-wins options and mutable option snapshots", async () => {
  if (!implementationAvailable()) return
  const wrongOptions = newMemoryTransport()
  const baseInit = wrongOptions.init.bind(wrongOptions)
  wrongOptions.init = (...options): void => {
    baseInit(...options)
  }
  wrongOptions.options = (): Options =>
    Object.freeze({
      codec: null,
      logger: null,
      timeoutMs: 0,
      secure: false,
      tlsConfig: null
    })
  await expect(
    conformanceCase(
      "transport applies options in order and returns defensive snapshots",
      () => wrongOptions
    ).run()
  ).rejects.toThrow("Transport.init must apply options in order with the last option winning")

  const mutable = newMemoryTransport()
  mutable.options = (): Options => ({
    codec: null,
    logger: null,
    timeoutMs: 2,
    secure: false,
    tlsConfig: null
  })
  await expect(
    conformanceCase(
      "transport applies options in order and returns defensive snapshots",
      () => mutable
    ).run()
  ).rejects.toThrow("Transport.options must return an immutable snapshot")
})

test("reports an empty bound address", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  let closeCalls = 0
  const broken: Transport = {
    ...base,
    async listen(ctx, address, ...options): Promise<Listener> {
      const listener = await base.listen(ctx, address, ...options)
      return {
        ...listener,
        addr: () => "",
        async close(closeCtx): Promise<void> {
          closeCalls += 1
          await listener.close(closeCtx)
        }
      }
    }
  }
  await expect(
    conformanceCase(
      "listener exposes its bound address and closes a pending accept",
      () => broken
    ).run()
  ).rejects.toThrow("Listener.addr must return a non-empty bound address")
  expect(closeCalls).toBeGreaterThan(0)
})

test("reports a listener that accepts again after normal close", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const broken: Transport = {
    ...base,
    async listen(ctx, address, ...options): Promise<Listener> {
      const listener = await base.listen(ctx, address, ...options)
      let accepts = 0
      return {
        ...listener,
        accept(acceptCtx, handler): Promise<void> {
          accepts += 1
          if (accepts > 1) return Promise.resolve()
          return listener.accept(acceptCtx, handler)
        }
      }
    }
  }
  await expect(
    conformanceCase(
      "listener exposes its bound address and closes a pending accept",
      () => broken
    ).run()
  ).rejects.toThrow("repeated Listener.accept must reject with GO_LIKE_TRANSPORT_STATE")
})

test("reports Listener.close that resolves before the accept owner terminal settles", async () => {
  if (!implementationAvailable()) return
  const release = deferred<void>()
  let ownerClose: Promise<void> | null = null
  const base = newMemoryTransport()
  const broken: Transport = {
    ...base,
    async listen(ctx, address, ...options): Promise<Listener> {
      const listener = await base.listen(ctx, address, ...options)
      return {
        ...listener,
        close(closeCtx): Promise<void> {
          if (ownerClose === null) {
            ownerClose = release.promise.then(() => listener.close(closeCtx))
          }
          return Promise.resolve()
        }
      }
    }
  }
  const timer = setTimeout(() => release.resolve(undefined), 20)
  try {
    await expect(
      conformanceCase(
        "listener exposes its bound address and closes a pending accept",
        () => broken
      ).run()
    ).rejects.toThrow("Listener.close must not resolve before Listener.accept settles")
  } finally {
    clearTimeout(timer)
    release.resolve(undefined)
    if (ownerClose !== null) await Promise.allSettled([ownerClose])
  }
})

test("reports started Listener.close cancellation that abandons owner cleanup", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const originals: Listener[] = []
  const broken: Transport = {
    ...base,
    async listen(ctx, address, ...options): Promise<Listener> {
      const listener = await base.listen(ctx, address, ...options)
      originals.push(listener)
      let cleanup: Promise<void> | null = null
      return {
        ...listener,
        close(closeCtx): Promise<void> {
          const preexisting = closeCtx.err()
          if (preexisting !== null) return Promise.reject(preexisting)
          if (cleanup !== null) return cleanup
          const signal = closeCtx.done()
          cleanup = new Promise<void>((_resolve, reject) => {
            function onAbort(): void {
              signal?.removeEventListener("abort", onAbort)
              reject(closeCtx.err() ?? canceled)
            }
            signal?.addEventListener("abort", onAbort, { once: true })
          })
          return cleanup
        }
      }
    }
  }
  const found = transportConformanceCases(() => broken, {
    listenAddress: "memory://requested",
    faultHarness: null,
    operationTimeoutMs: 30
  }).find(
    (entry) =>
      entry.name ===
      "pre-canceled accept remains reusable and pre-canceled or started close is caller-scoped"
  )
  if (found === undefined) throw new Error("missing started Listener.close case")
  let observed: unknown = null
  try {
    await found.run()
  } catch (failure) {
    observed = failure
  } finally {
    for (const listener of originals) await listener.close(background())
  }
  expect(observed).toBeInstanceOf(AggregateError)
  if (!(observed instanceof AggregateError))
    throw new Error("expected Listener.close ownership AggregateError")
  expect(observed.errors[0]).toMatchObject({
    message: "a later Listener.close caller must join owner cleanup"
  })
})

test("reports joined Listener.close that resolves before accept terminal", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const originals: Listener[] = []
  const broken: Transport = {
    ...base,
    async listen(ctx, address, ...options): Promise<Listener> {
      const listener = await base.listen(ctx, address, ...options)
      originals.push(listener)
      return {
        ...listener,
        close(closeCtx): Promise<void> {
          const failure = closeCtx.err()
          return failure === null ? Promise.resolve() : Promise.reject(failure)
        }
      }
    }
  }
  const found = transportConformanceCases(() => broken, {
    listenAddress: "memory://requested",
    faultHarness: null,
    operationTimeoutMs: 30
  }).find(
    (entry) =>
      entry.name ===
      "pre-canceled accept remains reusable and pre-canceled or started close is caller-scoped"
  )
  if (found === undefined) throw new Error("missing joined Listener.close terminal case")
  let observed: unknown = null
  try {
    await found.run()
  } catch (failure) {
    observed = failure
  } finally {
    for (const listener of originals) await listener.close(background())
  }
  expect(observed).toBeInstanceOf(AggregateError)
  if (!(observed instanceof AggregateError))
    throw new Error("expected early Listener.close AggregateError")
  expect(observed.errors[0]).toMatchObject({
    message: "a later Listener.close must not resolve before Listener.accept settles"
  })
})

test("reports an active listener whose normal close rejects accept", async () => {
  if (!implementationAvailable()) return
  const hiddenTerminalFailure = new Error("active normal close rejected accept")
  const base = newMemoryTransport()
  const broken: Transport = {
    ...base,
    async listen(ctx, address, ...options): Promise<Listener> {
      const listener = await base.listen(ctx, address, ...options)
      return {
        ...listener,
        async accept(acceptCtx, handler): Promise<void> {
          await listener.accept(acceptCtx, handler)
          throw hiddenTerminalFailure
        }
      }
    }
  }
  const found = transportConformanceCases(() => broken, ConformanceOptions).find(
    (entry) =>
      entry.name === "transport init preserves resources created from an earlier option snapshot"
  )
  if (found === undefined) throw new Error("missing active accept cleanup case")
  await expect(found.run()).rejects.toBe(hiddenTerminalFailure)
})

test("bounds listener close and accept cleanup independently", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const closeFailure = new Error("listener close failed before owner cleanup")
  const originals: Listener[] = []
  const broken: Transport = {
    ...base,
    async listen(ctx, address, ...options): Promise<Listener> {
      const listener = await base.listen(ctx, address, ...options)
      originals.push(listener)
      return {
        ...listener,
        accept(_acceptCtx, handler): Promise<void> {
          return listener.accept(background(), handler)
        },
        close(): Promise<void> {
          return Promise.reject(closeFailure)
        }
      }
    },
    async dial(ctx, address, ...options): Promise<Client> {
      const client = await base.dial(ctx, address, ...options)
      return {
        ...client,
        async recv(recvCtx): Promise<Message> {
          const response = await client.recv(recvCtx)
          return snapshotMessage({ header: response.header, body: new Uint8Array([9]) })
        }
      }
    }
  }
  const found = transportConformanceCases(() => broken, {
    listenAddress: "memory://requested",
    faultHarness: null,
    operationTimeoutMs: 10
  }).find((entry) => entry.name === "client and listener exchange a defensively copied Message")
  expect(found).toBeDefined()
  if (found === undefined) return
  let observed: unknown = null
  try {
    await found.run()
  } catch (failure) {
    observed = failure
  } finally {
    for (const listener of originals) await listener.close(background())
  }
  expect(observed).toBeInstanceOf(AggregateError)
  if (!(observed instanceof AggregateError)) throw new Error("expected cleanup AggregateError")
  expect(observed.errors[0]).toMatchObject({
    message: "transport did not defensively copy Message body bytes"
  })
  expect(observed.errors[1]).toBe(closeFailure)
  expect(observed.errors[2]).toMatchObject({
    message: "Message defensive copy cleanup 5 did not settle within 10ms"
  })
})

test("continues every registered client cleanup after the first close failure", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const firstCleanupFailure = new Error("first registered client cleanup failed")
  let dials = 0
  let cleanupCloses = 0
  let laterCloses = 0
  const broken: Transport = {
    ...base,
    async dial(ctx, address, ...options): Promise<Client> {
      const client = await base.dial(ctx, address, ...options)
      dials += 1
      const dialSequence = dials
      return {
        ...client,
        close(closeCtx): Promise<void> {
          if (dialSequence === 3 && cleanupCloses === 0) return client.close(closeCtx)
          cleanupCloses += 1
          if (cleanupCloses === 1) return Promise.reject(firstCleanupFailure)
          laterCloses += 1
          return client.close(closeCtx)
        }
      }
    }
  }
  const found = transportConformanceCases(() => broken, ConformanceOptions).find(
    (entry) =>
      entry.name ===
      "started client and handler Socket cancellation preserves identity and ownership"
  )
  if (found === undefined) throw new Error("missing started Socket cancellation case")
  await expect(found.run()).rejects.toBe(firstCleanupFailure)
  expect(cleanupCloses).toBeGreaterThan(1)
  expect(laterCloses).toBeGreaterThan(0)
})

test("reports an arbitrary send failure after started recv cancellation", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const arbitraryFailure = new Error("arbitrary send failure after recv cancellation")
  const broken: Transport = {
    ...base,
    async dial(ctx, address, ...options): Promise<Client> {
      const client = await base.dial(ctx, address, ...options)
      return {
        ...client,
        async send(sendCtx, message): Promise<void> {
          try {
            await client.send(sendCtx, message)
          } catch (failure) {
            if (message.header.topic === "client-recv-cancel") throw arbitraryFailure
            throw failure
          }
        }
      }
    }
  }
  const found = transportConformanceCases(() => broken, ConformanceOptions).find(
    (entry) =>
      entry.name ===
      "started client and handler Socket cancellation preserves identity and ownership"
  )
  if (found === undefined) throw new Error("missing started Socket cancellation case")
  await expect(found.run()).rejects.toThrow(
    "client Socket.send after recv cancellation returned an unrelated failure"
  )
})

test("preserves an assertion failure together with Transport cleanup failure", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const cleanupFailure = new Error("transport cleanup failed")
  const broken: Transport = {
    ...base,
    async listen(ctx, address, ...options): Promise<Listener> {
      const listener = await base.listen(ctx, address, ...options)
      return {
        ...listener,
        addr: () => "",
        async close(closeCtx): Promise<void> {
          await listener.close(closeCtx)
          throw cleanupFailure
        }
      }
    }
  }
  let failure: unknown = null
  try {
    await conformanceCase(
      "listener exposes its bound address and closes a pending accept",
      () => broken
    ).run()
  } catch (value) {
    failure = value
  }
  expect(failure).toBeInstanceOf(AggregateError)
  if (!(failure instanceof AggregateError)) throw new Error("expected transport AggregateError")
  expect(failure.errors[0]).toMatchObject({
    message: "Listener.addr must return a non-empty bound address"
  })
  expect(failure.errors[1]).toBe(cleanupFailure)
})

test("flattens an assertion and multiple cleanup failures in stable order", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const clientFailure = new Error("client cleanup failed")
  const listenerFailure = new Error("listener cleanup failed")
  const broken: Transport = {
    ...base,
    async listen(ctx, address, ...options): Promise<Listener> {
      const listener = await base.listen(ctx, address, ...options)
      const boundAddress = listener.addr()
      let addressReads = 0
      return {
        ...listener,
        addr(): string {
          addressReads += 1
          return addressReads === 1 ? boundAddress : `${boundAddress}/changed`
        },
        async close(closeCtx): Promise<void> {
          await listener.close(closeCtx)
          throw listenerFailure
        }
      }
    },
    async dial(ctx, address, ...options): Promise<Client> {
      const client = await base.dial(ctx, address, ...options)
      return {
        ...client,
        async close(closeCtx): Promise<void> {
          await client.close(closeCtx)
          throw clientFailure
        }
      }
    }
  }
  let observed: unknown = null
  try {
    await conformanceCase(
      "transport init preserves resources created from an earlier option snapshot",
      () => broken
    ).run()
  } catch (failure) {
    observed = failure
  }
  expect(observed).toBeInstanceOf(AggregateError)
  if (!(observed instanceof AggregateError)) throw new Error("expected scenario AggregateError")
  expect(observed.errors[0]).toMatchObject({
    message: "Transport.init changed an existing listener address"
  })
  expect(observed.errors[1]).toBe(clientFailure)
  expect(observed.errors[2]).toBe(listenerFailure)
})

test("reports a repeated accept that does not expose TransportStateError", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const broken: Transport = {
    ...base,
    async listen(ctx, address, ...options): Promise<Listener> {
      const listener = await base.listen(ctx, address, ...options)
      let calls = 0
      return {
        ...listener,
        accept(acceptCtx, handler): Promise<void> {
          calls += 1
          if (calls > 1) return Promise.reject(new Error("wrong repeated accept error"))
          return listener.accept(acceptCtx, handler)
        }
      }
    }
  }
  await expect(
    conformanceCase("accept cancellation preserves the Context terminal error", () => broken).run()
  ).rejects.toThrow("repeated Listener.accept must reject with GO_LIKE_TRANSPORT_STATE")
})

test("reports a corrupted response body from a structural client", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const broken: Transport = {
    ...base,
    async dial(ctx, address, ...options): Promise<Client> {
      const client = await base.dial(ctx, address, ...options)
      return {
        ...client,
        async recv(recvCtx): Promise<Message> {
          const response = await client.recv(recvCtx)
          return snapshotMessage({ header: response.header, body: new Uint8Array([9]) })
        }
      }
    }
  }
  await expect(
    conformanceCase("client and listener exchange a defensively copied Message", () => broken).run()
  ).rejects.toThrow("transport did not defensively copy Message body bytes")
})

test("reports a client that pairs FIFO slots by response completion order", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  let activeListener: MemoryListener | null = null
  const broken: Transport = {
    ...base,
    async listen(ctx, address, ...options): Promise<Listener> {
      const listener = await base.listen(ctx, address, ...options)
      activeListener = listener as MemoryListener
      return listener
    },
    async dial(ctx): Promise<Client> {
      checkContext(ctx)
      const listener = activeListener
      if (listener === null) throw newTransportStateError("listener is unavailable")
      let closed = false
      const completed: Message[] = []
      return {
        async send(sendCtx, message): Promise<void> {
          checkContext(sendCtx)
          if (closed) throw newTransportClosedError("client closed")
          const exchange = listener.dispatch(snapshotMessage(message))
          completed.push(snapshotMessage(await waitForContext(sendCtx, exchange.response)))
        },
        recv(recvCtx): Promise<Message> {
          checkContext(recvCtx)
          if (closed) return Promise.reject(newTransportClosedError("client closed"))
          const response = completed.shift()
          return response === undefined
            ? Promise.reject(newTransportStateError("recv before send"))
            : Promise.resolve(snapshotMessage(response))
        },
        close(closeCtx): Promise<void> {
          checkContext(closeCtx)
          closed = true
          return Promise.resolve()
        },
        local(): string {
          return "memory://completion-order-client"
        },
        remote(): string {
          return listener.addr()
        }
      }
    }
  }
  await expect(
    conformanceCase(
      "socket rejects recv-before-send and preserves invocation order",
      () => broken
    ).run()
  ).rejects.toThrow("transport did not defensively copy Message headers")
})

test("accepts a Client that serializes send calls in invocation order", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const serial: Transport = {
    init(...options): void {
      base.init(...options)
    },
    options(): Options {
      return base.options()
    },
    listen(ctx, address, ...options): Promise<Listener> {
      return base.listen(ctx, address, ...options)
    },
    async dial(ctx, address, ...options): Promise<Client> {
      const client = await base.dial(ctx, address, ...options)
      let sendQueue = Promise.resolve()
      return {
        send(sendCtx, message): Promise<void> {
          const outgoing = snapshotMessage(message)
          const sending = sendQueue.then(() => client.send(sendCtx, outgoing))
          sendQueue = sending.then(
            () => undefined,
            () => undefined
          )
          return sending
        },
        recv(recvCtx): Promise<Message> {
          return client.recv(recvCtx)
        },
        close(closeCtx): Promise<void> {
          return client.close(closeCtx)
        },
        local(): string {
          return client.local()
        },
        remote(): string {
          return client.remote()
        }
      }
    },
    string(): string {
      return base.string()
    }
  }
  const found = transportConformanceCases(() => serial, {
    listenAddress: "memory://requested",
    faultHarness: null,
    operationTimeoutMs: 40
  }).find(
    (entry) => entry.name === "socket rejects recv-before-send and preserves invocation order"
  )
  if (found === undefined) throw new Error("missing socket invocation-order conformance case")

  await expect(found.run()).resolves.toBeUndefined()
})

test("reports a Client.send implementation that snapshots Message after invocation", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const broken: Transport = {
    ...base,
    async dial(ctx, address, ...options): Promise<Client> {
      const client = await base.dial(ctx, address, ...options)
      return {
        ...client,
        send(sendCtx, message): Promise<void> {
          return Promise.resolve().then(() => client.send(sendCtx, message))
        }
      }
    }
  }
  await expect(
    conformanceCase("client and listener exchange a defensively copied Message", () => broken).run()
  ).rejects.toThrow()
})

test("reports reviewed common defaults that drift at the provider boundary", async () => {
  if (!implementationAvailable()) return
  const base = newMemoryTransport()
  const broken: Transport = {
    ...base,
    options(): Options {
      const current = base.options()
      return Object.freeze({
        codec: current.codec,
        logger: current.logger,
        timeoutMs: 1,
        secure: current.secure,
        tlsConfig: current.tlsConfig
      })
    }
  }
  await expect(
    conformanceCase(
      "transport exposes defaults and rejects invalid public options",
      () => broken
    ).run()
  ).rejects.toThrow("Transport.options must expose the reviewed common defaults")
})

test("reports a failed health exchange after started creation cancellation", async () => {
  if (!implementationAvailable()) return
  const healthFailure = new Error("started creation health failed")
  const broken = mutateClients(newMemoryTransport(), (client, sequence) =>
    sequence === 2
      ? {
          ...client,
          send(): Promise<void> {
            return Promise.reject(healthFailure)
          }
        }
      : client
  )
  await expect(
    conformanceCase(
      "started dial and listen cancellation preserves identity and later admission",
      () => broken
    ).run()
  ).rejects.toBe(healthFailure)
})

test("reports listener terminal and address drift branches", async () => {
  if (!implementationAvailable()) return

  const early = mutateListeners(newMemoryTransport(), (listener) => ({
    ...listener,
    accept(): Promise<void> {
      return Promise.resolve()
    }
  }))
  await expect(
    conformanceCase(
      "listener exposes its bound address and closes a pending accept",
      () => early
    ).run()
  ).rejects.toThrow("Listener.accept must remain pending until a terminal event")

  const terminalFailure = new Error("listener close rejected accept")
  const rejected = mutateListeners(newMemoryTransport(), (listener) => ({
    ...listener,
    async accept(acceptCtx, handler): Promise<void> {
      await listener.accept(acceptCtx, handler)
      throw terminalFailure
    }
  }))
  const rejectedResult = await captureTestOutcome(
    conformanceCase(
      "listener exposes its bound address and closes a pending accept",
      () => rejected
    ).run()
  )
  expect(rejectedResult.rejected).toBeTrue()
  if (!rejectedResult.rejected) throw new Error("listener terminal failure was not reported")
  expect(rejectedResult.value).toBe(terminalFailure)

  const changed = mutateListeners(newMemoryTransport(), (listener) => {
    const address = listener.addr()
    let closed = false
    return {
      ...listener,
      addr(): string {
        return closed ? `${address}/closed` : address
      },
      async close(closeCtx): Promise<void> {
        await listener.close(closeCtx)
        closed = true
      }
    }
  })
  await expect(
    conformanceCase(
      "listener exposes its bound address and closes a pending accept",
      () => changed
    ).run()
  ).rejects.toThrow("Listener.addr changed after close")
})

test("reports early cancellation settlement and consumed pre-canceled accept", async () => {
  if (!implementationAvailable()) return
  const early = mutateListeners(newMemoryTransport(), (listener) => ({
    ...listener,
    accept(): Promise<void> {
      return Promise.resolve()
    }
  }))
  await expect(
    conformanceCase("accept cancellation preserves the Context terminal error", () => early).run()
  ).rejects.toThrow("Listener.accept settled before Context cancellation")

  const consumed = mutateListeners(newMemoryTransport(), (listener) => {
    let accepts = 0
    return {
      ...listener,
      accept(acceptCtx, handler): Promise<void> {
        accepts += 1
        if (accepts !== 1) return Promise.resolve()
        void listener.accept(background(), handler).catch(() => {})
        return Promise.reject(canceled)
      }
    }
  })
  await expect(
    conformanceCase(
      "pre-canceled accept remains reusable and pre-canceled or started close is caller-scoped",
      () => consumed
    ).run()
  ).rejects.toThrow("pre-canceled accept consumed the one-shot Listener")
})

test("reports a rejecting accept terminal after joined listener close", async () => {
  if (!implementationAvailable()) return
  const terminalFailure = new Error("joined close accept rejected")
  const broken = mutateListeners(newMemoryTransport(), (listener) => ({
    ...listener,
    async accept(acceptCtx, handler): Promise<void> {
      await listener.accept(acceptCtx, handler)
      throw terminalFailure
    }
  }))
  const result = await captureTestOutcome(
    conformanceCase(
      "pre-canceled accept remains reusable and pre-canceled or started close is caller-scoped",
      () => broken
    ).run()
  )
  expect(result.rejected).toBeTrue()
  if (!result.rejected) throw new Error("joined close terminal rejection was not reported")
  expect(result.value).toBe(terminalFailure)
})

test("reports handler Contexts without signals or with wrong terminal errors", async () => {
  if (!implementationAvailable()) return
  const missingSignal = mutateHandlerContext(newMemoryTransport(), (ctx) => ({
    deadline: () => ctx.deadline(),
    done: () => null,
    err: () => ctx.err(),
    value: (key) => ctx.value(key)
  }))
  await expect(
    conformanceCase(
      "handler Context is derived and canceled by accept termination",
      () => missingSignal
    ).run()
  ).rejects.toThrow("handler Context must expose a cancellation signal")

  const wrongAcceptFailure = new Error("wrong accept handler terminal")
  const wrongAccept = mutateHandlerContext(newMemoryTransport(), (ctx) => ({
    deadline: () => ctx.deadline(),
    done: () => ctx.done(),
    err(): Error | null {
      return ctx.err() === null ? null : wrongAcceptFailure
    },
    value: (key) => ctx.value(key)
  }))
  await expect(
    conformanceCase(
      "handler Context is derived and canceled by accept termination",
      () => wrongAccept
    ).run()
  ).rejects.toThrow("accept termination must cancel the handler Context")

  const wrongOwnedFailure = new Error("wrong owned handler terminal")
  const wrongOwned = mutateHandlerContext(newMemoryTransport(), (ctx) => ({
    deadline: () => ctx.deadline(),
    done: () => ctx.done(),
    err(): Error | null {
      return ctx.err() === null ? null : wrongOwnedFailure
    },
    value: (key) => ctx.value(key)
  }))
  await expect(
    conformanceCase(
      "handler Context is canceled by listener and socket termination",
      () => wrongOwned
    ).run()
  ).rejects.toThrow("termination must cancel the handler Context")
})

test("reports every handler failure-isolation branch", async () => {
  if (!implementationAvailable()) return

  const swallowed = mutateListeners(newMemoryTransport(), (listener) => ({
    ...listener,
    accept(acceptCtx, handler): Promise<void> {
      return listener.accept(acceptCtx, async (handlerCtx, socket) => {
        try {
          await handler(handlerCtx, socket)
        } catch {
          await socket.send(handlerCtx, {
            header: Object.freeze({ topic: "failure" }),
            body: new Uint8Array([1, 2])
          })
        }
      })
    }
  }))
  await expect(
    conformanceCase("concurrent handlers isolate one handler failure", () => swallowed).run()
  ).rejects.toThrow("a rejecting handler must fail only its own exchange")

  const successFailure = new Error("success exchange failed")
  const rejectedSuccess = mutateHandlerSocket(newMemoryTransport(), (socket) => {
    let topic = ""
    return {
      ...socket,
      async recv(recvCtx): Promise<Message> {
        const message = await socket.recv(recvCtx)
        topic = message.header.topic ?? ""
        return message
      },
      send(sendCtx, message): Promise<void> {
        return topic === "success" ? Promise.reject(successFailure) : socket.send(sendCtx, message)
      }
    }
  })
  await expect(
    conformanceCase("concurrent handlers isolate one handler failure", () => rejectedSuccess).run()
  ).rejects.toBe(successFailure)

  const endedAccept = mutateListeners(newMemoryTransport(), (listener) => {
    const firstFailure = deferred<void>()
    return {
      ...listener,
      accept(acceptCtx, handler): Promise<void> {
        const accepting = listener.accept(acceptCtx, async (handlerCtx, socket) => {
          try {
            await handler(handlerCtx, socket)
          } catch (failure) {
            firstFailure.resolve(undefined)
            throw failure
          }
        })
        return Promise.race([accepting, firstFailure.promise])
      }
    }
  })
  await expect(
    conformanceCase("concurrent handlers isolate one handler failure", () => endedAccept).run()
  ).rejects.toThrow("one handler failure terminated the accept loop")

  const laterFailure = new Error("later exchange failed")
  const rejectedLater = mutateClients(newMemoryTransport(), (client, sequence) =>
    sequence === 3
      ? {
          ...client,
          send(): Promise<void> {
            return Promise.reject(laterFailure)
          }
        }
      : client
  )
  await expect(
    conformanceCase("concurrent handlers isolate one handler failure", () => rejectedLater).run()
  ).rejects.toBe(laterFailure)
})

test("reports response send failure and mutable response headers", async () => {
  if (!implementationAvailable()) return
  const responseFailure = new Error("response send failed")
  const rejectedSend = mutateClients(newMemoryTransport(), (client) => ({
    ...client,
    async send(sendCtx, message): Promise<void> {
      await client.send(sendCtx, message)
      throw responseFailure
    }
  }))
  await expect(
    conformanceCase(
      "client and listener exchange a defensively copied Message",
      () => rejectedSend
    ).run()
  ).rejects.toBe(responseFailure)

  const mutableHeader = mutateClients(newMemoryTransport(), (client) => ({
    ...client,
    async recv(recvCtx): Promise<Message> {
      const message = await client.recv(recvCtx)
      return { header: { ...message.header }, body: message.body }
    }
  }))
  await expect(
    conformanceCase(
      "client and listener exchange a defensively copied Message",
      () => mutableHeader
    ).run()
  ).rejects.toThrow("received Message header must be frozen")
})

test("reports a host failure harness that fulfills listener accept", async () => {
  if (!implementationAvailable()) return
  const found = transportConformanceCases(newMemoryTransport, {
    listenAddress: "memory://requested",
    faultHarness: {
      failListener(ctx, listener): Promise<void> {
        return listener.close(ctx)
      }
    }
  }).find((entry) => entry.name === "unexpected listener failure preserves its original cause")
  if (found === undefined) throw new Error("missing fulfilled host failure case")
  await expect(found.run()).rejects.toThrow(
    "unexpected listener failure must reject Listener.accept"
  )
})

test("rejects conformance options without a listen address", () => {
  expect(() =>
    Reflect.apply(transportConformanceCases, undefined, [
      newMemoryTransport,
      { faultHarness: null }
    ])
  ).toThrow("transport conformance listenAddress must be a non-empty string")
})

test("rejects an empty conformance listen address", () => {
  if (!implementationAvailable()) return
  expect(() =>
    transportConformanceCases(newMemoryTransport, {
      listenAddress: "",
      faultHarness: null
    })
  ).toThrow("transport conformance listenAddress must be a non-empty string")
})

test("rejects non-object conformance options", () => {
  expect(() =>
    Reflect.apply(transportConformanceCases, undefined, [newMemoryTransport, null])
  ).toThrow("transport conformance options must be an object")
})

test("rejects invalid conformance operation timeouts", () => {
  for (const operationTimeoutMs of [
    -1,
    0,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1
  ]) {
    expect(() =>
      transportConformanceCases(newMemoryTransport, {
        listenAddress: "memory://requested",
        faultHarness: null,
        operationTimeoutMs
      })
    ).toThrow("transport conformance operationTimeoutMs must be a positive safe integer")
  }
})

test("uses the standard canceled error for accept cancellation", () => {
  expect(canceled.name).toBe("Canceled")
})
