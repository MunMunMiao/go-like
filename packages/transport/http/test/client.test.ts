import { createServer, type IncomingMessage, type Server } from "node:http"

import { expect, test } from "bun:test"

import {
  background,
  canceled,
  deadlineExceeded,
  withCancel,
  withCancelCause
} from "@go-like/context"
import type { Client, Message, TransportLogLevel } from "@go-like/transport"
import { logger, timeout, withTimeout as withDialTimeout } from "@go-like/transport"
import { executor, newHTTPTransport, type HTTPExecutor } from "@go-like/transport-http"
import { runHTTPClientCleanupMatrix } from "./client-cleanup-matrix"

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

/** Creates one immutable transport Message fixture. */
function message(value: string, header: Readonly<Record<string, string>> = {}): Message {
  return Object.freeze({ header: Object.freeze(header), body: new TextEncoder().encode(value) })
}

/** Decodes one Message body for readable assertions. */
function text(value: Message): string {
  return new TextDecoder().decode(value.body)
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
async function incomingText(request: IncomingMessage): Promise<string> {
  request.setEncoding("utf8")
  let body = ""
  for await (const chunk of request) body += String(chunk)
  return body
}

test("client cleanup distinguishes synchronous close admission from terminal ownership", async () => {
  expect(await runHTTPClientCleanupMatrix()).toEqual({
    valid: true,
    activeReaderOwnerCycle: true,
    activeReaderIndependentResolve: true,
    activeReaderIndependentReject: true,
    statusOwnerCycle: true,
    multipleSlotAdmission: true,
    nonReentrantPendingJoin: true,
    callerCancellationJoin: true,
    duplicateOwnerIdentity: true,
    unhandled: 0
  })
})

test("dial is validation-only and send emits a defensive standard Fetch POST", async () => {
  const requests: Request[] = []
  const run = httpExecutor(function run(input, init) {
    const request = new Request(input, init)
    requests.push(request)
    return Promise.resolve(
      new Response("world", {
        status: 200,
        headers: { "Go-Like-Reply": "yes" }
      })
    )
  })
  const transport = newHTTPTransport(executor(run))
  const client = await transport.dial(background(), "example.test:8080")
  expect(requests).toHaveLength(0)

  const body = new TextEncoder().encode("hello")
  const headers = { "Go-Like-Topic": "greeting" }
  const sent = Object.freeze({ header: headers, body })
  const send = client.send(background(), sent)
  body.fill(0)
  headers["Go-Like-Topic"] = "mutated"
  await send

  expect(requests).toHaveLength(1)
  const request = requests[0]
  expect(request).toBeDefined()
  expect(request?.method).toBe("POST")
  expect(request?.url).toBe("http://example.test:8080/")
  expect(request?.headers.get("Go-Like-Topic")).toBe("greeting")
  expect(await request?.text()).toBe("hello")

  const received = await client.recv(background())
  expect(text(received)).toBe("world")
  expect(received.header["go-like-reply"]).toBe("yes")
  expect(client.local()).toBe("")
  expect(client.remote()).toBe("http://example.test:8080")
})

test("portable client does not follow a same-origin 307 redirect", async () => {
  const sourceRequests: Array<Readonly<Record<string, string | readonly string[] | undefined>>> = []
  let destinationRequests = 0
  const server = createServer(async function redirect(request, response): Promise<void> {
    if (request.url === "/destination") {
      destinationRequests += 1
      response.writeHead(200)
      response.end("redirected")
      return
    }
    sourceRequests.push(
      Object.freeze({
        body: await incomingText(request),
        custom: request.headers["x-redirect-test"],
        service: request.headers["go-like-service"],
        endpoint: request.headers["go-like-endpoint"],
        metadata: request.headers["go-like-metadata"]
      })
    )
    response.writeHead(307, { Location: "/destination" })
    response.end("same-origin redirect")
  })
  try {
    const port = await listenPort(server)
    const client = await newHTTPTransport().dial(background(), `http://127.0.0.1:${port}/source`)
    try {
      await client.send(
        background(),
        message("same-origin body", {
          "X-Redirect-Test": "same-origin custom",
          "Go-Like-Service": "orders",
          "Go-Like-Endpoint": "create",
          "Go-Like-Metadata": "same-origin metadata"
        })
      )
      await expect(client.recv(background())).rejects.toMatchObject({
        name: "HTTPStatusError",
        code: "GO_LIKE_HTTP_STATUS",
        status: 307
      })
      expect(sourceRequests).toEqual([
        {
          body: "same-origin body",
          custom: "same-origin custom",
          service: "orders",
          endpoint: "create",
          metadata: "same-origin metadata"
        }
      ])
      expect(destinationRequests).toBe(0)
    } finally {
      await client.close(background())
    }
  } finally {
    await closeServer(server)
  }
})

test("portable client does not leak internal metadata across a 307 redirect origin", async () => {
  const destinationMetadata: Array<string | readonly string[] | undefined> = []
  let destinationRequests = 0
  const destination = createServer(function receive(request, response): void {
    destinationRequests += 1
    destinationMetadata.push(request.headers["go-like-metadata"])
    response.writeHead(200)
    response.end("redirected")
  })
  const destinationPort = await listenPort(destination)
  const sourceRequests: Array<Readonly<Record<string, string | readonly string[] | undefined>>> = []
  const source = createServer(async function redirect(request, response): Promise<void> {
    sourceRequests.push(
      Object.freeze({
        body: await incomingText(request),
        custom: request.headers["x-redirect-test"],
        service: request.headers["go-like-service"],
        endpoint: request.headers["go-like-endpoint"],
        metadata: request.headers["go-like-metadata"]
      })
    )
    response.writeHead(307, {
      Location: `http://127.0.0.1:${destinationPort}/destination`
    })
    response.end("cross-origin redirect")
  })
  try {
    const sourcePort = await listenPort(source)
    const client = await newHTTPTransport().dial(
      background(),
      `http://127.0.0.1:${sourcePort}/source`
    )
    try {
      await client.send(
        background(),
        message("cross-origin body", {
          "X-Redirect-Test": "cross-origin custom",
          "Go-Like-Service": "payments",
          "Go-Like-Endpoint": "capture",
          "Go-Like-Metadata": "cross-origin secret metadata"
        })
      )
      await expect(client.recv(background())).rejects.toMatchObject({
        name: "HTTPStatusError",
        code: "GO_LIKE_HTTP_STATUS",
        status: 307
      })
      expect(sourceRequests).toEqual([
        {
          body: "cross-origin body",
          custom: "cross-origin custom",
          service: "payments",
          endpoint: "capture",
          metadata: "cross-origin secret metadata"
        }
      ])
      expect(destinationRequests).toBe(0)
      expect(destinationMetadata).toEqual([])
    } finally {
      await client.close(background())
    }
  } finally {
    await Promise.all([closeServer(source), closeServer(destination)])
  }
})

test("serial send invocation creates provisional FIFO slots", async () => {
  const first = deferred<Response>()
  const second = deferred<Response>()
  const calls: Request[] = []
  const run = httpExecutor(function run(input, init) {
    calls.push(new Request(input, init))
    return calls.length === 1 ? first.promise : second.promise
  })
  const client = await newHTTPTransport(executor(run)).dial(background(), "http://example.test/rpc")

  const sendOne = client.send(background(), message("one"))
  const recvOne = client.recv(background())
  const sendTwo = client.send(background(), message("two"))
  await Promise.resolve()
  expect(calls).toHaveLength(1)

  first.resolve(new Response("response-one"))
  await sendOne
  expect(text(await recvOne)).toBe("response-one")
  await Promise.resolve()
  expect(calls).toHaveLength(2)

  const recvTwo = client.recv(background())
  second.resolve(new Response("response-two"))
  await sendTwo
  expect(text(await recvTwo)).toBe("response-two")
})

test("recv requires a prior send and permits only one active receiver", async () => {
  const pending = deferred<Response>()
  const run = httpExecutor(function run() {
    return pending.promise
  })
  const client = await newHTTPTransport(executor(run)).dial(background(), "localhost:8080")

  await expect(client.recv(background())).rejects.toMatchObject({ code: "GO_LIKE_TRANSPORT_STATE" })
  const send = client.send(background(), message("request"))
  const recv = client.recv(background())
  await expect(client.recv(background())).rejects.toMatchObject({ code: "GO_LIKE_TRANSPORT_STATE" })
  pending.resolve(new Response("response"))
  await send
  await recv
})

test("one network failure preserves identity for claimed recv and does not poison later send", async () => {
  const failure = new Error("network failed")
  let call = 0
  const run = httpExecutor(function run() {
    call += 1
    return call === 1 ? Promise.reject(failure) : Promise.resolve(new Response("recovered"))
  })
  const client = await newHTTPTransport(executor(run)).dial(background(), "localhost:8080")
  const [liveContext] = withCancel(background())

  const firstSend = client.send(liveContext, message("first"))
  const firstRecv = client.recv(liveContext)
  const results = await Promise.allSettled([firstSend, firstRecv])
  expect(results[0]).toEqual({ status: "rejected", reason: failure })
  expect(results[1]).toEqual({ status: "rejected", reason: failure })

  const secondSend = client.send(background(), message("second"))
  const secondRecv = client.recv(background())
  await secondSend
  expect(text(await secondRecv)).toBe("recovered")
})

test("send validates Context and managed headers before executor I/O", async () => {
  let calls = 0
  const run = httpExecutor(function run() {
    calls += 1
    return Promise.resolve(new Response())
  })
  const client = await newHTTPTransport(executor(run)).dial(background(), "localhost:8080")
  const [ctx, cancel] = withCancel(background())
  cancel()

  await expect(client.send(ctx, message("x"))).rejects.toBe(canceled)
  await expect(
    client.send(background(), message("x", { "Content-Length": "1" }))
  ).rejects.toMatchObject({ code: "GO_LIKE_TRANSPORT_PROTOCOL" })
  await expect(
    client.send(background(), message("x", { Connection: "close" }))
  ).rejects.toMatchObject({ code: "GO_LIKE_TRANSPORT_PROTOCOL" })
  expect(calls).toBe(0)
})

test("preserves a custom Context cause while response headers are pending", async () => {
  const execution = deferred<Response>()
  const observedSignals: AbortSignal[] = []
  const run = httpExecutor(function run(input, init) {
    observedSignals.push(new Request(input, init).signal)
    return execution.promise
  })
  const client = await newHTTPTransport(executor(run)).dial(background(), "localhost:8080")
  const [ctx, cancel] = withCancelCause(background())
  const customCause = new Error("caller canceled pending headers")
  const sending = client.send(ctx, message("request"))
  const receiving = client.recv(ctx)
  await Promise.resolve()

  cancel(customCause)

  const settled = await Promise.allSettled([sending, receiving])
  expect(settled).toEqual([
    { status: "rejected", reason: customCause },
    { status: "rejected", reason: customCause }
  ])
  expect(observedSignals[0]?.aborted).toBe(true)
  expect(observedSignals[0]?.reason).toBe(customCause)
  await client.close(background())
})

test("preserves a custom Context cause while the response body is pending", async () => {
  const reading = deferred<void>()
  let canceledBodies = 0
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(): void {
        reading.resolve()
      },
      cancel(): void {
        canceledBodies += 1
      }
    })
  )
  const run = httpExecutor(function run() {
    return Promise.resolve(response)
  })
  const client = await newHTTPTransport(executor(run)).dial(background(), "localhost:8080")
  const [ctx, cancel] = withCancelCause(background())
  const customCause = new Error("caller canceled pending body")
  const sending = client.send(ctx, message("request"))
  const receiving = client.recv(ctx)
  await sending
  await reading.promise

  cancel(customCause)

  await expect(receiving).rejects.toBe(customCause)
  expect(canceledBodies).toBe(1)
  await client.close(background())
})

