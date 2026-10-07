import { expect, test } from "bun:test"

import { newClient, withEndpoint, withTransport } from "@go-like/client"
import {
  background,
  canceled,
  cause,
  deadlineExceeded,
  withCancelCause,
  type Context
} from "@go-like/context"
import { newTokenBucketLimiter } from "@go-like/resilience"
import { struct } from "@go-like/struct"
import { endpoint, withTimeout, type Endpoint } from "@go-like/transport"
import type {
  Client,
  ListenOption,
  Listener,
  Options,
  Transport,
  TransportHandler
} from "@go-like/transport"
import { decodeServiceErrorResponse } from "@go-like/transport/provider"
import { newMemoryTransport } from "@go-like/transport-memory"

import {
  address,
  advertise,
  listenOption,
  middleware,
  newServer,
  rateLimitMiddleware,
  transport,
  use,
  type Handler,
  type Middleware
} from "../src/index"

/** Copies bytes into an ArrayBuffer accepted as a Fetch body. */
function copiedBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

/** Builds one internal RPC request. Content-Type is whatever the caller supplies. */
function rpcRequest(
  service: string,
  endpointName: string,
  body: Uint8Array | null = new Uint8Array(),
  headers: HeadersInit = { "content-type": "application/json" },
  method = "POST"
): Request {
  const init: RequestInit = { method, headers }
  if (body !== null) init.body = copiedBytes(body)
  return new Request(`http://127.0.0.1/${service}/${endpointName}`, init)
}

/** Creates one listener controlled by close. */
function fixtureListener(
  sent: Response[],
  requests: readonly Request[] = [rpcRequest("orders", "get", new Uint8Array([1]))],
  listenerAddress = "127.0.0.1:43210",
  onAccept: (() => void) | null = null
): Listener {
  let resolveDone: (() => void) | null = null
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  return {
    addr(): string {
      return listenerAddress
    },
    async close(): Promise<void> {
      resolveDone?.()
    },
    async serve(ctx: Context, handler: TransportHandler): Promise<void> {
      onAccept?.()
      for (const request of requests) {
        sent.push(await handler(ctx, request))
      }
      await done
    }
  }
}

/** Records one middleware's nesting around a routed handler. */
function recordingMiddleware(name: string, events: string[]): Middleware {
  return (next) => async (ctx, request) => {
    events.push(`${name}:before`)
    const response = await next(ctx, request)
    events.push(`${name}:after`)
    return response
  }
}

/** Creates one structural transport around listener. */
function fixtureTransport(listener: Listener, kind = "http", tls = false): Transport {
  return {
    kind(): string {
      return kind
    },
    init(): void {},
    options(): Options {
      return Object.freeze({
        logger: null,
        timeoutMs: 0,
        secure: false,
        tlsConfig: tls
          ? {
              serverName: null,
              caCertificate: null,
              certificateChain: null,
              privateKey: null
            }
          : null
      })
    },
    dial(): Promise<Client> {
      return Promise.reject(new Error("unused"))
    },
    listen(): Promise<Listener> {
      return Promise.resolve(listener)
    },
    string(): string {
      return "fixture"
    }
  }
}

/** Exchanges one internal unary request through a real transport Client. */
async function exchange(client: Client, service: string, endpointName: string): Promise<Response> {
  return await client.fetch(
    background(),
    rpcRequest(service, endpointName, new Uint8Array(), { "content-type": "application/json" })
  )
}

test("routes one unary exchange and blocks until stop", async () => {
  const sent: Response[] = []
  const server = newServer(
    transport(fixtureTransport(fixtureListener(sent))),
    address("127.0.0.1:0"),
    middleware((next) => async (ctx, request) => next(ctx, request))
  )
  server.registerHandler("orders", "get", (_ctx, request) => new Response(request.body))

  const running = server.start(background())
  await Promise.resolve()
  await Promise.resolve()
  await expect(server.endpoint(background())).resolves.toBe("http://127.0.0.1:43210/")
  await server.stop(background())
  await running
  expect(sent).toHaveLength(1)
  expect(new Uint8Array(await sent[0]!.arrayBuffer())).toEqual(new Uint8Array([1]))
})

test("constructs without handlers and serves a typed registration", async () => {
  const NumberValue = struct.number()
  const operation = endpoint("calculator", "increment", NumberValue, NumberValue)
  const sent: Response[] = []
  const accepting = Promise.withResolvers<void>()
  const server = newServer(
    transport(
      fixtureTransport(
        fixtureListener(
          sent,
          [
            rpcRequest("calculator", "increment", new TextEncoder().encode("1"), {
              "content-type": "Application/JSON; charset=utf-8"
            }),
            rpcRequest("calculator", "increment", new TextEncoder().encode("2"), {}),
            rpcRequest("calculator", "increment", new TextEncoder().encode("9"), {
              "Content-Type": "application/json"
            })
          ],
          "127.0.0.1:43210",
          accepting.resolve
        )
      )
    )
  )
  server.registerHandler(operation, (_ctx, request) =>
    request === 9 ? ("invalid" as never) : request + 1
  )

  const running = server.start(background())
  await accepting.promise
  await server.stop(background())
  await running

  expect(sent[0]?.status).toBe(200)
  expect(sent[0]?.headers.get("content-type")).toBe("application/json")
  expect(new TextDecoder().decode(await sent[0]!.arrayBuffer())).toBe("2")
  const invalidRequest = sent[1]
  const invalidResponse = sent[2]
  if (invalidRequest === undefined || invalidResponse === undefined) {
    throw new Error("typed server responses are missing")
  }
  expect(await decodeServiceErrorResponse(invalidRequest)).toMatchObject({
    code: "invalid_request",
    status: 400
  })
  expect(await decodeServiceErrorResponse(invalidResponse)).toMatchObject({
    code: "internal",
    status: 500
  })
})

test("preserves a class receiver through typed service registration glue", async () => {
  const NumberValue = struct.number()
  const operation = endpoint("calculator", "increment", NumberValue, NumberValue)
  class Calculator {
    constructor(private readonly amount: number) {}

    increment(_ctx: Context, request: number): number {
      return request + this.amount
    }
  }
  const implementation = new Calculator(2)
  const sent: Response[] = []
  const accepting = Promise.withResolvers<void>()
  const server = newServer(
    transport(
      fixtureTransport(
        fixtureListener(
          sent,
          [
            rpcRequest("calculator", "increment", new TextEncoder().encode("1"), {
              "Content-Type": "application/json"
            })
          ],
          "127.0.0.1:43210",
          accepting.resolve
        )
      )
    )
  )
  server.registerHandler(operation, (ctx, request) => implementation.increment(ctx, request))

  const running = server.start(background())
  await accepting.promise
  await server.stop(background())
  await running

  expect(sent[0]?.status).toBe(200)
  expect(sent[0]?.headers.get("content-type")).toBe("application/json")
  expect(new TextDecoder().decode(await sent[0]!.arrayBuffer())).toBe("3")
})

