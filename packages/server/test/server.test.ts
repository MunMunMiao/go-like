import { expect, test } from "bun:test"

import { background, cause, withCancelCause, type Context } from "@likego/context"
import { newTokenBucketLimiter } from "@likego/resilience"
import { endpoint, type BodyCodec } from "@likego/transport"
import type {
  AcceptHandler,
  Client,
  ListenOption,
  Listener,
  Message,
  Options,
  Transport
} from "@likego/transport"
import { decodeServiceError } from "@likego/transport/provider"
import { newMemoryTransport } from "@likego/transport-memory"

import {
  address,
  advertise,
  handler,
  listenOption,
  middleware,
  newServer,
  rateLimitMiddleware,
  transport,
  use,
  type Handler,
  type Middleware
} from "../src/index"

/** Creates one listener controlled by close. */
function fixtureListener(
  sent: Message[],
  requests: readonly Message[] = [
    {
      header: {
        "Likego-Service": "orders",
        "Likego-Endpoint": "get"
      },
      body: new Uint8Array([1])
    }
  ],
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
    async accept(ctx: Context, handle: AcceptHandler): Promise<void> {
      onAccept?.()
      for (const request of requests) {
        const socket = {
          recv(): Promise<Message> {
            return Promise.resolve(request)
          },
          async send(_ctx: Context, message: Message): Promise<void> {
            sent.push(message)
          },
          close(): Promise<void> {
            return Promise.resolve()
          },
          local(): string {
            return "127.0.0.1:43210"
          },
          remote(): string {
            return "127.0.0.1:50000"
          }
        }
        await handle(ctx, socket)
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
        codec: null,
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
async function exchange(client: Client, service: string, endpoint: string): Promise<Message> {
  await client.send(background(), {
    header: {
      "Likego-Service": service,
      "Likego-Endpoint": endpoint
    },
    body: new Uint8Array()
  })
  return await client.recv(background())
}

test("routes one unary exchange and blocks until stop", async () => {
  const sent: Message[] = []
  const server = newServer(
    transport(fixtureTransport(fixtureListener(sent))),
    address("127.0.0.1:0"),
    handler("orders", "get", (_ctx, request) => request),
    middleware((next) => async (ctx, request) => next(ctx, request))
  )

  const running = server.start(background())
  await Promise.resolve()
  await Promise.resolve()
  await expect(server.endpoint(background())).resolves.toBe("http://127.0.0.1:43210/")
  await server.stop(background())
  await running
  expect(sent).toHaveLength(1)
  expect(sent[0]?.body).toEqual(new Uint8Array([1]))
})

test("adapts one typed endpoint at the Message boundary", async () => {
  const codec: BodyCodec<number> = {
    contentType: "application/example+number",
    encode(value) {
      return value === 10 ? (null as never) : new Uint8Array([value])
    },
    decode(body) {
      return body[0] ?? 0
    }
  }
  const operation = endpoint("calculator", "increment", codec, codec)
  const sent: Message[] = []
  const accepting = Promise.withResolvers<void>()
  const server = newServer(
    transport(
      fixtureTransport(
        fixtureListener(
          sent,
          [
            {
              header: {
                "Likego-Service": "calculator",
                "Likego-Endpoint": "increment",
                "content-type": "Application/Example+Number; charset=binary"
              },
              body: new Uint8Array([1])
            },
            {
              header: {
                "Likego-Service": "calculator",
                "Likego-Endpoint": "increment"
              },
              body: new Uint8Array([2])
            },
            {
              header: {
                "Likego-Service": "calculator",
                "Likego-Endpoint": "increment",
                "Content-Type": "application/example+number"
              },
              body: new Uint8Array([9])
            }
          ],
          "127.0.0.1:43210",
          accepting.resolve
        )
      )
    ),
    handler(operation, (_ctx, request) => request + 1)
  )

  const running = server.start(background())
  await accepting.promise
  await server.stop(background())
  await running

  expect(sent[0]).toEqual({
    header: { "Content-Type": "application/example+number" },
    body: new Uint8Array([2])
  })
  const invalidRequest = sent[1]
  const invalidResponse = sent[2]
  if (invalidRequest === undefined || invalidResponse === undefined) {
    throw new Error("typed server responses are missing")
  }
  expect(
    decodeServiceError("unary", 200, invalidRequest.header, invalidRequest.body)
  ).toMatchObject({
    code: "invalid_request",
    status: 400
  })
  expect(
    decodeServiceError("unary", 200, invalidResponse.header, invalidResponse.body)
  ).toMatchObject({
    code: "internal",
    status: 500
  })
})

test("rejects malformed typed request metadata and handler values", async () => {
  const codec: BodyCodec<number> = {
    contentType: "application/example+number",
    encode: (value) => new Uint8Array([value]),
    decode() {
      throw new Error("invalid request")
    }
  }
  const operation = endpoint("calculator", "increment", codec, codec)
  expect(() => Reflect.apply(handler, undefined, [operation, "invalid"])).toThrow(
    "server typed handler must be a function"
  )

  const sent: Message[] = []
  const accepting = Promise.withResolvers<void>()
  const server = newServer(
    transport(
      fixtureTransport(
        fixtureListener(
          sent,
          [
            {
              header: {
                "Likego-Service": "calculator",
                "Likego-Endpoint": "increment",
                "Content-Type": "application/example+number",
                "content-type": "application/example+number"
              },
              body: new Uint8Array([1])
            },
            {
              header: {
                "Likego-Service": "calculator",
                "Likego-Endpoint": "increment",
                "Content-Type": "application/example+number"
              },
              body: new Uint8Array([1])
            }
          ],
          "127.0.0.1:43210",
          accepting.resolve
        )
      )
    ),
    handler(operation, (_ctx, request) => request)
  )
  const running = server.start(background())
  await accepting.promise
  await server.stop(background())
  await running

  for (const response of sent) {
    expect(decodeServiceError("unary", 200, response.header, response.body)).toMatchObject({
      code: "invalid_request",
      status: 400
    })
  }
})

test("shares one actual bind between Endpointer and start", async () => {
  let listens = 0
  const base = fixtureTransport(fixtureListener([]))
  const transportValue: Transport = {
    ...base,
    listen(ctx, value, ...options) {
      listens += 1
      return base.listen(ctx, value, ...options)
    }
  }
  const server = newServer(
    transport(transportValue),
    handler("orders", "get", (_ctx, request) => request)
  )

  expect(await server.endpoint(background())).toBe("http://127.0.0.1:43210/")
  const running = server.start(background())
  await Promise.resolve()
  expect(listens).toBe(1)
  await server.stop(background())
  await running
})

test("stop owns an in-flight bind and closes the late listener once without accepting", async () => {
  const deferred = Promise.withResolvers<Listener>()
  let accepts = 0
  let closes = 0
  const lateListener: Listener = {
    /** Returns the late bind result. */
    addr(): string {
      return "127.0.0.1:43210"
    },
    /** Records the forbidden post-stop accept. */
    accept(): Promise<void> {
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
  const server = newServer(
    transport(transportValue),
    handler("orders", "get", (_ctx, request) => request)
  )

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
  const server = newServer(
    transport(transportValue),
    handler("orders", "get", (_ctx, request) => request)
  )
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
    }),
    handler("orders", "get", (_ctx, request) => request)
  )
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
    async accept(): Promise<void> {
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
  const server = newServer(
    transport(transportValue),
    handler("orders", "get", (_ctx, request) => request)
  )
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
    /** Keeps the unused accept loop pending. */
    accept(): Promise<void> {
      return new Promise(() => {})
    },
    /** Records and delays the single owner-scoped close. */
    async close(ctx): Promise<void> {
      closes += 1
      closeContexts.push(ctx)
      await shutdown.promise
    }
  }
  const server = newServer(
    transport(fixtureTransport(listener)),
    handler("orders", "get", (_ctx, request) => request)
  )
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
    /** Ends acceptance when the Server start Context is canceled. */
    async accept(ctx): Promise<void> {
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
  const server = newServer(
    transport(fixtureTransport(listener)),
    handler("orders", "get", (_ctx, request) => request)
  )
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
    advertise("orders.internal"),
    handler("orders", "get", (_ctx, request) => request)
  )

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
      advertise(selected),
      handler("orders", "get", (_ctx, request) => request)
    )
    await expect(server.endpoint(background())).resolves.toBe(expected)
    await server.stop(background())
  }
})