test("close aborts in-flight work and exposes one stable closed error", async () => {
  const observedSignals: AbortSignal[] = []
  const never = deferred<Response>()
  const run = httpExecutor(function run(input, init) {
    const request = new Request(input, init)
    observedSignals.push(request.signal)
    return never.promise
  })
  const client = await newHTTPTransport(executor(run)).dial(background(), "localhost:8080")
  const send = client.send(background(), message("request"))
  const recv = client.recv(background())
  await Promise.resolve()
  await client.close(background())

  expect(observedSignals[0]?.aborted).toBe(true)
  const settled = await Promise.allSettled([send, recv])
  expect(settled[0].status).toBe("rejected")
  expect(settled[1].status).toBe("rejected")
  const first = client.send(background(), message("later"))
  const second = client.recv(background())
  const closed = await Promise.allSettled([first, second])
  expect(closed[0].status).toBe("rejected")
  expect(closed[1].status).toBe("rejected")
  if (closed[0].status === "rejected" && closed[1].status === "rejected") {
    expect(closed[0].reason).toBe(closed[1].reason)
    expect(closed[0].reason).toMatchObject({ code: "GO_LIKE_TRANSPORT_CLOSED" })
  }
})

test("close publishes its owner promise before an executor AbortSignal listener reenters", async () => {
  const execution = deferred<Response>()
  let client: Client | null = null
  let reentrantClose: Promise<void> | null = null
  let abortCalls = 0
  /** Reads callback-owned close state without assuming synchronous assignment. */
  function observedReentrantClose(): Promise<void> | null {
    return reentrantClose
  }
  const run = httpExecutor(function run(input, init): Promise<Response> {
    const request = new Request(input, init)
    request.signal.addEventListener(
      "abort",
      function reenterClose(): void {
        abortCalls += 1
        const activeClient = client
        if (activeClient === null) throw new Error("client was not assigned before send")
        reentrantClose = activeClient.close(background())
      },
      { once: true }
    )
    return execution.promise
  })
  client = await newHTTPTransport(executor(run)).dial(background(), "localhost:8080")
  const sending = client.send(background(), message("request"))
  await Promise.resolve()

  const outerClose = client.close(background())
  expect(observedReentrantClose()).toBe(outerClose)
  expect(abortCalls).toBe(1)
  await expect(outerClose).resolves.toBeUndefined()
  await expect(sending).rejects.toMatchObject({ code: "GO_LIKE_TRANSPORT_CLOSED" })
  expect(client.close(background())).toBe(outerClose)
})