test("rejects malformed typed request metadata and handler values", async () => {
  const operation = endpoint("calculator", "increment", struct.literal(2), struct.number())
  const invalidServer = newServer(transport(fixtureTransport(fixtureListener([]))))
  expect(() =>
    Reflect.apply(invalidServer.registerHandler, invalidServer, [operation, "invalid"])
  ).toThrow("server typed handler must be a function")

  const sent: Response[] = []
  const accepting = Promise.withResolvers<void>()
  const server = newServer(
    transport(
      fixtureTransport(
        fixtureListener(
          sent,
          [
            rpcRequest("calculator", "increment", new TextEncoder().encode("1"), {
              "Content-Type": "application/json",
              "content-type": "application/json"
            }),
            rpcRequest("calculator", "increment", new TextEncoder().encode("1"), {
              "Content-Type": "application/json"
            })
          ],
          "127.0.0.1:43210",
          accepting.resolve
        )
      )
    )
  )
  server.registerHandler(operation, (_ctx, request) => request)
  const running = server.start(background())
  await accepting.promise
  await server.stop(background())
  await running

  for (const response of sent) {
    expect(await decodeServiceErrorResponse(response)).toMatchObject({
      code: "invalid_request",
      status: 400
    })
  }
})

test("rejects an empty endpoint seal before listen", async () => {
  let listens = 0
  const base = fixtureTransport(fixtureListener([]))
  const server = newServer(
    transport({
      ...base,
      listen(ctx, value, ...options) {
        listens += 1
        return base.listen(ctx, value, ...options)
      }
    })
  )

  const sealing = expect(server.endpoint(background())).rejects.toThrow(
    "server requires at least one registered handler"
  )
  expect(() =>
    server.registerHandler("orders", "late", (_ctx, request) => new Response(request.body))
  ).toThrow("server registration is sealed")
  await sealing
  expect(listens).toBe(0)
})

test("rejects an empty direct start before listen", async () => {
  let listens = 0
  const base = fixtureTransport(fixtureListener([]))
  const server = newServer(
    transport({
      ...base,
      listen(ctx, value, ...options) {
        listens += 1
        return base.listen(ctx, value, ...options)
      }
    })
  )

  await expect(server.start(background())).rejects.toThrow(
    "server requires at least one registered handler"
  )
  expect(listens).toBe(0)
})

test("rejects typed and raw duplicate registrations synchronously", () => {
  const NumberValue = struct.number()
  const operation = endpoint("calculator", "increment", NumberValue, NumberValue)
  const raw: Handler = (_ctx, request) => new Response(request.body)

  const typedFirst = newServer(transport(fixtureTransport(fixtureListener([]))))
  typedFirst.registerHandler(operation, (_ctx, request) => request + 1)
  expect(() => typedFirst.registerHandler("calculator", "increment", raw)).toThrow(
    "server handler is duplicated: calculator/increment"
  )

  const rawFirst = newServer(transport(fixtureTransport(fixtureListener([]))))
  rawFirst.registerHandler("calculator", "increment", raw)
  expect(() => rawFirst.registerHandler(operation, (_ctx, request) => request + 1)).toThrow(
    "server handler is duplicated: calculator/increment"
  )
})

test("endpoint seals registration while its bind is pending", async () => {
  const listener = fixtureListener([])
  const deferred = Promise.withResolvers<Listener>()
  const base = fixtureTransport(listener)
  const server = newServer(
    transport({
      ...base,
      listen: () => deferred.promise
    })
  )
  server.registerHandler("orders", "get", (_ctx, request) => new Response(request.body))

  const pending = server.endpoint(background())
  expect(() =>
    server.registerHandler("orders", "late", (_ctx, request) => new Response(request.body))
  ).toThrow("server registration is sealed")
  deferred.resolve(listener)
  await expect(pending).resolves.toBe("http://127.0.0.1:43210/")
  await server.stop(background())
})

test("start seals registration while its bind is pending", async () => {
  const listener = fixtureListener([])
  const deferred = Promise.withResolvers<Listener>()
  const base = fixtureTransport(listener)
  const server = newServer(
    transport({
      ...base,
      listen: () => deferred.promise
    })
  )
  server.registerHandler("orders", "get", (_ctx, request) => new Response(request.body))

  const running = server.start(background())
  expect(() =>
    server.registerHandler("orders", "late", (_ctx, request) => new Response(request.body))
  ).toThrow("server registration is sealed")
  deferred.resolve(listener)
  await Promise.resolve()
  await server.stop(background())
  await running
})

test("a failed bind leaves registration sealed", async () => {
  const failure = new Error("bind failed")
  const base = fixtureTransport(fixtureListener([]))
  const server = newServer(
    transport({
      ...base,
      listen: () => Promise.reject(failure)
    })
  )
  server.registerHandler("orders", "get", (_ctx, request) => new Response(request.body))

  await expect(server.endpoint(background())).rejects.toBe(failure)
  expect(() =>
    server.registerHandler("orders", "late", (_ctx, request) => new Response(request.body))
  ).toThrow("server registration is sealed")
})

test("shares one composed dispatcher and bind between concurrent endpoint and start", async () => {
  let listens = 0
  let compositions = 0
  const sent: Response[] = []
  const accepting = Promise.withResolvers<void>()
  const listener = fixtureListener(sent, undefined, "127.0.0.1:43210", accepting.resolve)
  const deferred = Promise.withResolvers<Listener>()
  const base = fixtureTransport(listener)
  const transportValue: Transport = {
    ...base,
    listen() {
      listens += 1
      return deferred.promise
    }
  }
  const server = newServer(
    transport(transportValue),
    middleware((next) => {
      compositions += 1
      return (ctx, request) => next(ctx, request)
    })
  )
  server.registerHandler("orders", "get", (_ctx, request) => new Response(request.body))

  const advertised = server.endpoint(background())
  const running = server.start(background())
  expect(listens).toBe(1)
  expect(compositions).toBe(1)
  deferred.resolve(listener)
  await expect(advertised).resolves.toBe("http://127.0.0.1:43210/")
  await accepting.promise
  await server.stop(background())
  await running
  expect(sent).toHaveLength(1)
  expect(new Uint8Array(await sent[0]!.arrayBuffer())).toEqual(new Uint8Array([1]))
})

test.each([
  ["undefined", undefined],
  ["a frozen non-Error object", Object.freeze({ code: "middleware composition failed" })]
] as const)(
  "caches %s middleware composition failure across lifecycle calls",
  async (_label, reason) => {
    let compositions = 0
    let listens = 0
    const base = fixtureTransport(fixtureListener([]))
    const server = newServer(
      transport({
        ...base,
        listen(ctx, value, ...options) {
          listens += 1
          return base.listen(ctx, value, ...options)
        }
      }),
      middleware(() => {
        compositions += 1
        throw reason
      })
    )
    server.registerHandler("orders", "get", (_ctx, request) => new Response(request.body))

    const endpointOutcome = Promise.allSettled([server.endpoint(background())])
    expect(() =>
      server.registerHandler("orders", "late", (_ctx, request) => new Response(request.body))
    ).toThrow("server registration is sealed")
    const startOutcome = Promise.allSettled([server.start(background())])
    const [[endpointResult], [startResult]] = await Promise.all([endpointOutcome, startOutcome])
    if (endpointResult.status !== "rejected" || startResult.status !== "rejected") {
      throw new Error("endpoint and start must reject a cached composition failure")
    }
    expect(endpointResult.reason).toBe(reason)
    expect(startResult.reason).toBe(reason)
    expect(compositions).toBe(1)
    expect(listens).toBe(0)
  }
)