test("requires an explicit usable advertise value for wildcard binds", async () => {
  for (const listenerAddress of ["0.0.0.0:43210", "[::]:43210"]) {
    const server = newServer(
      transport(fixtureTransport(fixtureListener([], [], listenerAddress))),
      handler("orders", "get", (_ctx, request) => request)
    )
    await expect(server.endpoint(background())).rejects.toThrow("requires explicit advertise")
    await server.stop(background())
  }

  const server = newServer(
    transport(fixtureTransport(fixtureListener([], [], "127.0.0.1:43210"))),
    advertise("0.0.0.0"),
    handler("orders", "get", (_ctx, request) => request)
  )
  await expect(server.endpoint(background())).rejects.toThrow(
    "advertise must not use a wildcard host"
  )
  await server.stop(background())
})

test("advertises a TLS-configured HTTP authority with its real HTTPS scheme", async () => {
  const server = newServer(
    transport(fixtureTransport(fixtureListener([]), "http", true)),
    handler("orders", "get", (_ctx, request) => request)
  )

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
  const server = newServer(
    transport(transportValue),
    handler("orders", "get", (_ctx, request) => request),
    listenOption(option)
  )

  expect(server.options().listenOptions).toEqual([option])
  expect(server.string()).toBe("server")
  await expect(server.endpoint(background())).resolves.toBe("http://127.0.0.1:43210/")
  expect(received).toEqual([option])
  await server.stop(background())
})

