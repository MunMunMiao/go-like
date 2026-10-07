import { createConnection } from "node:net"

import { expect, test } from "bun:test"
import { afterFunc, background, cause } from "@go-like/context"

import {
  bunShutdownTimeout,
  newBunServer,
  port,
  type BunServer,
  type BunServerOption
} from "../../src/bun"
import { contextHandler, type Handler } from "../../src/index"

interface Host {
  readonly server: BunServer
  readonly running: Promise<void>
  readonly origin: string
  readonly port: number
}

/** Reserves and releases one loopback TCP port for a deterministic host test. */
async function availablePort(): Promise<number> {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    reusePort: false,
    fetch: () => new Response()
  })
  const reserved = probe.port
  await probe.stop(true)
  if (reserved === undefined) throw new Error("port probe did not bind a TCP port")
  return reserved
}

/** Starts one real Bun host on loopback and waits for its actual endpoint. */
async function startHost(handler: Handler, ...options: readonly BunServerOption[]): Promise<Host> {
  const server = newBunServer(handler, ...options)
  const running = server.start(background())
  const url = new URL(await server.endpoint(background()))
  return { server, running, origin: url.origin, port: Number(url.port) }
}

/**
 * Awaits a rejection through ordinary promise reactions and returns its reason.
 * expect(...).rejects spins a nested event loop, which starves an in-flight native Bun stop.
 */
function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("promise unexpectedly fulfilled")
    },
    (error: unknown) => error
  )
}

/** Stops one host gracefully and asserts that the lifecycle ended without a failure. */
async function stopHost(host: Host): Promise<void> {
  await host.server.stop(background())
  await host.running
}

/** Sends one raw HTTP exchange and resolves with everything the server wrote before it closed. */
function rawExchange(hostPort: number, text: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    const socket = createConnection({ host: "127.0.0.1", port: hostPort }, () => {
      socket.write(text)
    })
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk)
    })
    socket.once("error", reject)
    socket.once("close", () => {
      resolve(Buffer.concat(chunks).toString("utf8"))
    })
  })
}

/** Reports whether a fresh connection to one origin is refused. */
async function refuses(origin: string): Promise<boolean> {
  try {
    await fetch(`${origin}/probe`, { headers: { connection: "close" } })
    return false
  } catch {
    return true
  }
}

test("delegates the one-argument Fetch ABI to Bun.serve without replacing globals", async () => {
  const originalRequest = Request
  const originalResponse = Response
  const observed: { arguments: number; request: Request | null } = { arguments: -1, request: null }
  const host = await startHost(async function handler(request) {
    observed.arguments = arguments.length
    observed.request = request
    return new Response(`${request.method}:${await request.text()}`, {
      status: 201,
      headers: { "x-answer": request.headers.get("x-ask") ?? "" }
    })
  })

  try {
    expect(host.server.protocol()).toBe("http")
    const response = await fetch(`${host.origin}/upstream?x=1`, {
      method: "POST",
      body: "payload",
      headers: { "x-ask": "question" }
    })

    expect(response.status).toBe(201)
    expect(response.headers.get("x-answer")).toBe("question")
    expect(await response.text()).toBe("POST:payload")
    expect(observed.arguments).toBe(1)
    expect(observed.request).toBeInstanceOf(originalRequest)
    const url = new URL(observed.request?.url ?? "")
    expect(`${url.pathname}${url.search}`).toBe("/upstream?x=1")
    expect(Request).toBe(originalRequest)
    expect(Response).toBe(originalResponse)
  } finally {
    await stopHost(host)
  }
})

test("endpoint binds once, shares the listener with start, and is refused after stop", async () => {
  const server = newBunServer(() => new Response("endpoint"))
  const endpoint = await server.endpoint(background())
  const running = server.start(background())

  try {
    const url = new URL(endpoint)
    expect(url.hostname).toBe("127.0.0.1")
    expect(Number(url.port)).toBeGreaterThan(0)
    expect(await server.endpoint(background())).toBe(endpoint)
    const response = await fetch(endpoint)
    expect(await response.text()).toBe("endpoint")
  } finally {
    await server.stop(background())
    await running
  }

  await expect(server.endpoint(background())).rejects.toThrow("bun web server is not bound")
  await expect(server.start(background())).rejects.toMatchObject({
    name: "BunServerAlreadyStartedError",
    status: "stopped"
  })
})

const failures: readonly (readonly [string, Handler, number])[] = [
  [
    "a synchronous throw",
    () => {
      throw new Error("boom")
    },
    500
  ],
  ["a rejected promise", () => Promise.reject(new Error("rejected")), 500],
  ["a non-Error rejection", () => Promise.reject("text" as never), 500],
  [
    "a TimeoutError by name",
    () => Promise.reject(Object.assign(new Error("late"), { name: "TimeoutError" })),
    504
  ],
  ["a missing Response", () => undefined as never, 500],
  ["a non-Response object", () => ({ status: 200 }) as never, 500]
]

for (const [label, handler, status] of failures) {
  test(`maps ${label} to an empty ${status} response`, async () => {
    const host = await startHost(handler)

    try {
      const response = await fetch(`${host.origin}/`)

      expect(response.status).toBe(status)
      expect(await response.text()).toBe("")
    } finally {
      await stopHost(host)
    }
  })
}

test("answers 400 without entering the handler when the Host header is unusable", async () => {
  let calls = 0
  const host = await startHost(() => {
    calls += 1
    return new Response("reached")
  })

  try {
    for (const head of ["", "Host: bad host\r\n"]) {
      const text = await rawExchange(
        host.port,
        `GET /p HTTP/1.1\r\n${head}Connection: close\r\n\r\n`
      )
      expect(text.startsWith("HTTP/1.1 400")).toBe(true)
    }
    expect(calls).toBe(0)

    const valid = await rawExchange(
      host.port,
      "GET /p HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
    )
    expect(valid.startsWith("HTTP/1.1 200")).toBe(true)
    expect(calls).toBe(1)
  } finally {
    await stopHost(host)
  }
})

