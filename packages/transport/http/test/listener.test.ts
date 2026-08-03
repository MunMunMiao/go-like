import { expect, test } from "bun:test"

import { background, canceled, withCancel, withCancelCause, type Context } from "@likego/context"
import {
  logger,
  secure,
  tlsConfig,
  withConnClose,
  type Message,
  type TransportLogLevel
} from "@likego/transport"
import {
  executor,
  newHTTPTransport,
  type HTTPExecutor,
  type HTTPListener
} from "@likego/transport-http"
import { newHTTPListener } from "../src/listener"
import { host } from "../src/options"
import { dispatchHTTPHostRequest } from "../src/socket"
import type {
  HTTPHandler,
  HTTPHost,
  HTTPHostCapabilities,
  HTTPHostHandle,
  HTTPHostListenOptions,
  HTTPServeHandle
} from "../src/types"

/** Creates one externally settled Promise. */
function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
} {
  let resolve: ((value: T) => void) | null = null
  let reject: ((error: unknown) => void) | null = null
  const promise = new Promise<T>(function capture(resolvePromise, rejectPromise): void {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return Object.freeze({
    promise,
    /** Resolves the captured Promise. */
    resolve(value: T): void {
      resolve?.(value)
    },
    /** Rejects the captured Promise. */
    reject(error: unknown): void {
      reject?.(error)
    }
  })
}

/** Holds observable controls for one borrowed fake runtime host. */
interface HostFixture {
  readonly host: HTTPHost
  readonly handle: HTTPHostHandle
  readonly ready: ReturnType<typeof deferred<void>>
  readonly serveDone: ReturnType<typeof deferred<void>>
  readonly hostDone: ReturnType<typeof deferred<void>>
  readonly bindOptions: HTTPHostListenOptions[]
  readonly requests: HTTPHandler[]
  readonly closeCalls: number[]
  readonly bindCalls: number[]
}

/** Creates a controllable two-phase host that gracefully terminates on close. */
function hostFixture(
  capabilities: HTTPHostCapabilities = Object.freeze({
    tls: false,
    forceClose: false,
    connectionMetadata: true
  }),
  advertiseForceWithoutMethod = false
): HostFixture {
  const ready = deferred<void>()
  const serveDone = deferred<void>()
  const hostDone = deferred<void>()
  const bindOptions: HTTPHostListenOptions[] = []
  const requests: HTTPHandler[] = []
  const closeCalls: number[] = []
  const bindCalls: number[] = []
  const handle: HTTPHostHandle = Object.freeze({
    /** Returns one actual ephemeral address. */
    address(): string {
      return "127.0.0.1:43123"
    },
    /** Captures the transport dispatcher and exposes controlled lifecycle Promises. */
    serve(_ctx: Context, handler: HTTPHandler) {
      requests.push(handler)
      return Object.freeze({
        /** Returns controlled admission. */
        ready(): Promise<void> {
          return ready.promise
        },
        /** Returns controlled serve terminal. */
        done(): Promise<void> {
          return serveDone.promise
        }
      })
    },
    /** Returns controlled host terminal. */
    done(): Promise<void> {
      return hostDone.promise
    },
    /** Gracefully settles both runtime sides. */
    close(): Promise<void> {
      closeCalls.push(closeCalls.length + 1)
      serveDone.resolve(undefined)
      hostDone.resolve(undefined)
      return Promise.resolve()
    }
  })
  const forceHandle: HTTPHostHandle = advertiseForceWithoutMethod
    ? handle
    : Object.freeze(
        Object.assign(
          {},
          handle,
          capabilities.forceClose
            ? {
                /** Settles both sides when the declared force capability is invoked. */
                forceClose(): Promise<void> {
                  serveDone.resolve(undefined)
                  hostDone.resolve(undefined)
                  return Promise.resolve()
                }
              }
            : {}
        )
      )
  const borrowed: HTTPHost = Object.freeze({
    /** Returns the chosen capability snapshot. */
    capabilities(): HTTPHostCapabilities {
      return capabilities
    },
    /** Records bind inputs and returns the controlled handle. */
    bind(_ctx: Context, _address: string, options: HTTPHostListenOptions): Promise<HTTPHostHandle> {
      bindCalls.push(bindCalls.length + 1)
      bindOptions.push(options)
      return Promise.resolve(forceHandle)
    }
  })
  return Object.freeze({
    host: borrowed,
    handle: forceHandle,
    ready,
    serveDone,
    hostDone,
    bindOptions,
    requests,
    closeCalls,
    bindCalls
  })
}

/** Creates one immutable transport Message response. */
function message(value: string): Message {
  return Object.freeze({
    header: Object.freeze({ "X-Likego-Result": "ok" }),
    body: new TextEncoder().encode(value)
  })
}

/** Completes a callable Fetch executor with optional runtime statics. */
function httpExecutor(
  run: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): HTTPExecutor {
  return Object.assign(run, {
    /** Leaves optional connection warming inert in portable tests. */
    preconnect(): void {}
  })
}

/** Holds every independently settled side of one listener terminal arbiter. */
interface ArbiterFixture {
  readonly handle: HTTPHostHandle
  readonly ready: ReturnType<typeof deferred<void>>
  readonly serveDone: ReturnType<typeof deferred<void>>
  readonly hostDone: ReturnType<typeof deferred<void>>
  readonly closeDone: ReturnType<typeof deferred<void>>
  readonly closeCalls: number[]
  readonly serveContexts: Context[]
}

/** Observes listener registrations on one live parent Context without canceling it. */
interface ContextListenerProbe {
  readonly context: Context
  readonly signal: AbortSignal
  /** Returns the current add/remove listener balance. */
  readonly listenerCount: () => number
}

/** Creates one structural parent Context with an observable standard AbortSignal boundary. */
function contextListenerProbe(): ContextListenerProbe {
  const controller = new AbortController()
  const fallback = background()
  let added = 0
  let removed = 0
  const signal = new Proxy(controller.signal, {
    /** Counts listener operations while preserving the native AbortSignal receiver. */
    get(target, property): unknown {
      if (property === "addEventListener") {
        return function addEventListener(
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | AddEventListenerOptions
        ): void {
          added += 1
          target.addEventListener(type, listener, options)
        }
      }
      if (property === "removeEventListener") {
        return function removeEventListener(
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | EventListenerOptions
        ): void {
          removed += 1
          target.removeEventListener(type, listener, options)
        }
      }
      return Reflect.get(target, property, target)
    }
  })
  const context: Context = Object.freeze({
    /** Returns the no-deadline parent snapshot. */
    deadline(): readonly [Date, boolean] {
      return fallback.deadline()
    },
    /** Returns the observed parent signal. */
    done(): AbortSignal {
      return signal
    },
    /** Keeps the parent live while the listener-owned child terminates. */
    err(): null {
      return null
    },
    /** Delegates the inert parent value lookup. */
    value(key: unknown): unknown {
      return fallback.value(key)
    }
  })
  return Object.freeze({
    context,
    signal,
    /** Returns the current add/remove listener balance. */
    listenerCount(): number {
      return added - removed
    }
  })
}

/** Returns the Error rejection from one Promise and fails for any other outcome. */
async function rejection(work: Promise<unknown>): Promise<Error> {
  try {
    await work
  } catch (error) {
    if (error instanceof Error) return error
    throw new Error("expected listener operation to reject with an Error")
  }
  throw new Error("expected listener operation to reject")
}

/** Verifies one serve-first terminal ordering releases only the derived accept owner. */
async function expectServeFirstOwnerCleanup(
  phase: "before-ready" | "running",
  outcome: "resolve" | "reject"
): Promise<void> {
  const fixture = arbiterFixture()
  const parent = contextListenerProbe()
  const listener = newHTTPListener("127.0.0.1:43125", fixture.handle, baselineCapabilities())
  const baselineListeners = parent.listenerCount()
  const accepted = listener.accepted()
  const accepting = listener.accept(parent.context, function noop(): void {})
  expect(parent.listenerCount()).toBeGreaterThan(baselineListeners)

  if (phase === "running") {
    fixture.ready.resolve(undefined)
    await accepted
  }
  const serveFailure = new Error(`serve ${phase} rejected`)
  if (outcome === "resolve") fixture.serveDone.resolve(undefined)
  else fixture.serveDone.reject(serveFailure)

  const admissionFailure = phase === "before-ready" ? await rejection(accepted) : null
  await Promise.resolve()
  expect(fixture.closeCalls).toHaveLength(1)
  fixture.hostDone.resolve(undefined)
  fixture.closeDone.resolve(undefined)
  const terminalFailure = await rejection(accepting)

  if (outcome === "reject") {
    expect(admissionFailure).toBe(phase === "before-ready" ? serveFailure : null)
    expect(terminalFailure).toBe(serveFailure)
  } else {
    expect(terminalFailure).toMatchObject({
      code: "LIKEGO_HTTP_TRANSPORT_UNEXPECTED_EXIT",
      source: "serve",
      phase
    })
    if (admissionFailure !== null) expect(admissionFailure).toBe(terminalFailure)
  }
  expect(await rejection(listener.close(background()))).toBe(terminalFailure)
  expect(fixture.serveContexts[0]?.err()).toBe(canceled)
  expect(parent.listenerCount()).toBe(baselineListeners)
  expect(parent.context.err()).toBeNull()
  expect(parent.signal.aborted).toBe(false)
  expect(fixture.closeCalls).toHaveLength(1)
}

/** Creates one host handle whose readiness, terminals, and close are independent. */
function arbiterFixture(): ArbiterFixture {
  const ready = deferred<void>()
  const serveDone = deferred<void>()
  const hostDone = deferred<void>()
  const closeDone = deferred<void>()
  const closeCalls: number[] = []
  const serveContexts: Context[] = []
  const handle: HTTPHostHandle = Object.freeze({
    /** Returns one deterministic bound address. */
    address(): string {
      return "127.0.0.1:43125"
    },
    /** Captures the owner Context and returns independently settled serve state. */
    serve(ctx: Context): HTTPServeHandle {
      serveContexts.push(ctx)
      return Object.freeze({
        /** Returns controlled admission readiness. */
        ready(): Promise<void> {
          return ready.promise
        },
        /** Returns controlled serve terminal state. */
        done(): Promise<void> {
          return serveDone.promise
        }
      })
    },
    /** Returns controlled host terminal state. */
    done(): Promise<void> {
      return hostDone.promise
    },
    /** Records graceful cleanup without pretending either runtime side terminated. */
    close(): Promise<void> {
      closeCalls.push(closeCalls.length + 1)
      return closeDone.promise
    }
  })
  return Object.freeze({
    handle,
    ready,
    serveDone,
    hostDone,
    closeDone,
    closeCalls,
    serveContexts
  })
}

/** Returns the portable baseline capability snapshot used by direct arbiter tests. */
function baselineCapabilities(): HTTPHostCapabilities {
  return Object.freeze({
    tls: false,
    forceClose: false,
    connectionMetadata: false
  })
}

interface ReadyThrowRace {
  readonly listener: HTTPListener
  readonly accepted: Promise<void>
  readonly accepting: Promise<void>
  readonly failure: Error
  readonly closeCalls: readonly number[]
  readonly reentrantClose: () => Promise<void> | null
}

/** Starts a ready call that first cancels admission or closes its listener, then throws. */
function readyThrowRace(kind: "cancel" | "close"): ReadyThrowRace {
  const hostDone = deferred<void>()
  const serveDone = deferred<void>()
  const failure = new Error(`ready failed after ${kind}`)
  const closeCalls: number[] = []
  const [acceptContext, cancelAccept] = withCancel(background())
  let listener: HTTPListener | null = null
  let reentrantClose: Promise<void> | null = null
  const handle: HTTPHostHandle = Object.freeze({
    /** Returns one deterministic bound address. */
    address(): string {
      return "127.0.0.1:43127"
    },
    /** Returns a serve handle whose ready boundary performs the selected reentry. */
    serve(): HTTPServeHandle {
      return Object.freeze({
        /** Lets host and serve settlement jobs race ahead of the later ready rejection job. */
        ready(): never {
          if (kind === "cancel") cancelAccept()
          else {
            const activeListener = listener
            if (activeListener === null) throw new Error("listener missing during ready reentry")
            reentrantClose = activeListener.close(background())
          }
          throw failure
        },
        /** Returns the host-close-controlled serve terminal. */
        done(): Promise<void> {
          return serveDone.promise
        }
      })
    },
    /** Returns the host-close-controlled host terminal. */
    done(): Promise<void> {
      return hostDone.promise
    },
    /** Resolves both sides synchronously and records exactly-once cleanup. */
    close(): Promise<void> {
      closeCalls.push(closeCalls.length + 1)
      serveDone.resolve(undefined)
      hostDone.resolve(undefined)
      return Promise.resolve()
    }
  })
  listener = newHTTPListener("127.0.0.1:43127", handle, baselineCapabilities())
  const activeListener = listener
  const accepted = activeListener.accepted()
  const accepting = activeListener.accept(
    kind === "cancel" ? acceptContext : background(),
    function noop(): void {}
  )
  return Object.freeze({
    listener: activeListener,
    accepted,
    accepting,
    failure,
    closeCalls,
    /** Reads callback-owned close state without assuming assignment timing. */
    reentrantClose(): Promise<void> | null {
      return reentrantClose
    }
  })
}

test("listen binds, accepts once, dispatches unary wire, and closes cleanly", async () => {
  const fixture = hostFixture()
  const transport = newHTTPTransport()
  const listener = await transport.listen(background(), "127.0.0.1:0", host(fixture.host))
  expect(listener.addr()).toBe("127.0.0.1:43123")
  expect(fixture.bindOptions).toEqual([
    {
      secure: false,
      tlsConfig: null
    }
  ])
  expect(listener.accepted()).toBe(listener.accepted())

  const accept = listener.accept(background(), async function echo(ctx, socket): Promise<void> {
    const incoming = await socket.recv(ctx)
    expect(new TextDecoder().decode(incoming.body)).toBe("ping")
    expect(socket.local()).toBe("127.0.0.1:43123")
    expect(socket.remote()).toBe("127.0.0.1:54321")
    await socket.send(ctx, message("pong"))
  })
  fixture.ready.resolve(undefined)
  await listener.accepted()
  const dispatcher = fixture.requests[0]
  if (dispatcher === undefined) throw new Error("dispatcher missing")
  const response = await dispatcher(
    Object.freeze({
      request: new Request("http://127.0.0.1/rpc", { method: "POST", body: "ping" }),
      localAddress: "127.0.0.1:43123",
      remoteAddress: "127.0.0.1:54321"
    })
  )
  expect(response.status).toBe(200)
  expect(response.headers.get("X-Likego-Result")).toBe("ok")
  expect(await response.text()).toBe("pong")

  await listener.close(background())
  await expect(accept).resolves.toBeUndefined()
  await expect(listener.accept(background(), function noop(): void {})).rejects.toMatchObject({
    code: "LIKEGO_TRANSPORT_STATE"
  })
})

test("cancelable bind and close callers detach from the shared listener terminal", async () => {
  const fixture = hostFixture()
  const [liveContext] = withCancel(background())
  const listener = await newHTTPTransport().listen(liveContext, "127.0.0.1:0", host(fixture.host))
  await listener.close(liveContext)

  const pendingFixture = arbiterFixture()
  const pending = newHTTPListener("127.0.0.1:43125", pendingFixture.handle, baselineCapabilities())
  const [caller, cancelCaller] = withCancel(background())
  const closing = pending.close(caller)
  cancelCaller()
  await expect(closing).rejects.toBe(canceled)
  pendingFixture.hostDone.resolve(undefined)
  pendingFixture.closeDone.resolve(undefined)
  await pending.close(background())
})

test("pre-canceled close preserves its cause without admitting cleanup", async () => {
  const fixture = hostFixture()
  const listener = await newHTTPTransport().listen(background(), "127.0.0.1:0", host(fixture.host))
  const [ctx, cancel] = withCancelCause(background())
  const marker = new Error("listener close caller expired")
  cancel(marker)

  await expect(listener.close(ctx)).rejects.toBe(marker)
  expect(fixture.closeCalls).toHaveLength(0)
  await expect(listener.close(background())).resolves.toBeUndefined()
  expect(fixture.closeCalls).toHaveLength(1)
})

test("pre-canceled dial preserves its custom Context cause", async () => {
  const [ctx, cancel] = withCancelCause(background())
  const marker = new Error("dial caller expired")
  cancel(marker)

  await expect(newHTTPTransport().dial(ctx, "localhost:8080")).rejects.toBe(marker)
})

test("handler failures and missing send return secret-safe 500 responses", async () => {
  const fixture = hostFixture()
  const secret = "credential-secret-value"
  const handlerFailure = new Error(secret)
  let loggedCause: unknown = null
  const transport = newHTTPTransport()
  transport.init(
    logger(
      Object.freeze({
        /** Captures the internal handler failure without changing the wire response. */
        log(
          _level: TransportLogLevel,
          _message: string,
          fields?: Readonly<Record<string, unknown>>
        ): void {
          loggedCause = fields?.["cause"]
        }
      })
    )
  )
  const listener = await transport.listen(background(), "127.0.0.1:0", host(fixture.host))
  const accept = listener.accept(background(), function fail(): never {
    throw handlerFailure
  })
  fixture.ready.resolve(undefined)
  await listener.accepted()
  const dispatcher = fixture.requests[0]
  if (dispatcher === undefined) throw new Error("dispatcher missing")
  const response = await dispatcher(
    Object.freeze({
      request: new Request("http://127.0.0.1/rpc", { method: "POST" }),
      localAddress: "",
      remoteAddress: ""
    })
  )
  expect(response.status).toBe(500)
  expect(await response.text()).not.toContain(secret)
  expect(loggedCause).toBe(handlerFailure)
  await listener.close(background())
  await accept

  const second = hostFixture()
  const noSend = await newHTTPTransport().listen(background(), "127.0.0.1:0", host(second.host))
  const noSendAccept = noSend.accept(background(), function returnWithoutSend(): void {})
  second.ready.resolve(undefined)
  await noSend.accepted()
  const noSendDispatcher = second.requests[0]
  if (noSendDispatcher === undefined) throw new Error("dispatcher missing")
  expect(
    (
      await noSendDispatcher(
        Object.freeze({
          request: new Request("http://127.0.0.1/rpc", { method: "POST" }),
          localAddress: "",
          remoteAddress: ""
        })
      )
    ).status
  ).toBe(500)
  await noSend.close(background())
  await noSendAccept
})

test("pre-canceled Socket close preserves its cause without closing the exchange", async () => {
  const [ctx, cancel] = withCancelCause(background())
  const marker = new Error("socket close caller expired")
  cancel(marker)
  let closeFailure: unknown = null
  let received = ""

  const response = await dispatchHTTPHostRequest(
    background(),
    async function close(_handlerContext, socket): Promise<void> {
      closeFailure = await socket.close(ctx).then(
        function fulfilled(): unknown {
          return null
        },
        function rejected(error: unknown): unknown {
          return error
        }
      )
      const incoming = await socket.recv(background())
      received = new TextDecoder().decode(incoming.body)
      await socket.send(background(), message("open"))
    },
    Object.freeze({
      request: new Request("http://127.0.0.1/rpc", { method: "POST", body: "request" }),
      localAddress: "",
      remoteAddress: ""
    }),
    false
  )

  expect(response.status).toBe(200)
  expect(closeFailure).toBe(marker)
  expect(received).toBe("request")
  expect(await response.text()).toBe("open")
})

test("pending listen keeps its option snapshot while later listeners use new options", async () => {
  const first = hostFixture()
  const binding = deferred<HTTPHostHandle>()
  const pendingHost: HTTPHost = Object.freeze({
    /** Reuses the portable capability declaration while delaying bind completion. */
    capabilities(): HTTPHostCapabilities {
      return first.host.capabilities()
    },
    /** Exposes a controlled pending bind window for common-option replacement. */
    bind(): Promise<HTTPHostHandle> {
      return binding.promise
    }
  })
  const firstLoggerCauses: unknown[] = []
  const laterLoggerCauses: unknown[] = []
  const transport = newHTTPTransport()
  transport.init(
    logger(
      Object.freeze({
        /** Records diagnostics owned by resources started under the first snapshot. */
        log(
          _level: TransportLogLevel,
          _message: string,
          fields?: Readonly<Record<string, unknown>>
        ): void {
          firstLoggerCauses.push(fields?.["cause"])
        }
      })
    )
  )

  const listening = transport.listen(background(), "127.0.0.1:0", host(pendingHost))
  await Promise.resolve()
  transport.init(
    logger(
      Object.freeze({
        /** Records diagnostics owned by resources started after option replacement. */
        log(
          _level: TransportLogLevel,
          _message: string,
          fields?: Readonly<Record<string, unknown>>
        ): void {
          laterLoggerCauses.push(fields?.["cause"])
        }
      })
    )
  )
  binding.resolve(first.handle)

  const firstListener = await listening
  const firstFailure = new Error("first snapshot handler failed")
  const firstAccept = firstListener.accept(background(), function fail(): never {
    throw firstFailure
  })
  first.ready.resolve(undefined)
  await firstListener.accepted()
  const firstDispatcher = first.requests[0]
  if (firstDispatcher === undefined) throw new Error("first dispatcher missing")
  expect(
    (
      await firstDispatcher(
        Object.freeze({
          request: new Request("http://127.0.0.1/first", { method: "POST" }),
          localAddress: "",
          remoteAddress: ""
        })
      )
    ).status
  ).toBe(500)
  expect(firstLoggerCauses).toEqual([firstFailure])
  expect(laterLoggerCauses).toEqual([])
  await firstListener.close(background())
  await firstAccept

  const later = hostFixture()
  const laterListener = await transport.listen(background(), "127.0.0.1:0", host(later.host))
  const laterFailure = new Error("later snapshot handler failed")
  const laterAccept = laterListener.accept(background(), function fail(): never {
    throw laterFailure
  })
  later.ready.resolve(undefined)
  await laterListener.accepted()
  const laterDispatcher = later.requests[0]
  if (laterDispatcher === undefined) throw new Error("later dispatcher missing")
  expect(
    (
      await laterDispatcher(
        Object.freeze({
          request: new Request("http://127.0.0.1/later", { method: "POST" }),
          localAddress: "",
          remoteAddress: ""
        })
      )
    ).status
  ).toBe(500)
  expect(firstLoggerCauses).toEqual([firstFailure])
  expect(laterLoggerCauses).toEqual([laterFailure])
  await laterListener.close(background())
  await laterAccept
})

test("capability admission happens before bind and force claims are verified after bind", async () => {
  const noTLS = hostFixture()
  const transport = newHTTPTransport()
  transport.init(secure(true))
  await expect(
    transport.listen(background(), "127.0.0.1:0", host(noTLS.host))
  ).rejects.toMatchObject({ code: "LIKEGO_TRANSPORT_UNSUPPORTED_CAPABILITY" })
  expect(noTLS.bindCalls).toHaveLength(0)

  const invalidForce = hostFixture(
    Object.freeze({
      tls: false,
      forceClose: true,
      connectionMetadata: false
    }),
    true
  )
  await expect(
    newHTTPTransport().listen(background(), "127.0.0.1:0", host(invalidForce.host))
  ).rejects.toMatchObject({ code: "LIKEGO_TRANSPORT_UNSUPPORTED_CAPABILITY" })
  expect(invalidForce.bindCalls).toHaveLength(1)
  expect(invalidForce.closeCalls).toHaveLength(1)
})

test("normal serve exit is an unexpected terminal error after readiness", async () => {
  const fixture = hostFixture()
  const listener = await newHTTPTransport().listen(background(), "127.0.0.1:0", host(fixture.host))
  const accept = listener.accept(background(), function noop(): void {})
  fixture.ready.resolve(undefined)
  await listener.accepted()
  fixture.serveDone.resolve(undefined)

  await expect(accept).rejects.toMatchObject({
    code: "LIKEGO_HTTP_TRANSPORT_UNEXPECTED_EXIT",
    source: "serve",
    phase: "running"
  })
  expect(fixture.closeCalls).toHaveLength(1)
})

test("done settlement observed before ready wins the admission race", async () => {
  const fixture = hostFixture()
  const listener = await newHTTPTransport().listen(background(), "127.0.0.1:0", host(fixture.host))
  const accepted = listener.accepted()
  const accept = listener.accept(background(), function noop(): void {})
  fixture.serveDone.resolve(undefined)
  fixture.ready.resolve(undefined)

  await expect(accepted).rejects.toMatchObject({
    code: "LIKEGO_HTTP_TRANSPORT_UNEXPECTED_EXIT",
    source: "serve",
    phase: "before-ready"
  })
  await expect(accept).rejects.toMatchObject({ code: "LIKEGO_HTTP_TRANSPORT_UNEXPECTED_EXIT" })
})

test("serve-first normal exit before ready cancels its derived owner", async () => {
  await expectServeFirstOwnerCleanup("before-ready", "resolve")
})

test("serve-first rejection before ready cancels its derived owner", async () => {
  await expectServeFirstOwnerCleanup("before-ready", "reject")
})

test("serve-first normal exit after ready cancels its derived owner", async () => {
  await expectServeFirstOwnerCleanup("running", "resolve")
})

test("serve-first rejection after ready cancels its derived owner", async () => {
  await expectServeFirstOwnerCleanup("running", "reject")
})

test("accept cancellation during serve admission starts owned cleanup", async () => {
  const [acceptContext, cancelAccept] = withCancel(background())
  const ready = deferred<void>()
  const serveDone = deferred<void>()
  const hostDone = deferred<void>()
  let closeCalls = 0
  const handle: HTTPHostHandle = Object.freeze({
    /** Returns one deterministic address. */
    address(): string {
      return "127.0.0.1:43124"
    },
    /** Cancels admission in the narrow window before accept installs its terminal waiter. */
    serve(): ReturnType<HTTPHostHandle["serve"]> {
      cancelAccept()
      return Object.freeze({
        /** Keeps readiness pending until cleanup owns admission. */
        ready(): Promise<void> {
          return ready.promise
        },
        /** Keeps serving pending until host cleanup runs. */
        done(): Promise<void> {
          return serveDone.promise
        }
      })
    },
    /** Returns the controlled host terminal. */
    done(): Promise<void> {
      return hostDone.promise
    },
    /** Proves cancellation starts background cleanup exactly once. */
    close(): Promise<void> {
      closeCalls += 1
      serveDone.resolve(undefined)
      hostDone.resolve(undefined)
      return Promise.resolve()
    }
  })
  const runtimeHost: HTTPHost = Object.freeze({
    /** Reports portable baseline capabilities. */
    capabilities(): HTTPHostCapabilities {
      return Object.freeze({
        tls: false,
        forceClose: false,
        connectionMetadata: false
      })
    },
    /** Returns the controlled handle. */
    bind(): Promise<HTTPHostHandle> {
      return Promise.resolve(handle)
    }
  })
  const listener = await newHTTPTransport().listen(background(), "127.0.0.1:0", host(runtimeHost))
  const accepted = listener.accepted()
  const accepting = listener.accept(acceptContext, function noop(): void {})

  await expect(accepting).rejects.toBe(canceled)
  expect(closeCalls).toBe(1)
  await expect(accepted).rejects.toBe(canceled)
})

test("accept cancellation wins over a later synchronous serve failure", async () => {
  const fixture = arbiterFixture()
  const [acceptContext, cancelAccept] = withCancel(background())
  const serveFailure = new Error("serve failed after accept cancellation")
  const handle: HTTPHostHandle = Object.freeze({
    address: fixture.handle.address,
    /** Cancels the accepting Context before reporting a synchronous serve failure. */
    serve(): never {
      cancelAccept()
      throw serveFailure
    },
    done: fixture.handle.done,
    close: fixture.handle.close
  })
  const listener = newHTTPListener("127.0.0.1:43125", handle, baselineCapabilities())
  const accepted = listener.accepted()
  const accepting = listener.accept(acceptContext, function noop(): void {})

  await expect(accepted).rejects.toBe(canceled)
  await expect(accepting).rejects.toBe(canceled)
  const terminalOwner = listener.close(background())
  expect(terminalOwner).toBe(listener.close(background()))
  fixture.hostDone.resolve(undefined)
  fixture.closeDone.resolve(undefined)
  await expect(terminalOwner).rejects.toBe(serveFailure)
  expect(fixture.closeCalls).toHaveLength(1)
})

test("accept cancellation wins over a later invalid serve handle", async () => {
  const fixture = arbiterFixture()
  const [acceptContext, cancelAccept] = withCancel(background())
  const handle: HTTPHostHandle = Object.freeze({
    address: fixture.handle.address,
    /** Cancels the accepting Context before returning an invalid runtime handle. */
    serve(): HTTPServeHandle {
      cancelAccept()
      return Reflect.get({}, "missing")
    },
    done: fixture.handle.done,
    close: fixture.handle.close
  })
  const listener = newHTTPListener("127.0.0.1:43125", handle, baselineCapabilities())
  const accepted = listener.accepted()
  const accepting = listener.accept(acceptContext, function noop(): void {})

  await expect(accepted).rejects.toBe(canceled)
  await expect(accepting).rejects.toBe(canceled)
  const terminalOwner = listener.close(background())
  fixture.hostDone.resolve(undefined)
  fixture.closeDone.resolve(undefined)
  await expect(terminalOwner).rejects.toBeInstanceOf(TypeError)
  expect(fixture.closeCalls).toHaveLength(1)
})

test("listener close wins admission before a later synchronous serve failure", async () => {
  const fixture = arbiterFixture()
  const serveFailure = new Error("serve failed after listener close")
  let listener: HTTPListener | null = null
  let reentrantClose: Promise<void> | null = null
  const handle: HTTPHostHandle = Object.freeze({
    address: fixture.handle.address,
    /** Closes the listener before reporting a later borrowed serve failure. */
    serve(): never {
      const activeListener = listener
      if (activeListener === null) throw new Error("listener was not assigned before accept")
      reentrantClose = activeListener.close(background())
      throw serveFailure
    },
    done: fixture.handle.done,
    close: fixture.handle.close
  })
  listener = newHTTPListener("127.0.0.1:43125", handle, baselineCapabilities())
  const accepted = listener.accepted()
  const accepting = listener.accept(background(), function noop(): void {})

  /** Reads callback-owned close state without assuming synchronous assignment. */
  function observedReentrantClose(): Promise<void> | null {
    return reentrantClose
  }
  await expect(accepted).rejects.toMatchObject({ code: "LIKEGO_TRANSPORT_CLOSED" })
  expect(observedReentrantClose()).toBe(accepting)
  fixture.hostDone.resolve(undefined)
  fixture.closeDone.resolve(undefined)
  await expect(accepting).rejects.toBe(serveFailure)
  expect(fixture.closeCalls).toHaveLength(1)
})

test("accept cancellation stays primary while a synchronous ready throw reaches terminal", async () => {
  const race = readyThrowRace("cancel")

  await expect(race.accepted).rejects.toBe(canceled)
  await expect(race.accepting).rejects.toBe(canceled)
  const terminalOwner = race.listener.close(background())
  expect(terminalOwner).toBe(race.listener.close(background()))
  await expect(terminalOwner).rejects.toBe(race.failure)
  expect(race.closeCalls).toHaveLength(1)
})

test("listener close stays primary while a synchronous ready throw reaches terminal", async () => {
  const race = readyThrowRace("close")

  await expect(race.accepted).rejects.toMatchObject({ code: "LIKEGO_TRANSPORT_CLOSED" })
  expect(race.reentrantClose()).toBe(race.accepting)
  expect(race.listener.close(background())).toBe(race.accepting)
  await expect(race.accepting).rejects.toBe(race.failure)
  expect(race.closeCalls).toHaveLength(1)
})

test("ready failure remains primary and secondary terminal failures stay ordered", async () => {
  const fixture = arbiterFixture()
  const listener = newHTTPListener("127.0.0.1:43125", fixture.handle, baselineCapabilities())
  const primary = new Error("ready failed")
  const serveFailure = new Error("serve cleanup failed")
  const hostFailure = new Error("host cleanup failed")
  const closeFailure = new Error("close failed")
  const accepted = listener.accepted()
  const accepting = listener.accept(withCancel(background())[0], function noop(): void {})

  fixture.ready.reject(primary)
  await expect(accepted).rejects.toBe(primary)
  expect(fixture.closeCalls).toHaveLength(1)
  fixture.serveDone.reject(serveFailure)
  await Promise.resolve()
  fixture.hostDone.reject(hostFailure)
  await Promise.resolve()
  fixture.closeDone.reject(closeFailure)

  try {
    await accepting
    throw new Error("expected aggregate terminal failure")
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError)
    if (!(error instanceof AggregateError)) throw error
    expect(error.errors).toEqual([primary, serveFailure, hostFailure, closeFailure])
    expect(Object.isFrozen(error)).toBe(true)
    expect(Object.isFrozen(error.errors)).toBe(true)
  }
})

test("normal close reports one original cleanup failure", async () => {
  const fixture = arbiterFixture()
  const listener = newHTTPListener("127.0.0.1:43125", fixture.handle, baselineCapabilities())
  const cleanupFailure = new Error("close rejected")
  const accepting = listener.accept(background(), function noop(): void {})
  fixture.ready.resolve(undefined)
  await listener.accepted()
  const closing = listener.close(background())
  fixture.serveDone.resolve(undefined)
  fixture.hostDone.resolve(undefined)
  fixture.closeDone.reject(cleanupFailure)

  await expect(accepting).rejects.toBe(cleanupFailure)
  await expect(closing).rejects.toBe(cleanupFailure)
})

test("deduplicates one terminal Promise observed as serve and host", async () => {
  const side = deferred<void>()
  const handle: HTTPHostHandle = Object.freeze({
    address: () => "127.0.0.1:43125",
    serve: () =>
      Object.freeze({
        ready: () => Promise.resolve(),
        done: () => side.promise
      }),
    done: () => side.promise,
    close: () => Promise.resolve()
  })
  const listener = newHTTPListener("127.0.0.1:43125", handle, baselineCapabilities())
  const accepting = listener.accept(background(), function noop(): void {})
  await listener.accepted()
  const closing = listener.close(background())
  const failure = new Error("shared terminal failure")

  side.reject(failure)

  await expect(accepting).rejects.toBe(failure)
  await expect(closing).rejects.toBe(failure)
})

test("normal close freezes multiple cleanup failures in observation order", async () => {
  const fixture = arbiterFixture()
  const listener = newHTTPListener("127.0.0.1:43125", fixture.handle, baselineCapabilities())
  const serveFailure = new Error("serve close failed")
  const hostFailure = new Error("host close failed")
  const closeFailure = new Error("close call failed")
  const accepting = listener.accept(background(), function noop(): void {})
  fixture.ready.resolve(undefined)
  await listener.accepted()
  const closing = listener.close(background())
  fixture.serveDone.reject(serveFailure)
  await Promise.resolve()
  fixture.hostDone.reject(hostFailure)
  await Promise.resolve()
  fixture.closeDone.reject(closeFailure)

  const settled = await Promise.allSettled([accepting, closing])
  for (const result of settled) {
    expect(result.status).toBe("rejected")
    if (result.status === "rejected") {
      expect(result.reason).toBeInstanceOf(AggregateError)
      expect(result.reason.errors).toEqual([serveFailure, hostFailure, closeFailure])
      expect(Object.isFrozen(result.reason.errors)).toBe(true)
    }
  }
})

test("host-first normal exit cancels the serve owner without redundant host close", async () => {
  const fixture = arbiterFixture()
  const listener = newHTTPListener("127.0.0.1:43125", fixture.handle, baselineCapabilities())
  const accepting = listener.accept(background(), function noop(): void {})
  fixture.ready.resolve(undefined)
  await listener.accepted()
  fixture.hostDone.resolve(undefined)
  await Promise.resolve()

  expect(fixture.serveContexts[0]?.err()).toBe(canceled)
  expect(fixture.closeCalls).toHaveLength(0)
  fixture.serveDone.resolve(undefined)
  await expect(accepting).rejects.toMatchObject({
    code: "LIKEGO_HTTP_TRANSPORT_UNEXPECTED_EXIT",
    source: "host",
    phase: "running"
  })
})

test("synchronous serve failure rolls back and preserves the original Error", async () => {
  const fixture = arbiterFixture()
  const original = new Error("serve threw")
  const handle: HTTPHostHandle = Object.freeze({
    address: fixture.handle.address,
    /** Throws before a serve handle can be published. */
    serve(): never {
      throw original
    },
    done: fixture.handle.done,
    close: fixture.handle.close
  })
  const listener = newHTTPListener("127.0.0.1:43125", handle, baselineCapabilities())
  const accepted = listener.accepted()
  const accepting = listener.accept(background(), function noop(): void {})
  await expect(accepted).rejects.toBe(original)
  fixture.hostDone.resolve(undefined)
  fixture.closeDone.resolve(undefined)

  await expect(accepting).rejects.toBe(original)
  expect(fixture.closeCalls).toHaveLength(1)
})

test("invalid serve handle is an admission failure with owned rollback", async () => {
  const fixture = arbiterFixture()
  const handle: HTTPHostHandle = Object.freeze({
    address: fixture.handle.address,
    /** Returns one hostile non-handle through an untyped runtime boundary. */
    serve(): HTTPServeHandle {
      return Reflect.get({}, "missing")
    },
    done: fixture.handle.done,
    close: fixture.handle.close
  })
  const listener = newHTTPListener("127.0.0.1:43125", handle, baselineCapabilities())
  const accepted = listener.accepted()
  const accepting = listener.accept(background(), function noop(): void {})
  await expect(accepted).rejects.toBeInstanceOf(TypeError)
  fixture.hostDone.resolve(undefined)
  fixture.closeDone.resolve(undefined)

  await expect(accepting).rejects.toBeInstanceOf(TypeError)
  expect(fixture.closeCalls).toHaveLength(1)
})

test("serve handles with non-callable lifecycle members roll back admission", async () => {
  const fixture = arbiterFixture()
  const stableServe: HTTPServeHandle = {
    /** Reports immediate readiness before the proxy hides it. */
    ready(): Promise<void> {
      return Promise.resolve()
    },
    /** Reports immediate terminal state. */
    done(): Promise<void> {
      return Promise.resolve()
    }
  }
  const invalidServe = new Proxy<HTTPServeHandle>(stableServe, {
    /** Hides one required method at the borrowed runtime boundary. */
    get(target, property, receiver): unknown {
      return property === "ready" ? undefined : Reflect.get(target, property, receiver)
    }
  })
  const handle: HTTPHostHandle = Object.freeze({
    address: fixture.handle.address,
    /** Returns the partially formed serve handle. */
    serve(): HTTPServeHandle {
      return invalidServe
    },
    done: fixture.handle.done,
    close: fixture.handle.close
  })
  const listener = newHTTPListener("127.0.0.1:43125", handle, baselineCapabilities())
  const accepted = listener.accepted()
  const accepting = listener.accept(background(), function noop(): void {})
  await expect(accepted).rejects.toBeInstanceOf(TypeError)
  fixture.hostDone.resolve(undefined)
  fixture.closeDone.resolve(undefined)
  await expect(accepting).rejects.toBeInstanceOf(TypeError)
  expect(fixture.closeCalls).toHaveLength(1)
})

test("synchronous serve done and ready failures enter the same terminal arbiter", async () => {
  const doneFixture = arbiterFixture()
  const doneFailure = new Error("serve done threw")
  const doneHandle: HTTPHostHandle = Object.freeze({
    address: doneFixture.handle.address,
    /** Returns a handle whose terminal accessor throws synchronously. */
    serve(): HTTPServeHandle {
      return Object.freeze({
        /** Reports immediate readiness, after done observation is installed. */
        ready(): Promise<void> {
          return Promise.resolve()
        },
        /** Throws while the listener synchronously observes terminal state. */
        done(): never {
          throw doneFailure
        }
      })
    },
    done: doneFixture.handle.done,
    close: doneFixture.handle.close
  })
  const doneListener = newHTTPListener("127.0.0.1:43125", doneHandle, baselineCapabilities())
  const doneAccepted = doneListener.accepted()
  const doneAccepting = doneListener.accept(background(), function noop(): void {})
  await expect(doneAccepted).rejects.toBe(doneFailure)
  doneFixture.hostDone.resolve(undefined)
  doneFixture.closeDone.resolve(undefined)
  await expect(doneAccepting).rejects.toBe(doneFailure)

  const readyFixture = arbiterFixture()
  const readyFailure = new Error("ready threw")
  const readyHandle: HTTPHostHandle = Object.freeze({
    address: readyFixture.handle.address,
    /** Returns a handle whose readiness accessor throws synchronously. */
    serve(): HTTPServeHandle {
      return Object.freeze({
        /** Throws during admission observation. */
        ready(): never {
          throw readyFailure
        },
        /** Returns the controlled serve terminal. */
        done(): Promise<void> {
          return readyFixture.serveDone.promise
        }
      })
    },
    done: readyFixture.handle.done,
    close: readyFixture.handle.close
  })
  const readyListener = newHTTPListener("127.0.0.1:43125", readyHandle, baselineCapabilities())
  const readyAccepted = readyListener.accepted()
  const readyAccepting = readyListener.accept(background(), function noop(): void {})
  await expect(readyAccepted).rejects.toBe(readyFailure)
  readyFixture.serveDone.resolve(undefined)
  readyFixture.hostDone.resolve(undefined)
  readyFixture.closeDone.resolve(undefined)
  await expect(readyAccepting).rejects.toBe(readyFailure)
})

test("synchronous host done and close failures are normalized by the owner", async () => {
  const hostFailure = new Error("host done threw")
  const closeFailure = new Error("host close threw")
  const serveDone = deferred<void>()
  const handle: HTTPHostHandle = Object.freeze({
    /** Returns one deterministic address. */
    address(): string {
      return "127.0.0.1:43126"
    },
    /** Returns a pending serve side so host-first remains the primary signal. */
    serve(): HTTPServeHandle {
      return Object.freeze({
        /** Keeps ready pending until the already-observed host failure wins. */
        ready(): Promise<void> {
          return Promise.resolve()
        },
        /** Returns controlled serve terminal state. */
        done(): Promise<void> {
          return serveDone.promise
        }
      })
    },
    /** Throws at listener construction. */
    done(): never {
      throw hostFailure
    },
    /** Throws if cleanup is attempted. */
    close(): never {
      throw closeFailure
    }
  })
  const listener = newHTTPListener("127.0.0.1:43126", handle, baselineCapabilities())
  const accepted = listener.accepted()
  const accepting = listener.accept(background(), function noop(): void {})
  await expect(accepted).rejects.toBe(hostFailure)
  serveDone.resolve(undefined)

  await expect(accepting).rejects.toBe(hostFailure)
})

test("dial and listen reject every unavailable portable capability before I/O", async () => {
  let executorCalls = 0
  const run = httpExecutor(function run(): Promise<Response> {
    executorCalls += 1
    return Promise.resolve(new Response())
  })
  const transport = newHTTPTransport(executor(run))
  await expect(
    transport.dial(background(), "localhost:8080", withConnClose())
  ).rejects.toMatchObject({ code: "LIKEGO_TRANSPORT_UNSUPPORTED_CAPABILITY" })
  await expect(transport.dial(background(), ":")).rejects.toBeInstanceOf(TypeError)
  await expect(transport.listen(background(), "127.0.0.1:0")).rejects.toMatchObject({
    code: "LIKEGO_TRANSPORT_UNSUPPORTED_CAPABILITY"
  })

  const customTLS = newHTTPTransport(executor(run))
  customTLS.init(
    tlsConfig(
      Object.freeze({
        serverName: "service.test",
        caCertificate: null,
        certificateChain: null,
        privateKey: null
      })
    )
  )
  await expect(customTLS.dial(background(), "service.test:443")).rejects.toMatchObject({
    code: "LIKEGO_TRANSPORT_UNSUPPORTED_CAPABILITY"
  })

  expect(transport.string()).toBe("http")
  expect(transport.kind?.()).toBe("http")
  expect(executorCalls).toBe(0)
})

test("host capability failures stop before bind", async () => {
  const capabilityFailure = new Error("capabilities failed")
  let bindCalls = 0
  const throwingHost: HTTPHost = Object.freeze({
    /** Preserves an Error thrown by the borrowed capability provider. */
    capabilities(): never {
      throw capabilityFailure
    },
    /** Must remain unreachable after capability failure. */
    bind(): Promise<HTTPHostHandle> {
      bindCalls += 1
      return Promise.reject(new Error("unexpected bind"))
    }
  })
  await expect(
    newHTTPTransport().listen(background(), "127.0.0.1:0", host(throwingHost))
  ).rejects.toBe(capabilityFailure)

  const getterFailure = new Error("capability getter failed")
  const getterCapabilities = new Proxy<HTTPHostCapabilities>(
    {
      tls: false,
      forceClose: false,
      connectionMetadata: false
    },
    {
      /** Throws while the transport snapshots the borrowed declaration. */
      get(): never {
        throw getterFailure
      }
    }
  )
  const getterHost: HTTPHost = Object.freeze({
    /** Returns a declaration with a hostile property boundary. */
    capabilities(): HTTPHostCapabilities {
      return getterCapabilities
    },
    /** Must remain unreachable after snapshot failure. */
    bind(): Promise<HTTPHostHandle> {
      bindCalls += 1
      return Promise.reject(new Error("unexpected bind"))
    }
  })
  await expect(
    newHTTPTransport().listen(background(), "127.0.0.1:0", host(getterHost))
  ).rejects.toBe(getterFailure)

  const malformedHost: HTTPHost = Object.freeze({
    /** Returns one hostile non-object capability declaration. */
    capabilities(): HTTPHostCapabilities {
      return Reflect.get({}, "missing")
    },
    /** Must remain unreachable after structural validation. */
    bind(): Promise<HTTPHostHandle> {
      bindCalls += 1
      return Promise.reject(new Error("unexpected bind"))
    }
  })
  await expect(
    newHTTPTransport().listen(background(), "127.0.0.1:0", host(malformedHost))
  ).rejects.toBeInstanceOf(TypeError)

  const invalidFlags: HTTPHost = Object.freeze({
    /** Returns one declaration with a non-boolean runtime field. */
    capabilities(): HTTPHostCapabilities {
      return JSON.parse('{"tls":"false","forceClose":false,"connectionMetadata":false}')
    },
    /** Must remain unreachable after flag validation. */
    bind(): Promise<HTTPHostHandle> {
      bindCalls += 1
      return Promise.reject(new Error("unexpected bind"))
    }
  })
  await expect(
    newHTTPTransport().listen(background(), "127.0.0.1:0", host(invalidFlags))
  ).rejects.toBeInstanceOf(TypeError)

  expect(bindCalls).toBe(0)
})

test("host capability snapshot reads each borrowed field exactly once", async () => {
  const fixture = hostFixture()
  const reads: Record<keyof HTTPHostCapabilities, number> = {
    tls: 0,
    forceClose: 0,
    connectionMetadata: 0
  }
  const declared: HTTPHostCapabilities = {
    tls: false,
    forceClose: false,
    connectionMetadata: true
  }
  /** Records one exact capability read and rejects repetition. */
  function recordCapability(name: keyof HTTPHostCapabilities): void {
    reads[name] += 1
    if (reads[name] > 1) throw new Error(`capability ${name} read twice`)
  }
  const capabilities = new Proxy<HTTPHostCapabilities>(declared, {
    /** Rejects any attempt to read one capability more than once. */
    get(target, property, receiver): unknown {
      if (property === "tls") recordCapability("tls")
      else if (property === "forceClose") recordCapability("forceClose")
      else if (property === "connectionMetadata") recordCapability("connectionMetadata")
      return Reflect.get(target, property, receiver)
    }
  })
  const runtimeHost: HTTPHost = Object.freeze({
    /** Returns the hostile borrowed snapshot. */
    capabilities(): HTTPHostCapabilities {
      return capabilities
    },
    /** Delegates bind while preserving the borrowed host receiver. */
    bind(ctx: Context, address: string, options: HTTPHostListenOptions): Promise<HTTPHostHandle> {
      return fixture.host.bind.call(fixture.host, ctx, address, options)
    }
  })
  const listener = await newHTTPTransport().listen(background(), "127.0.0.1:0", host(runtimeHost))
  expect(reads).toEqual({
    tls: 1,
    forceClose: 1,
    connectionMetadata: 1
  })
  await listener.close(background())
})

test("TLS capability success forwards a defensive host snapshot", async () => {
  const fixture = hostFixture(
    Object.freeze({
      tls: true,
      forceClose: false,
      connectionMetadata: false
    })
  )
  const transport = newHTTPTransport()
  transport.init(
    tlsConfig(
      Object.freeze({
        serverName: "service.test",
        caCertificate: null,
        certificateChain: null,
        privateKey: null
      })
    )
  )
  const listener = await transport.listen(background(), "127.0.0.1:0", host(fixture.host))
  expect(fixture.bindOptions[0]).toMatchObject({
    secure: false,
    tlsConfig: { serverName: "service.test" }
  })
  expect(Object.isFrozen(fixture.bindOptions[0])).toBe(true)
  await listener.close(background())
})

test("bind synchronous and asynchronous failures preserve boundary identity", async () => {
  const synchronousFailure = new Error("bind threw")
  const synchronousHost: HTTPHost = Object.freeze({
    /** Reports the portable baseline. */
    capabilities: baselineCapabilities,
    /** Throws before a bind Promise can be returned. */
    bind(): never {
      throw synchronousFailure
    }
  })
  await expect(
    newHTTPTransport().listen(background(), "127.0.0.1:0", host(synchronousHost))
  ).rejects.toBe(synchronousFailure)

  const asynchronousFailure = new Error("bind rejected")
  const rejectingHost: HTTPHost = Object.freeze({
    /** Reports the portable baseline. */
    capabilities: baselineCapabilities,
    /** Rejects from the asynchronous bind boundary. */
    bind(): Promise<HTTPHostHandle> {
      return Promise.reject(asynchronousFailure)
    }
  })
  await expect(
    newHTTPTransport().listen(background(), "127.0.0.1:0", host(rejectingHost))
  ).rejects.toBe(asynchronousFailure)

  const hostileHost: HTTPHost = Object.freeze({
    /** Reports the portable baseline. */
    capabilities: baselineCapabilities,
    /** Rejects with a hostile non-Error runtime value. */
    bind(): Promise<HTTPHostHandle> {
      return Promise.reject("bind-string")
    }
  })
  await expect(
    newHTTPTransport().listen(background(), "127.0.0.1:0", host(hostileHost))
  ).rejects.toBeInstanceOf(Error)
})

test("bind Context cancellation returns promptly and rolls back every late handle", async () => {
  const closeModes: readonly ("resolve" | "throw" | "reject")[] = Object.freeze([
    "resolve",
    "throw",
    "reject"
  ])
  for (const closeMode of closeModes) {
    const binding = deferred<HTTPHostHandle>()
    let closeCalls = 0
    const handle: HTTPHostHandle = Object.freeze({
      /** Returns one address that must never escape the canceled bind. */
      address(): string {
        return "127.0.0.1:43127"
      },
      /** Remains unreachable after bind cancellation. */
      serve(): never {
        throw new Error("unexpected serve")
      },
      /** Reports immediate terminal state for a late rollback fixture. */
      done(): Promise<void> {
        return Promise.resolve()
      },
      /** Records late rollback and optionally exercises the synchronous throw boundary. */
      close(): Promise<void> {
        closeCalls += 1
        if (closeMode === "throw") throw new Error("late close threw")
        if (closeMode === "reject") return Promise.reject(new Error("late close rejected"))
        return Promise.resolve()
      }
    })
    const runtimeHost: HTTPHost = Object.freeze({
      /** Reports the portable baseline. */
      capabilities: baselineCapabilities,
      /** Holds bind until after the caller Context is canceled. */
      bind(): Promise<HTTPHostHandle> {
        return binding.promise
      }
    })
    const [ctx, cancel] = withCancel(background())
    const listening = newHTTPTransport().listen(ctx, "127.0.0.1:0", host(runtimeHost))
    await Promise.resolve()
    cancel()
    await expect(listening).rejects.toBe(canceled)
    binding.resolve(handle)
    await Promise.resolve()
    expect(closeCalls).toBe(1)
  }
})

test("invalid bound handles are rolled back before admission failure escapes", async () => {
  let closeCalls = 0
  const valid: HTTPHostHandle = {
    /** Returns one otherwise valid address. */
    address(): string {
      return "127.0.0.1:43128"
    },
    /** Returns one inert serve handle. */
    serve(): HTTPServeHandle {
      return Object.freeze({
        /** Reports immediate readiness. */
        ready(): Promise<void> {
          return Promise.resolve()
        },
        /** Reports immediate terminal state. */
        done(): Promise<void> {
          return Promise.resolve()
        }
      })
    },
    /** Reports immediate host terminal state. */
    done(): Promise<void> {
      return Promise.resolve()
    },
    /** Records admission rollback. */
    close(): Promise<void> {
      closeCalls += 1
      return Promise.resolve()
    }
  }
  const invalid = new Proxy<HTTPHostHandle>(valid, {
    /** Hides one required member at the untrusted host boundary. */
    get(target, property, receiver): unknown {
      return property === "address" ? undefined : Reflect.get(target, property, receiver)
    }
  })
  const runtimeHost: HTTPHost = Object.freeze({
    /** Reports the portable baseline. */
    capabilities: baselineCapabilities,
    /** Returns a partially formed bound resource that still owns cleanup. */
    bind(): Promise<HTTPHostHandle> {
      return Promise.resolve(invalid)
    }
  })

  await expect(
    newHTTPTransport().listen(background(), "127.0.0.1:0", host(runtimeHost))
  ).rejects.toBeInstanceOf(TypeError)
  expect(closeCalls).toBe(1)
})

test("throwing bound-handle getters enter owned rollback", async () => {
  const getterFailure = new Error("address getter failed")
  let closeCalls = 0
  const handle: HTTPHostHandle = Object.freeze({
    /** Throws while transport admission snapshots the borrowed method. */
    get address(): HTTPHostHandle["address"] {
      throw getterFailure
    },
    /** Remains unreachable after getter admission fails. */
    serve(): never {
      throw new Error("unexpected serve")
    },
    /** Reports immediate terminal state for rollback. */
    done(): Promise<void> {
      return Promise.resolve()
    },
    /** Records owned rollback. */
    close(): Promise<void> {
      closeCalls += 1
      return Promise.resolve()
    }
  })
  const runtimeHost: HTTPHost = Object.freeze({
    /** Reports baseline portable capabilities. */
    capabilities: baselineCapabilities,
    /** Returns the hostile borrowed handle. */
    bind(): Promise<HTTPHostHandle> {
      return Promise.resolve(handle)
    }
  })

  await expect(
    newHTTPTransport().listen(background(), "127.0.0.1:0", host(runtimeHost))
  ).rejects.toBe(getterFailure)
  expect(closeCalls).toBe(1)
})

test("cleanup contract getters and missing methods fail before listener publication", async () => {
  const cleanupGetterFailure = new Error("cleanup getter failed")
  const closeGetterFailure = new Error("close getter failed")
  let partialCloseCalls = 0
  let missingDoneCloseCalls = 0
  const throwingHandle: HTTPHostHandle = Object.freeze({
    /** Returns one otherwise valid address. */
    address(): string {
      return "127.0.0.1:43130"
    },
    /** Remains unreachable before cleanup contract admission. */
    serve(): never {
      throw new Error("unexpected serve")
    },
    /** Throws before the cleanup contract can be admitted. */
    get done(): HTTPHostHandle["done"] {
      throw cleanupGetterFailure
    },
    /** Provides the other cleanup method. */
    close(): Promise<void> {
      partialCloseCalls += 1
      return Promise.resolve()
    }
  })
  const missingHandle: HTTPHostHandle = Object.freeze({
    /** Returns one otherwise valid address. */
    address(): string {
      return "127.0.0.1:43130"
    },
    /** Remains unreachable before cleanup contract admission. */
    serve(): never {
      throw new Error("unexpected serve")
    },
    /** Reports terminal state while close is hidden. */
    done(): Promise<void> {
      return Promise.resolve()
    },
    /** Is hidden through an untyped runtime boundary. */
    close: Reflect.get({}, "missing")
  })
  const throwingCloseHandle: HTTPHostHandle = Object.freeze({
    /** Returns one otherwise valid address. */
    address(): string {
      return "127.0.0.1:43130"
    },
    /** Remains unreachable before cleanup contract admission. */
    serve(): never {
      throw new Error("unexpected serve")
    },
    /** Reports immediate terminal state while close snapshot fails. */
    done(): Promise<void> {
      return Promise.resolve()
    },
    /** Throws before any executable cleanup method can be retained. */
    get close(): HTTPHostHandle["close"] {
      throw closeGetterFailure
    }
  })
  const missingDoneHandle: HTTPHostHandle = Object.freeze({
    /** Returns one otherwise valid address. */
    address(): string {
      return "127.0.0.1:43130"
    },
    /** Remains unreachable before cleanup contract admission. */
    serve(): never {
      throw new Error("unexpected serve")
    },
    /** Is hidden after close was already retained. */
    done: Reflect.get({}, "missing"),
    /** Records rollback through the retained cleanup entrypoint. */
    close(): Promise<void> {
      missingDoneCloseCalls += 1
      return Promise.resolve()
    }
  })
  const handles: readonly HTTPHostHandle[] = Object.freeze([
    throwingHandle,
    missingHandle,
    throwingCloseHandle,
    missingDoneHandle
  ])
  for (const handle of handles) {
    const runtimeHost: HTTPHost = Object.freeze({
      /** Reports baseline portable capabilities. */
      capabilities: baselineCapabilities,
      /** Returns the selected malformed cleanup contract. */
      bind(): Promise<HTTPHostHandle> {
        return Promise.resolve(handle)
      }
    })
    const listening = newHTTPTransport().listen(background(), "127.0.0.1:0", host(runtimeHost))
    if (handle === throwingHandle) await expect(listening).rejects.toBe(cleanupGetterFailure)
    else if (handle === throwingCloseHandle)
      await expect(listening).rejects.toBe(closeGetterFailure)
    else await expect(listening).rejects.toBeInstanceOf(TypeError)
  }
  expect(partialCloseCalls).toBe(1)
  expect(missingDoneCloseCalls).toBe(1)

  const getterFailure = new Error("bound done getter failed")
  const closeFailure = new Error("partial rollback close rejected")
  const closeDone = deferred<void>()
  let closeCalls = 0
  const handle: HTTPHostHandle = Object.freeze({
    /** Returns one otherwise valid address. */
    address(): string {
      return "127.0.0.1:43130"
    },
    /** Remains unreachable before cleanup contract admission. */
    serve(): never {
      throw new Error("unexpected serve")
    },
    /** Throws after close was already snapshotted. */
    get done(): HTTPHostHandle["done"] {
      throw getterFailure
    },
    /** Delays and rejects the only available owner rollback side. */
    close(): Promise<void> {
      closeCalls += 1
      return closeDone.promise
    }
  })
  const runtimeHost: HTTPHost = Object.freeze({
    /** Reports baseline portable capabilities. */
    capabilities: baselineCapabilities,
    /** Returns the partially malformed bound handle. */
    bind(): Promise<HTTPHostHandle> {
      return Promise.resolve(handle)
    }
  })
  const listening = newHTTPTransport().listen(background(), "127.0.0.1:0", host(runtimeHost))
  let settled = false
  void listening.then(
    function unexpectedlyResolved(): void {
      settled = true
    },
    function observedRejection(): void {
      settled = true
    }
  )
  await Promise.resolve()
  await Promise.resolve()
  expect(closeCalls).toBe(1)
  expect(settled).toBe(false)

  closeDone.reject(closeFailure)
  try {
    await listening
    throw new Error("expected partial rollback failure")
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError)
    if (!(error instanceof AggregateError)) throw error
    expect(error.errors).toEqual([getterFailure, closeFailure])
    expect(Object.isFrozen(error.errors)).toBe(true)
  }
})

