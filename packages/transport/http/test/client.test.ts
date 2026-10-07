import { createServer, type IncomingMessage, type Server } from "node:http"

import { expect, test } from "bun:test"

import {
  background,
  canceled,
  deadlineExceeded,
  withCancel,
  withCancelCause,
  withTimeout,
  type Context
} from "@go-like/context"
import type { TransportLogLevel } from "@go-like/transport"
import { logger, timeout, withTimeout as withDialTimeout } from "@go-like/transport"
import {
  executor,
  maxMessageBytes,
  newHTTPTransport,
  type HTTPExecutor
} from "@go-like/transport-http"

/** Creates one externally settled Promise. */
function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return Object.freeze({ promise, resolve, reject })
}

/** Completes a standard callable executor with runtime-specific Fetch statics. */
function httpExecutor(
  run: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): HTTPExecutor {
  return Object.assign(run, {
    /** Allows runtimes to expose optional connection warming without affecting tests. */
    preconnect(): void {}
  })
}

/** Copies bytes into an ArrayBuffer Fetch accepts as a body. */
function copied(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

/** Builds one same-origin request for the portable example dial target. */
function request(
  path: string,
  body: Uint8Array | string | null = null,
  headers: HeadersInit = {},
  method = "POST"
): Request {
  const init: RequestInit = { method, headers }
  if (typeof body === "string") init.body = body
  else if (body !== null) init.body = copied(body)
  return new Request(`http://example.test:8080${path}`, init)
}

/** Starts one real loopback HTTP endpoint and returns its assigned port. */
async function listenPort(server: Server): Promise<number> {
  await new Promise<void>(function listen(resolve, reject): void {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (typeof address !== "object" || address === null) {
    throw new Error("redirect test server omitted its bound address")
  }
  return address.port
}

/** Closes one real loopback HTTP endpoint without retaining idle Fetch connections. */
async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections()
  if (!server.listening) return
  await new Promise<void>(function close(resolve, reject): void {
    server.close(function closed(error?: Error): void {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
}

/** Reads one real incoming request body as UTF-8. */
async function incomingText(value: IncomingMessage): Promise<string> {
  value.setEncoding("utf8")
  let body = ""
  for await (const chunk of value) body += String(chunk)
  return body
}

test("dial is validation-only and fetch preserves method, URL, and a detached body", async () => {
  const requests: Request[] = []
  const run = httpExecutor(function run(input) {
    const received = input instanceof Request ? input : new Request(input)
    requests.push(received)
    return Promise.resolve(new Response("world", { status: 200, headers: { "X-Reply": "yes" } }))
  })
  const transport = newHTTPTransport(executor(run))
  const client = await transport.dial(background(), "example.test:8080")
  expect(requests).toHaveLength(0)

  const body = new TextEncoder().encode("hello")
  const headers = { "X-Topic": "greeting", Connection: "close", Host: "evil.test" }
  const sent = request("/orders/Create", body, headers, "PUT")
  body.fill(0)
  headers["X-Topic"] = "mutated"
  const response = await client.fetch(background(), sent)

  expect(requests).toHaveLength(1)
  const outbound = requests[0]
  expect(outbound?.method).toBe("PUT")
  expect(outbound?.url).toBe("http://example.test:8080/orders/Create")
  expect(outbound?.redirect).toBe("manual")
  expect(outbound?.headers.get("X-Topic")).toBe("greeting")
  expect(outbound?.headers.get("connection")).toBeNull()
  expect(outbound?.headers.get("host")).toBeNull()
  expect(await outbound?.text()).toBe("hello")
  expect(response.status).toBe(200)
  expect(response.headers.get("x-reply")).toBe("yes")
  expect(await response.text()).toBe("world")
  await client.close(background())
})

test("rejects a non-root dial address and a cross-origin request before I/O", async () => {
  let calls = 0
  const run = httpExecutor(function run(): Promise<Response> {
    calls += 1
    return Promise.resolve(new Response())
  })
  const transport = newHTTPTransport(executor(run))
  await expect(transport.dial(background(), "http://example.test/rpc")).rejects.toThrow(
    "HTTP dial address must be a root URL without a path, query, or fragment; internal RPC paths are request URLs, not dial addresses"
  )
  const client = await transport.dial(background(), "http://example.test:8080/")
  await expect(
    client.fetch(background(), new Request("http://other.test/orders/Create", { method: "POST" }))
  ).rejects.toThrow("HTTP request must remain on its dial origin")
  await expect(client.fetch(background(), null as never)).rejects.toThrow(
    "HTTP client fetch requires a Request"
  )
  expect(calls).toBe(0)
  await client.close(background())
})

test("portable client does not follow a same-origin redirect", async () => {
  const server = createServer(function redirect(incoming, response): void {
    void incomingText(incoming).then(function replied(): void {
      response.writeHead(307, { location: "/next" }).end("stop")
    })
  })
  const port = await listenPort(server)
  try {
    const client = await newHTTPTransport().dial(background(), `127.0.0.1:${port}`)
    const response = await client.fetch(
      background(),
      new Request(`http://127.0.0.1:${port}/start`, { method: "POST", body: "hello" })
    )
    expect(response.status).toBe(307)
    expect(response.headers.get("location")).toBe("/next")
    expect(await response.text()).toBe("stop")
    await client.close(background())
  } finally {
    await closeServer(server)
  }
})

test("bounds request and response bodies by maxMessageBytes", async () => {
  const run = httpExecutor(function run(): Promise<Response> {
    return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 503 }))
  })
  const transport = newHTTPTransport(executor(run), maxMessageBytes(2))
  const client = await transport.dial(background(), "example.test:8080")
  await expect(
    client.fetch(
      background(),
      request("/orders/Create", new Uint8Array([1]), { "content-length": "3" })
    )
  ).rejects.toMatchObject({ code: "GO_LIKE_TRANSPORT_PROTOCOL" })
  await expect(
    client.fetch(background(), request("/orders/Create", new Uint8Array([1, 2, 3])))
  ).rejects.toMatchObject({ code: "GO_LIKE_TRANSPORT_PROTOCOL" })
  const response = await client.fetch(background(), request("/orders/Create", new Uint8Array([1])))
  expect(response.status).toBe(503)
  await expect(response.arrayBuffer()).rejects.toMatchObject({ code: "GO_LIKE_TRANSPORT_PROTOCOL" })
  await client.close(background())
})

test("preserves a caller cancellation and a request abort while headers are pending", async () => {
  const gate = deferred<void>()
  const run = httpExecutor(function run(): Promise<Response> {
    return gate.promise.then(function respond(): Response {
      return new Response("late")
    })
  })
  const client = await newHTTPTransport(executor(run)).dial(background(), "example.test:8080")
  const [ctx, cancel] = withCancelCause(background())
  const marker = new Error("caller canceled")
  const pending = client.fetch(ctx, request("/orders/Create", "one"))
  cancel(marker)
  await expect(pending).rejects.toBe(marker)

  const controller = new AbortController()
  const aborted = new Request("http://example.test:8080/orders/Create", {
    method: "POST",
    body: "two",
    signal: controller.signal
  })
  const second = client.fetch(background(), aborted)
  controller.abort(marker)
  await expect(second).rejects.toBe(marker)
  gate.resolve(undefined)
  await client.close(background())
})

test("header and body timeouts use the earlier deadline and release the body", async () => {
  const headerGate = deferred<Response>()
  const headerRun = httpExecutor(function run(): Promise<Response> {
    return headerGate.promise
  })
  const headerTransport = newHTTPTransport(executor(headerRun))
  headerTransport.init(timeout(1_000))
  const headerClient = await headerTransport.dial(
    background(),
    "example.test:8080",
    withDialTimeout(20)
  )
  await expect(headerClient.fetch(background(), request("/orders/Create", "x"))).rejects.toBe(
    deadlineExceeded
  )
  headerGate.resolve(new Response("late"))
  await headerClient.close(background())

  let canceledBodies = 0
  const bodyRun = httpExecutor(function run(): Promise<Response> {
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(): void {},
          cancel(): void {
            canceledBodies += 1
          }
        })
      )
    )
  })
  const bodyTransport = newHTTPTransport(executor(bodyRun))
  bodyTransport.init(timeout(30))
  const bodyClient = await bodyTransport.dial(
    background(),
    "example.test:8080",
    withDialTimeout(1_000)
  )
  const response = await bodyClient.fetch(background(), request("/orders/Create", "x"))
  await new Promise<void>(function wait(resolve): void {
    setTimeout(resolve, 50)
  })
  expect(canceledBodies).toBe(1)
  await expect(response.arrayBuffer()).rejects.toBeDefined()
  await bodyClient.close(background())
})