test("stop owns an in-flight bind and closes the late listener once without accepting", async () => {
  const deferred = Promise.withResolvers<Listener>()
  let accepts = 0
  let closes = 0
  const lateListener: Listener = {
    /** Returns the late bind result. */
    addr(): string {
      return "127.0.0.1:43210"
    },
    /** Records the forbidden post-stop serve. */
    serve(): Promise<void> {
      accepts += 1
      return Promise.resolve()
    },
    /** Records the single owner close. */
    close(): Promise<void> {
      closes += 1
      return Promise.resolve()
    }
  }
  const base = fixtureTransport(lateListener)
  const transportValue: Transport = {
    ...base,
    listen(): Promise<Listener> {
      return deferred.promise
    }
  }
  const server = newServer(transport(transportValue))
  server.registerHandler("orders", "get", (_ctx, request) => new Response(request.body))

  const running = server.start(background())
  await Promise.resolve()
  const firstStop = server.stop(background())
  const secondStop = server.stop(background())
  deferred.resolve(lateListener)

  await Promise.all([firstStop, secondStop, running])
  expect(closes).toBe(1)
  expect(accepts).toBe(0)
})

test("settles start cleanly when stop cancels a cancellation-aware bind", async () => {
  const bound = Promise.withResolvers<void>()
  const base = fixtureTransport(fixtureListener([]))
  const transportValue: Transport = {
    ...base,
    listen(ctx): Promise<Listener> {
      const signal = ctx.done()
      if (signal === null) throw new Error("bind owner Context must be cancelable")
      bound.resolve()
      return new Promise<Listener>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(cause(ctx) ?? ctx.err()), { once: true })
      })
    }
  }
  const server = newServer(transport(transportValue))
  server.registerHandler("orders", "get", (_ctx, request) => new Response(request.body))
  const running = server.start(background())
  void running.catch(() => {})
  await bound.promise

  await expect(server.stop(background())).resolves.toBeUndefined()
  await expect(running).resolves.toBeUndefined()
})

test("preserves an external bind failure that races stop", async () => {
  const failure = new Error("transport bind failed")
  const deferred = Promise.withResolvers<Listener>()
  const base = fixtureTransport(fixtureListener([]))
  const server = newServer(
    transport({
      ...base,
      listen(): Promise<Listener> {
        return deferred.promise
      }
    })
  )
  server.registerHandler("orders", "get", (_ctx, request) => new Response(request.body))
  const running = server.start(background())
  void running.catch(() => {})
  await Promise.resolve()
  const stopping = server.stop(background())
  void stopping.catch(() => {})
  deferred.reject(failure)

  await expect(running).rejects.toBe(failure)
  await expect(stopping).rejects.toBe(failure)
})

test("keeps a shared bind alive when one endpoint waiter cancels", async () => {
  const admitted = Promise.withResolvers<Listener>()
  const accepted = Promise.withResolvers<void>()
  const stopped = Promise.withResolvers<void>()
  const bound = Promise.withResolvers<Context>()
  const listener: Listener = {
    addr(): string {
      return "127.0.0.1:43210"
    },
    async serve(): Promise<void> {
      accepted.resolve()
      await stopped.promise
    },
    async close(): Promise<void> {
      stopped.resolve()
    }
  }
  const base = fixtureTransport(listener)
  const transportValue: Transport = {
    ...base,
    listen(ctx): Promise<Listener> {
      bound.resolve(ctx)
      const signal = ctx.done()
      if (signal === null) return admitted.promise
      return new Promise<Listener>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(cause(ctx) ?? ctx.err()), { once: true })
        void admitted.promise.then(resolve, reject)
      })
    }
  }
  const server = newServer(transport(transportValue))
  server.registerHandler("orders", "get", (_ctx, request) => new Response(request.body))
  const [caller, cancel] = withCancelCause(background())
  const cancellation = new Error("endpoint waiter canceled")
  const endpoint = server.endpoint(caller)
  const bindContext = await bound.promise

  cancel(cancellation)
  await expect(endpoint).rejects.toBe(cancellation)
  expect(bindContext.err()).toBeNull()

  const running = server.start(background())
  admitted.resolve(listener)
  await accepted.promise
  await server.stop(background())
  await running
})

test("starts one owner close when the first stop caller is already canceled", async () => {
  const shutdown = Promise.withResolvers<void>()
  const closeContexts: Context[] = []
  let closes = 0
  const listener: Listener = {
    /** Returns the bound fixture address. */
    addr(): string {
      return "127.0.0.1:43210"
    },
    /** Keeps the unused serve loop pending. */
    serve(): Promise<void> {
      return new Promise(() => {})
    },
    /** Records and delays the single owner-scoped close. */
    async close(ctx): Promise<void> {
      closes += 1
      closeContexts.push(ctx)
      await shutdown.promise
    }
  }
  const server = newServer(transport(fixtureTransport(listener)))
  server.registerHandler("orders", "get", (_ctx, request) => new Response(request.body))
  await server.endpoint(background())
  const [caller, cancel] = withCancelCause(background())
  const reason = new Error("stop caller canceled")
  cancel(reason)

  await expect(server.stop(caller)).rejects.toBe(reason)
  expect(closes).toBe(1)
  expect(closeContexts[0]?.err()).toBeNull()
  let joined = false
  const second = server.stop(background()).then(function observeJoin() {
    joined = true
  })
  await Promise.resolve()
  expect(joined).toBe(false)
  shutdown.resolve()
  await second
  expect(closes).toBe(1)
})

test("closes once after start Context cancellation ends accept", async () => {
  const accepting = Promise.withResolvers<void>()
  const shutdown = Promise.withResolvers<void>()
  const closeContexts: Context[] = []
  let closes = 0
  const listener: Listener = {
    /** Returns the bound fixture address. */
    addr(): string {
      return "127.0.0.1:43210"
    },
    /** Ends serve when the Server start Context is canceled. */
    async serve(ctx): Promise<void> {
      accepting.resolve()
      const signal = ctx.done()
      if (signal === null) throw new Error("start Context must be cancelable")
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true })
      })
    },
    /** Records and delays the single owner-scoped close. */
    async close(ctx): Promise<void> {
      closes += 1
      closeContexts.push(ctx)
      await shutdown.promise
    }
  }
  const server = newServer(transport(fixtureTransport(listener)))
  server.registerHandler("orders", "get", (_ctx, request) => new Response(request.body))
  const [startContext, cancelStart] = withCancelCause(background())
  const running = server.start(startContext)
  await accepting.promise
  cancelStart(new Error("start canceled"))
  await running

  const [caller, cancelCaller] = withCancelCause(background())
  const reason = new Error("stop caller canceled")
  cancelCaller(reason)
  await expect(server.stop(caller)).rejects.toBe(reason)
  expect(closes).toBe(1)
  expect(closeContexts[0]?.err()).toBeNull()

  let joined = false
  const second = server.stop(background()).then(function observeJoin() {
    joined = true
  })
  await Promise.resolve()
  expect(joined).toBe(false)
  shutdown.resolve()
  await second
  expect(closes).toBe(1)
})

test("separates bind and advertise while preserving the actual bound port", async () => {
  const server = newServer(
    transport(fixtureTransport(fixtureListener([], [], "0.0.0.0:43210"))),
    address("0.0.0.0:0"),
    advertise("orders.internal")
  )
  server.registerHandler("orders", "get", (_ctx, request) => new Response(request.body))

  expect(server.options().address).toBe("0.0.0.0:0")
  expect(server.options().advertise).toBe("orders.internal")
  await expect(server.endpoint(background())).resolves.toBe("http://orders.internal:43210/")
  await server.stop(background())
})

test("accepts an explicit advertise address or absolute endpoint", async () => {
  for (const [selected, expected] of [
    ["orders.internal:8443", "http://orders.internal:8443/"],
    ["https://orders.example/rpc", "https://orders.example/rpc"],
    ["https://orders.example/rpc?", "https://orders.example/rpc?"]
  ] as const) {
    const server = newServer(
      transport(fixtureTransport(fixtureListener([], [], "0.0.0.0:43210"))),
      advertise(selected)
    )
    server.registerHandler("orders", "get", (_ctx, request) => new Response(request.body))
    await expect(server.endpoint(background())).resolves.toBe(expected)
    await server.stop(background())
  }
})