test("force-close capability getter failures roll back and valid methods are retained", async () => {
  const capabilities: HTTPHostCapabilities = Object.freeze({
    tls: false,
    forceClose: true,
    connectionMetadata: false
  })
  const getterFailure = new Error("forceClose getter failed")
  let rollbackCalls = 0
  const throwingForce: HTTPHostHandle = Object.freeze({
    /** Returns one valid actual address. */
    address(): string {
      return "127.0.0.1:43131"
    },
    /** Remains unreachable after force capability admission fails. */
    serve(): never {
      throw new Error("unexpected serve")
    },
    /** Reports immediate terminal state for rollback. */
    done(): Promise<void> {
      return Promise.resolve()
    },
    /** Records admission rollback. */
    close(): Promise<void> {
      rollbackCalls += 1
      return Promise.resolve()
    },
    /** Throws while the advertised capability is verified. */
    get forceClose(): (reason: Error) => Promise<void> {
      throw getterFailure
    }
  })
  const throwingHost: HTTPHost = Object.freeze({
    /** Advertises force-close support. */
    capabilities(): HTTPHostCapabilities {
      return capabilities
    },
    /** Returns the hostile force-close getter. */
    bind(): Promise<HTTPHostHandle> {
      return Promise.resolve(throwingForce)
    }
  })
  await expect(
    newHTTPTransport().listen(background(), "127.0.0.1:0", host(throwingHost))
  ).rejects.toBe(getterFailure)
  expect(rollbackCalls).toBe(1)

  const valid = hostFixture(capabilities)
  const listener = await newHTTPTransport().listen(background(), "127.0.0.1:0", host(valid.host))
  await listener.close(background())
  expect(valid.closeCalls).toHaveLength(1)
})