test("graceful stop refuses new connections while an in-flight request completes", async () => {
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const host = await startHost(async (request) => {
    if (!request.url.endsWith("/slow")) return new Response("fast")
    entered.resolve()
    await gate.promise
    return new Response("finished")
  })
  const inFlight = fetch(`${host.origin}/slow`)

  try {
    await entered.promise
    const stopping = host.server.stop(background())
    expect(await refuses(host.origin)).toBe(true)

    gate.resolve()
    const response = await inFlight
    expect(await response.text()).toBe("finished")
    await stopping
    await host.running
  } finally {
    gate.resolve()
  }
})

test("force cancels a non-cooperative response body and reports the hard timeout", async () => {
  const cancelled = Promise.withResolvers<void>()
  const aborted = Promise.withResolvers<void>()
  const host = await startHost((request) => {
    request.signal.addEventListener(
      "abort",
      () => {
        aborted.resolve()
      },
      { once: true }
    )
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("first"))
        },
        cancel() {
          cancelled.resolve()
        }
      })
    )
  }, bunShutdownTimeout(50))
  const response = await fetch(`${host.origin}/stream`)
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error("streaming response has no body")

  const first = await reader.read()
  expect(new TextDecoder().decode(first.value)).toBe("first")
  const stopping = host.server.stop(background())

  expect(await rejection(host.running)).toMatchObject({
    name: "BunServerForceCloseError",
    code: "GO_LIKE_BUN_SERVER_FORCE_CLOSE",
    timeoutMs: 50,
    activeRequests: 1
  })
  await stopping
  await cancelled.promise
  await aborted.promise
  await reader.read().then(
    () => undefined,
    () => undefined
  )
})

test("force cancels the request Context of a contextHandler", async () => {
  const entered = Promise.withResolvers<void>()
  const canceledWith = Promise.withResolvers<Error | null>()
  const host = await startHost(
    contextHandler(async (ctx) => {
      afterFunc(ctx, () => {
        canceledWith.resolve(cause(ctx))
      })
      entered.resolve()
      await new Promise<never>(() => undefined)
      return new Response()
    }),
    bunShutdownTimeout(0)
  )
  const pending = fetch(`${host.origin}/hang`).then(
    () => undefined,
    () => undefined
  )

  await entered.promise
  const stopping = host.server.stop(background())

  expect(await rejection(host.running)).toMatchObject({ code: "GO_LIKE_BUN_SERVER_FORCE_CLOSE" })
  await stopping
  expect(await canceledWith.promise).toBeInstanceOf(Error)
  await pending
})

test("a client disconnect aborts the request signal and cancels the response body", async () => {
  const aborted = Promise.withResolvers<void>()
  const cancelled = Promise.withResolvers<void>()
  const host = await startHost((request) => {
    request.signal.addEventListener(
      "abort",
      () => {
        aborted.resolve()
      },
      { once: true }
    )
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("first"))
        },
        cancel() {
          cancelled.resolve()
        }
      })
    )
  })
  const received = Promise.withResolvers<void>()
  const socket = createConnection({ host: "127.0.0.1", port: host.port }, () => {
    socket.write("GET /stream HTTP/1.1\r\nHost: localhost\r\n\r\n")
  })
  let text = ""
  socket.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8")
    if (text.includes("first")) received.resolve()
  })

  try {
    await received.promise
    socket.destroy()
    await aborted.promise
    await cancelled.promise
  } finally {
    socket.destroy()
    await stopHost(host)
  }
})

/** Binds, serves one request on, and cleanly stops a host that uses one exact port. */
async function serveOnce(listenPort: number, body: string): Promise<void> {
  const server = newBunServer(() => new Response(body), port(listenPort))
  const running = server.start(background())
  const endpoint = await server.endpoint(background())
  try {
    expect(new URL(endpoint).port).toBe(String(listenPort))
    expect(await (await fetch(endpoint)).text()).toBe(body)
  } finally {
    await server.stop(background())
    await running
  }
}

test("releases the exact port after a clean stop so it can be bound again", async () => {
  const listenPort = await availablePort()

  await serveOnce(listenPort, "first")
  await serveOnce(listenPort, "second")
})

test("releases the exact port after a forced stop so it can be bound again", async () => {
  const listenPort = await availablePort()
  const server = newBunServer(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("held"))
          }
        })
      ),
    port(listenPort),
    bunShutdownTimeout(0)
  )
  const running = server.start(background())
  const endpoint = await server.endpoint(background())
  const response = await fetch(endpoint)
  const reader = response.body?.getReader()
  await reader?.read()

  await server.stop(background())
  expect(await rejection(running)).toMatchObject({ code: "GO_LIKE_BUN_SERVER_FORCE_CLOSE" })
  await reader?.read().then(
    () => undefined,
    () => undefined
  )

  await serveOnce(listenPort, "again")
})

test("an occupied port rejects start, endpoint, and stop with the runtime bind error", async () => {
  const occupier = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    reusePort: false,
    fetch: () => new Response()
  })

  try {
    const server = newBunServer(() => new Response(), port(occupier.port ?? 0))
    const failure = await rejection(server.start(background()))

    expect(failure).toMatchObject({ code: "EADDRINUSE" })
    expect(await rejection(server.endpoint(background()))).toBe(failure)
    expect(await rejection(server.stop(background()))).toBe(failure)
  } finally {
    await occupier.stop(true)
  }
})