test("F5 text/plain caller deadline rejects the unread tail", async () => {
  const bodyRun = httpExecutor(function run(): Promise<Response> {
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          /** Publishes one chunk and leaves the tail open. */
          start(controller): void {
            controller.enqueue(new TextEncoder().encode("hello"))
          }
        }),
        { headers: { "content-type": "text/plain" } }
      )
    )
  })
  const client = await newHTTPTransport(executor(bodyRun)).dial(background(), "example.test:8080")
  const [ctx, cancel] = withTimeout(background(), 40)
  try {
    const response = await client.fetch(ctx, request("/orders/Create", "x"))
    await expect(response.text()).rejects.toBe(deadlineExceeded)
  } finally {
    cancel()
    await client.close(background())
  }
})

test("a jumped clock after headers rejects when the common timeout is already exhausted", async () => {
  const realNow = Date.now
  let now = realNow()
  Date.now = function frozen(): number {
    return now
  }
  try {
    const run = httpExecutor(function run(): Promise<Response> {
      now += 50
      return Promise.resolve(new Response("late"))
    })
    const transport = newHTTPTransport(executor(run))
    transport.init(timeout(20))
    const client = await transport.dial(background(), "example.test:8080")
    await expect(client.fetch(background(), request("/orders/Create", "x"))).rejects.toBe(
      deadlineExceeded
    )
    await client.close(background())
  } finally {
    Date.now = realNow
  }
})