test("throwing serve-handle lifecycle getters enter admission rollback", async () => {
  const properties: readonly ("ready" | "done")[] = Object.freeze(["ready", "done"])
  for (const property of properties) {
    const getterFailure = new Error(`${property} getter failed`)
    const hostDone = deferred<void>()
    let closeCalls = 0
    let getterReads = 0
    const stableServe: HTTPServeHandle = Object.freeze({
      /** Reports immediate readiness when this getter is not selected. */
      ready(): Promise<void> {
        return Promise.resolve()
      },
      /** Reports a pending serve lifecycle when this getter is not selected. */
      done(): Promise<void> {
        return Promise.resolve()
      }
    })
    const hostileServe = new Proxy<HTTPServeHandle>(stableServe, {
      /** Throws from the selected lifecycle getter exactly once. */
      get(target, key, receiver): unknown {
        if (key === property) {
          getterReads += 1
          throw getterFailure
        }
        return Reflect.get(target, key, receiver)
      }
    })
    const handle: HTTPHostHandle = Object.freeze({
      /** Returns one admitted actual address. */
      address(): string {
        return "127.0.0.1:43130"
      },
      /** Returns the hostile serve lifecycle handle. */
      serve(): HTTPServeHandle {
        return hostileServe
      },
      /** Reports host termination after cleanup begins. */
      done(): Promise<void> {
        return hostDone.promise
      },
      /** Settles the host side and records rollback. */
      close(): Promise<void> {
        closeCalls += 1
        hostDone.resolve(undefined)
        return Promise.resolve()
      }
    })
    const runtimeHost: HTTPHost = Object.freeze({
      /** Reports baseline portable capabilities. */
      capabilities: baselineCapabilities,
      /** Returns the hostile host handle. */
      bind(): Promise<HTTPHostHandle> {
        return Promise.resolve(handle)
      }
    })
    const listener = await newHTTPTransport().listen(background(), "127.0.0.1:0", host(runtimeHost))
    const accepted = listener.accepted()
    const accepting = listener.accept(background(), function noop(): void {})
    await expect(accepted).rejects.toBe(getterFailure)
    await expect(accepting).rejects.toBe(getterFailure)
    expect(getterReads).toBe(1)
    expect(closeCalls).toBe(1)
  }
})