test("requires an explicit usable advertise value for wildcard binds", async () => {
  for (const listenerAddress of ["0.0.0.0:43210", "[::]:43210"]) {
    const server = newServer(transport(fixtureTransport(fixtureListener([], [], listenerAddress))))
    server.registerHandler("orders", "get", (_ctx, request) => new Response(request.body))
    await expect(server.endpoint(background())).rejects.toThrow("requires explicit advertise")
    await server.stop(background())
  }

  const server = newServer(
    transport(fixtureTransport(fixtureListener([], [], "127.0.0.1:43210"))),
    advertise("0.0.0.0")
  )
  server.registerHandler("orders", "get", (_ctx, request) => new Response(request.body))
  await expect(server.endpoint(background())).rejects.toThrow(
    "advertise must not use a wildcard host"
  )
  await server.stop(background())
})

test("advertises a TLS-configured HTTP authority with its real HTTPS scheme", async () => {
  const server = newServer(transport(fixtureTransport(fixtureListener([]), "http", true)))
  server.registerHandler("orders", "get", (_ctx, request) => new Response(request.body))

  await expect(server.endpoint(background())).resolves.toBe("https://127.0.0.1:43210/")
  await server.stop(background())
})

test("forwards listen options and exposes the construction snapshot", async () => {
  const listener = fixtureListener([])
  const base = fixtureTransport(listener)
  const received: ListenOption[] = []
  const option: ListenOption = (options) => options
  const transportValue: Transport = {
    ...base,
    listen(ctx, value, ...options) {
      received.push(...options)
      return base.listen(ctx, value, ...options)
    }
  }
  const server = newServer(transport(transportValue), listenOption(option))
  server.registerHandler("orders", "get", (_ctx, request) => new Response(request.body))

  expect(server.options().listenOptions).toEqual([option])
  expect(server.string()).toBe("server")
  await expect(server.endpoint(background())).resolves.toBe("http://127.0.0.1:43210/")
  expect(received).toEqual([option])
  await server.stop(background())
})

test("keeps routing state isolated from returned option snapshots", async () => {
  const sent: Response[] = []
  const events: string[] = []
  const accepting = Promise.withResolvers<void>()
  const operation: Handler = (_ctx, request) => {
    events.push("handler")
    return new Response(request.body)
  }
  const selectedMiddleware = recordingMiddleware("operation", events)
  const server = newServer(
    transport(
      fixtureTransport(fixtureListener(sent, undefined, "127.0.0.1:43210", accepting.resolve))
    ),
    use("orders/get", selectedMiddleware)
  )
  server.registerHandler("orders", "get", operation)

  const exposed = server.options()
  Reflect.apply(Map.prototype.clear, exposed.operationMiddleware, [])

  expect(server.options().operationMiddleware.get("orders/get")).toEqual([selectedMiddleware])
  expect(Object.isFrozen(server.options().operationMiddleware.get("orders/get"))).toBe(true)

  const running = server.start(background())
  await accepting.promise
  await server.stop(background())
  await running

  expect(sent).toHaveLength(1)
  expect(events).toEqual(["operation:before", "handler", "operation:after"])
})

test("encodes routing and handler failures without leaking internal errors", async () => {
  const cases: readonly [Request, string, number][] = [
    [new Request("http://127.0.0.1/", { method: "POST" }), "not_found", 404],
    [new Request("http://127.0.0.1/orders/get*", { method: "POST" }), "not_found", 404],
    [new Request("http://127.0.0.1/%E8%AE%A2%E5%8D%95/get", { method: "POST" }), "not_found", 404],
    [
      rpcRequest("inventory", "get", new Uint8Array(), { "content-type": "application/json" }),
      "not_found",
      404
    ],
    [
      rpcRequest("orders", "get", new Uint8Array(), { "content-type": "text/plain" }),
      "invalid_request",
      400
    ],
    [
      rpcRequest("orders", "get", new Uint8Array(), {
        "content-type": "application/json",
        "Go-Like-Metadata": "invalid"
      }),
      "invalid_metadata",
      400
    ],
    [
      rpcRequest("orders", "get", new Uint8Array(), {
        "content-type": "application/json",
        "Go-Like-Timeout-Ms": "nope"
      }),
      "invalid_request",
      400
    ],
    [
      rpcRequest("orders", "missing", new Uint8Array(), { "Go-Like-Timeout-Ms": "-1" }),
      "invalid_request",
      400
    ],
    [
      rpcRequest("orders", "get", new Uint8Array(), {
        "content-type": "application/json",
        "Go-Like-Timeout-Ms": "99999999999999999999"
      }),
      "invalid_request",
      400
    ],
    [
      new Request("http://127.0.0.1/orders/get", {
        method: "GET",
        headers: { "content-type": "application/json" }
      }),
      "method_not_allowed",
      405
    ],
    [
      rpcRequest("orders", "get", new Uint8Array(), { "content-type": "application/json" }),
      "internal",
      500
    ]
  ]

  for (const [request, code, status] of cases) {
    const sent: Response[] = []
    const accepting = Promise.withResolvers<void>()
    const server = newServer(
      transport(
        fixtureTransport(fixtureListener(sent, [request], "127.0.0.1:43210", accepting.resolve))
      )
    )
    server.registerHandler("orders", "get", () => {
      throw new Error("secret")
    })
    const running = server.start(background())
    await accepting.promise
    await server.stop(background())
    await running
    const response = sent[0]
    if (response === undefined) throw new Error("server omitted its failure response")
    const failure = await decodeServiceErrorResponse(response.clone())
    expect(response.status).toBe(status)
    expect(failure?.code).toBe(code)
    expect(failure?.status).toBe(status)
    expect(failure?.message).not.toContain("secret")
    if (code === "method_not_allowed") expect(response.headers.get("allow")).toBe("POST")
  }
})

test("cancels the handler context immediately when Go-Like-Timeout-Ms is zero", async () => {
  let seen = null as Error | null
  const sent: Response[] = []
  const accepting = Promise.withResolvers<void>()
  const server = newServer(
    transport(
      fixtureTransport(
        fixtureListener(
          sent,
          [
            rpcRequest("orders", "get", new Uint8Array(), {
              "content-type": "application/json",
              "Go-Like-Timeout-Ms": "0"
            })
          ],
          "127.0.0.1:43210",
          accepting.resolve
        )
      )
    )
  )
  server.registerHandler("orders", "get", (ctx) => {
    seen = ctx.err()
    return new Response(null, { status: 204 })
  })
  const running = server.start(background())
  await accepting.promise
  await server.stop(background())
  await running
  expect(seen).toBe(deadlineExceeded)
  expect(sent[0]?.status).toBe(204)
})