test("slot cleanup publishes one sentinel before every response cancellation reentry boundary", async () => {
  type CancellationBoundary =
    | "body-getter"
    | "cancel-getter"
    | "cancel-call"
    | "then-getter"
    | "then-call"
  const boundaries: readonly CancellationBoundary[] = Object.freeze([
    "body-getter",
    "cancel-getter",
    "cancel-call",
    "then-getter",
    "then-call"
  ])

  for (const boundary of boundaries) {
    const completion = deferred<void>()
    let client: Client | null = null
    let reentrantClose: Promise<void> | null = null
    let reentryStarted = false
    let bodyGetterCalls = 0
    let cancelGetterCalls = 0
    let cancelCalls = 0
    let thenGetterCalls = 0
    let thenCallCalls = 0
    let cancelReceiver: unknown = null
    /** Reads callback-owned close state without assuming synchronous assignment. */
    function observedReentrantClose(): Promise<void> | null {
      return reentrantClose
    }
    /** Reenters the client owner exactly once from the selected third-party boundary. */
    function reenter(): void {
      if (reentryStarted) return
      reentryStarted = true
      const activeClient = client
      if (activeClient === null) throw new Error("client was not assigned before cleanup")
      reentrantClose = activeClient.close(background())
    }
    const body = new ReadableStream<Uint8Array>({ pull(): void {} })
    /** Returns one pending body cleanup or a hostile pending thenable. */
    function cancelBody(this: unknown) {
      cancelCalls += 1
      // oxlint-disable-next-line typescript/no-this-alias
      cancelReceiver = this
      if (boundary === "cancel-call") reenter()
      if (boundary === "then-getter" || boundary === "then-call") {
        return Object.freeze({
          /** Exposes a hostile then boundary while still representing real pending cleanup. */
          get then() {
            thenGetterCalls += 1
            if (boundary === "then-getter") reenter()
            return function settleThenable(
              resolve: (value: void) => void,
              reject: (reason: unknown) => void
            ): void {
              thenCallCalls += 1
              if (boundary === "then-call") reenter()
              void completion.promise.then(resolve, reject)
            }
          }
        })
      }
      return completion.promise
    }
    if (boundary === "cancel-getter") {
      Object.defineProperty(body, "cancel", {
        configurable: true,
        /** Reenters while the borrowed cancel method is read. */
        get() {
          cancelGetterCalls += 1
          reenter()
          return cancelBody
        }
      })
    } else {
      Object.defineProperty(body, "cancel", {
        configurable: true,
        value: cancelBody
      })
    }
    const response = new Response(body)
    if (boundary === "body-getter") {
      Object.defineProperty(response, "body", {
        configurable: true,
        /** Reenters while the transferred Response body is read. */
        get(): ReadableStream<Uint8Array> {
          bodyGetterCalls += 1
          reenter()
          return body
        }
      })
    }
    client = await newHTTPTransport(
      executor(
        httpExecutor(function run(): Promise<Response> {
          return Promise.resolve(response)
        })
      )
    ).dial(background(), "localhost:8080")
    await client.send(background(), message("request"))

    const outerClose = client.close(background())
    let settled = false
    void outerClose.then(function markSettled(): void {
      settled = true
    })
    await Promise.resolve()
    await Promise.resolve()

    if (boundary === "cancel-call") {
      expect(observedReentrantClose()).not.toBe(outerClose)
    } else {
      expect(observedReentrantClose()).toBe(outerClose)
    }
    expect(client.close(background())).toBe(outerClose)
    expect(cancelCalls).toBe(1)
    expect(cancelReceiver).toBe(body)
    expect(bodyGetterCalls).toBe(boundary === "body-getter" ? 1 : 0)
    expect(cancelGetterCalls).toBe(boundary === "cancel-getter" ? 1 : 0)
    expect(thenGetterCalls).toBe(boundary === "then-getter" || boundary === "then-call" ? 1 : 0)
    expect(thenCallCalls).toBe(boundary === "then-getter" || boundary === "then-call" ? 1 : 0)
    expect(settled).toBe(false)

    completion.resolve(undefined)
    await expect(outerClose).resolves.toBeUndefined()
  }
})