test("address admission keeps its primary Error ahead of rollback failures", async () => {
  const addressFailure = new Error("address failed")
  const cleanupFailure = new Error("rollback failed")
  const handle: HTTPHostHandle = Object.freeze({
    /** Fails after bind while preserving the original admission identity. */
    address(): never {
      throw addressFailure
    },
    /** Remains unreachable after address admission fails. */
    serve(): never {
      throw new Error("unexpected serve")
    },
    /** Reports a clean terminal join. */
    done(): Promise<void> {
      return Promise.resolve()
    },
    /** Fails rollback after the address failure was already selected. */
    close(): Promise<void> {
      return Promise.reject(cleanupFailure)
    }
  })
  const runtimeHost: HTTPHost = Object.freeze({
    /** Reports the portable baseline. */
    capabilities: baselineCapabilities,
    /** Returns the hostile bound handle. */
    bind(): Promise<HTTPHostHandle> {
      return Promise.resolve(handle)
    }
  })

  try {
    await newHTTPTransport().listen(background(), "127.0.0.1:0", host(runtimeHost))
    throw new Error("expected address admission failure")
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError)
    if (!(error instanceof AggregateError)) throw error
    expect(error.errors).toEqual([addressFailure, cleanupFailure])
  }
})

test("invalid actual address values perform a clean rollback", async () => {
  for (const actualAddress of ["", 42]) {
    let closeCalls = 0
    const handle: HTTPHostHandle = Object.freeze({
      /** Returns the selected hostile runtime value. */
      address(): string {
        return JSON.parse(JSON.stringify(actualAddress))
      },
      /** Remains unreachable after address validation. */
      serve(): never {
        throw new Error("unexpected serve")
      },
      /** Reports immediate terminal state. */
      done(): Promise<void> {
        return Promise.resolve()
      },
      /** Records the required rollback. */
      close(): Promise<void> {
        closeCalls += 1
        return Promise.resolve()
      }
    })
    const runtimeHost: HTTPHost = Object.freeze({
      /** Reports the portable baseline. */
      capabilities: baselineCapabilities,
      /** Returns the invalid-address handle. */
      bind(): Promise<HTTPHostHandle> {
        return Promise.resolve(handle)
      }
    })
    await expect(
      newHTTPTransport().listen(background(), "127.0.0.1:0", host(runtimeHost))
    ).rejects.toBeInstanceOf(TypeError)
    expect(closeCalls).toBe(1)
  }
})