test("validates server construction and raw registrations", () => {
  expect(() => newServer()).toThrow("server transport is required")
  expect(() => address("")).toThrow("server address must be a non-empty string")
  expect(() => advertise("")).toThrow("server advertise must be a non-empty string")
  for (const value of ["[::1", "orders.internal/path", "orders.internal?", "orders.internal#"]) {
    expect(() => advertise(value)).toThrow(
      "server advertise must be an absolute endpoint, host, or host:port"
    )
  }
  for (const value of [
    "http://user:secret@orders.internal/rpc",
    "http://orders.internal/rpc#private",
    "http://orders.internal/rpc#"
  ]) {
    expect(() => advertise(value)).toThrow(
      "server advertise endpoint must not contain credentials or a fragment"
    )
  }
  const registrationServer = newServer(transport(fixtureTransport(fixtureListener([]))))
  expect(() =>
    registrationServer.registerHandler(
      "",
      "get",
      async (_ctx, request) => new Response(request.body)
    )
  ).toThrow("server service must be a URL unreserved route token")
  expect(() =>
    registrationServer.registerHandler(
      "orders",
      "",
      async (_ctx, request) => new Response(request.body)
    )
  ).toThrow("server endpoint must be a URL unreserved route token")
  for (const [service, endpoint] of [
    ["a/b", "c"],
    ["a", "b/c"],
    ["a*", "c"],
    ["a", "b*"],
    ["a\u0000", "c"],
    ["a", "b\u001f"],
    ["a\u007f", "c"],
    ["a", "\ud800"],
    ["a", "\udfff"],
    [" a", "c"],
    ["a ", "c"],
    ["a", "b c"],
    ["订单", "c"],
    ["a", "é"],
    ["a", "😀"],
    ["a!", "c"]
  ] as const) {
    expect(() =>
      registrationServer.registerHandler(
        service,
        endpoint,
        async (_ctx, request) => new Response(request.body)
      )
    ).toThrow("route token")
  }
  expect(() =>
    registrationServer.registerHandler("orders.v1", "pay_now~1-ok", async () => new Response(null))
  ).not.toThrow()
  expect(() => transport({} as never)).toThrow("server transport must implement Transport")
  expect(() => listenOption(null as never)).toThrow("server listen option must be a function")
  expect(() =>
    newServer(transport(fixtureTransport(fixtureListener([]))), (options) => ({
      address: options.address,
      advertise: options.advertise,
      transport: options.transport,
      middleware: options.middleware,
      operationMiddleware: options.operationMiddleware,
      listenOptions: [null as never],
      httpRoutes: options.httpRoutes,
      streamKeepAliveMs: options.streamKeepAliveMs,
      maxSendMessageBytes: options.maxSendMessageBytes
    }))
  ).toThrow("server listen option must be a function")
})

test("registerHandlers writes every endpoint only after the whole list validates", async () => {
  const request = struct.number()
  const response = struct.number()
  const keep = endpoint("catalog", "keep", request, response)
  const add = endpoint("catalog", "add", request, response)
  const watch = endpoint("catalog", "watch", request, response, true)
  const other = endpoint("inventory", "get", request, response)
  const unary = (): number => 1
  const stream = async function* (): AsyncGenerator<number> {
    yield 1
  }

  /** Binds the batch registrar without assuming it already exists on the type. */
  function batchOf(server: ReturnType<typeof newServer>): (
    handlers: readonly {
      readonly endpoint: Endpoint
      readonly handler: (ctx: Context, request: unknown) => unknown
    }[]
  ) => void {
    const candidate: unknown = Reflect.get(server, "registerHandlers")
    if (typeof candidate !== "function") {
      throw new TypeError("server registerHandlers is missing")
    }
    return candidate.bind(server) as (
      handlers: readonly {
        readonly endpoint: Endpoint
        readonly handler: (ctx: Context, request: unknown) => unknown
      }[]
    ) => void
  }

  const server = newServer(transport(fixtureTransport(fixtureListener([]))))
  const batch = batchOf(server)
  server.registerHandler(keep, unary)
  expect(() =>
    batch([
      { endpoint: add, handler: unary },
      { endpoint: keep, handler: unary }
    ])
  ).toThrow("server handler is duplicated: catalog/keep")
  server.registerHandler(add, unary)
  expect(() => server.registerHandler(keep, unary)).toThrow(
    "server handler is duplicated: catalog/keep"
  )

  const fresh = newServer(transport(fixtureTransport(fixtureListener([]))))
  expect(() =>
    batchOf(fresh)([
      { endpoint: add, handler: unary },
      { endpoint: add, handler: unary }
    ])
  ).toThrow("server handler is duplicated: catalog/add")
  fresh.registerHandler(add, unary)

  const invalid = newServer(transport(fixtureTransport(fixtureListener([]))))
  const invalidBatch = batchOf(invalid)
  expect(() =>
    invalidBatch([
      { endpoint: add, handler: unary },
      {
        endpoint: {
          service: "bad/name",
          endpoint: "add",
          request,
          response,
          stream: false
        },
        handler: unary
      }
    ])
  ).toThrow("route token")
  invalid.registerHandler(add, unary)
  expect(() =>
    invalidBatch([
      { endpoint: other, handler: unary },
      {
        endpoint: {
          service: "inventory",
          endpoint: "broken",
          request: {},
          response,
          stream: false
        } as never,
        handler: unary
      }
    ])
  ).toThrow("must be a Struct")
  invalid.registerHandler(other, unary)
  expect(() => invalidBatch(null as never)).toThrow("server handler registrations must be an array")
  expect(() => invalidBatch([{ endpoint: watch, handler: "no" as never }])).toThrow(
    "server typed handler must be a function"
  )
  expect(() => invalidBatch([null as never])).toThrow(
    "server handler registration must be an object"
  )
  expect(() => invalidBatch([{ endpoint: "catalog", handler: unary } as never])).toThrow(
    "server handler registration endpoint must be an object"
  )
  expect(() => invalid.registerHandler(watch, stream)).not.toThrow()

  const open = newServer(transport(fixtureTransport(fixtureListener([]))))
  open.registerHandler(keep, unary)
  batchOf(open)([
    { endpoint: add, handler: unary },
    { endpoint: watch, handler: stream },
    { endpoint: other, handler: unary }
  ])
  expect(() => open.registerHandler(add, unary)).toThrow("duplicated")
  expect(() => open.registerHandler(watch, stream)).toThrow("duplicated")
  expect(() => open.registerHandler(other, unary)).toThrow("duplicated")
  expect(() => open.registerHandler("catalog", "extra", () => new Response(null))).not.toThrow()

  const sealed = newServer(transport(fixtureTransport(fixtureListener([]))))
  sealed.registerHandler(keep, unary)
  const pending = sealed.endpoint(background())
  expect(() => batchOf(sealed)([{ endpoint: add, handler: unary }])).toThrow(
    "server registration is sealed"
  )
  await pending
  expect(() => sealed.registerHandler(add, unary)).toThrow("server registration is sealed")
  await sealed.stop(background())
})

test("registerHandlers does not overwrite a handler committed by a reentrant getter", async () => {
  const dto = struct.object({ n: struct.number() })
  const first = endpoint("reentry", "first", dto, dto)
  const second = endpoint("reentry", "second", dto, dto)
  const outer = (_ctx: Context, request: unknown): { n: number } => ({
    n: (request as { n: number }).n + 1
  })
  const memory = newMemoryTransport()
  const url = "memory://reentry-overwrite"
  const server = newServer(transport(memory), address(url))
  const batch: {
    readonly endpoint: Endpoint
    readonly handler: (ctx: Context, request: unknown) => unknown
  }[] = [
    { endpoint: first, handler: outer },
    {
      get endpoint(): Endpoint {
        server.registerHandler(first, () => ({ n: 99 }))
        return second
      },
      handler: outer
    }
  ]

  expect(() => server.registerHandlers(batch)).toThrow(
    "server handler is duplicated: reentry/first"
  )

  const running = server.start(background())
  await server.endpoint(background())
  const conn = newClient(withTransport(memory), withEndpoint(url))
  try {
    await expect(conn.call(background(), first, { n: 1 })).resolves.toEqual({ n: 99 })
    await expect(conn.call(background(), second, { n: 1 })).rejects.toThrow(
      "unknown service endpoint: reentry/second"
    )
  } finally {
    await conn.close(background())
    await server.stop(background())
    await running
  }
})