test("slot cleanup breaks an exact cycle with a distinct synchronous admission", async () => {
  let client: Client | null = null
  let reentrantClose: Promise<void> | null = null
  let cancelCalls = 0
  const body = new ReadableStream<Uint8Array>({ pull(): void {} })
  Object.defineProperty(body, "cancel", {
    configurable: true,
    /** Returns the reentrant admission Promise that prevents owner self-wait. */
    value(): Promise<void> {
      cancelCalls += 1
      const activeClient = client
      if (activeClient === null) throw new Error("client was not assigned before cleanup")
      const admission = activeClient.close(background())
      reentrantClose = admission
      return admission
    }
  })
  client = await newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(new Response(body))
      })
    )
  ).dial(background(), "localhost:8080")
  await client.send(background(), message("request"))

  const ownerClose = client.close(background())
  let timer: ReturnType<typeof setTimeout> | null = null
  const settled = await Promise.race([
    ownerClose.then(function ownerSettled(): boolean {
      return true
    }),
    new Promise<boolean>(function timeout(resolve): void {
      timer = setTimeout(function expired(): void {
        resolve(false)
      }, 20)
    })
  ])
  if (timer !== null) clearTimeout(timer)

  /** Reads callback-owned close state without assuming synchronous assignment. */
  function observedReentrantClose(): Promise<void> | null {
    return reentrantClose
  }
  expect(settled).toBe(true)
  expect(observedReentrantClose()).not.toBe(ownerClose)
  expect(client.close(background())).toBe(ownerClose)
  expect(cancelCalls).toBe(1)
})

test("executor synchronous and non-Error failures preserve one slot identity", async () => {
  const original = new Error("synchronous failure")
  const sync = httpExecutor(function sync(): Promise<Response> {
    throw original
  })
  const client = await newHTTPTransport(executor(sync)).dial(background(), "localhost:8080")
  const sending = client.send(background(), message("request"))
  const receiving = client.recv(background())
  const settled = await Promise.allSettled([sending, receiving])
  expect(settled[0]).toEqual({ status: "rejected", reason: original })
  expect(settled[1]).toEqual({ status: "rejected", reason: original })

  const nonError = httpExecutor(function nonError(): Promise<Response> {
    return Promise.reject("network-string")
  })
  const second = await newHTTPTransport(executor(nonError)).dial(background(), "localhost:8080")
  const secondSend = second.send(background(), message("request"))
  const secondRecv = second.recv(background())
  const normalized = await Promise.allSettled([secondSend, secondRecv])
  if (normalized[0].status === "rejected" && normalized[1].status === "rejected") {
    expect(normalized[0].reason).toBeInstanceOf(Error)
    expect(normalized[0].reason).toBe(normalized[1].reason)
  } else {
    throw new Error("non-Error executor rejection unexpectedly fulfilled")
  }
})

test("executor output and response body protocol failures stay slot-local", async () => {
  const invalid = httpExecutor(function invalid(): Promise<Response> {
    return Promise.resolve(Reflect.get({}, "missing"))
  })
  const client = await newHTTPTransport(executor(invalid)).dial(background(), "localhost:8080")
  const sending = client.send(background(), message("request"))
  const receiving = client.recv(background())
  const invalidResults = await Promise.allSettled([sending, receiving])
  for (const result of invalidResults) {
    expect(result.status).toBe("rejected")
    if (result.status === "rejected") {
      expect(result.reason).toMatchObject({ code: "GO_LIKE_TRANSPORT_PROTOCOL" })
    }
  }

  for (const failure of [new Error("body failed"), "body failed"]) {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        /** Rejects owned response consumption with the selected hostile value. */
        pull(controller): void {
          controller.error(failure)
        }
      }),
      { status: 200 }
    )
    const run = httpExecutor(function run(): Promise<Response> {
      return Promise.resolve(response)
    })
    const bodyClient = await newHTTPTransport(executor(run)).dial(background(), "localhost:8080")
    await bodyClient.send(background(), message("request"))
    await expect(bodyClient.recv(background())).rejects.toMatchObject({
      code: "GO_LIKE_TRANSPORT_PROTOCOL"
    })
  }
})

test("the earliest configured response-header timeout rejects send and claimed recv identically", async () => {
  const never = deferred<Response>()
  const run = httpExecutor(function run(): Promise<Response> {
    return never.promise
  })
  const transport = newHTTPTransport(executor(run))
  transport.init(timeout(2))
  const client = await transport.dial(background(), "localhost:8080", withDialTimeout(100))
  const sending = client.send(background(), message("request"))
  const receiving = client.recv(background())
  const settled = await Promise.allSettled([sending, receiving])
  expect(settled[0]).toEqual({ status: "rejected", reason: deadlineExceeded })
  expect(settled[1]).toEqual({ status: "rejected", reason: deadlineExceeded })
})

test("dial timeout alone bounds pending response headers", async () => {
  const never = deferred<Response>()
  const run = httpExecutor(function run(): Promise<Response> {
    return never.promise
  })
  const client = await newHTTPTransport(executor(run)).dial(
    background(),
    "localhost:8080",
    withDialTimeout(2)
  )
  const sending = client.send(background(), message("request"))
  const receiving = client.recv(background())
  const settled = await Promise.allSettled([sending, receiving])
  expect(settled[0]).toEqual({ status: "rejected", reason: deadlineExceeded })
  expect(settled[1]).toEqual({ status: "rejected", reason: deadlineExceeded })
})