test("listener close normalizes a synchronous host cleanup throw", async () => {
  const closeFailure = new Error("close threw")
  const handle: HTTPHostHandle = Object.freeze({
    /** Returns one deterministic bound address. */
    address(): string {
      return "127.0.0.1:43129"
    },
    /** Remains unreachable when close wins before accept. */
    serve(): never {
      throw new Error("unexpected serve")
    },
    /** Reports an already terminated host. */
    done(): Promise<void> {
      return Promise.resolve()
    },
    /** Throws synchronously from graceful cleanup. */
    close(): never {
      throw closeFailure
    }
  })
  const listener = newHTTPListener("127.0.0.1:43129", handle, baselineCapabilities())
  await expect(listener.close(background())).rejects.toBe(closeFailure)
  await expect(listener.accepted()).rejects.toMatchObject({ code: "LIKEGO_TRANSPORT_CLOSED" })
})

test("live-Context bind rejection uses the terminal waiter normalization branch", async () => {
  const failure = new Error("live bind rejected")
  const runtimeHost: HTTPHost = Object.freeze({
    /** Reports the portable baseline. */
    capabilities: baselineCapabilities,
    /** Rejects while the supplied Context has a live signal. */
    bind(): Promise<HTTPHostHandle> {
      return Promise.reject(failure)
    }
  })
  const ctx = withCancel(background())[0]
  await expect(newHTTPTransport().listen(ctx, "127.0.0.1:0", host(runtimeHost))).rejects.toBe(
    failure
  )
})