test("keeps routing state isolated from returned option snapshots", async () => {
  const sent: Message[] = []
  const events: string[] = []
  const accepting = Promise.withResolvers<void>()
  const operation: Handler = (_ctx, request) => {
    events.push("handler")
    return request
  }
  const selectedMiddleware = recordingMiddleware("operation", events)
  const server = newServer(
    transport(
      fixtureTransport(fixtureListener(sent, undefined, "127.0.0.1:43210", accepting.resolve))
    ),
    handler("orders", "get", operation),
    use("orders/get", selectedMiddleware)
  )

  const exposed = server.options()
  const exposedHandlers = exposed.handlers.get("orders")
  if (exposedHandlers === undefined) throw new Error("server option snapshot omitted handlers")
  Reflect.apply(Map.prototype.clear, exposedHandlers, [])
  Reflect.apply(Map.prototype.clear, exposed.handlers, [])
  Reflect.apply(Map.prototype.clear, exposed.operationMiddleware, [])

  expect(server.options().handlers.get("orders")?.get("get")).toBe(operation)
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
  const cases: readonly [
    request: Message,
    operation: (_ctx: Context, request: Message) => Message | PromiseLike<Message>,
    code: string
  ][] = [
    [
      {
        header: { "Likego-Endpoint": "get" },
        body: new Uint8Array()
      },
      (_ctx, request) => request,
      "invalid_request"
    ],
    ...[
      { "Likego-Service": "orders/admin", "Likego-Endpoint": "get" },
      { "Likego-Service": "orders", "Likego-Endpoint": "get*" },
      { "Likego-Service": "orders\u0000", "Likego-Endpoint": "get" },
      { "Likego-Service": "orders", "Likego-Endpoint": "get\u001f" },
      { "Likego-Service": "orders\u007f", "Likego-Endpoint": "get" },
      { "Likego-Service": "orders", "Likego-Endpoint": "get\udfff" },
      { "Likego-Service": " orders", "Likego-Endpoint": "get" },
      { "Likego-Service": "orders", "Likego-Endpoint": "get " },
      { "Likego-Service": "orders admin", "Likego-Endpoint": "get" },
      { "Likego-Service": "订单", "Likego-Endpoint": "get" },
      { "Likego-Service": "orders", "Likego-Endpoint": "😀" }
    ].map(
      (header) =>
        [
          { header, body: new Uint8Array() },
          (_ctx: Context, request: Message) => request,
          "invalid_request"
        ] as [Message, (_ctx: Context, request: Message) => Message, string]
    ),
    [
      {
        header: {
          "Likego-Service": "orders",
          "Likego-Endpoint": "get",
          "Likego-Metadata": "v1.%5B%5B%22trace%22%2C%5B%22one%22%5D%5D%5D",
          "likego-metadata": "v1.%5B%5B%22trace%22%2C%5B%22two%22%5D%5D%5D"
        },
        body: new Uint8Array()
      },
      (_ctx, request) => request,
      "invalid_metadata"
    ],
    [
      {
        header: {
          "Likego-Service": "inventory",
          "Likego-Endpoint": "get"
        },
        body: new Uint8Array()
      },
      (_ctx, request) => request,
      "not_found"
    ],
    [
      {
        header: {
          "Likego-Service": "orders",
          "Likego-Endpoint": "get",
          "Likego-Metadata": "invalid"
        },
        body: new Uint8Array()
      },
      (_ctx, request) => request,
      "invalid_metadata"
    ],
    [
      {
        header: {
          "Likego-Service": "orders",
          "Likego-Endpoint": "get"
        },
        body: new Uint8Array()
      },
      () => {
        throw new Error("secret")
      },
      "internal"
    ]
  ]

  for (const [request, operation, code] of cases) {
    const sent: Message[] = []
    const accepting = Promise.withResolvers<void>()
    const server = newServer(
      transport(
        fixtureTransport(fixtureListener(sent, [request], "127.0.0.1:43210", accepting.resolve))
      ),
      handler("orders", "get", operation)
    )
    const running = server.start(background())
    await accepting.promise
    await server.stop(background())
    await running
    const response = sent[0]
    if (response === undefined) throw new Error("server omitted its failure response")
    expect(decodeServiceError("unary", 200, response.header, response.body)?.code).toBe(code)
  }
})