test("registerHandlers rejects the batch when a getter seals the server", async () => {
  const dto = struct.object({ n: struct.number() })
  const keep = endpoint("reentry", "keep", dto, dto)
  const first = endpoint("reentry", "first", dto, dto)
  const second = endpoint("reentry", "second", dto, dto)
  const unary = (_ctx: Context, request: unknown): { n: number } => ({
    n: (request as { n: number }).n + 1
  })
  const memory = newMemoryTransport()
  const url = "memory://reentry-seal"
  const server = newServer(transport(memory), address(url))
  server.registerHandler(keep, unary)
  let pending: Promise<string> | undefined
  const batch: {
    readonly endpoint: Endpoint
    readonly handler: (ctx: Context, request: unknown) => unknown
  }[] = [
    { endpoint: first, handler: unary },
    {
      get endpoint(): Endpoint {
        pending = server.endpoint(background())
        return second
      },
      handler: unary
    }
  ]

  expect(() => server.registerHandlers(batch)).toThrow("server registration is sealed")
  await pending

  const running = server.start(background())
  await server.endpoint(background())
  const conn = newClient(withTransport(memory), withEndpoint(url))
  try {
    await expect(conn.call(background(), keep, { n: 2 })).resolves.toEqual({ n: 3 })
    await expect(conn.call(background(), first, { n: 2 })).rejects.toThrow(
      "unknown service endpoint: reentry/first"
    )
  } finally {
    await conn.close(background())
    await server.stop(background())
    await running
  }
})

test("registerHandlers keeps a distinct handler committed by a registration getter", () => {
  const dto = struct.object({ n: struct.number() })
  const inner = endpoint("reentry", "inner", dto, dto)
  const outer = endpoint("reentry", "outer", dto, dto)
  const server = newServer(transport(fixtureTransport(fixtureListener([]))))
  let ran = false
  const batch: {
    readonly endpoint: Endpoint
    readonly handler: (ctx: Context, request: unknown) => unknown
  }[] = [
    {
      get endpoint(): Endpoint {
        server.registerHandler(inner, () => ({ n: 7 }))
        ran = true
        return outer
      },
      handler: () => ({ n: 1 })
    }
  ]

  expect(() => server.registerHandlers(batch)).not.toThrow()
  expect(ran).toBe(true)
  expect(() => server.registerHandler(inner, () => ({ n: 0 }))).toThrow("duplicated")
  expect(() => server.registerHandler(outer, () => ({ n: 0 }))).toThrow("duplicated")
})

test("Q3-04 registerHandler rechecks the seal after an endpoint getter runs", async () => {
  const dto = struct.object({ n: struct.number() })
  const memory = newMemoryTransport()
  const url = "memory://single-seal"
  const server = newServer(transport(memory), address(url))
  const keep = endpoint("single", "keep", dto, dto)
  const late = endpoint("single", "late", dto, dto)
  server.registerHandler(keep, () => ({ n: 1 }))
  let pending: Promise<string> | undefined
  const hostile = {
    ...late,
    get response(): typeof dto {
      pending = server.endpoint(background())
      return dto
    }
  }
  let thrown: unknown
  try {
    server.registerHandler(hostile, () => ({ n: 2 }))
  } catch (error) {
    thrown = error
  }
  await pending
  const running = server.start(background())
  const conn = newClient(withTransport(memory), withEndpoint(await server.endpoint(background())))
  try {
    expect(thrown).toBeInstanceOf(TypeError)
    expect((thrown as Error).message).toContain("sealed")
    await expect(conn.call(background(), keep, { n: 0 })).resolves.toEqual({ n: 1 })
    await expect(conn.call(background(), late, { n: 0 })).rejects.toThrow(
      "unknown service endpoint: single/late"
    )
  } finally {
    await conn.close(background())
    await server.stop(background())
    await running
  }
})

test("rejects exact dot-segment route tokens and accepts embedded dots", () => {
  const registrationServer = newServer(transport(fixtureTransport(fixtureListener([]))))
  const handler = async (): Promise<Response> => new Response(null)
  expect(() => registrationServer.registerHandler(".", "ok", handler)).toThrow(
    "server service must be a URL unreserved route token"
  )
  expect(() => registrationServer.registerHandler("..", "ok", handler)).toThrow(
    "server service must be a URL unreserved route token"
  )
  expect(() => registrationServer.registerHandler("orders", ".", handler)).toThrow(
    "server endpoint must be a URL unreserved route token"
  )
  expect(() => registrationServer.registerHandler("orders", "..", handler)).toThrow(
    "server endpoint must be a URL unreserved route token"
  )
  expect(() => registrationServer.registerHandler("a.b", "a..b", handler)).not.toThrow()
  expect(() => registrationServer.registerHandler("...", ".a", handler)).not.toThrow()
  expect(() => registrationServer.registerHandler("a.", "~_.-", handler)).not.toThrow()
  for (const selector of ["./ok", "../ok", "ok/.", "ok/..", "./", "../"]) {
    expect(() => use(selector)).toThrow(
      "server middleware selector must identify a canonical operation or trailing wildcard"
    )
  }
  expect(() => use("a.b/a..b")).not.toThrow()
  expect(() => use(".../*")).not.toThrow()
  expect(() => use(".a/ok")).not.toThrow()
})

test("rejects duplicate routes", () => {
  const operation = async (_ctx: Context, request: Request): Promise<Response> =>
    new Response(request.body)
  const server = newServer(transport(fixtureTransport(fixtureListener([]))))
  server.registerHandler("orders", "get", operation)
  expect(() => server.registerHandler("orders", "get", operation)).toThrow(
    "server handler is duplicated"
  )
})

test("keeps service and endpoint identities separate", async () => {
  const sent: Response[] = []
  const accepting = Promise.withResolvers<void>()
  const server = newServer(
    transport(
      fixtureTransport(
        fixtureListener(
          sent,
          [
            rpcRequest("a.b", "c", new Uint8Array(), { "content-type": "application/json" }),
            rpcRequest("a", "b.c", new Uint8Array(), { "content-type": "application/json" })
          ],
          "127.0.0.1:43210",
          accepting.resolve
        )
      )
    )
  )
  server.registerHandler("a.b", "c", () => new Response(copiedBytes(new Uint8Array([1]))))
  server.registerHandler("a", "b.c", () => new Response(copiedBytes(new Uint8Array([2]))))

  const running = server.start(background())
  await accepting.promise
  await server.stop(background())
  await running
  expect(sent).toHaveLength(2)
  expect(new Uint8Array(await sent[0]!.arrayBuffer())).toEqual(new Uint8Array([1]))
  expect(new Uint8Array(await sent[1]!.arrayBuffer())).toEqual(new Uint8Array([2]))
})