test("rollback normalizes synchronous close and done throws behind the admission error", async () => {
  const closeFailure = new Error("rollback close threw")
  const doneFailure = new Error("rollback done threw")
  const handle: HTTPHostHandle = Object.freeze({
    /** Returns an invalid empty actual address. */
    address(): string {
      return ""
    },
    /** Remains unreachable after address admission fails. */
    serve(): never {
      throw new Error("unexpected serve")
    },
    /** Throws from rollback terminal observation. */
    done(): never {
      throw doneFailure
    },
    /** Throws from rollback cleanup. */
    close(): never {
      throw closeFailure
    }
  })
  const runtimeHost: HTTPHost = Object.freeze({
    /** Reports the portable baseline. */
    capabilities: baselineCapabilities,
    /** Returns the hostile bound handle. */
    bind(): Promise<HTTPHostHandle> {
      return Promise.resolve(handle)
    }
  })

  try {
    await newHTTPTransport().listen(background(), "127.0.0.1:0", host(runtimeHost))
    throw new Error("expected rollback failure")
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError)
    if (!(error instanceof AggregateError)) throw error
    expect(error.errors[0]).toBeInstanceOf(TypeError)
    expect(error.errors[1]).toBe(closeFailure)
    expect(error.errors[2]).toBe(doneFailure)
  }
})

