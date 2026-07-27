import {
  createServer,
  request as nodeRequest,
  type IncomingMessage,
  type RequestListener,
  type Server
} from "node:http"
import type { Socket } from "node:net"

import { describe, expect, test } from "bun:test"

import { background, canceled, withCancelCause, type Context } from "@likego/context"
import {
  listenerConformanceCases,
  type ListenerLifecycleConformanceHandle
} from "@likego/testing/listener"

import { newNodeHTTPHost, newNodeHTTPHostWithFactory } from "../src/node-host"
import type { HTTPHandler, HTTPHost, HTTPHostHandle, HTTPHostListenOptions } from "../src/types"

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

interface ConnectionMetadataProbe {
  readonly bindAddress: string
  readonly nativeLocalAddress: string
  readonly envelopeLocalAddress: string
  readonly status: number
}

interface PendingPost {
  readonly response: Promise<number>
  readonly destroy: () => void
}

const listenOptions: HTTPHostListenOptions = Object.freeze({
  secure: false,
  tlsConfig: null
})

// Real loopback probes must not be redirected by a developer or CI proxy.
const noProxy = [process.env.NO_PROXY, process.env.no_proxy, "127.0.0.1", "localhost", "::1"]
  .filter(Boolean)
  .join(",")
process.env.NO_PROXY = noProxy
process.env.no_proxy = noProxy

/** Creates one externally resolvable Promise controller. */
function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | null = null
  const promise = new Promise<T>(function capture(resolve): void {
    resolvePromise = resolve
  })
  return Object.freeze({
    promise,
    resolve(value: T): void {
      resolvePromise?.(value)
    }
  })
}

/** Returns one HTTP URL for an actual bound host address. */
function url(address: string): string {
  return `http://${address}/transport`
}

/** Reports whether one Promise remains pending after a task checkpoint. */
async function remainsPending(operation: Promise<unknown>): Promise<boolean> {
  let settled = false
  void operation.then(
    function resolved(): void {
      settled = true
    },
    function rejected(): void {
      settled = true
    }
  )
  await new Promise<void>(function checkpoint(resolve): void {
    setTimeout(resolve, 0)
  })
  return !settled
}