test("common recv timeout cancels owned bodies while dial timeout remains header-only", async () => {
  let canceledBodies = 0
  const pendingResponse = new Response(
    new ReadableStream<Uint8Array>({
      /** Keeps response-body consumption pending. */
      pull(): void {},
      /** Records operation-timeout cleanup. */
      cancel(): void {
        canceledBodies += 1
      }
    })
  )
  const run = httpExecutor(function run(): Promise<Response> {
    return Promise.resolve(pendingResponse)
  })
  const transport = newHTTPTransport(executor(run))
  transport.init(timeout(2))
  const client = await transport.dial(background(), "localhost:8080")
  await client.send(background(), message("request"))
  await expect(client.recv(background())).rejects.toBe(deadlineExceeded)
  await Promise.resolve()
  expect(canceledBodies).toBe(1)

  const bodyController = deferred<ReadableStreamDefaultController<Uint8Array>>()
  const delayed = new Response(
    new ReadableStream<Uint8Array>({
      /** Captures the body controller without publishing bytes yet. */
      start(value): void {
        bodyController.resolve(value)
      }
    })
  )
  const delayedRun = httpExecutor(function delayedRun(): Promise<Response> {
    return Promise.resolve(delayed)
  })
  const delayedClient = await newHTTPTransport(executor(delayedRun)).dial(
    background(),
    "localhost:8080",
    withDialTimeout(1)
  )
  await delayedClient.send(background(), message("request"))
  const receiving = delayedClient.recv(background())
  const controller = await bodyController.promise
  await new Promise<void>(function waitPastHeaderTimeout(resolve): void {
    setTimeout(resolve, 3)
  })
  controller.enqueue(new TextEncoder().encode("body"))
  controller.close()
  expect(text(await receiving)).toBe("body")
})

test("queued sends recheck Context and close before executor admission", async () => {
  const first = deferred<Response>()
  let calls = 0
  const run = httpExecutor(function run(): Promise<Response> {
    calls += 1
    return first.promise
  })
  const client = await newHTTPTransport(executor(run)).dial(background(), "localhost:8080")
  const firstSend = client.send(background(), message("first"))
  const firstRecv = client.recv(background())
  const [queuedContext, cancelQueued] = withCancel(background())
  const queued = client.send(queuedContext, message("queued"))
  cancelQueued()
  first.resolve(new Response("first"))
  await firstSend
  await firstRecv
  await expect(queued).rejects.toBe(canceled)
  expect(calls).toBe(1)

  const hanging = deferred<Response>()
  let closeCalls = 0
  const closeRun = httpExecutor(function closeRun(): Promise<Response> {
    closeCalls += 1
    return hanging.promise
  })
  const closing = await newHTTPTransport(executor(closeRun)).dial(background(), "localhost:8080")
  const active = closing.send(background(), message("active"))
  const queuedAfter = closing.send(background(), message("queued"))
  await Promise.resolve()
  await closing.close(background())
  await expect(active).rejects.toMatchObject({ code: "GO_LIKE_TRANSPORT_CLOSED" })
  await expect(queuedAfter).rejects.toMatchObject({ code: "GO_LIKE_TRANSPORT_CLOSED" })
  expect(closeCalls).toBe(1)
})

test("close racing received headers cancels transferred and unread response bodies", async () => {
  let canceledBodies = 0
  const stream = new ReadableStream<Uint8Array>({
    /** Keeps the body pending until the owning client cancels it. */
    pull(): void {},
    /** Records body ownership cleanup. */
    cancel(): void {
      canceledBodies += 1
    }
  })
  const headers = deferred<Response>()
  const run = httpExecutor(function run(): Promise<Response> {
    return headers.promise
  })
  const client = await newHTTPTransport(executor(run)).dial(background(), "localhost:8080")
  const sending = client.send(background(), message("request"))
  headers.resolve(new Response(stream, { status: 200 }))
  await sending
  await client.close(background())
  await Promise.resolve()
  expect(canceledBodies).toBe(1)

  const raceHeaders = deferred<Response>()
  let raceCanceled = 0
  const raceStream = new ReadableStream<Uint8Array>({
    /** Keeps the racing body pending. */
    pull(): void {},
    /** Records racing body cleanup. */
    cancel(): void {
      raceCanceled += 1
    }
  })
  const raceRun = httpExecutor(function raceRun(): Promise<Response> {
    return raceHeaders.promise
  })
  const racing = await newHTTPTransport(executor(raceRun)).dial(background(), "localhost:8080")
  const raceSend = racing.send(background(), message("request"))
  await Promise.resolve()
  raceHeaders.resolve(new Response(raceStream, { status: 200 }))
  await racing.close(background())
  await expect(raceSend).rejects.toMatchObject({ code: "GO_LIKE_TRANSPORT_CLOSED" })
  await new Promise<void>(function nextTurn(resolve): void {
    setTimeout(resolve, 0)
  })
  expect(raceCanceled).toBe(1)
})