test("close aborts an in-flight body read and a returned response body", async () => {
  let releases = 0
  const body = new ReadableStream<Uint8Array>({
    pull(): void {},
    cancel(): void {
      releases += 1
    }
  })
  const run = httpExecutor(function run(): Promise<Response> {
    return Promise.resolve(new Response("ok"))
  })
  const client = await newHTTPTransport(executor(run)).dial(background(), "example.test:8080")
  const reading = client.fetch(
    background(),
    new Request("http://example.test:8080/orders/Create", { method: "POST", body })
  )
  await Promise.resolve()
  await client.close(background())
  await expect(reading).rejects.toMatchObject({ code: "GO_LIKE_TRANSPORT_CLOSED" })
  expect(releases).toBeGreaterThan(0)
  await expect(client.fetch(background(), request("/orders/Create", "x"))).rejects.toMatchObject({
    code: "GO_LIKE_TRANSPORT_CLOSED"
  })

  let responseCancels = 0
  const open = await newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              pull(): void {},
              cancel(): void {
                responseCancels += 1
              }
            })
          )
        )
      })
    )
  ).dial(background(), "example.test:8080")
  const response = await open.fetch(background(), request("/orders/Create", "x"))
  await open.close(background())
  expect(responseCancels).toBe(1)
  await expect(response.arrayBuffer()).rejects.toBeDefined()
})

test("close reentered from response-body cancellation resolves without deadlock", async () => {
  let clientClose: Promise<void> | null = null
  const client = await newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              pull(): void {},
              cancel(): void {
                clientClose = client.close(background())
              }
            })
          )
        )
      })
    )
  ).dial(background(), "example.test:8080")
  await client.fetch(background(), request("/orders/Create", "x"))
  await client.close(background())
  await clientClose
  await expect(client.close(background())).resolves.toBeUndefined()
})

test("logs response cleanup failure and preserves executor close failure", async () => {
  const logged: unknown[] = []
  const cleanup = new Error("body cancel failed")
  const transport = newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              pull(): void {},
              cancel(): Promise<void> {
                return Promise.reject(cleanup)
              }
            })
          )
        )
      })
    )
  )
  transport.init(
    logger({
      log(
        level: TransportLogLevel,
        _message: string,
        fields?: Readonly<Record<string, unknown>>
      ): void {
        logged.push([level, fields?.cause])
      }
    })
  )
  const client = await transport.dial(background(), "example.test:8080")
  await client.fetch(background(), request("/orders/Create", "x"))
  await expect(client.close(background())).resolves.toBeUndefined()
  expect(logged.length).toBeGreaterThan(0)

  const failure = new Error("executor close failed")
  const owned = await newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(new Response(null, { status: 204 }))
      })
    )
  ).dial(background(), "example.test:8080")
  await owned.fetch(background(), request("/orders/Create"))
  await owned.close(background())

  const rejecting = newHTTPTransport(
    executor(function execute(): Promise<Response> {
      return Promise.resolve(new Response(null, { status: 204 }))
    })
  )
  void rejecting
  const preCanceled = withCancelCause(background())
  preCanceled[1](failure)
  const closedClient = await newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(new Response("x"))
      })
    )
  ).dial(background(), "example.test:8080")
  await expect(closedClient.close(preCanceled[0])).rejects.toBe(failure)
  await expect(
    closedClient.fetch(background(), request("/orders/Create", "x"))
  ).resolves.toBeInstanceOf(Response)
})