/** Bounds one test-only asynchronous checkpoint with a precise diagnostic. */
async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>(function wait(_resolve, reject): void {
    timer = setTimeout(function timedOut(): void {
      reject(new Error(`${label} did not settle`))
    }, 1_000)
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** Rebinds the exact released address once and closes the probe listener. */
async function expectPortReleased(address: string): Promise<void> {
  const separator = address.lastIndexOf(":")
  const addressHost = address.slice(0, separator)
  const hostname =
    addressHost.startsWith("[") && addressHost.endsWith("]")
      ? addressHost.slice(1, -1)
      : addressHost
  const port = Number(address.slice(separator + 1))
  const probe = createServer()
  await new Promise<void>(function bind(resolve, reject): void {
    probe.once("error", reject)
    probe.listen(Object.freeze({ host: hostname, port }), resolve)
  })
  await new Promise<void>(function close(resolve, reject): void {
    probe.close(function closed(error?: Error): void {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
}

/** Returns one dial authority by replacing only the host of an actual bind address. */
function dialAddress(address: string, hostname: string): string {
  const separator = address.lastIndexOf(":")
  const port = Number(address.slice(separator + 1))
  return hostname.includes(":") ? `[${hostname}]:${port}` : `${hostname}:${port}`
}

/** Exercises one real socket and records native versus Fetch-envelope local metadata. */
async function connectionMetadataProbe(
  bindAddress: string,
  dialHostname: string,
  hideSocketLocalAddress: boolean
): Promise<ConnectionMetadataProbe> {
  let nativeLocalAddress = ""
  let envelopeLocalAddress = ""
  const host = newNodeHTTPHostWithFactory(function factory(listener): Server {
    return createServer(function capture(request, response): void {
      const localHostname = request.socket.localAddress ?? ""
      const localPort = request.socket.localPort ?? 0
      nativeLocalAddress = localHostname.includes(":")
        ? `[${localHostname}]:${localPort}`
        : `${localHostname}:${localPort}`
      if (hideSocketLocalAddress) {
        Object.defineProperty(request.socket, "localAddress", {
          configurable: true,
          value: undefined
        })
        Object.defineProperty(request.socket, "localPort", {
          configurable: true,
          value: undefined
        })
      }
      listener(request, response)
    })
  })
  let handle: HTTPHostHandle | null = null
  try {
    handle = await host.bind(background(), bindAddress, listenOptions)
    const actualBindAddress = handle.address()
    const served = handle.serve(background(), function dispatch(input): Response {
      envelopeLocalAddress = input.localAddress
      return new Response("metadata")
    })
    await served.ready()
    const response = await fetch(url(dialAddress(actualBindAddress, dialHostname)))
    const status = response.status
    await response.arrayBuffer()
    await handle.close(background())
    await served.done()
    await handle.done()
    await expectPortReleased(actualBindAddress)
    handle = null
    return Object.freeze({
      bindAddress: actualBindAddress,
      nativeLocalAddress,
      envelopeLocalAddress,
      status
    })
  } finally {
    await cleanup(handle)
  }
}

/** Force-cleans one partially exercised handle after a failed assertion. */
async function cleanup(handle: HTTPHostHandle | null): Promise<void> {
  if (handle === null) return
  const force = handle.forceClose
  if (typeof force === "function") {
    try {
      await force.call(handle, new Error("test cleanup"))
    } catch {}
  }
  try {
    await handle.close(background())
  } catch {}
  try {
    await handle.done()
  } catch {}
}

/** Creates an event-compatible Server whose listen side effect is fully synthetic. */
function syntheticServer(listener: RequestListener, addressValue: unknown): Server {
  const server = createServer(listener)
  Reflect.set(server, "listen", function listen(): Server {
    queueMicrotask(function announceListening(): void {
      server.emit("listening")
    })
    return server
  })
  Reflect.set(server, "address", function address(): unknown {
    return addressValue
  })
  return server
}

/** Starts one native request, writes a partial body, and abandons the connection. */
async function abandonPost(address: string, entered: Promise<void>): Promise<void> {
  const separator = address.lastIndexOf(":")
  const hostname = address.slice(0, separator)
  const port = Number(address.slice(separator + 1))
  await new Promise<void>(function send(resolve): void {
    const request = nodeRequest(
      Object.freeze({
        hostname,
        port,
        path: "/aborted",
        method: "POST"
      })
    )
    request.on("error", function ignoredClientAbort(): void {
      resolve()
    })
    request.on("close", function closedClientAbort(): void {
      resolve()
    })
    request.write("partial")
    void entered.then(function abandon(): void {
      request.destroy()
    })
  })
}

/** Starts an incomplete native upload and requires an early complete response. */
async function partialPostResponse(address: string, bodyCanceled: Promise<void>): Promise<number> {
  const separator = address.lastIndexOf(":")
  const hostname = address.slice(0, separator)
  const port = Number(address.slice(separator + 1))
  const partial = "partial"
  const remaining = "remaining"
  return await new Promise<number>(function send(resolve, reject): void {
    let settled = false
    const request = nodeRequest(
      Object.freeze({
        hostname,
        port,
        path: "/cancel",
        method: "POST",
        agent: false,
        headers: Object.freeze({ "content-length": String(partial.length + remaining.length) })
      }),
      function responseReceived(response): void {
        const status = response.statusCode ?? 0
        /** Rejects one incomplete or failed native response exactly once. */
        function failed(error: Error): void {
          if (settled) return
          settled = true
          request.destroy()
          request.socket?.destroy()
          reject(error)
        }
        response.once("error", failed)
        response.once("aborted", function aborted(): void {
          failed(new Error("partial upload response aborted"))
        })
        response.once("end", function ended(): void {
          if (settled) return
          settled = true
          resolve(status)
        })
        response.resume()
      }
    )
    request.once("error", function failed(error): void {
      if (settled) return
      settled = true
      request.destroy()
      request.socket?.destroy()
      reject(error)
    })
    request.write(partial)
    void bodyCanceled.then(function completeUpload(): void {
      if (!settled) request.end(remaining)
    })
  })
}

/** Starts one incomplete upload while exposing explicit completion and cleanup controls. */
function pendingPost(address: string, path: string): PendingPost {
  const separator = address.lastIndexOf(":")
  const hostname = address.slice(0, separator)
  const port = Number(address.slice(separator + 1))
  const partial = "partial"
  const remaining = "remaining"
  let responseSettled = false
  let inputSettled = false
  const request = nodeRequest(
    Object.freeze({
      hostname,
      port,
      path,
      method: "POST",
      agent: false,
      headers: Object.freeze({ "content-length": String(partial.length + remaining.length) })
    })
  )
  const response = new Promise<number>(function receive(resolve, reject): void {
    /** Rejects the pending response at most once. */
    function failed(error: Error): void {
      if (responseSettled) return
      responseSettled = true
      reject(error)
    }
    request.once("response", function responseReceived(nativeResponse): void {
      const status = nativeResponse.statusCode ?? 0
      nativeResponse.once("error", failed)
      nativeResponse.once("aborted", function aborted(): void {
        failed(new Error("pending upload response aborted"))
      })
      nativeResponse.once("end", function ended(): void {
        if (responseSettled) return
        responseSettled = true
        resolve(status)
      })
      nativeResponse.resume()
    })
    request.once("error", failed)
  })
  request.write(partial)
  return Object.freeze({
    response,
    destroy(): void {
      if (inputSettled) return
      inputSettled = true
      request.destroy()
    }
  })
}

type BackpressureTerminal = "drain" | "close" | "error"

/** Creates a real server whose first write waits for one selected native terminal. */
function backpressureFactory(
  terminal: BackpressureTerminal,
  failure: Error
): (listener: RequestListener) => Server {
  return function create(listener: RequestListener): Server {
    return createServer(function intercept(request, response): void {
      const originalWrite = response.write.bind(response)
      let intercepted = false
      Reflect.set(response, "write", function write(chunk: Uint8Array): boolean {
        originalWrite(chunk)
        if (!intercepted) {
          intercepted = true
          queueMicrotask(function releaseBackpressure(): void {
            if (terminal === "error") response.emit("error", failure)
            else response.emit(terminal)
          })
        }
        return false
      })
      listener(request, response)
    })
  }
}

/** Creates one real bound Node listener behind the shared lifecycle conformance contract. */
async function nodeLifecycleFactory(): Promise<ListenerLifecycleConformanceHandle> {
  const native: { current: Server | null } = { current: null }
  const host = newNodeHTTPHostWithFactory(function factory(listener: RequestListener): Server {
    const created = createServer(listener)
    native.current = created
    return created
  })
  const handle = await host.bind(background(), "127.0.0.1:0", listenOptions)
  const served = handle.serve(background(), function dispatch(): Response {
    return new Response("conformance")
  })
  await served.ready()
  const address = handle.address()
  const forceClose = handle.forceClose
  if (typeof forceClose !== "function") {
    await handle.close(background())
    throw new Error("Node HTTP host omitted forceClose")
  }
  return Object.freeze({
    /** Returns the actual immutable native bind address. */
    address(): string {
      return handle.address()
    },
    /** Returns the host's stable true native terminal. */
    done(): Promise<void> {
      return handle.done()
    },
    /** Delegates caller-scoped close to the real host handle. */
    close(ctx: Context): Promise<void> {
      return handle.close(ctx)
    },
    /** Returns request admission from the real installed serve loop. */
    ready(): Promise<void> {
      return served.ready()
    },
    /** Executes the real Node force primitive. */
    force(reason: Error): Promise<void> {
      return forceClose.call(handle, reason)
    },
    /** Injects one real native Server error event. */
    fail(error: Error): void {
      const active = native.current
      if (active === null) throw new Error("Node HTTP native server was not created")
      active.emit("error", error)
    },
    /** Proves the exact released TCP authority can be rebound. */
    rebind(): Promise<void> {
      return expectPortReleased(address)
    }
  })
}

describe("Node HTTP host", () => {
  for (const entry of listenerConformanceCases(nodeLifecycleFactory)) {
    test(`satisfies shared listener conformance: ${entry.name}`, entry.run)
  }

  test("publishes the exact frozen runtime capability snapshot", () => {
    const host = newNodeHTTPHost()
    const capabilities = host.capabilities()
    const plainCapabilities = newNodeHTTPHostWithFactory(createServer).capabilities()

    expect(capabilities).toEqual({
      tls: true,
      forceClose: true,
      connectionMetadata: true
    })
    expect(Object.isFrozen(capabilities)).toBeTrue()
    expect(host.capabilities()).toBe(capabilities)
    expect(plainCapabilities).toEqual({
      tls: false,
      forceClose: true,
      connectionMetadata: true
    })
  })

  test("rejects incomplete TLS, invalid addresses, factories, and canceled bind", async () => {
    const host = newNodeHTTPHost()
    await expect(
      host.bind(
        background(),
        "127.0.0.1:0",
        Object.freeze({
          secure: true,
          tlsConfig: null
        })
      )
    ).rejects.toThrow("requires a PEM certificate chain and private key")
    await expect(
      newNodeHTTPHostWithFactory(createServer).bind(
        background(),
        "127.0.0.1:0",
        Object.freeze({ secure: true, tlsConfig: null })
      )
    ).rejects.toThrow("does not support TLS")
    await expect(host.bind(background(), "invalid", listenOptions)).rejects.toThrow(
      "listen address must be host:port"
    )
    await expect(host.bind(background(), "127.0.0.1:65536", listenOptions)).rejects.toThrow(
      "listen port must be an integer"
    )
    expect(() => newNodeHTTPHostWithFactory(null as never)).toThrow(TypeError)

    const [ctx, cancel] = withCancelCause(background())
    const failure = new Error("bind canceled")
    cancel(failure)
    await expect(host.bind(ctx, "127.0.0.1:0", listenOptions)).rejects.toBe(failure)
  })

  test("keeps bind boundary failures asynchronous and releases a post-listen Context fault", async () => {
    const initialFailure = new Error("initial Context inspection failed")
    const initialContext: Context = Object.freeze({
      deadline(): readonly [Date, boolean] {
        return [new Date(0), false]
      },
      done(): null {
        return null
      },
      err(): never {
        throw initialFailure
      },
      value(_key: unknown): null {
        return null
      }
    })
    const initialBinding = newNodeHTTPHost().bind(initialContext, "127.0.0.1:0", listenOptions)
    expect(initialBinding).toBeInstanceOf(Promise)
    await expect(initialBinding).rejects.toBe(initialFailure)

    const optionFailure = new Error("listen option inspection failed")
    const hostileOptions = Object.defineProperty({}, "secure", {
      get(): never {
        throw optionFailure
      }
    }) as HTTPHostListenOptions
    const optionBinding = newNodeHTTPHost().bind(background(), "127.0.0.1:0", hostileOptions)
    expect(optionBinding).toBeInstanceOf(Promise)
    await expect(optionBinding).rejects.toBe(optionFailure)

    const postListenFailure = new Error("post-listen Context inspection failed")
    const native: { current: Server | null } = { current: null }
    let observedAddress = ""
    let reads = 0
    const racingContext: Context = Object.freeze({
      deadline(): readonly [Date, boolean] {
        return [new Date(0), false]
      },
      done(): null {
        return null
      },
      err(): null {
        reads += 1
        if (reads === 1) return null
        throw postListenFailure
      },
      value(_key: unknown): null {
        return null
      }
    })
    const host = newNodeHTTPHostWithFactory(function factory(listener): Server {
      const server = createServer(listener)
      native.current = server
      const listen = server.listen.bind(server)
      Reflect.set(server, "listen", function start(options: object): Server {
        Reflect.apply(listen, server, [options])
        const address = server.address()
        if (typeof address === "object" && address !== null) {
          observedAddress = `${address.address}:${address.port}`
        }
        return server
      })
      return server
    })
    try {
      const binding = host.bind(racingContext, "127.0.0.1:0", listenOptions)
      expect(binding).toBeInstanceOf(Promise)
      await expect(bounded(binding, "post-listen Context cleanup")).rejects.toBe(postListenFailure)
      expect(reads).toBe(2)
      expect(observedAddress).not.toBeEmpty()
      await expectPortReleased(observedAddress)
    } finally {
      const server = native.current
      if (server !== null && server.listening) {
        await bounded(
          new Promise<void>(function close(resolve, reject): void {
            server.close(function closed(error?: Error): void {
              if (error === undefined) resolve()
              else reject(error)
            })
          }),
          "post-listen Context fallback cleanup"
        )
      }
    }
  })

  test("owns hostile bind Context registration and listener-observation failures", async () => {
    const doneFailure = new Error("bind Context done failed")
    const doneContext: Context = Object.freeze({
      deadline(): readonly [Date, boolean] {
        return [new Date(0), false]
      },
      done(): never {
        throw doneFailure
      },
      err(): null {
        return null
      },
      value(_key: unknown): null {
        return null
      }
    })
    await expect(
      bounded(
        newNodeHTTPHost().bind(doneContext, "127.0.0.1:0", listenOptions),
        "bind Context done cleanup"
      )
    ).rejects.toBe(doneFailure)

    const addFailure = new Error("bind Context add failed")
    const addDetachFailure = new Error("bind Context add detach failed")
    const addSignal = new AbortController().signal
    Reflect.set(addSignal, "addEventListener", function add(): never {
      throw addFailure
    })
    Reflect.set(addSignal, "removeEventListener", function remove(): never {
      throw addDetachFailure
    })
    const addContext: Context = Object.freeze({
      deadline(): readonly [Date, boolean] {
        return [new Date(0), false]
      },
      done(): AbortSignal {
        return addSignal
      },
      err(): null {
        return null
      },
      value(_key: unknown): null {
        return null
      }
    })
    const addTerminal = await bounded(
      newNodeHTTPHost()
        .bind(addContext, "127.0.0.1:0", listenOptions)
        .catch(function rejected(error: Error): Error {
          return error
        }),
      "bind Context add cleanup"
    )
    expect(addTerminal).toBeInstanceOf(AggregateError)
    if (!(addTerminal instanceof AggregateError)) throw addTerminal
    expect(Array.from(addTerminal.errors)).toEqual([addFailure, addDetachFailure])

    const reentrantFailure = new Error("bind Context reentrant cause failed")
    const reentrantSignal = new AbortController().signal
    let reentered = false
    Reflect.set(
      reentrantSignal,
      "addEventListener",
      function add(_type: string, listener: EventListenerOrEventListenerObject): void {
        reentered = true
        if (typeof listener === "function") listener(new Event("abort"))
        else listener.handleEvent(new Event("abort"))
      }
    )
    Reflect.set(reentrantSignal, "removeEventListener", function remove(): void {})
    const reentrantContext: Context = Object.freeze({
      deadline(): readonly [Date, boolean] {
        return [new Date(0), false]
      },
      done(): AbortSignal {
        return reentrantSignal
      },
      err(): null {
        if (reentered) throw reentrantFailure
        return null
      },
      value(_key: unknown): null {
        return null
      }
    })
    await expect(
      bounded(
        newNodeHTTPHost().bind(reentrantContext, "127.0.0.1:0", listenOptions),
        "bind Context reentrant cleanup"
      )
    ).rejects.toBe(reentrantFailure)

    const detachFailure = new Error("successful bind Context detach failed")
    const detachSignal = new AbortController().signal
    Reflect.set(detachSignal, "removeEventListener", function remove(): never {
      throw detachFailure
    })
    const detachContext: Context = Object.freeze({
      deadline(): readonly [Date, boolean] {
        return [new Date(0), false]
      },
      done(): AbortSignal {
        return detachSignal
      },
      err(): null {
        return null
      },
      value(_key: unknown): null {
        return null
      }
    })
    const native: { current: Server | null; address: string } = { current: null, address: "" }
    const detachHost = newNodeHTTPHostWithFactory(function factory(listener): Server {
      const server = createServer(listener)
      native.current = server
      server.once("listening", function capture(): void {
        const address = server.address()
        if (typeof address === "object" && address !== null) {
          native.address = `${address.address}:${address.port}`
        }
      })
      return server
    })
    try {
      await expect(
        bounded(
          detachHost.bind(detachContext, "127.0.0.1:0", listenOptions),
          "successful bind Context detach cleanup"
        )
      ).rejects.toBe(detachFailure)
      expect(native.address).not.toBeEmpty()
      await expectPortReleased(native.address)
    } finally {
      const server = native.current
      if (server !== null && server.listening) {
        await bounded(
          new Promise<void>(function close(resolve): void {
            server.close(function closed(): void {
              resolve()
            })
          }),
          "successful bind Context detach fallback cleanup"
        )
      }
    }

    const listeningFailure = new Error("bind listening observation failed")
    const observationHost = newNodeHTTPHostWithFactory(function factory(listener): Server {
      const server = createServer(listener)
      return new Proxy(server, {
        get(target, property): unknown {
          if (property === "once") {
            return function once(event: string): never {
              if (event === "listening") throw listeningFailure
              throw new Error(`unexpected once event ${event}`)
            }
          }
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === "function" ? value.bind(target) : value
        }
      })
    })
    await expect(
      bounded(
        observationHost.bind(background(), "127.0.0.1:0", listenOptions),
        "bind listening observation cleanup"
      )
    ).rejects.toBe(listeningFailure)
  })

  test("supports synthetic IPv6 bind and true no-listener close", async () => {
    const host = newNodeHTTPHostWithFactory(function factory(listener): Server {
      return syntheticServer(
        listener,
        Object.freeze({
          address: "::1",
          family: "IPv6",
          port: 43100
        })
      )
    })
    const handle = await host.bind(background(), "[::1]:0", listenOptions)
    expect(handle.address()).toBe("[::1]:43100")
    await handle.close(background())
    await handle.done()
  })

  test("rejects invalid native bound addresses after active startup cleanup", async () => {
    for (const value of [null, Object.freeze({ address: 42, port: "bad" })]) {
      const host = newNodeHTTPHostWithFactory(function factory(listener): Server {
        return syntheticServer(listener, value)
      })
      await expect(host.bind(background(), "127.0.0.1:0", listenOptions)).rejects.toThrow(
        "Node HTTP host address is not a TCP address"
      )
    }
  })

  test("normalizes factory and synchronous native listen failures", async () => {
    const factoryFailure = new Error("factory threw")
    const badFactory = newNodeHTTPHostWithFactory(function factory(): Server {
      throw factoryFailure
    })
    await expect(badFactory.bind(background(), "127.0.0.1:0", listenOptions)).rejects.toBe(
      factoryFailure
    )

    const listenFailure = new Error("listen threw")
    const badListen = newNodeHTTPHostWithFactory(function factory(listener): Server {
      const server = createServer(listener)
      Reflect.set(server, "listen", function listen(): never {
        throw listenFailure
      })
      return server
    })
    await expect(badListen.bind(background(), "127.0.0.1:0", listenOptions)).rejects.toBe(
      listenFailure
    )

    const delayed = newNodeHTTPHostWithFactory(function factory(listener): Server {
      const server = createServer(listener)
      Reflect.set(server, "listen", function listen(): Server {
        return server
      })
      return server
    })
    const [ctx, cancel] = withCancelCause(background())
    const canceledBind = delayed.bind(ctx, "127.0.0.1:0", listenOptions)
    const canceledFailure = new Error("started bind canceled")
    cancel(canceledFailure)
    await expect(canceledBind).rejects.toBe(canceledFailure)
  })

  test("closes a real native listener when bind is canceled before listening", async () => {
    const native: { current: Server | null } = { current: null }
    const host = newNodeHTTPHostWithFactory(function factory(listener): Server {
      const server = createServer(listener)
      native.current = server
      return server
    })
    const [ctx, cancel] = withCancelCause(background())
    const failure = new Error("real bind canceled")
    const binding = host.bind(ctx, "127.0.0.1:0", listenOptions)
    cancel(failure)

    await expect(binding).rejects.toBe(failure)
    const server = native.current
    if (server === null) throw new Error("native server was not created")
    await bounded(
      new Promise<void>(function observeClose(resolve): void {
        if (!server.listening && server.address() === null) {
          setTimeout(function confirmStableClose(): void {
            if (!server.listening && server.address() === null) resolve()
          }, 0)
          return
        }
        server.once("close", resolve)
      }),
      "canceled native bind close"
    )
    expect(server.listening).toBeFalse()
    expect(server.address()).toBeNull()
  })

  test("aggregates pending-listen close callback and throw failures behind cancellation", async () => {
    for (const mode of ["callback", "throw"] as const) {
      const cleanupFailure = new Error(`pending listen close ${mode}`)
      const host = newNodeHTTPHostWithFactory(function factory(listener): Server {
        const server = createServer(listener)
        Reflect.set(server, "listen", function listen(): Server {
          return server
        })
        Reflect.set(server, "close", function close(callback?: (error?: Error) => void): Server {
          if (mode === "throw") throw cleanupFailure
          queueMicrotask(function rejectPendingClose(): void {
            callback?.(cleanupFailure)
          })
          return server
        })
        return server
      })
      const [ctx, cancel] = withCancelCause(background())
      const primary = new Error(`pending listen canceled ${mode}`)
      const binding = host.bind(ctx, "127.0.0.1:0", listenOptions)
      cancel(primary)

      const failure = await (async function rejectedBind(): Promise<unknown> {
        try {
          await binding
        } catch (error) {
          return error
        }
        throw new Error("expected pending bind rejection")
      })()
      expect(failure).toBeInstanceOf(AggregateError)
      if (!(failure instanceof AggregateError)) throw new Error("expected pending AggregateError")
      expect(failure.errors).toEqual([primary, cleanupFailure])
    }
  })

  test("closes when cancellation wins inside the native listening event", async () => {
    const [ctx, cancel] = withCancelCause(background())
    const failure = new Error("listening event canceled")
    const native: { current: Server | null } = { current: null }
    const host = newNodeHTTPHostWithFactory(function factory(listener): Server {
      const server = createServer(listener)
      native.current = server
      const listen = server.listen.bind(server)
      Reflect.set(server, "listen", function start(options: object): Server {
        server.prependOnceListener("listening", function cancelAtListening(): void {
          cancel(failure)
        })
        return listen(options)
      })
      return server
    })

    await expect(host.bind(ctx, "127.0.0.1:0", listenOptions)).rejects.toBe(failure)
    const server = native.current
    if (server === null) throw new Error("native server was not created")
    expect(server.listening).toBeFalse()
    expect(server.address()).toBeNull()
  })

  test("serves pre-runtime synthetic traffic through the admission failure response", async () => {
    const observed = { resumed: false, status: 0, ended: "" }
    const host = newNodeHTTPHostWithFactory(function factory(listener): Server {
      Reflect.apply(listener, undefined, [
        Object.freeze({
          resume(): void {
            observed.resumed = true
          }
        }),
        {
          statusCode: 0,
          setHeader(): void {},
          end(body: string): void {
            observed.status = Reflect.get(this, "statusCode") as number
            observed.ended = body
          }
        }
      ])
      return syntheticServer(
        listener,
        Object.freeze({
          address: "127.0.0.1",
          family: "IPv4",
          port: 43101
        })
      )
    })
    const handle = await host.bind(background(), "127.0.0.1:0", listenOptions)
    expect(observed).toEqual({ resumed: true, status: 503, ended: "Service Unavailable" })
    await handle.close(background())
  })

  test("binds a real port, rejects pre-serve traffic, and exchanges standard Fetch values", async () => {
    const host = newNodeHTTPHost()
    let handle: HTTPHostHandle | null = null
    try {
      handle = await host.bind(background(), "127.0.0.1:0", listenOptions)
      const address = handle.address()
      expect(handle.done()).toBe(handle.done())

      const early = await fetch(url(address), Object.freeze({ method: "POST" }))
      expect(early.status).toBe(503)
      await early.arrayBuffer()

      let envelopeAddress = ""
      let envelopeRemote = ""
      const served = handle.serve(background(), async function dispatch(input) {
        envelopeAddress = input.localAddress
        envelopeRemote = input.remoteAddress
        expect(input.request).toBeInstanceOf(Request)
        expect(await input.request.text()).toBe("hello")
        return new Response(
          "world",
          Object.freeze({
            status: 201,
            headers: Object.freeze({ "x-likego-node": "ok" })
          })
        )
      })
      expect(served.done()).toBe(served.done())
      await served.ready()

      const response = await fetch(
        url(address),
        Object.freeze({
          method: "POST",
          body: "hello"
        })
      )
      expect(response.status).toBe(201)
      expect(response.headers.get("x-likego-node")).toBe("ok")
      expect(await response.text()).toBe("world")
      expect(envelopeAddress).toBe(address)
      expect(envelopeRemote.length).toBeGreaterThan(0)

      await handle.close(background())
      await served.done()
      await handle.done()
      await expectPortReleased(address)
      handle = null
    } finally {
      await cleanup(handle)
    }
  })

  test("reports the real IPv4 socket local address instead of the wildcard bind authority", async () => {
    const probe = await connectionMetadataProbe("0.0.0.0:0", "127.0.0.1", false)

    expect(probe.status).toBe(200)
    expect(probe.bindAddress).toStartWith("0.0.0.0:")
    expect(probe.nativeLocalAddress).toStartWith("127.0.0.1:")
    expect(probe.envelopeLocalAddress).toBe(probe.nativeLocalAddress)
    expect(probe.envelopeLocalAddress).not.toBe(probe.bindAddress)
  })

  test("reports the real IPv6 socket local address instead of the wildcard bind authority", async () => {
    const probe = await connectionMetadataProbe("[::]:0", "::1", false)

    expect(probe.status).toBe(200)
    expect(probe.bindAddress).toStartWith("[::]:")
    expect(probe.nativeLocalAddress).toStartWith("[::1]:")
    expect(probe.envelopeLocalAddress).toBe(probe.nativeLocalAddress)
    expect(probe.envelopeLocalAddress).not.toBe(probe.bindAddress)
  })

  test("falls back to the bind authority only when socket local metadata is missing", async () => {
    const probe = await connectionMetadataProbe("0.0.0.0:0", "127.0.0.1", true)

    expect(probe.status).toBe(200)
    expect(probe.nativeLocalAddress).not.toBe(probe.bindAddress)
    expect(probe.envelopeLocalAddress).toBe(probe.bindAddress)
  })

  test("validates serve admission and keeps it one-shot", async () => {
    const handle = await newNodeHTTPHost().bind(background(), "127.0.0.1:0", listenOptions)
    try {
      const [ctx, cancel] = withCancelCause(background())
      const failure = new Error("serve canceled")
      cancel(failure)
      expect(() =>
        handle.serve(ctx, function unused(): Response {
          return new Response("unused")
        })
      ).toThrow(failure)
      expect(() => handle.serve(background(), null as never)).toThrow(
        "Node HTTP handler must be a function"
      )
      const served = handle.serve(background(), function dispatch(): Response {
        return new Response("ok")
      })
      await served.ready()
      expect(() =>
        handle.serve(background(), function duplicate(): Response {
          return new Response("duplicate")
        })
      ).toThrow("serve is one-shot")
    } finally {
      await handle.close(background())
      await handle.done()
    }
  })

  test("keeps hostile serve Context observation atomic and retryable", async () => {
    const handle = await newNodeHTTPHost().bind(background(), "127.0.0.1:0", listenOptions)
    try {
      const doneFailure = new Error("serve Context done failed")
      const doneContext: Context = Object.freeze({
        deadline(): readonly [Date, boolean] {
          return [new Date(0), false]
        },
        done(): never {
          throw doneFailure
        },
        err(): null {
          return null
        },
        value(_key: unknown): null {
          return null
        }
      })
      expect(() =>
        handle.serve(doneContext, function unused(): Response {
          return new Response("unused")
        })
      ).toThrow(doneFailure)

      const racedFailure = new Error("serve Context raced inspection failed")
      let reads = 0
      const racedContext: Context = Object.freeze({
        deadline(): readonly [Date, boolean] {
          return [new Date(0), false]
        },
        done(): null {
          return null
        },
        err(): null {
          reads += 1
          if (reads === 1) return null
          throw racedFailure
        },
        value(_key: unknown): null {
          return null
        }
      })
      expect(() =>
        handle.serve(racedContext, function unused(): Response {
          return new Response("unused")
        })
      ).toThrow(racedFailure)

      const signal = new AbortController().signal
      let removals = 0
      Reflect.set(
        signal,
        "addEventListener",
        function cancelDuringRegistration(
          _type: string,
          listener: EventListenerOrEventListenerObject
        ): void {
          if (typeof listener === "function") listener(new Event("abort"))
          else listener.handleEvent(new Event("abort"))
        }
      )
      Reflect.set(signal, "removeEventListener", function remove(): void {
        removals += 1
      })
      const canceledContext: Context = Object.freeze({
        deadline(): readonly [Date, boolean] {
          return [new Date(0), false]
        },
        done(): AbortSignal {
          return signal
        },
        err(): null {
          return null
        },
        value(_key: unknown): null {
          return null
        }
      })
      expect(() =>
        handle.serve(canceledContext, function unused(): Response {
          return new Response("unused")
        })
      ).toThrow(canceled)
      expect(removals).toBe(1)

      const served = handle.serve(background(), function dispatch(): Response {
        return new Response("ok")
      })
      await served.ready()
    } finally {
      await handle.close(background())
      await handle.done()
    }
  })

  test("forces a bound host when failed serve admission cannot detach its Context", async () => {
    const primary = new Error("serve Context observation failed")
    const detachFailure = new Error("serve Context detach failed")
    const signal = new AbortController().signal
    Reflect.set(signal, "addEventListener", function add(): never {
      throw primary
    })
    Reflect.set(signal, "removeEventListener", function remove(): never {
      throw detachFailure
    })
    const context: Context = Object.freeze({
      deadline(): readonly [Date, boolean] {
        return [new Date(0), false]
      },
      done(): AbortSignal {
        return signal
      },
      err(): null {
        return null
      },
      value(_key: unknown): null {
        return null
      }
    })
    const handle = await newNodeHTTPHost().bind(background(), "127.0.0.1:0", listenOptions)
    const address = handle.address()
    expect(() =>
      handle.serve(context, function unused(): Response {
        return new Response("unused")
      })
    ).toThrow(primary)
    const terminal = await bounded(
      handle.done().catch(function rejected(error: Error): Error {
        return error
      }),
      "failed serve admission cleanup"
    )
    expect(terminal).toBeInstanceOf(AggregateError)
    if (!(terminal instanceof AggregateError)) throw terminal
    expect(Array.from(terminal.errors)).toEqual([primary, detachFailure])
    await expectPortReleased(address)
  })

  test("settles terminal when the admitted serve Context detach throws", async () => {
    const detachFailure = new Error("terminal serve Context detach failed")
    const signal = new AbortController().signal
    Reflect.set(signal, "removeEventListener", function remove(): never {
      throw detachFailure
    })
    const context: Context = Object.freeze({
      deadline(): readonly [Date, boolean] {
        return [new Date(0), false]
      },
      done(): AbortSignal {
        return signal
      },
      err(): null {
        return null
      },
      value(_key: unknown): null {
        return null
      }
    })
    const handle = await newNodeHTTPHost().bind(background(), "127.0.0.1:0", listenOptions)
    const address = handle.address()
    const served = handle.serve(context, function dispatch(): Response {
      return new Response("unused")
    })
    await served.ready()
    const closing = handle.close(background())
    await expect(bounded(closing, "terminal serve Context detach")).rejects.toBe(detachFailure)
    await expect(handle.done()).rejects.toBe(detachFailure)
    await expect(served.done()).rejects.toBe(detachFailure)
    expect(handle.done()).toBe(served.done())
    await expectPortReleased(address)
  })

  test("handles GET, empty responses, invalid handlers, and malformed response streams", async () => {
    const host = newNodeHTTPHost()
    let handle: HTTPHostHandle | null = null
    try {
      handle = await host.bind(background(), "127.0.0.1:0", listenOptions)
      const served = handle.serve(background(), function dispatch(input): Response {
        const pathname = new URL(input.request.url).pathname
        if (pathname === "/empty") {
          expect(input.request.method).toBe("GET")
          expect(input.request.body).toBeNull()
          return new Response(null, Object.freeze({ status: 204 }))
        }
        if (pathname === "/invalid") return 42 as never
        if (pathname === "/chunk") {
          const output = new Response(null)
          const reader = Object.freeze({
            read(): Promise<unknown> {
              return Promise.resolve(Object.freeze({ done: false, value: "invalid" }))
            },
            cancel(): Promise<void> {
              return Promise.resolve()
            },
            releaseLock(): void {}
          })
          Object.defineProperty(output, "body", {
            configurable: true,
            enumerable: true,
            value: Object.freeze({
              getReader(): typeof reader {
                return reader
              }
            })
          })
          return output
        }
        const body = new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(new TextEncoder().encode("partial"))
            setTimeout(function failAfterFirstWrite(): void {
              controller.error(new Error("stream failed after headers"))
            }, 0)
          }
        })
        return new Response(body)
      })
      await served.ready()
      const base = `http://${handle.address()}`

      const empty = await fetch(`${base}/empty`)
      expect(empty.status).toBe(204)
      expect(await empty.arrayBuffer()).toHaveLength(0)

      const invalid = await fetch(`${base}/invalid`)
      expect(invalid.status).toBe(500)
      expect(await invalid.text()).toBe("Internal Server Error")

      const chunk = await fetch(`${base}/chunk`)
      expect(chunk.status).toBe(500)
      await chunk.arrayBuffer()

      let streamedFailure: unknown = null
      try {
        const streamed = await fetch(`${base}/streamed`)
        await streamed.arrayBuffer()
      } catch (error) {
        streamedFailure = error
      }
      expect(streamedFailure).toBeInstanceOf(Error)
    } finally {
      await cleanup(handle)
    }
  })

  test("cancels and aborts real incoming request bodies", async () => {
    const host = newNodeHTTPHost()
    let handle: HTTPHostHandle | null = null
    const entered = deferred<void>()
    const aborted = deferred<Error>()
    const canceledBody = deferred<void>()
    try {
      handle = await host.bind(background(), "127.0.0.1:0", listenOptions)
      const served = handle.serve(background(), async function dispatch(input): Promise<Response> {
        const pathname = new URL(input.request.url).pathname
        if (pathname === "/cancel") {
          const body = input.request.body
          if (body === null) throw new Error("request body was missing")
          await body.cancel()
          canceledBody.resolve(undefined)
          return new Response(null, Object.freeze({ status: 204 }))
        }
        entered.resolve(undefined)
        try {
          await input.request.text()
        } catch (error) {
          aborted.resolve(
            error instanceof Error ? error : new Error("request abort was not an Error")
          )
        }
        return new Response("aborted")
      })
      await served.ready()

      expect(
        await bounded(
          partialPostResponse(handle.address(), canceledBody.promise),
          "partial upload response"
        )
      ).toBe(204)
      await bounded(canceledBody.promise, "request body cancellation")

      await bounded(abandonPost(handle.address(), entered.promise), "abandoned client request")
      expect(await bounded(aborted.promise, "aborted body consumption")).toBeInstanceOf(Error)
    } finally {
      await cleanup(handle)
    }
  })

  test("owns post-cancel native request errors until input terminal", async () => {
    const nativeRequest = deferred<IncomingMessage>()
    const nativeClosed = deferred<void>()
    const requestSignal = deferred<AbortSignal>()
    const host = newNodeHTTPHostWithFactory(function factory(listener): Server {
      return createServer(function capture(request, response): void {
        nativeRequest.resolve(request)
        request.once("close", function inputClosed(): void {
          nativeClosed.resolve(undefined)
        })
        listener(request, response)
      })
    })
    let handle: HTTPHostHandle | null = null
    let upload: PendingPost | null = null
    try {
      handle = await host.bind(background(), "127.0.0.1:0", listenOptions)
      const address = handle.address()
      const served = handle.serve(background(), async function dispatch(input): Promise<Response> {
        requestSignal.resolve(input.request.signal)
        const body = input.request.body
        if (body === null) throw new Error("request body was missing")
        await body.cancel()
        return new Response(null, Object.freeze({ status: 204 }))
      })
      await served.ready()
      upload = pendingPost(address, "/cancel-native-error")
      expect(await bounded(upload.response, "early canceled response")).toBe(204)
      await new Promise<void>(function checkpoint(resolve): void {
        setImmediate(resolve)
      })

      const activeNative = await bounded(nativeRequest.promise, "captured native request")
      expect(activeNative.complete).toBe(false)
      const failure = new Error("native request failed after body cancellation")
      expect(function emitNativeFailure(): void {
        activeNative.emit("error", failure)
      }).not.toThrow()
      const activeSignal = await bounded(requestSignal.promise, "standard request signal")
      expect(activeSignal.aborted).toBe(true)
      expect(activeSignal.reason).toBe(failure)

      activeNative.emit("close")
      await bounded(nativeClosed.promise, "native request terminal")
      expect(activeNative.listenerCount("error")).toBe(0)
      upload.destroy()
      await handle.close(background())
      await served.done()
      await handle.done()
      await expectPortReleased(address)
      handle = null
      upload = null
    } finally {
      upload?.destroy()
      await cleanup(handle)
    }
  })

  for (const terminal of ["drain", "close", "error"] as const) {
    test(`handles native response backpressure ${terminal}`, async () => {
      const failure = new Error(`backpressure ${terminal}`)
      const host = newNodeHTTPHostWithFactory(backpressureFactory(terminal, failure))
      let handle: HTTPHostHandle | null = null
      try {
        handle = await host.bind(background(), "127.0.0.1:0", listenOptions)
        const served = handle.serve(background(), function dispatch(): Response {
          return new Response("backpressure")
        })
        await served.ready()
        if (terminal === "drain") {
          const response = await fetch(url(handle.address()))
          expect(await response.text()).toBe("backpressure")
        } else {
          try {
            const response = await fetch(url(handle.address()))
            await response.arrayBuffer()
          } catch (error) {
            expect(error).toBeInstanceOf(Error)
          }
        }
      } finally {
        await cleanup(handle)
      }
    })
  }

  test("keeps graceful in-flight work alive while close callers remain scoped", async () => {
    const host = newNodeHTTPHost()
    let handle: HTTPHostHandle | null = null
    const entered = deferred<void>()
    const release = deferred<void>()
    try {
      handle = await host.bind(background(), "127.0.0.1:0", listenOptions)
      const served = handle.serve(background(), async function dispatch(): Promise<Response> {
        entered.resolve(undefined)
        await release.promise
        return new Response("drained")
      })
      await served.ready()
      const responseWork = fetch(url(handle.address()), Object.freeze({ method: "POST" }))
      await entered.promise

      const [callerCtx, cancelCaller] = withCancelCause(background())
      const callerFailure = new Error("caller stopped waiting")
      const first = handle.close(callerCtx)
      await Promise.resolve()
      cancelCaller(callerFailure)
      await expect(first).rejects.toBe(callerFailure)

      const joined = handle.close(background())
      expect(await remainsPending(joined)).toBeTrue()
      release.resolve(undefined)
      const response = await responseWork
      expect(await response.text()).toBe("drained")
      await joined
      await handle.done()
      handle = null
    } finally {
      release.resolve(undefined)
      await cleanup(handle)
    }
  })

  test("forces an active streamed response but waits for real socket and handler terminal", async () => {
    const host = newNodeHTTPHost()
    let handle: HTTPHostHandle | null = null
    const canceled = deferred<void>()
    try {
      handle = await host.bind(background(), "127.0.0.1:0", listenOptions)
      const address = handle.address()
      const served = handle.serve(background(), function dispatch(): Response {
        const body = new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(new TextEncoder().encode("partial"))
          },
          cancel(): void {
            canceled.resolve(undefined)
          }
        })
        return new Response(body)
      })
      await served.ready()
      const response = await fetch(url(address), Object.freeze({ method: "POST" }))
      expect(response.status).toBe(200)

      const closing = handle.close(background())
      expect(await remainsPending(closing)).toBeTrue()
      const force = handle.forceClose
      if (typeof force !== "function") throw new Error("Node host omitted forceClose")
      await force.call(handle, new Error("owner hard drain timeout"))
      await expect(response.arrayBuffer()).rejects.toBeInstanceOf(Error)
      await canceled.promise
      await closing
      await served.done()
      await handle.done()
      await expectPortReleased(address)
      handle = null
    } finally {
      await cleanup(handle)
    }
  })

  test("claims a passive native error and actively releases the bound port", async () => {
    const native: { current: Server | null } = { current: null }
    const host = newNodeHTTPHostWithFactory(function factory(listener: RequestListener): Server {
      const created = createServer(listener)
      native.current = created
      return created
    })
    let handle: HTTPHostHandle | null = null
    try {
      handle = await host.bind(background(), "127.0.0.1:0", listenOptions)
      const address = handle.address()
      const served = handle.serve(background(), function dispatch(): Response {
        return new Response("unused")
      })
      await served.ready()
      const failure = new Error("native host failed")
      const activeNative = native.current
      if (activeNative === null) throw new Error("native server was not created")
      activeNative.emit("error", failure)

      await expect(handle.done()).rejects.toBe(failure)
      await expect(served.done()).rejects.toBe(failure)
      await expectPortReleased(address)
      handle = null
    } finally {
      await cleanup(handle)
    }
  })

  test("aggregates ordered native force cleanup failures", async () => {
    const idleFailure = new Error("close idle failed")
    const allFailure = new Error("close all failed")
    const host = newNodeHTTPHostWithFactory(function factory(listener): Server {
      const server = createServer(listener)
      Reflect.set(server, "closeIdleConnections", function closeIdleConnections(): never {
        throw idleFailure
      })
      Reflect.set(server, "closeAllConnections", function closeAllConnections(): never {
        throw allFailure
      })
      return server
    })
    const handle = await host.bind(background(), "127.0.0.1:0", listenOptions)
    const served = handle.serve(background(), function dispatch(): Response {
      return new Response("unused")
    })
    await served.ready()
    const force = handle.forceClose
    if (typeof force !== "function") throw new Error("Node HTTP host omitted forceClose")
    await force.call(handle, new Error("force cleanup"))

    const failure = await (async function terminalFailure(): Promise<unknown> {
      try {
        await handle.done()
      } catch (error) {
        return error
      }
      throw new Error("expected force cleanup rejection")
    })()
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new Error("expected native AggregateError")
    expect(failure.errors).toEqual([idleFailure, allFailure])
    expect(Object.isFrozen(failure.errors)).toBeTrue()
  })

  test("contains synchronous native close failure until the real close event", async () => {
    const closeFailure = new Error("native close threw")
    const seam: { native: Server | null; close: Server["close"] | null } = {
      native: null,
      close: null
    }
    const host = newNodeHTTPHostWithFactory(function factory(listener): Server {
      const server = createServer(listener)
      seam.native = server
      seam.close = server.close.bind(server)
      Reflect.set(server, "close", function close(): never {
        throw closeFailure
      })
      return server
    })
    const handle = await host.bind(background(), "127.0.0.1:0", listenOptions)
    const address = handle.address()
    const closing = handle.close(background())
    expect(await remainsPending(closing)).toBeTrue()
    const active = seam.native
    const closeNative = seam.close
    if (active === null || closeNative === null)
      throw new Error("native close seam was not captured")
    Reflect.set(active, "close", closeNative)
    closeNative.call(active)

    await expect(closing).rejects.toBe(closeFailure)
    await expect(handle.done()).rejects.toBe(closeFailure)
    await expectPortReleased(address)
  })

  test("contains native listening inspection failures and still closes the real listener", async () => {
    const inspectionFailure = new Error("native listening inspection failed")
    const native: { current: Server | null } = { current: null }
    let failInspection = false
    const host = newNodeHTTPHostWithFactory(function factory(listener): Server {
      const server = createServer(listener)
      native.current = server
      return new Proxy(server, {
        get(target, property): unknown {
          if (property === "listening" && failInspection) throw inspectionFailure
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === "function" ? value.bind(target) : value
        }
      })
    })
    const handle = await host.bind(background(), "127.0.0.1:0", listenOptions)
    const address = handle.address()
    const server = native.current
    if (server === null) throw new Error("native server was not captured")
    try {
      failInspection = true
      const closing = handle.close(background())
      expect(closing).toBeInstanceOf(Promise)
      await expect(bounded(closing, "native listening inspection cleanup")).rejects.toBe(
        inspectionFailure
      )
      await expect(handle.done()).rejects.toBe(inspectionFailure)
      await expectPortReleased(address)
    } finally {
      failInspection = false
      if (server.listening) {
        await bounded(
          new Promise<void>(function close(resolve): void {
            server.close(function closed(): void {
              resolve()
            })
          }),
          "native listening inspection fallback cleanup"
        )
      }
    }
  })

  test("retries native close after close and listening reinspection both throw", async () => {
    const closeFailure = new Error("native retry close failed")
    const inspectionFailure = new Error("native retry listening inspection failed")
    const native: { current: Server | null } = { current: null }
    let failInspection = false
    let inspections = 0
    const host = newNodeHTTPHostWithFactory(function factory(listener): Server {
      const server = createServer(listener)
      native.current = server
      return new Proxy(server, {
        get(target, property): unknown {
          if (property === "listening" && failInspection) {
            inspections += 1
            if (inspections > 1) throw inspectionFailure
          }
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === "function" ? value.bind(target) : value
        }
      })
    })
    const handle = await host.bind(background(), "127.0.0.1:0", listenOptions)
    const address = handle.address()
    const server = native.current
    if (server === null) throw new Error("native server was not captured")
    const close = server.close
    try {
      failInspection = true
      Reflect.set(server, "close", function failedClose(): never {
        throw closeFailure
      })
      const first = handle.close(background())
      expect(first).toBeInstanceOf(Promise)
      failInspection = false
      Reflect.set(server, "close", close)
      const second = handle.close(background())
      const failure = await bounded(
        second.catch(function rejected(error: Error): Error {
          return error
        }),
        "native close retry"
      )
      expect(failure).toBeInstanceOf(AggregateError)
      if (!(failure instanceof AggregateError)) throw failure
      expect(Array.from(failure.errors)).toEqual([closeFailure, inspectionFailure])
      await expect(first).rejects.toBe(failure)
      await expect(handle.done()).rejects.toBe(failure)
      expect(server.listening).toBeFalse()
      await expectPortReleased(address)
    } finally {
      failInspection = false
      Reflect.set(server, "close", close)
      if (server.listening) {
        await bounded(
          new Promise<void>(function closeFallback(resolve): void {
            close(function closed(): void {
              resolve()
            })
          }),
          "native close retry fallback cleanup"
        )
      }
    }
  })

  test("contains active response destroy failure and continues force cleanup", async () => {
    const destroyFailure = new Error("active response destroy failed")
    const canceledBody = deferred<void>()
    const native: { current: Server | null } = { current: null }
    const host = newNodeHTTPHostWithFactory(function factory(listener): Server {
      const server = createServer(function intercept(request, response): void {
        Reflect.set(response, "destroy", function destroy(): never {
          throw destroyFailure
        })
        listener(request, response)
      })
      native.current = server
      return server
    })
    let handle: HTTPHostHandle | null = null
    try {
      handle = await host.bind(background(), "127.0.0.1:0", listenOptions)
      const address = handle.address()
      const served = handle.serve(background(), function dispatch(): Response {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller): void {
              controller.enqueue(new TextEncoder().encode("active"))
            },
            cancel(): void {
              canceledBody.resolve(undefined)
            }
          })
        )
      })
      await served.ready()
      const response = await bounded(fetch(url(address)), "active response admission")
      const force = handle.forceClose
      if (typeof force !== "function") throw new Error("Node HTTP host omitted forceClose")
      const forced = force.call(handle, new Error("force active response"))
      expect(forced).toBeInstanceOf(Promise)
      await forced
      await bounded(canceledBody.promise, "active response body cancellation")
      await expect(
        bounded(response.arrayBuffer(), "active response peer failure")
      ).rejects.toBeInstanceOf(Error)
      await expect(bounded(handle.done(), "active response force terminal")).rejects.toBe(
        destroyFailure
      )
      await expect(served.done()).rejects.toBe(destroyFailure)
      await expectPortReleased(address)
      handle = null
    } finally {
      await cleanup(handle)
      const server = native.current
      if (server !== null && server.listening) {
        await bounded(
          new Promise<void>(function close(resolve): void {
            server.close(function closed(): void {
              resolve()
            })
          }),
          "active response fallback cleanup"
        )
      }
    }
  })

  test("contains an active request force throw and continues socket cleanup", async () => {
    const forceFailure = new Error("active request force failed")
    const entered = deferred<void>()
    const release = deferred<void>()
    let handle: HTTPHostHandle | null = null
    const originalAbort = AbortController.prototype.abort
    try {
      handle = await newNodeHTTPHost().bind(background(), "127.0.0.1:0", listenOptions)
      const address = handle.address()
      const served = handle.serve(background(), async function dispatch(): Promise<Response> {
        entered.resolve(undefined)
        await release.promise
        return new Response("released")
      })
      await served.ready()
      const request = fetch(url(address))
      await bounded(entered.promise, "active request force admission")
      Reflect.set(AbortController.prototype, "abort", function abort(): never {
        throw forceFailure
      })
      const force = handle.forceClose
      if (typeof force !== "function") throw new Error("Node HTTP host omitted forceClose")
      const forced = force.call(handle, new Error("force active request"))
      expect(forced).toBeInstanceOf(Promise)
      await forced
      Reflect.set(AbortController.prototype, "abort", originalAbort)
      release.resolve(undefined)
      await request.catch(function expectedPeerFailure(): void {})
      await expect(bounded(handle.done(), "active request force terminal")).rejects.toBe(
        forceFailure
      )
      await expect(served.done()).rejects.toBe(forceFailure)
      await expectPortReleased(address)
      handle = null
    } finally {
      Reflect.set(AbortController.prototype, "abort", originalAbort)
      release.resolve(undefined)
      await cleanup(handle)
    }
  })

  test("contains a tracked socket destroy throw and still waits for real socket terminal", async () => {
    const destroyFailure = new Error("socket destroy threw")
    const seam: { socket: Socket | null; destroy: Socket["destroy"] | null } = {
      socket: null,
      destroy: null
    }
    const entered = deferred<void>()
    const release = deferred<void>()
    const host = newNodeHTTPHostWithFactory(function factory(listener): Server {
      const server = createServer(function intercept(request, response): void {
        Reflect.set(response, "destroy", function destroyResponse(): void {})
        listener(request, response)
      })
      server.on("connection", function captureSocket(connected): void {
        seam.socket = connected
        seam.destroy = connected.destroy.bind(connected)
        Reflect.set(connected, "destroy", function destroy(): never {
          throw destroyFailure
        })
      })
      Reflect.set(server, "closeAllConnections", function closeAllConnections(): void {})
      return server
    })
    const handle = await host.bind(background(), "127.0.0.1:0", listenOptions)
    const served = handle.serve(background(), async function dispatch(): Promise<Response> {
      entered.resolve(undefined)
      await release.promise
      return new Response("released")
    })
    await served.ready()
    const request = fetch(url(handle.address()))
    await entered.promise
    const force = handle.forceClose
    if (typeof force !== "function") throw new Error("Node HTTP host omitted forceClose")
    await force.call(handle, new Error("force idle socket"))
    expect(await remainsPending(handle.done())).toBeTrue()
    const active = seam.socket
    const destroyNative = seam.destroy
    if (active === null || destroyNative === null)
      throw new Error("socket destroy seam was not captured")
    Reflect.set(active, "destroy", destroyNative)
    destroyNative.call(active)
    release.resolve(undefined)
    try {
      await request
    } catch {}

    await expect(handle.done()).rejects.toBe(destroyFailure)
  })

  test("ignores late cleanup failures after true terminal and validates force reason", async () => {
    const lateFailure = new Error("late close all failed")
    const host = newNodeHTTPHostWithFactory(function factory(listener): Server {
      const server = createServer(listener)
      Reflect.set(server, "closeAllConnections", function closeAllConnections(): never {
        throw lateFailure
      })
      return server
    })
    const handle = await host.bind(background(), "127.0.0.1:0", listenOptions)
    const force = handle.forceClose
    if (typeof force !== "function") throw new Error("Node HTTP host omitted forceClose")
    await expect(force.call(handle, null as never)).rejects.toThrow(
      "Node HTTP force reason must be an Error"
    )
    await handle.close(background())
    await handle.done()
    await force.call(handle, lateFailure)
    await handle.done()
  })

  test("serve owner cancellation starts native graceful close", async () => {
    const handle = await newNodeHTTPHost().bind(background(), "127.0.0.1:0", listenOptions)
    const [ctx, cancel] = withCancelCause(background())
    const served = handle.serve(ctx, function dispatch(): Response {
      return new Response("unused")
    })
    await served.ready()
    cancel(new Error("serve owner canceled"))
    await served.done()
    await handle.done()
  })
})