test("selects one operation middleware sequence while global middleware stays outermost", async () => {
  const events: string[] = []
  const sent: Response[] = []
  const accepting = Promise.withResolvers<void>()
  const exact = recordingMiddleware("exact", events)
  const exactSecond = recordingMiddleware("exact-second", events)
  const staleExact = recordingMiddleware("stale-exact", events)
  const terminal: Handler = (_ctx, request) => {
    const [service, endpointName] = new URL(request.url).pathname.slice(1).split("/")
    events.push(`handler:${service}/${endpointName}`)
    return new Response(null)
  }
  const requests = [
    rpcRequest("orders", "get", new Uint8Array(), { "content-type": "application/json" }),
    rpcRequest("orders", "getById", new Uint8Array(), { "content-type": "application/json" }),
    rpcRequest("orders", "list", new Uint8Array(), { "content-type": "application/json" }),
    rpcRequest("inventory", "list", new Uint8Array(), { "content-type": "application/json" }),
    rpcRequest("blocked", "list", new Uint8Array(), { "content-type": "application/json" })
  ]
  const server = newServer(
    transport(
      fixtureTransport(fixtureListener(sent, requests, "127.0.0.1:43210", accepting.resolve))
    ),
    use("*", recordingMiddleware("fallback", events)),
    use("orders/*", recordingMiddleware("orders-prefix", events)),
    middleware(recordingMiddleware("global-first", events)),
    use("orders/get*", recordingMiddleware("get-prefix", events)),
    use("orders/get", staleExact),
    middleware(recordingMiddleware("global-second", events)),
    use("orders/get", exact, exactSecond),
    use("blocked/*")
  )
  server.registerHandler("orders", "get", terminal)
  server.registerHandler("orders", "getById", terminal)
  server.registerHandler("orders", "list", terminal)
  server.registerHandler("inventory", "list", terminal)
  server.registerHandler("blocked", "list", terminal)

  expect(server.options().operationMiddleware.get("orders/get")).toEqual([exact, exactSecond])
  const running = server.start(background())
  await accepting.promise
  await server.stop(background())
  await running

  expect(sent).toHaveLength(requests.length)
  expect(events).toEqual([
    "global-first:before",
    "global-second:before",
    "exact:before",
    "exact-second:before",
    "handler:orders/get",
    "exact-second:after",
    "exact:after",
    "global-second:after",
    "global-first:after",
    "global-first:before",
    "global-second:before",
    "get-prefix:before",
    "handler:orders/getById",
    "get-prefix:after",
    "global-second:after",
    "global-first:after",
    "global-first:before",
    "global-second:before",
    "orders-prefix:before",
    "handler:orders/list",
    "orders-prefix:after",
    "global-second:after",
    "global-first:after",
    "global-first:before",
    "global-second:before",
    "fallback:before",
    "handler:inventory/list",
    "fallback:after",
    "global-second:after",
    "global-first:after",
    "global-first:before",
    "global-second:before",
    "handler:blocked/list",
    "global-second:after",
    "global-first:after"
  ])
})

test("validates operation middleware selectors and functions", () => {
  for (const selector of [
    "*",
    "orders*",
    "orders/*",
    "orders/Get*",
    "orders/Get",
    "orders.v1/pay_now~1-ok"
  ]) {
    expect(() => use(selector)).not.toThrow()
  }
  expect(() => use(null as never)).toThrow("server middleware selector must be a non-empty string")
  expect(() => use("")).toThrow("server middleware selector must be a non-empty string")
  expect(() => use("orders/*/get")).toThrow(
    "server middleware selector must be exact or end with one *"
  )
  expect(() => use("orders/**")).toThrow(
    "server middleware selector must be exact or end with one *"
  )
  for (const selector of ["orders", "orders/", "/Get", "orders//Get", " orders/Get", "订单/Get"]) {
    expect(() => use(selector)).toThrow(
      "server middleware selector must identify a canonical operation or trailing wildcard"
    )
  }
  expect(() => use("orders/get", null as never)).toThrow("server middleware must be a function")
})

test("validates operation middleware injected by custom ServerOption values", () => {
  const base = [transport(fixtureTransport(fixtureListener([])))] as const

  expect(() =>
    newServer(...base, (options) => ({
      address: options.address,
      advertise: options.advertise,
      transport: options.transport,
      middleware: options.middleware,
      operationMiddleware: new Map([["orders/*/get", Object.freeze([])]]),
      listenOptions: options.listenOptions,
      httpRoutes: options.httpRoutes,
      streamKeepAliveMs: options.streamKeepAliveMs,
      maxSendMessageBytes: options.maxSendMessageBytes
    }))
  ).toThrow("server middleware selector must be exact or end with one *")
  expect(() =>
    newServer(...base, (options) => ({
      address: options.address,
      advertise: options.advertise,
      transport: options.transport,
      middleware: options.middleware,
      operationMiddleware: new Map([["orders/", Object.freeze([])]]),
      listenOptions: options.listenOptions,
      httpRoutes: options.httpRoutes,
      streamKeepAliveMs: options.streamKeepAliveMs,
      maxSendMessageBytes: options.maxSendMessageBytes
    }))
  ).toThrow("server middleware selector must identify a canonical operation or trailing wildcard")
  expect(() =>
    newServer(...base, (options) => ({
      address: options.address,
      advertise: options.advertise,
      transport: options.transport,
      middleware: options.middleware,
      operationMiddleware: new Map([["orders/get", Object.freeze([null as never])]]),
      listenOptions: options.listenOptions,
      httpRoutes: options.httpRoutes,
      streamKeepAliveMs: options.streamKeepAliveMs,
      maxSendMessageBytes: options.maxSendMessageBytes
    }))
  ).toThrow("server middleware must be a function")
})

test("shares one limiter per middleware and stops before the denied handler", async () => {
  let admissions = 0
  let handled = 0
  const limited = rateLimitMiddleware({
    allow() {
      admissions += 1
      return Object.freeze({
        allowed: admissions === 1,
        retryAfterMs: admissions === 1 ? 0 : 250
      })
    },
    snapshot() {
      return Object.freeze({
        availableTokens: 0,
        capacity: 1,
        nextRefillInMs: 250
      })
    }
  })(async () => {
    handled += 1
    return new Response(null, { status: 204 })
  })
  const request = new Request("http://127.0.0.1/orders/get", { method: "POST" })

  await expect(limited(background(), request)).resolves.toMatchObject({ status: 204 })
  await expect(limited(background(), request)).rejects.toMatchObject({
    code: "rate_limited",
    message: "rate limit exceeded",
    status: 429,
    metadata: { retryAfterMs: "250" }
  })
  expect(handled).toBe(1)
  expect(() => rateLimitMiddleware(null as never)).toThrow(
    "rate limiter must implement RateLimiter"
  )
  expect(() => rateLimitMiddleware({ allow() {} } as never)).toThrow(
    "rate limiter must implement RateLimiter"
  )
})