test("executor failures stay local and non-Response results are protocol errors", async () => {
  const syncFailure = new Error("executor threw")
  const syncClient = await newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        throw syncFailure
      })
    )
  ).dial(background(), "example.test:8080")
  await expect(syncClient.fetch(background(), request("/orders/Create", "x"))).rejects.toBe(
    syncFailure
  )
  await syncClient
    .fetch(background(), request("/orders/Create", "x"))
    .catch(function ignore(): void {})
  const marker = Object.freeze({ phase: "executor" })
  const weird = await newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.reject(marker)
      })
    )
  ).dial(background(), "example.test:8080")
  await expect(weird.fetch(background(), request("/orders/Create", "x"))).rejects.toMatchObject({
    message: "HTTP executor rejected",
    cause: marker
  })
  const empty = await newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(null as never)
      })
    )
  ).dial(background(), "example.test:8080")
  await expect(empty.fetch(background(), request("/orders/Create", "x"))).rejects.toMatchObject({
    code: "GO_LIKE_TRANSPORT_PROTOCOL",
    message: "HTTP executor must return Response"
  })
  await syncClient.close(background())
  await weird.close(background())
  await empty.close(background())
})

test("a caller timeout Context rejects before dial admission", async () => {
  const [ctx, cancel] = withCancel(background())
  cancel()
  await expect(newHTTPTransport().dial(ctx, "example.test:8080")).rejects.toBe(canceled)
  const [timed, stopTimer] = withTimeout(background(), 0)
  await expect(newHTTPTransport().dial(timed, "example.test:8080")).rejects.toBe(deadlineExceeded)
  stopTimer()
})