test("requires a transport and at least one handler", () => {
  expect(() => newServer(handler("orders", "get", async (_ctx, request) => request))).toThrow(
    "server transport is required"
  )
  expect(() => newServer(transport(fixtureTransport(fixtureListener([]))))).toThrow(
    "server requires at least one handler"
  )
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
  expect(() => handler("", "get", async (_ctx, request) => request)).toThrow(
    "server service must be a visible ASCII route token"
  )
  expect(() => handler("orders", "", async (_ctx, request) => request)).toThrow(
    "server endpoint must be a visible ASCII route token"
  )
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
    ["a", "😀"]
  ] as const) {
    expect(() => handler(service, endpoint, async (_ctx, request) => request)).toThrow(
      "route token"
    )
  }
  expect(() => transport({} as never)).toThrow("server transport must implement Transport")
  expect(() => listenOption(null as never)).toThrow("server listen option must be a function")
  expect(() =>
    newServer(
      transport(fixtureTransport(fixtureListener([]))),
      handler("orders", "get", async (_ctx, request) => request),
      (options) => ({
        address: options.address,
        advertise: options.advertise,
        transport: options.transport,
        handlers: options.handlers,
        middleware: options.middleware,
        operationMiddleware: options.operationMiddleware,
        listenOptions: [null as never]
      })
    )
  ).toThrow("server listen option must be a function")
})

test("rejects duplicate routes", () => {
  const operation = async (_ctx: Context, request: Message): Promise<Message> => request
  expect(() =>
    newServer(
      transport(fixtureTransport(fixtureListener([]))),
      handler("orders", "get", operation),
      handler("orders", "get", operation)
    )
  ).toThrow("server handler is duplicated")
})

test("keeps service and endpoint identities separate", () => {
  const operation = async (_ctx: Context, request: Message): Promise<Message> => request
  const server = newServer(
    transport(fixtureTransport(fixtureListener([]))),
    handler("a.b", "c", operation),
    handler("a", "b.c", operation)
  )

  expect(server.options().handlers.get("a.b")?.get("c")).toBe(operation)
  expect(server.options().handlers.get("a")?.get("b.c")).toBe(operation)
})