test("late response cleanup contains hostile cancellation and preserves close identity", async () => {
  const synchronousFailure = new Error("late body cancel threw")
  const bodyGetterFailure = new Error("late response body getter threw")
  const getterFailure = new Error("late body cancel getter threw")
  const asynchronousFailure = new Error("late body cancel rejected")
  const cases: ReadonlyArray<() => Response> = Object.freeze([
    function synchronousThrow(): Response {
      const body = new ReadableStream<Uint8Array>({ pull(): void {} })
      Object.defineProperty(body, "cancel", {
        configurable: true,
        /** Throws before a cleanup Promise can be returned. */
        value(): never {
          throw synchronousFailure
        }
      })
      return new Response(body)
    },
    function bodyGetterThrow(): Response {
      const response = new Response(new ReadableStream<Uint8Array>({ pull(): void {} }))
      Object.defineProperty(response, "body", {
        configurable: true,
        /** Throws while the late Response transfers its body boundary. */
        get(): never {
          throw bodyGetterFailure
        }
      })
      return response
    },
    function getterThrow(): Response {
      const body = new ReadableStream<Uint8Array>({ pull(): void {} })
      Object.defineProperty(body, "cancel", {
        configurable: true,
        /** Throws while the standard cancel method is read. */
        get(): never {
          throw getterFailure
        }
      })
      return new Response(body)
    },
    function synchronousReturn(): Response {
      const body = new ReadableStream<Uint8Array>({ pull(): void {} })
      Object.defineProperty(body, "cancel", {
        configurable: true,
        /** Returns no Promise despite the standard TypeScript declaration. */
        value(): void {}
      })
      return new Response(body)
    },
    function asynchronousReject(): Response {
      const body = new ReadableStream<Uint8Array>({ pull(): void {} })
      Object.defineProperty(body, "cancel", {
        configurable: true,
        /** Rejects after returning from the cleanup boundary. */
        value(): Promise<void> {
          return Promise.reject(asynchronousFailure)
        }
      })
      return new Response(body)
    }
  ])

  for (const response of cases.map(function create(createResponse): Response {
    return createResponse()
  })) {
    const execution = deferred<Response>()
    const client = await newHTTPTransport(
      executor(
        httpExecutor(function run(): Promise<Response> {
          return execution.promise
        })
      )
    ).dial(background(), "localhost:8080")
    const sending = client.send(background(), message("request"))
    await Promise.resolve()
    await expect(client.close(background())).resolves.toBeUndefined()
    const sent = await Promise.allSettled([sending])
    expect(sent[0]?.status).toBe("rejected")
    if (sent[0]?.status !== "rejected") throw new Error("closed send unexpectedly fulfilled")
    const closedError = sent[0].reason

    execution.resolve(response)
    await new Promise<void>(function nextTurn(resolve): void {
      setTimeout(resolve, 0)
    })

    const closed = await Promise.allSettled([
      client.send(background(), message("later")),
      client.recv(background())
    ])
    expect(closed[0]).toEqual({ status: "rejected", reason: closedError })
    expect(closed[1]).toEqual({ status: "rejected", reason: closedError })
  }
})

test("close joins response-body cleanup once and isolates cleanup rejection through logger", async () => {
  const cleanup = deferred<void>()
  let cancelCalls = 0
  const response = new Response(
    new ReadableStream<Uint8Array>({
      /** Keeps the unread body available for owner cleanup. */
      pull(): void {},
      /** Delays cleanup settlement until the test releases it. */
      cancel(): Promise<void> {
        cancelCalls += 1
        return cleanup.promise
      }
    })
  )
  const run = httpExecutor(function run(): Promise<Response> {
    return Promise.resolve(response)
  })
  const client = await newHTTPTransport(executor(run)).dial(background(), "localhost:8080")
  await client.send(background(), message("request"))

  const firstClose = client.close(background())
  const repeatedClose = client.close(background())
  let settled = false
  void firstClose.then(function markSettled(): void {
    settled = true
  })
  await Promise.resolve()
  await Promise.resolve()
  expect(firstClose).toBe(repeatedClose)
  expect(cancelCalls).toBe(1)
  expect(settled).toBe(false)

  cleanup.resolve(undefined)
  await expect(firstClose).resolves.toBeUndefined()
  expect(settled).toBe(true)

  const cleanupFailure = new Error("response cleanup rejected")
  let loggedCause: unknown = null
  const rejectingTransport = newHTTPTransport(
    executor(
      httpExecutor(function rejectRun(): Promise<Response> {
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              /** Keeps the unread response body owned by the client. */
              pull(): void {},
              /** Rejects the owner cleanup boundary. */
              cancel(): Promise<void> {
                return Promise.reject(cleanupFailure)
              }
            })
          )
        )
      })
    )
  )
  rejectingTransport.init(
    logger(
      Object.freeze({
        /** Captures the isolated cleanup diagnostic. */
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
  const rejectingClient = await rejectingTransport.dial(background(), "localhost:8080")
  await rejectingClient.send(background(), message("request"))
  await expect(rejectingClient.close(background())).resolves.toBeUndefined()
  expect(loggedCause).toBe(cleanupFailure)

  const synchronousFailure = new Error("response cleanup threw")
  let synchronousCause: unknown = null
  const hostileBody = new ReadableStream<Uint8Array>({
    /** Keeps the unread response body pending. */
    pull(): void {}
  })
  Object.defineProperty(hostileBody, "cancel", {
    configurable: true,
    /** Throws from the hostile standard body cleanup boundary. */
    value(): never {
      throw synchronousFailure
    }
  })
  const hostileTransport = newHTTPTransport(
    executor(
      httpExecutor(function hostileRun(): Promise<Response> {
        return Promise.resolve(new Response(hostileBody))
      })
    )
  )
  hostileTransport.init(
    logger(
      Object.freeze({
        /** Captures the normalized synchronous cleanup diagnostic. */
        log(
          _level: TransportLogLevel,
          _message: string,
          fields?: Readonly<Record<string, unknown>>
        ): void {
          synchronousCause = fields?.["cause"]
        }
      })
    )
  )
  const hostileClient = await hostileTransport.dial(background(), "localhost:8080")
  await hostileClient.send(background(), message("request"))
  await expect(hostileClient.close(background())).resolves.toBeUndefined()
  expect(synchronousCause).toBe(synchronousFailure)

  const bodyGetterFailure = new Error("response body getter threw")
  let bodyGetterCause: unknown = null
  const getterResponse = new Response(new ReadableStream<Uint8Array>({ pull(): void {} }))
  Object.defineProperty(getterResponse, "body", {
    configurable: true,
    /** Throws before the owner can inspect its unread body. */
    get(): never {
      throw bodyGetterFailure
    }
  })
  const getterTransport = newHTTPTransport(
    executor(
      httpExecutor(function getterRun(): Promise<Response> {
        return Promise.resolve(getterResponse)
      })
    )
  )
  getterTransport.init(
    logger(
      Object.freeze({
        /** Captures the isolated hostile body getter diagnostic. */
        log(
          _level: TransportLogLevel,
          _message: string,
          fields?: Readonly<Record<string, unknown>>
        ): void {
          bodyGetterCause = fields?.["cause"]
        }
      })
    )
  )
  const getterClient = await getterTransport.dial(background(), "localhost:8080")
  await getterClient.send(background(), message("request"))
  await expect(
    Promise.resolve().then(function closeGetterClient(): Promise<void> {
      return getterClient.close(background())
    })
  ).resolves.toBeUndefined()
  expect(bodyGetterCause).toBe(bodyGetterFailure)
})

test("standard logger option contains asynchronous diagnostic rejection end to end", async () => {
  const cleanupFailure = new Error("owner cleanup rejected")
  const loggerFailure = new Error("diagnostic logger rejected")
  const unhandled: unknown[] = []
  let receiverPreserved = false
  let loggedCause: unknown = null
  const loggerOwner = {
    marker: "standard-option",
    log(_level: TransportLogLevel, _message: string, fields?: Readonly<Record<string, unknown>>) {
      receiverPreserved = this.marker === "standard-option"
      loggedCause = fields?.["cause"]
      return Promise.reject(loggerFailure)
    }
  }
  /** Records any rejected diagnostic Promise that escaped both snapshots. */
  function observeUnhandled(reason: unknown): void {
    unhandled.push(reason)
  }
  process.on("unhandledRejection", observeUnhandled)
  try {
    const transport = newHTTPTransport(
      executor(
        httpExecutor(function run(): Promise<Response> {
          return Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                /** Keeps the unread response body owned until close. */
                pull(): void {},
                /** Rejects the owner cleanup so the standard logger path runs. */
                cancel(): Promise<void> {
                  return Promise.reject(cleanupFailure)
                }
              })
            )
          )
        })
      )
    )
    transport.init(logger(loggerOwner))
    const client = await transport.dial(background(), "localhost:8080")
    await client.send(background(), message("request"))
    await expect(client.close(background())).resolves.toBeUndefined()
    await new Promise<void>(function nextTurn(resolve): void {
      setTimeout(resolve, 0)
    })

    expect(receiverPreserved).toBe(true)
    expect(loggedCause).toBe(cleanupFailure)
    expect(unhandled).toEqual([])
  } finally {
    process.off("unhandledRejection", observeUnhandled)
  }
})