test("enforces operation buckets through the real memory transport wire", async () => {
  const transportValue = newMemoryTransport()
  const calls: string[] = []
  const limiterOptions = {
    capacity: 1,
    refillTokens: 1,
    refillIntervalMs: 60_000
  }
  const server = newServer(
    transport(transportValue),
    address("memory://server-rate-limit"),
    use("orders/a", rateLimitMiddleware(newTokenBucketLimiter(limiterOptions))),
    use("orders/b", rateLimitMiddleware(newTokenBucketLimiter(limiterOptions))),
    use("guard/*", rateLimitMiddleware(newTokenBucketLimiter(limiterOptions)))
  )
  server.registerHandler("orders", "a", () => {
    calls.push("orders/a")
    return new Response(null, { status: 204 })
  })
  server.registerHandler("orders", "b", () => {
    calls.push("orders/b")
    return new Response(null, { status: 204 })
  })
  server.registerHandler("orders", "unmatched", () => {
    calls.push("orders/unmatched")
    return new Response(null, { status: 204 })
  })
  server.registerHandler("guard", "known", () => {
    calls.push("guard/known")
    return new Response(null, { status: 204 })
  })
  const endpoint = await server.endpoint(background())
  const running = server.start(background())
  await Promise.resolve()
  await Promise.resolve()
  const client = await transportValue.dial(background(), endpoint)

  try {
    const guardUnknown = await exchange(client, "guard", "missing")
    expect(await decodeServiceErrorResponse(guardUnknown)).toMatchObject({
      code: "not_found",
      status: 404
    })
    const guardKnown = await exchange(client, "guard", "known")
    expect(await decodeServiceErrorResponse(guardKnown)).toBeNull()

    const firstA = await exchange(client, "orders", "a")
    const deniedA = await exchange(client, "orders", "a")
    const firstB = await exchange(client, "orders", "b")
    const deniedB = await exchange(client, "orders", "b")
    const unmatchedFirst = await exchange(client, "orders", "unmatched")
    const unmatchedSecond = await exchange(client, "orders", "unmatched")
    const deniedGuard = await exchange(client, "guard", "known")

    expect(await decodeServiceErrorResponse(firstA)).toBeNull()
    expect(await decodeServiceErrorResponse(firstB)).toBeNull()
    expect(await decodeServiceErrorResponse(unmatchedFirst)).toBeNull()
    expect(await decodeServiceErrorResponse(unmatchedSecond)).toBeNull()
    for (const response of [deniedA, deniedB, deniedGuard]) {
      const failure = await decodeServiceErrorResponse(response)
      expect(failure).toMatchObject({
        code: "rate_limited",
        message: "rate limit exceeded",
        status: 429
      })
      expect(Number(failure?.metadata.retryAfterMs)).toBeGreaterThan(0)
    }
    expect(calls).toEqual([
      "guard/known",
      "orders/a",
      "orders/b",
      "orders/unmatched",
      "orders/unmatched"
    ])
  } finally {
    await client.close(background())
    await server.stop(background())
    await running
  }
})

test("reports a non-empty transport protocol and rejects missing or empty kinds", async () => {
  const listener = fixtureListener([], [], "http://127.0.0.1:43210")
  const base = fixtureTransport(listener)
  const missingKind: Transport = {
    init: base.init,
    options: base.options,
    dial: base.dial,
    listen: base.listen,
    string: base.string
  }
  const valid = newServer(transport(base))
  const missing = newServer(transport(missingKind))
  const empty = newServer(transport(fixtureTransport(listener, "")))

  expect(valid.protocol()).toBe("http")
  for (const server of [missing, empty]) {
    expect(() => server.protocol()).toThrow("server transport kind must be a non-empty string")
  }

  empty.registerHandler("orders", "get", async (_ctx, request) => new Response(request.body))
  await expect(empty.endpoint(background())).rejects.toThrow(
    "server transport kind must be a non-empty string"
  )
  await empty.stop(background())
})

/** Builds one timed internal RPC request. */
function timedRequest(timeoutMs: string): Request {
  return rpcRequest("orders", "get", new Uint8Array(), {
    "content-type": "application/json",
    "Go-Like-Timeout-Ms": timeoutMs
  })
}

test("cancels a positive Go-Like-Timeout-Ms when the Response body reaches EOF", async () => {
  const transportValue = newMemoryTransport()
  const seen: { ctx: Context | null } = { ctx: null }
  const server = newServer(transport(transportValue), address("memory://deadline-body"))
  server.registerHandler("orders", "get", (ctx) => {
    seen.ctx = ctx
    return new Response("ok", { status: 200 })
  })
  const endpointAddress = await server.endpoint(background())
  const running = server.start(background())
  await Promise.resolve()
  await Promise.resolve()
  const client = await transportValue.dial(background(), endpointAddress, withTimeout(0))
  let response: Response | null = null
  try {
    response = await client.fetch(background(), timedRequest("60000"))
    expect(seen.ctx?.err() ?? null).toBeNull()
    expect(seen.ctx?.deadline()[1]).toBe(true)
    expect(await response.text()).toBe("ok")
    expect(seen.ctx?.err() ?? null).toBe(canceled)
  } finally {
    await response?.body?.cancel().catch(function ignore(): void {})
    await client.close(background())
    await server.stop(background())
    await running
  }
})

test("cancels a positive Go-Like-Timeout-Ms when a handler failure body ends", async () => {
  const transportValue = newMemoryTransport()
  const seen: { ctx: Context | null } = { ctx: null }
  const server = newServer(transport(transportValue), address("memory://deadline-error"))
  server.registerHandler("orders", "get", (ctx) => {
    seen.ctx = ctx
    throw new Error("secret")
  })
  const endpointAddress = await server.endpoint(background())
  const running = server.start(background())
  await Promise.resolve()
  await Promise.resolve()
  const client = await transportValue.dial(background(), endpointAddress, withTimeout(0))
  let response: Response | null = null
  try {
    response = await client.fetch(background(), timedRequest("60000"))
    expect(seen.ctx?.err() ?? null).toBeNull()
    const failure = await decodeServiceErrorResponse(response)
    expect(failure?.code).toBe("internal")
    expect(failure?.message).not.toContain("secret")
    expect(seen.ctx?.err() ?? null).toBe(canceled)
  } finally {
    await response?.body?.cancel().catch(function ignore(): void {})
    await client.close(background())
    await server.stop(background())
    await running
  }
})

test("cancels a positive Go-Like-Timeout-Ms when the Response body is canceled or errors", async () => {
  const transportValue = newMemoryTransport()
  const seen = new Map<string, Context>()
  let release = function noop(): void {}
  const gate = new Promise<void>(function capture(resolve): void {
    release = resolve
  })
  const server = newServer(transport(transportValue), address("memory://deadline-stream"))
  server.registerHandler("orders", "get", (ctx, request) => {
    const mode = request.headers.get("x-stream")
    seen.set(mode ?? "", ctx)
    if (mode === "broken") {
      return new Response(
        new ReadableStream<Uint8Array>({
          /** Fails the first read. */
          start(controller): void {
            controller.error(new Error("broke"))
          }
        })
      )
    }
    return new Response(
      new ReadableStream<Uint8Array>({
        /** Stays open until the test releases or the consumer cancels. */
        async pull(controller): Promise<void> {
          await gate
          try {
            controller.close()
          } catch {
            // Consumer cancellation already terminated the body.
          }
        }
      })
    )
  })
  const endpointAddress = await server.endpoint(background())
  const running = server.start(background())
  await Promise.resolve()
  await Promise.resolve()
  const client = await transportValue.dial(background(), endpointAddress, withTimeout(0))
  let hanging: Response | null = null
  let broken: Response | null = null
  try {
    hanging = await client.fetch(
      background(),
      rpcRequest("orders", "get", new Uint8Array(), {
        "content-type": "application/json",
        "Go-Like-Timeout-Ms": "60000",
        "x-stream": "hang"
      })
    )
    expect(seen.get("hang")?.err() ?? null).toBeNull()
    await hanging.body?.cancel(new Error("stop"))
    expect(seen.get("hang")?.err() ?? null).toBe(canceled)

    broken = await client.fetch(
      background(),
      rpcRequest("orders", "get", new Uint8Array(), {
        "content-type": "application/json",
        "Go-Like-Timeout-Ms": "60000",
        "x-stream": "broken"
      })
    )
    expect(seen.get("broken")?.err() ?? null).toBeNull()
    await expect(broken.text()).rejects.toThrow("broke")
    expect(seen.get("broken")?.err() ?? null).toBe(canceled)
  } finally {
    release()
    await hanging?.body?.cancel().catch(function ignore(): void {})
    await broken?.body?.cancel().catch(function ignore(): void {})
    await client.close(background())
    await server.stop(background())
    await running
  }
})