test("selects one operation middleware sequence while global middleware stays outermost", async () => {
  const events: string[] = []
  const sent: Message[] = []
  const accepting = Promise.withResolvers<void>()
  const exact = recordingMiddleware("exact", events)
  const exactSecond = recordingMiddleware("exact-second", events)
  const staleExact = recordingMiddleware("stale-exact", events)
  const terminal: Handler = (_ctx, request) => {
    const service = request.header["Likego-Service"] ?? ""
    const endpoint = request.header["Likego-Endpoint"] ?? ""
    events.push(`handler:${service}/${endpoint}`)
    return request
  }
  const requests = [
    {
      header: { "Likego-Service": "orders", "Likego-Endpoint": "get" },
      body: new Uint8Array()
    },
    {
      header: { "Likego-Service": "orders", "Likego-Endpoint": "getById" },
      body: new Uint8Array()
    },
    {
      header: { "Likego-Service": "orders", "Likego-Endpoint": "list" },
      body: new Uint8Array()
    },
    {
      header: { "Likego-Service": "inventory", "Likego-Endpoint": "list" },
      body: new Uint8Array()
    },
    {
      header: { "Likego-Service": "blocked", "Likego-Endpoint": "list" },
      body: new Uint8Array()
    }
  ]
  const server = newServer(
    transport(
      fixtureTransport(fixtureListener(sent, requests, "127.0.0.1:43210", accepting.resolve))
    ),
    use("*", recordingMiddleware("fallback", events)),
    use("orders/*", recordingMiddleware("orders-prefix", events)),
    middleware(recordingMiddleware("global-first", events)),
    handler("orders", "get", terminal),
    handler("orders", "getById", terminal),
    handler("orders", "list", terminal),
    handler("inventory", "list", terminal),
    handler("blocked", "list", terminal),
    use("orders/get*", recordingMiddleware("get-prefix", events)),
    use("orders/get", staleExact),
    middleware(recordingMiddleware("global-second", events)),
    use("orders/get", exact, exactSecond),
    use("blocked/*")
  )

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
  for (const selector of ["*", "orders*", "orders/*", "orders/Get*", "orders/Get"]) {
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
  const base = [
    transport(fixtureTransport(fixtureListener([]))),
    handler("orders", "get", async (_ctx: Context, request: Message) => request)
  ] as const

  expect(() =>
    newServer(...base, (options) => ({
      address: options.address,
      advertise: options.advertise,
      transport: options.transport,
      handlers: options.handlers,
      middleware: options.middleware,
      operationMiddleware: new Map([["orders/*/get", Object.freeze([])]]),
      listenOptions: options.listenOptions
    }))
  ).toThrow("server middleware selector must be exact or end with one *")
  expect(() =>
    newServer(...base, (options) => ({
      address: options.address,
      advertise: options.advertise,
      transport: options.transport,
      handlers: options.handlers,
      middleware: options.middleware,
      operationMiddleware: new Map([["orders/", Object.freeze([])]]),
      listenOptions: options.listenOptions
    }))
  ).toThrow("server middleware selector must identify a canonical operation or trailing wildcard")
  expect(() =>
    newServer(...base, (options) => ({
      address: options.address,
      advertise: options.advertise,
      transport: options.transport,
      handlers: options.handlers,
      middleware: options.middleware,
      operationMiddleware: new Map([["orders/get", Object.freeze([null as never])]]),
      listenOptions: options.listenOptions
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
  })(async (_ctx, request) => {
    handled += 1
    return request
  })
  const request: Message = { header: {}, body: new Uint8Array() }

  await expect(limited(background(), request)).resolves.toBe(request)
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
    handler("orders", "a", (_ctx, request) => {
      calls.push("orders/a")
      return request
    }),
    handler("orders", "b", (_ctx, request) => {
      calls.push("orders/b")
      return request
    }),
    handler("orders", "unmatched", (_ctx, request) => {
      calls.push("orders/unmatched")
      return request
    }),
    handler("guard", "known", (_ctx, request) => {
      calls.push("guard/known")
      return request
    }),
    use("orders/a", rateLimitMiddleware(newTokenBucketLimiter(limiterOptions))),
    use("orders/b", rateLimitMiddleware(newTokenBucketLimiter(limiterOptions))),
    use("guard/*", rateLimitMiddleware(newTokenBucketLimiter(limiterOptions)))
  )
  const endpoint = await server.endpoint(background())
  const running = server.start(background())
  await Promise.resolve()
  await Promise.resolve()
  const client = await transportValue.dial(background(), endpoint)

  try {
    const guardUnknown = await exchange(client, "guard", "missing")
    expect(decodeServiceError("unary", 200, guardUnknown.header, guardUnknown.body)).toMatchObject({
      code: "not_found",
      status: 404
    })
    const guardKnown = await exchange(client, "guard", "known")
    expect(decodeServiceError("unary", 200, guardKnown.header, guardKnown.body)).toBeNull()

    const firstA = await exchange(client, "orders", "a")
    const deniedA = await exchange(client, "orders", "a")
    const firstB = await exchange(client, "orders", "b")
    const deniedB = await exchange(client, "orders", "b")
    const unmatchedFirst = await exchange(client, "orders", "unmatched")
    const unmatchedSecond = await exchange(client, "orders", "unmatched")
    const deniedGuard = await exchange(client, "guard", "known")

    expect(decodeServiceError("unary", 200, firstA.header, firstA.body)).toBeNull()
    expect(decodeServiceError("unary", 200, firstB.header, firstB.body)).toBeNull()
    expect(decodeServiceError("unary", 200, unmatchedFirst.header, unmatchedFirst.body)).toBeNull()
    expect(
      decodeServiceError("unary", 200, unmatchedSecond.header, unmatchedSecond.body)
    ).toBeNull()
    for (const response of [deniedA, deniedB, deniedGuard]) {
      const failure = decodeServiceError("unary", 200, response.header, response.body)
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

test("rejects an authority address when the transport kind is empty", async () => {
  const server = newServer(
    transport(fixtureTransport(fixtureListener([]), "")),
    handler("orders", "get", async (_ctx, request) => request)
  )

  await expect(server.endpoint(background())).rejects.toThrow(
    "server transport kind is required for an authority address"
  )
  await server.stop(background())
})