test("client cleanup contains a synchronous private AbortController failure", async () => {
  const originalAbort = AbortController.prototype.abort
  const abortFailure = new Error("private abort threw")
  let loggedCause: unknown = null
  const transport = newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ pull(): void {} })))
      })
    )
  )
  transport.init(
    logger(
      Object.freeze({
        /** Captures the isolated abort failure after body cleanup settles. */
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
  const client = await transport.dial(background(), "localhost:8080")
  await client.send(background(), message("request"))
  try {
    Object.defineProperty(AbortController.prototype, "abort", {
      configurable: true,
      writable: true,
      /** Throws before the private controller can notify executor listeners. */
      value(): never {
        throw abortFailure
      }
    })
    await expect(client.close(background())).resolves.toBeUndefined()
  } finally {
    Object.defineProperty(AbortController.prototype, "abort", {
      configurable: true,
      writable: true,
      value: originalAbort
    })
  }
  expect(loggedCause).toBe(abortFailure)
})

test("close caller cancellation does not abandon owner response cleanup", async () => {
  const cleanup = deferred<void>()
  let cancelCalls = 0
  const response = new Response(
    new ReadableStream<Uint8Array>({
      /** Keeps the response unread before close. */
      pull(): void {},
      /** Holds owner cleanup beyond the first caller lifetime. */
      cancel(): Promise<void> {
        cancelCalls += 1
        return cleanup.promise
      }
    })
  )
  const run = httpExecutor(function run(): Promise<Response> {
    return Promise.resolve(response)
  })
  const client = await newHTTPTransport(executor(run)).dial(background(), "localhost:8080")
  await client.send(background(), message("request"))
  const [ctx, cancel] = withCancel(background())
  const caller = client.close(ctx)
  cancel()
  await expect(caller).rejects.toBe(canceled)
  expect(cancelCalls).toBe(1)

  const ownerJoin = client.close(background())
  cleanup.resolve(undefined)
  await expect(ownerJoin).resolves.toBeUndefined()
})

test("pre-canceled close preserves its cause without admitting cleanup", async () => {
  const client = await newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(new Response("open"))
      })
    )
  ).dial(background(), "localhost:8080")
  const [ctx, cancel] = withCancelCause(background())
  const marker = new Error("close caller expired")
  cancel(marker)

  await expect(client.close(ctx)).rejects.toBe(marker)
  await client.send(background(), message("after-close"))
  expect(text(await client.recv(background()))).toBe("open")
  await expect(client.close(background())).resolves.toBeUndefined()
})

test("recv cancellation permanently consumes a response slot and cancels its body", async () => {
  let bodyCanceled = 0
  const pullStarted = deferred<void>()
  const response = new Response(
    new ReadableStream<Uint8Array>({
      /** Keeps body consumption pending. */
      pull(): void {
        pullStarted.resolve(undefined)
      },
      /** Records recv-owned cancellation. */
      cancel(): void {
        bodyCanceled += 1
      }
    })
  )
  const run = httpExecutor(function run(): Promise<Response> {
    return Promise.resolve(response)
  })
  const client = await newHTTPTransport(executor(run)).dial(background(), "localhost:8080")
  await client.send(background(), message("request"))
  const [ctx, cancel] = withCancel(background())
  const receiving = client.recv(ctx)
  await pullStarted.promise
  cancel()
  await expect(receiving).rejects.toBe(canceled)
  await expect(client.recv(background())).rejects.toMatchObject({ code: "GO_LIKE_TRANSPORT_STATE" })
  await new Promise<void>(function nextTurn(resolve): void {
    setTimeout(resolve, 0)
  })
  expect(bodyCanceled).toBe(1)
})