test("rollback waits for every cleanup side and orders failures by observation", async () => {
  const closeFailure = new Error("delayed rollback close rejected")
  const doneFailure = new Error("rollback done rejected first")
  const delayedClose = deferred<void>()
  const handle: HTTPHostHandle = Object.freeze({
    /** Returns an invalid address that selects the admission primary. */
    address(): string {
      return ""
    },
    /** Remains unreachable after admission failure. */
    serve(): never {
      throw new Error("unexpected serve")
    },
    /** Rejects before the delayed close side settles. */
    done(): Promise<void> {
      return Promise.reject(doneFailure)
    },
    /** Keeps rollback pending so every cleanup side must be joined. */
    close(): Promise<void> {
      return delayedClose.promise
    }
  })
  const runtimeHost: HTTPHost = Object.freeze({
    /** Reports baseline portable capabilities. */
    capabilities: baselineCapabilities,
    /** Returns the hostile bound handle. */
    bind(): Promise<HTTPHostHandle> {
      return Promise.resolve(handle)
    }
  })
  const listening = newHTTPTransport().listen(background(), "127.0.0.1:0", host(runtimeHost))
  let settled = false
  void listening.then(
    function unexpectedlyResolved(): void {
      settled = true
    },
    function observedRejection(): void {
      settled = true
    }
  )
  await Promise.resolve()
  await Promise.resolve()
  expect(settled).toBe(false)

  delayedClose.reject(closeFailure)
  try {
    await listening
    throw new Error("expected rollback failure")
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError)
    if (!(error instanceof AggregateError)) throw error
    expect(error.errors[0]).toBeInstanceOf(TypeError)
    expect(error.errors[1]).toBe(doneFailure)
    expect(error.errors[2]).toBe(closeFailure)
  }
})

test("a completely invalid host handle fails without inventing cleanup", async () => {
  const runtimeHost: HTTPHost = Object.freeze({
    /** Reports the portable baseline. */
    capabilities: baselineCapabilities,
    /** Returns a primitive through an untyped runtime boundary. */
    bind(): Promise<HTTPHostHandle> {
      return Promise.resolve(JSON.parse("null"))
    }
  })
  await expect(
    newHTTPTransport().listen(background(), "127.0.0.1:0", host(runtimeHost))
  ).rejects.toBeInstanceOf(TypeError)
})