test("close observes an active caller signal and a late closed response", async () => {
  const [openCtx, stopOpen] = withCancel(background())
  const opened = await newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(new Response("x"))
      })
    )
  ).dial(background(), "example.test:8080")
  await expect(opened.close(openCtx)).resolves.toBeUndefined()
  stopOpen()

  const { newHTTPTransportWithDialExecutor } = await import("../src/transport")
  const closeFailure = new Error("executor close rejected")
  const [rejectCtx, stopReject] = withCancel(background())
  const rejecting = await newHTTPTransportWithDialExecutor(
    function factory(_target, _common, _dial, fallback) {
      return {
        executor: fallback,
        close(): Promise<void> {
          return Promise.reject(closeFailure)
        }
      }
    }
  ).dial(background(), "example.test:8080")
  await expect(rejecting.close(rejectCtx)).rejects.toBe(closeFailure)
  stopReject()

  const [cancelCtx, cancelClose] = withCancel(background())
  const canceling = await newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(new Response(null, { status: 204 }))
      })
    )
  ).dial(background(), "example.test:8080")
  const closing = canceling.close(cancelCtx)
  cancelClose()
  await expect(closing).rejects.toBe(canceled)

  let checks = 0
  const signal = new AbortController().signal
  const root = background()
  const flipping: Context = {
    deadline: () => root.deadline(),
    done: () => signal,
    err(): Error | null {
      checks += 1
      return checks < 3 ? null : canceled
    },
    value: (key) => root.value(key)
  }
  const flippingClient = await newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(new Response(null, { status: 204 }))
      })
    )
  ).dial(background(), "example.test:8080")
  await expect(flippingClient.close(flipping)).rejects.toBe(canceled)

  let releaseExecutor = null as ((response: Response) => void) | null
  let executorStarted: (() => void) | null = null
  const executorReady = new Promise<void>(function capture(resolve): void {
    executorStarted = resolve
  })
  const owned = await newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return new Promise<Response>(function pending(resolve): void {
          releaseExecutor = resolve
          executorStarted?.()
        })
      })
    )
  ).dial(background(), "example.test:8080")
  let lateCancels = 0
  const pending = owned.fetch(background(), request("/orders/Create", "x"))
  await executorReady
  const abortFailure = new Error("abort threw")
  const originalAbort = AbortController.prototype.abort
  AbortController.prototype.abort = function throwAbort(): void {
    throw abortFailure
  }
  let closingOwner: Promise<void>
  try {
    closingOwner = owned.close(background())
  } finally {
    AbortController.prototype.abort = originalAbort
  }
  const closeResult = closingOwner.then(
    function resolved(): Error {
      return new Error("close resolved")
    },
    function rejected(error: unknown): unknown {
      return error
    }
  )
  const fetchResult = pending.then(
    function resolved(): Error {
      return new Error("fetch resolved")
    },
    function rejected(error: unknown): unknown {
      return error
    }
  )
  releaseExecutor?.(
    new Response(
      new ReadableStream<Uint8Array>({
        pull(): void {},
        cancel(): void {
          lateCancels += 1
        }
      })
    )
  )
  expect(await closeResult).toBe(abortFailure)
  expect(await fetchResult).toMatchObject({ code: "GO_LIKE_TRANSPORT_CLOSED" })
  expect(lateCancels).toBe(1)

  const caller = new AbortController()
  let abandoned = 0
  const aborting = await newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Object.assign(Promise.resolve(new Response(null)), {
          then(resolve: (response: Response) => void, _reject: (error: unknown) => void): void {
            resolve(
              new Response(
                new ReadableStream<Uint8Array>({
                  pull(): void {},
                  cancel(): void {
                    abandoned += 1
                  }
                })
              )
            )
            caller.abort(new Error("late abort"))
          }
        }) as Promise<Response>
      })
    )
  ).dial(background(), "example.test:8080")
  const late = new Request("http://example.test:8080/orders/Create", {
    method: "POST",
    body: "x",
    signal: caller.signal
  })
  await expect(aborting.fetch(background(), late)).rejects.toMatchObject({ message: "late abort" })
  expect(abandoned).toBe(2)
  await aborting.close(background())

  const locked = await newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              pull(): void {}
            })
          )
        )
      })
    )
  ).dial(background(), "example.test:8080")
  const lockedResponse = await locked.fetch(background(), request("/orders/Create", "x"))
  const reader = lockedResponse.body?.getReader()
  if (reader === undefined) throw new Error("response body was missing")
  const originalCancel = ReadableStream.prototype.cancel
  ReadableStream.prototype.cancel = function throwCancel(): Promise<void> {
    throw new Error("cancel threw")
  }
  try {
    await expect(locked.close(background())).resolves.toBeUndefined()
  } finally {
    ReadableStream.prototype.cancel = originalCancel
  }
  await expect(reader.read()).rejects.toBeDefined()
  reader.releaseLock()

  const NativeRequest = globalThis.Request
  let requestMode: "error" | "string" = "error"
  globalThis.Request = class ThrowingRequest extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      if (init?.redirect === "manual") {
        if (requestMode === "error") throw new Error("rejected request")
        throw "rejected request"
      }
      super(input, init)
    }
  }
  try {
    const rejectingRequest = await newHTTPTransport(
      executor(
        httpExecutor(function run(): Promise<Response> {
          return Promise.resolve(new Response("x"))
        })
      )
    ).dial(background(), "example.test:8080")
    await expect(
      rejectingRequest.fetch(background(), request("/orders/Create", "x"))
    ).rejects.toMatchObject({
      code: "GO_LIKE_TRANSPORT_PROTOCOL",
      message: "invalid HTTP Fetch request",
      cause: { message: "rejected request" }
    })
    requestMode = "string"
    await expect(
      rejectingRequest.fetch(background(), request("/orders/Create", "x"))
    ).rejects.toMatchObject({
      code: "GO_LIKE_TRANSPORT_PROTOCOL",
      message: "invalid HTTP Fetch request"
    })
    await rejectingRequest.close(background())
  } finally {
    globalThis.Request = NativeRequest
  }

  const invalidURL = await newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(new Response("x"))
      })
    )
  ).dial(background(), "example.test:8080")
  const badURL = new Proxy(request("/orders/Create", "x"), {
    get(target, property, receiver): unknown {
      if (property === "url") throw new Error("bad url")
      return Reflect.get(target, property, receiver)
    }
  })
  await expect(invalidURL.fetch(background(), badURL)).rejects.toMatchObject({
    code: "GO_LIKE_TRANSPORT_PROTOCOL",
    message: "invalid HTTP Fetch request",
    cause: { message: "bad url" }
  })
  const badValue = new Proxy(request("/orders/Create", "x"), {
    get(target, property, receiver): unknown {
      if (property === "url") throw "bad url"
      return Reflect.get(target, property, receiver)
    }
  })
  await expect(invalidURL.fetch(background(), badValue)).rejects.toMatchObject({
    code: "GO_LIKE_TRANSPORT_PROTOCOL",
    message: "invalid HTTP Fetch request"
  })
  await invalidURL.close(background())

  const already = new AbortController()
  const alreadyReason = new Error("already aborted")
  already.abort(alreadyReason)
  const earlyClient = await newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(new Response("x"))
      })
    )
  ).dial(background(), "example.test:8080")
  await expect(
    earlyClient.fetch(
      background(),
      new Request("http://example.test:8080/orders/Create", {
        method: "POST",
        signal: already.signal
      })
    )
  ).rejects.toBe(alreadyReason)
  await earlyClient.close(background())
})