test("close breaks an active reader cancellation cycle through a stable admission", async () => {
  const pullStarted = deferred<void>()
  let client: Client | null = null
  const reentrantCloses: Promise<void>[] = []
  let cancelCalls = 0
  const response = new Response(
    new ReadableStream<Uint8Array>({
      /** Publishes that recv owns one active standard reader. */
      pull(): void {
        pullStarted.resolve(undefined)
      },
      /** Reenters close and returns the stable admission that cannot wait on the owner. */
      cancel(): Promise<void> {
        cancelCalls += 1
        const activeClient = client
        if (activeClient === null) throw new Error("client was not assigned before reader cleanup")
        const first = activeClient.close(background())
        const second = activeClient.close(background())
        reentrantCloses.push(first, second)
        return first
      }
    })
  )
  client = await newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(response)
      })
    )
  ).dial(background(), "localhost:8080")
  await client.send(background(), message("request"))
  const receiving = client.recv(background())
  void receiving.catch(function observeClosedRecv(): void {})
  await pullStarted.promise

  const owner = client.close(background())
  let timer: ReturnType<typeof setTimeout> | null = null
  const settled = await Promise.race([
    Promise.allSettled([owner, receiving]),
    new Promise<null>(function bounded(resolve): void {
      timer = setTimeout(function expired(): void {
        resolve(null)
      }, 25)
    })
  ])
  if (timer !== null) clearTimeout(timer)

  expect(settled).not.toBeNull()
  if (settled === null) return
  expect(settled[0]).toEqual({ status: "fulfilled", value: undefined })
  expect(settled[1]).toEqual({
    status: "rejected",
    reason: expect.objectContaining({ code: "GO_LIKE_TRANSPORT_CLOSED" })
  })
  expect(reentrantCloses).toHaveLength(2)
  expect(reentrantCloses[0]).toBe(reentrantCloses[1])
  expect(reentrantCloses[0]).not.toBe(owner)
  expect(client.close(background())).toBe(owner)
  expect(cancelCalls).toBe(1)
})

test("close keeps joining a non-reentrant pending active reader cleanup", async () => {
  const pullStarted = deferred<void>()
  const cleanup = deferred<void>()
  let cancelCalls = 0
  const response = new Response(
    new ReadableStream<Uint8Array>({
      /** Publishes that recv owns one active standard reader. */
      pull(): void {
        pullStarted.resolve(undefined)
      },
      /** Keeps ordinary reader cleanup pending without reentering the client owner. */
      cancel(): Promise<void> {
        cancelCalls += 1
        return cleanup.promise
      }
    })
  )
  const client = await newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(response)
      })
    )
  ).dial(background(), "localhost:8080")
  await client.send(background(), message("request"))
  const receiving = client.recv(background())
  void receiving.catch(function observeClosedRecv(): void {})
  await pullStarted.promise

  const owner = client.close(background())
  let ownerSettled = false
  void owner.then(function markOwnerSettled(): void {
    ownerSettled = true
  })
  await Promise.resolve()
  await Promise.resolve()
  expect(ownerSettled).toBe(false)
  expect(cancelCalls).toBe(1)

  cleanup.resolve(undefined)
  await expect(owner).resolves.toBeUndefined()
  await expect(receiving).rejects.toMatchObject({ code: "GO_LIKE_TRANSPORT_CLOSED" })
})

test("recv cancellation contains a synchronous reader cancel failure", async () => {
  const pullStarted = deferred<void>()
  const response = new Response(
    new ReadableStream<Uint8Array>({
      /** Keeps body consumption pending while exposing reader ownership. */
      pull(): void {
        pullStarted.resolve(undefined)
      }
    })
  )
  const client = await newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(response)
      })
    )
  ).dial(background(), "localhost:8080")
  await client.send(background(), message("request"))

  const originalCancel = Object.getOwnPropertyDescriptor(
    ReadableStreamDefaultReader.prototype,
    "cancel"
  )
  const cleanupFailure = new Error("response reader cancel threw")
  const [ctx, cancel] = withCancel(background())
  const receiving = client.recv(ctx)
  await pullStarted.promise
  try {
    Object.defineProperty(ReadableStreamDefaultReader.prototype, "cancel", {
      configurable: true,
      writable: true,
      /** Throws from the active response reader cleanup boundary. */
      value(): never {
        throw cleanupFailure
      }
    })
    cancel()
    await expect(receiving).rejects.toBe(canceled)
  } finally {
    if (originalCancel === undefined) {
      Reflect.deleteProperty(ReadableStreamDefaultReader.prototype, "cancel")
    } else {
      Object.defineProperty(ReadableStreamDefaultReader.prototype, "cancel", originalCancel)
    }
  }
})

test("Request construction failures become protocol errors before executor I/O", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Request")
  let calls = 0
  const run = httpExecutor(function run(): Promise<Response> {
    calls += 1
    return Promise.resolve(new Response())
  })
  const client = await newHTTPTransport(executor(run)).dial(background(), "localhost:8080")
  try {
    for (const failure of [new Error("request failed"), "request failed"]) {
      Object.defineProperty(globalThis, "Request", {
        configurable: true,
        writable: true,
        /** Throws the selected hostile constructor value. */
        value: function BrokenRequest(): never {
          throw failure
        }
      })
      await expect(client.send(background(), message("request"))).rejects.toMatchObject({
        code: "GO_LIKE_TRANSPORT_PROTOCOL"
      })
    }
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, "Request")
    else Object.defineProperty(globalThis, "Request", descriptor)
  }
  expect(calls).toBe(0)
})
