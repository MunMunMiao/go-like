import { expect, test } from "bun:test"

import { background, canceled, withCancel } from "@go-like/context"
import { fromServerContext, type Client, type Message } from "@go-like/transport"
import {
  executor,
  maxMessageBytes,
  newHTTPTransport,
  type HTTPExecutor
} from "@go-like/transport-http"
import {
  assertHTTPContentLength,
  newHTTPStatusError,
  normalizeHTTPError,
  snapshotHTTPBodyChunk
} from "../src/errors"
import { requestHeaders, snapshotResponseHeaders } from "../src/headers"
import { dispatchHTTPHostRequest } from "../src/socket"
import { withHTTPServerTransportInfo } from "../src/transport-info"

/** Creates one empty immutable request Message. */
function requestMessage(): Message {
  return Object.freeze({ header: Object.freeze({}), body: new Uint8Array() })
}

/** Completes a standard callable executor with runtime-specific Fetch statics. */
function httpExecutor(run: () => Promise<Response>): HTTPExecutor {
  return Object.assign(run, {
    /** Allows runtimes to expose optional connection warming without affecting tests. */
    preconnect(): void {}
  })
}

/** Creates one externally settled Promise. */
function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolvePromise: ((value: T) => void) | null = null
  const promise = new Promise<T>(function capture(resolve): void {
    resolvePromise = resolve
  })
  return Object.freeze({
    promise,
    /** Resolves the captured Promise once. */
    resolve(value: T): void {
      resolvePromise?.(value)
    }
  })
}

/** Creates a real standard body stream that emits one hostile runtime chunk. */
function invalidBodyStream(value: unknown): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    /** Enqueues the untyped value through the actual stream controller boundary. */
    start(controller): void {
      Reflect.apply(controller.enqueue, controller, [value])
      controller.close()
    }
  })
}

type InvalidatedBodyKind = "detached" | "out-of-bounds"

const InvalidatedBodyKinds: readonly InvalidatedBodyKind[] = Object.freeze([
  "detached",
  "out-of-bounds"
])

/** Creates a standard byte stream whose queued view becomes invalid before it is read. */
function invalidatedBodyStream(kind: InvalidatedBodyKind): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    /** Queues one real Uint8Array and then invalidates its backing storage. */
    start(controller): void {
      if (kind === "detached") {
        const chunk = new Uint8Array([1, 2, 3])
        controller.enqueue(chunk)
        structuredClone(chunk.buffer, { transfer: [chunk.buffer] })
      } else {
        const buffer = new ArrayBuffer(8, { maxByteLength: 8 })
        const chunk = new Uint8Array(buffer, 4, 4)
        controller.enqueue(chunk)
        buffer.resize(2)
      }
      controller.close()
    }
  })
}

/** Returns one client body failure after the selected standard byte view is invalidated. */
async function invalidatedClientFailure(
  status: number,
  kind: InvalidatedBodyKind
): Promise<unknown> {
  const client = await newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(new Response(invalidatedBodyStream(kind), { status }))
      })
    )
  ).dial(background(), "localhost:8080")
  await client.send(background(), requestMessage())
  const failure = await client.recv(background()).then(
    function unexpectedMessage(): unknown {
      return null
    },
    function rejected(error: unknown): unknown {
      return error
    }
  )
  await client.close(background())
  return failure
}

/** Returns one server POST body failure and its secret-safe wire status. */
async function invalidatedServerFailure(kind: InvalidatedBodyKind): Promise<{
  readonly error: unknown
  readonly status: number
}> {
  let failure: unknown = null
  const response = await dispatchHTTPHostRequest(
    background(),
    async function receive(ctx, socket): Promise<void> {
      try {
        await socket.recv(ctx)
      } catch (error) {
        failure = error
      }
    },
    Object.freeze({
      request: new Request("http://service.test/rpc", {
        method: "POST",
        body: invalidatedBodyStream(kind)
      }),
      localAddress: "",
      remoteAddress: ""
    }),
    true
  )
  return Object.freeze({ error: failure, status: response.status })
}

/** Requires one protocol error whose cause is the runtime's original byte-copy TypeError. */
function expectInvalidatedProtocolFailure(value: unknown): void {
  expect(value).toMatchObject({ code: "GO_LIKE_TRANSPORT_PROTOCOL" })
  if (typeof value !== "object" || value === null) throw value
  expect(Reflect.get(value, "cause")).toBeInstanceOf(TypeError)
}

test("non-200 responses become bounded defensive HTTPStatusError values", async () => {
  const source = new Uint8Array(65_537)
  source.fill(7)
  const run = httpExecutor(function run() {
    return Promise.resolve(new Response(source, { status: 503, statusText: "Unavailable" }))
  })
  const client = await newHTTPTransport(executor(run)).dial(background(), "localhost:8080")
  await client.send(background(), requestMessage())

  try {
    await client.recv(background())
    throw new Error("expected HTTP status failure")
  } catch (error) {
    expect(error).toMatchObject({
      name: "HTTPStatusError",
      code: "GO_LIKE_HTTP_STATUS",
      status: 503,
      statusText: "Unavailable",
      bodyTruncated: true
    })
    if (typeof error !== "object" || error === null || !("body" in error)) throw error
    const first = error.body
    if (!(first instanceof Uint8Array)) throw error
    expect(first).toHaveLength(65_536)
    first[0] = 99
    const second = error.body
    if (!(second instanceof Uint8Array)) throw error
    expect(second[0]).toBe(7)
    expect(Object.isFrozen(error)).toBe(true)
  }
})

test("200 response Messages detach headers and body from the owned Response", async () => {
  const run = httpExecutor(function run() {
    return Promise.resolve(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: [["X-Result", "ok"]]
      })
    )
  })
  const client = await newHTTPTransport(executor(run)).dial(background(), "localhost:8080")
  await client.send(background(), requestMessage())
  const received = await client.recv(background())
  const first = received.body
  first[0] = 9

  expect(received.body).toEqual(new Uint8Array([1, 2, 3]))
  expect(received.header["x-result"]).toBe("ok")
  expect(Object.isFrozen(received)).toBe(true)
  expect(Object.isFrozen(received.header)).toBe(true)
})

test("unary clients admit the exact message limit and reject larger known request bodies", async () => {
  let calls = 0
  const run = httpExecutor(function run(): Promise<Response> {
    calls += 1
    return Promise.resolve(
      new Response(new Uint8Array([4, 5, 6]), {
        status: 200,
        headers: { "content-length": "3" }
      })
    )
  })
  const client = await newHTTPTransport(maxMessageBytes(3), executor(run)).dial(
    background(),
    "localhost:8080"
  )

  await expect(
    client.send(
      background(),
      Object.freeze({ header: Object.freeze({}), body: new Uint8Array([1, 2, 3, 4]) })
    )
  ).rejects.toMatchObject({ code: "GO_LIKE_TRANSPORT_PROTOCOL" })
  expect(calls).toBe(0)

  await client.send(
    background(),
    Object.freeze({ header: Object.freeze({}), body: new Uint8Array([1, 2, 3]) })
  )
  expect((await client.recv(background())).body).toEqual(new Uint8Array([4, 5, 6]))
  expect(calls).toBe(1)
  await client.close(background())
})

test("unary clients reject declared and streamed oversized responses and cancel their bodies", async () => {
  const canceledBodies = [0, 0]
  const responses = [
    new Response(
      new ReadableStream<Uint8Array>({
        pull(): void {},
        cancel(): void {
          canceledBodies[0] = (canceledBodies[0] ?? 0) + 1
        }
      }),
      { status: 200, headers: { "content-length": "4" } }
    ),
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller): void {
          controller.enqueue(new Uint8Array([1, 2]))
        },
        cancel(): void {
          canceledBodies[1] = (canceledBodies[1] ?? 0) + 1
        }
      }),
      { status: 200 }
    )
  ]
  for (let index = 0; index < responses.length; index += 1) {
    const response = responses[index]
    if (response === undefined) throw new Error("response is missing")
    const client = await newHTTPTransport(
      maxMessageBytes(3),
      executor(
        httpExecutor(function run(): Promise<Response> {
          return Promise.resolve(response)
        })
      )
    ).dial(background(), "localhost:8080")
    await client.send(background(), requestMessage())
    await expect(client.recv(background())).rejects.toMatchObject({
      code: "GO_LIKE_TRANSPORT_PROTOCOL"
    })
    expect(canceledBodies[index]).toBe(1)
    await client.close(background())
  }
})

test("unary clients fail closed for an oversized declaration without a response body", async () => {
  const client = await newHTTPTransport(
    maxMessageBytes(3),
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(
          new Response(null, { status: 200, headers: { "content-length": "4" } })
        )
      })
    )
  ).dial(background(), "localhost:8080")
  await client.send(background(), requestMessage())
  await expect(client.recv(background())).rejects.toMatchObject({
    code: "GO_LIKE_TRANSPORT_PROTOCOL"
  })
  await client.close(background())
})

test("unary servers enforce declared, streamed, and known response message limits", async () => {
  let requestCanceled = 0
  let receiveFailure: unknown = null
  const oversizedRequest = new Request("http://service.test/rpc", {
    method: "POST",
    headers: { "content-length": "4" },
    body: new ReadableStream<Uint8Array>({
      pull(): void {},
      cancel(): void {
        requestCanceled += 1
      }
    })
  })
  const rejectedRequest = await dispatchHTTPHostRequest(
    background(),
    async function receive(ctx, socket): Promise<void> {
      try {
        await socket.recv(ctx)
      } catch (error) {
        receiveFailure = error
      }
    },
    Object.freeze({ request: oversizedRequest, localAddress: "", remoteAddress: "" }),
    false,
    null,
    "",
    3
  )
  expect(rejectedRequest.status).toBe(500)
  expect(receiveFailure).toMatchObject({ code: "GO_LIKE_TRANSPORT_PROTOCOL" })
  expect(requestCanceled).toBe(1)

  let streamedCanceled = 0
  let streamedFailure: unknown = null
  const streamedRequest = await dispatchHTTPHostRequest(
    background(),
    async function receive(ctx, socket): Promise<void> {
      try {
        await socket.recv(ctx)
      } catch (error) {
        streamedFailure = error
      }
    },
    Object.freeze({
      request: new Request("http://service.test/rpc", {
        method: "POST",
        body: new ReadableStream<Uint8Array>({
          pull(controller): void {
            controller.enqueue(new Uint8Array([1, 2]))
          },
          cancel(): void {
            streamedCanceled += 1
          }
        })
      }),
      localAddress: "",
      remoteAddress: ""
    }),
    false,
    null,
    "",
    3
  )
  expect(streamedRequest.status).toBe(500)
  expect(streamedFailure).toMatchObject({ code: "GO_LIKE_TRANSPORT_PROTOCOL" })
  expect(streamedCanceled).toBe(1)

  let emptyFailure: unknown = null
  const emptyRequest = await dispatchHTTPHostRequest(
    background(),
    async function receive(ctx, socket): Promise<void> {
      try {
        await socket.recv(ctx)
      } catch (error) {
        emptyFailure = error
      }
    },
    Object.freeze({
      request: new Request("http://service.test/rpc", {
        method: "POST",
        headers: { "content-length": "4" }
      }),
      localAddress: "",
      remoteAddress: ""
    }),
    false,
    null,
    "",
    3
  )
  expect(emptyRequest.status).toBe(500)
  expect(emptyFailure).toMatchObject({ code: "GO_LIKE_TRANSPORT_PROTOCOL" })

  let sendFailure: unknown = null
  const rejectedResponse = await dispatchHTTPHostRequest(
    background(),
    async function send(ctx, socket): Promise<void> {
      await socket.recv(ctx)
      try {
        await socket.send(
          ctx,
          Object.freeze({ header: Object.freeze({}), body: new Uint8Array([1, 2, 3, 4]) })
        )
      } catch (error) {
        sendFailure = error
      }
    },
    Object.freeze({
      request: new Request("http://service.test/rpc", {
        method: "POST",
        body: new Uint8Array([1, 2, 3])
      }),
      localAddress: "",
      remoteAddress: ""
    }),
    false,
    null,
    "",
    3
  )
  expect(rejectedResponse.status).toBe(500)
  expect(sendFailure).toMatchObject({ code: "GO_LIKE_TRANSPORT_PROTOCOL" })

  const admitted = await dispatchHTTPHostRequest(
    background(),
    async function echo(ctx, socket): Promise<void> {
      const message = await socket.recv(ctx)
      await socket.send(ctx, message)
    },
    Object.freeze({
      request: new Request("http://service.test/rpc", {
        method: "POST",
        body: new Uint8Array([1, 2, 3])
      }),
      localAddress: "",
      remoteAddress: ""
    }),
    false,
    null,
    "",
    3
  )
  expect(admitted.status).toBe(200)
  expect(new Uint8Array(await admitted.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
})

test("Content-Length inspection preserves its original Headers failure", () => {
  const descriptor = Object.getOwnPropertyDescriptor(Headers.prototype, "get")
  const failure = new Error("Headers get failed")
  try {
    Object.defineProperty(Headers.prototype, "get", {
      configurable: true,
      writable: true,
      value(): never {
        throw failure
      }
    })
    expect(() => assertHTTPContentLength(new Headers(), 3, "invalid length")).toThrow(
      expect.objectContaining({ code: "GO_LIKE_TRANSPORT_PROTOCOL", cause: failure })
    )
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(Headers.prototype, "get")
    else Object.defineProperty(Headers.prototype, "get", descriptor)
  }
  expect(() =>
    assertHTTPContentLength(new Headers({ "content-length": "invalid" }), 3, "invalid length")
  ).toThrow(expect.objectContaining({ code: "GO_LIKE_TRANSPORT_PROTOCOL" }))
})

test("200 response bodies reject non-Uint8Array chunks with the original Error cause", async () => {
  const chunkFailure = new Error("invalid successful response chunk")
  const run = httpExecutor(function run(): Promise<Response> {
    return Promise.resolve(new Response(invalidBodyStream(chunkFailure), { status: 200 }))
  })
  const client = await newHTTPTransport(executor(run)).dial(background(), "localhost:8080")
  await client.send(background(), requestMessage())

  await expect(client.recv(background())).rejects.toMatchObject({
    code: "GO_LIKE_TRANSPORT_PROTOCOL",
    cause: chunkFailure
  })
})

test("status errors support null and exact-limit bodies without false truncation", async () => {
  const empty = await newHTTPStatusError(new Response(null, { status: 204 }))
  expect(empty.body).toHaveLength(0)
  expect(empty.bodyTruncated).toBe(false)

  const exact = new Uint8Array(65_536)
  exact.fill(5)
  const bounded = await newHTTPStatusError(new Response(exact, { status: 500 }))
  expect(bounded.body).toHaveLength(65_536)
  expect(bounded.bodyTruncated).toBe(false)
  const marker = Object.freeze({ phase: "executor" })
  const failure = normalizeHTTPError(marker, "normalized")
  expect(failure).toMatchObject({ message: "normalized" })
  expect(failure.cause).toBe(marker)
})

test("non-200 status bodies reject non-Uint8Array chunks with the original Error cause", async () => {
  const chunkFailure = new Error("invalid status response chunk")
  const run = httpExecutor(function run(): Promise<Response> {
    return Promise.resolve(new Response(invalidBodyStream(chunkFailure), { status: 502 }))
  })
  const client = await newHTTPTransport(executor(run)).dial(background(), "localhost:8080")
  await client.send(background(), requestMessage())

  await expect(client.recv(background())).rejects.toMatchObject({
    code: "GO_LIKE_TRANSPORT_PROTOCOL",
    cause: chunkFailure
  })
})

test("body read-result validation normalizes malformed values and getter failures", () => {
  expect(() => snapshotHTTPBodyChunk(null, "invalid body result")).toThrow(
    expect.objectContaining({ code: "GO_LIKE_TRANSPORT_PROTOCOL" })
  )
  const getterFailure = new Error("body result getter failed")
  const result = new Proxy(Object.freeze({}), {
    /** Throws from the standard read-result observation boundary. */
    get(): never {
      throw getterFailure
    }
  })
  expect(() => snapshotHTTPBodyChunk(result, "invalid body result")).toThrow(
    expect.objectContaining({
      code: "GO_LIKE_TRANSPORT_PROTOCOL",
      cause: getterFailure
    })
  )
})

test("body byte snapshot preserves the exact defensive-copy Error cause", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Uint8Array")
  const NativeUint8Array = Uint8Array
  const source = new NativeUint8Array([1, 2, 3])
  const copyFailure = new TypeError("byte snapshot copy failed")
  const HostileUint8Array = new Proxy(NativeUint8Array, {
    /** Throws one identifiable Error only for the selected defensive copy. */
    construct(target, argumentsList, newTarget): object {
      if (argumentsList[0] === source) throw copyFailure
      return Reflect.construct(target, argumentsList, newTarget)
    }
  })
  let observed: unknown = null
  try {
    Object.defineProperty(globalThis, "Uint8Array", {
      configurable: true,
      writable: true,
      value: HostileUint8Array
    })
    snapshotHTTPBodyChunk(Object.freeze({ done: false, value: source }), "invalid body result")
  } catch (error) {
    observed = error
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, "Uint8Array")
    else Object.defineProperty(globalThis, "Uint8Array", descriptor)
  }

  expect(observed).toMatchObject({ code: "GO_LIKE_TRANSPORT_PROTOCOL" })
  if (typeof observed !== "object" || observed === null) throw observed
  expect(Reflect.get(observed, "cause")).toBe(copyFailure)
})

test("invalidated Uint8Array chunks are client 200 protocol failures", async () => {
  for (const kind of InvalidatedBodyKinds) {
    expectInvalidatedProtocolFailure(await invalidatedClientFailure(200, kind))
  }
})

test("invalidated Uint8Array chunks are status protocol failures", async () => {
  for (const kind of InvalidatedBodyKinds) {
    expectInvalidatedProtocolFailure(await invalidatedClientFailure(502, kind))
  }
})

test("invalidated Uint8Array chunks are server POST protocol failures", async () => {
  for (const kind of InvalidatedBodyKinds) {
    const result = await invalidatedServerFailure(kind)
    expect(result.status).toBe(500)
    expectInvalidatedProtocolFailure(result.error)
  }
})

test("status body read rejection becomes a protocol error with the original cause", async () => {
  const readFailure = new Error("status body read failed")
  const response = new Response(
    new ReadableStream<Uint8Array>({
      /** Rejects the real standard reader operation. */
      pull(controller): void {
        controller.error(readFailure)
      }
    }),
    { status: 502 }
  )

  await expect(newHTTPStatusError(response)).rejects.toMatchObject({
    code: "GO_LIKE_TRANSPORT_PROTOCOL",
    cause: readFailure
  })
})

test("status classification survives truncated-body cancellation failure", async () => {
  const cancelFailure = new Error("status body cancel failed")
  const bytes = new Uint8Array(65_537)
  bytes.fill(6)
  const response = new Response(
    new ReadableStream<Uint8Array>({
      /** Publishes more than the retained status limit. */
      pull(controller): void {
        controller.enqueue(bytes)
      },
      /** Rejects cleanup after truncation has already been established. */
      cancel(): Promise<void> {
        return Promise.reject(cancelFailure)
      }
    }),
    { status: 502 }
  )

  const error = await newHTTPStatusError(response)
  expect(error).toMatchObject({
    code: "GO_LIKE_HTTP_STATUS",
    status: 502,
    bodyTruncated: true
  })
  expect(error.body).toHaveLength(65_536)
})

test("status classification survives a synchronous reader cancellation throw", async () => {
  const originalCancel = Object.getOwnPropertyDescriptor(
    ReadableStreamDefaultReader.prototype,
    "cancel"
  )
  const bytes = new Uint8Array(65_537)
  bytes.fill(2)
  try {
    Object.defineProperty(ReadableStreamDefaultReader.prototype, "cancel", {
      configurable: true,
      writable: true,
      /** Throws before a reader cancellation Promise can be returned. */
      value(): never {
        throw new Error("status reader cancel threw")
      }
    })
    const error = await newHTTPStatusError(new Response(bytes, { status: 504 }))
    expect(error).toMatchObject({
      code: "GO_LIKE_HTTP_STATUS",
      status: 504,
      bodyTruncated: true
    })
  } finally {
    if (originalCancel === undefined) {
      Reflect.deleteProperty(ReadableStreamDefaultReader.prototype, "cancel")
    } else {
      Object.defineProperty(ReadableStreamDefaultReader.prototype, "cancel", originalCancel)
    }
  }
})

test("status truncation publishes reader cancellation before client-close reentry", async () => {
  const originalCancel = ReadableStreamDefaultReader.prototype.cancel
  let client: Client | null = null
  let reentrantClose: Promise<void> | null = null
  let reentryStarted = false
  let cancelCalls = 0
  /** Reads callback-owned close state without assuming synchronous assignment. */
  function observedReentrantClose(): Promise<void> | null {
    return reentrantClose
  }
  const bytes = new Uint8Array(65_537)
  bytes.fill(4)
  const response = new Response(
    new ReadableStream<Uint8Array>({
      /** Publishes one chunk that forces bounded status truncation. */
      pull(controller): void {
        controller.enqueue(bytes)
      }
    }),
    { status: 502 }
  )
  try {
    Object.defineProperty(ReadableStreamDefaultReader.prototype, "cancel", {
      configurable: true,
      writable: true,
      /** Reenters client close from the status reader cancellation boundary. */
      value(this: ReadableStreamDefaultReader<Uint8Array>, reason?: unknown): Promise<void> {
        cancelCalls += 1
        if (!reentryStarted) {
          reentryStarted = true
          const activeClient = client
          if (activeClient === null) throw new Error("client was not assigned before recv")
          reentrantClose = activeClient.close(background())
        }
        return Reflect.apply(originalCancel, this, [reason])
      }
    })
    client = await newHTTPTransport(
      executor(
        httpExecutor(function run(): Promise<Response> {
          return Promise.resolve(response)
        })
      )
    ).dial(background(), "localhost:8080")
    await client.send(background(), requestMessage())
    const receiving = client.recv(background())

    await expect(receiving).rejects.toMatchObject({ code: "GO_LIKE_TRANSPORT_CLOSED" })
    const ownerClose = client.close(background())
    expect(observedReentrantClose()).not.toBe(ownerClose)
    expect(client.close(background())).toBe(ownerClose)
    await expect(ownerClose).resolves.toBeUndefined()
    expect(cancelCalls).toBe(1)
  } finally {
    Object.defineProperty(ReadableStreamDefaultReader.prototype, "cancel", {
      configurable: true,
      writable: true,
      value: originalCancel
    })
  }
})

test("status truncation breaks a reader-to-owner cleanup cycle without abandoning cleanup", async () => {
  let client: Client | null = null
  let reentrantClose: Promise<void> | null = null
  let cancelCalls = 0
  const cancelEntered = deferred<void>()
  const bytes = new Uint8Array(65_537)
  bytes.fill(8)
  const response = new Response(
    new ReadableStream<Uint8Array>({
      /** Publishes one chunk that forces bounded status truncation. */
      start(controller): void {
        controller.enqueue(bytes)
      },
      /** Reenters close and returns the distinct admission Promise to avoid R -> O -> R. */
      cancel(): Promise<void> {
        cancelCalls += 1
        const activeClient = client
        if (activeClient === null) throw new Error("client was not assigned before status cleanup")
        const owner = activeClient.close(background())
        reentrantClose = owner
        cancelEntered.resolve(undefined)
        return owner
      }
    }),
    { status: 503 }
  )
  client = await newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(response)
      })
    )
  ).dial(background(), "localhost:8080")
  await client.send(background(), requestMessage())
  const receiving = client.recv(background())
  void receiving.catch(function observeClosedRecv(): void {})
  await cancelEntered.promise

  /** Reads callback-owned close state without assuming synchronous assignment. */
  function observedReentrantClose(): Promise<void> | null {
    return reentrantClose
  }
  const ownerClose = client.close(background())
  expect(observedReentrantClose()).not.toBe(ownerClose)
  expect(client.close(background())).toBe(ownerClose)
  const settlement = await Promise.race([
    Promise.all([
      ownerClose,
      receiving.then(
        function unexpectedMessage(): string {
          return "message"
        },
        function closed(error: unknown): string {
          return typeof error === "object" &&
            error !== null &&
            Reflect.get(error, "code") === "GO_LIKE_TRANSPORT_CLOSED"
            ? "closed"
            : "unexpected-error"
        }
      )
    ]).then(function settled(result): string {
      return result[1] ?? "missing-result"
    }),
    new Promise<string>(function bounded(resolve): void {
      setTimeout(function timeout(): void {
        resolve("pending")
      }, 25)
    })
  ])

  expect(settlement).toBe("closed")
  expect(cancelCalls).toBe(1)
  await expect(ownerClose).resolves.toBeUndefined()
})

test("header helpers normalize invalid Messages, names, and borrowed iteration failures", () => {
  expect(() => Reflect.apply(requestHeaders, undefined, [null])).toThrow()
  expect(() =>
    requestHeaders(
      Object.freeze({
        header: Object.freeze({ "invalid header": "value" }),
        body: new Uint8Array()
      })
    )
  ).toThrow()

  const originalSet = Headers.prototype.set
  try {
    Object.defineProperty(Headers.prototype, "set", {
      configurable: true,
      writable: true,
      /** Throws a non-Error rejection to exercise one hostile Web API boundary. */
      value(): never {
        throw "header-set-failed"
      }
    })
    expect(() =>
      requestHeaders(
        Object.freeze({
          header: Object.freeze({ valid: "value" }),
          body: new Uint8Array()
        })
      )
    ).toThrow()
  } finally {
    Object.defineProperty(Headers.prototype, "set", {
      configurable: true,
      writable: true,
      value: originalSet
    })
  }

  const headers = new Headers()
  Object.defineProperty(headers, "forEach", {
    configurable: true,
    /** Rejects one borrowed iteration boundary. */
    value(): never {
      throw new Error("iteration failed")
    }
  })
  expect(() => snapshotResponseHeaders(headers)).toThrow()
})

test("server unary socket enforces state, explicit close, response, and metadata boundaries", async () => {
  let local = ""
  let remote = ""
  const response = await dispatchHTTPHostRequest(
    background(),
    async function exercise(ctx, socket): Promise<void> {
      local = socket.local()
      remote = socket.remote()
      const responseMethod = Reflect.get(socket, "response")
      if (typeof responseMethod !== "function") throw new Error("response method missing")
      await expect(Reflect.apply(responseMethod, socket, [])).rejects.toMatchObject({
        code: "GO_LIKE_TRANSPORT_STATE"
      })
      const incoming = await socket.recv(ctx)
      await expect(socket.recv(ctx)).rejects.toMatchObject({ code: "GO_LIKE_TRANSPORT_STATE" })
      await socket.send(ctx, incoming)
      await expect(socket.send(ctx, incoming)).rejects.toMatchObject({
        code: "GO_LIKE_TRANSPORT_STATE"
      })
      await expect(Reflect.apply(responseMethod, socket, [])).resolves.toBeInstanceOf(Response)
      await socket.close(ctx)
      await socket.close(background())
      await expect(socket.recv(background())).rejects.toMatchObject({
        code: "GO_LIKE_TRANSPORT_CLOSED"
      })
      await expect(socket.send(background(), incoming)).rejects.toMatchObject({
        code: "GO_LIKE_TRANSPORT_CLOSED"
      })
    },
    Object.freeze({
      request: new Request("http://service.test/rpc", { method: "POST", body: "payload" }),
      localAddress: "private-local",
      remoteAddress: "private-remote"
    }),
    false
  )
  expect(response.status).toBe(200)
  expect(local).toBe("")
  expect(remote).toBe("")
})

test("server wire maps invalid methods and request body failures to safe 500", async () => {
  const get = await dispatchHTTPHostRequest(
    background(),
    async function receive(ctx, socket): Promise<void> {
      await socket.recv(ctx)
    },
    Object.freeze({
      request: new Request("http://service.test/rpc", { method: "GET" }),
      localAddress: "",
      remoteAddress: ""
    }),
    true
  )
  expect(get.status).toBe(500)

  for (const failure of [new Error("body failed"), "body failed"]) {
    const request = new Request("http://service.test/rpc", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        /** Rejects request-body consumption with the selected hostile value. */
        pull(controller): void {
          controller.error(failure)
        }
      })
    })
    let observed: unknown = null
    const response = await dispatchHTTPHostRequest(
      background(),
      async function receive(ctx, socket): Promise<void> {
        try {
          await socket.recv(ctx)
        } catch (error) {
          observed = error
        }
      },
      Object.freeze({ request, localAddress: "", remoteAddress: "" }),
      true
    )
    expect(response.status).toBe(500)
    expect(observed).toMatchObject({ code: "GO_LIKE_TRANSPORT_PROTOCOL" })
  }
})

test("server POST bodies reject non-Uint8Array chunks with the original Error cause", async () => {
  const chunkFailure = new Error("invalid request chunk")
  const request = new Request("http://service.test/rpc", {
    method: "POST",
    body: invalidBodyStream(chunkFailure)
  })
  let observed: unknown = null
  const response = await dispatchHTTPHostRequest(
    background(),
    async function receive(ctx, socket): Promise<void> {
      try {
        await socket.recv(ctx)
      } catch (error) {
        observed = error
      }
    },
    Object.freeze({ request, localAddress: "", remoteAddress: "" }),
    true
  )

  expect(response.status).toBe(500)
  expect(observed).toMatchObject({
    code: "GO_LIKE_TRANSPORT_PROTOCOL",
    cause: chunkFailure
  })
})

test("request cancellation flows one way into the private handler Context", async () => {
  const controller = new AbortController()
  const request = new Request("http://service.test/rpc", {
    method: "POST",
    signal: controller.signal
  })
  controller.abort(new Error("external"))
  let observed: unknown = null
  const response = await dispatchHTTPHostRequest(
    background(),
    async function canceledHandler(ctx, socket): Promise<void> {
      observed = ctx.err()
      await expect(socket.recv(background())).rejects.toBe(canceled)
    },
    Object.freeze({ request, localAddress: "", remoteAddress: "" }),
    true
  )
  expect(observed).toBe(canceled)
  expect(response.status).toBe(500)

  const [ctx, cancel] = withCancel(background())
  cancel()
  const preCanceled = await dispatchHTTPHostRequest(
    ctx,
    async function preCanceledHandler(handlerCtx, socket): Promise<void> {
      await expect(socket.recv(handlerCtx)).rejects.toBe(canceled)
    },
    Object.freeze({
      request: new Request("http://service.test/rpc", { method: "POST" }),
      localAddress: "",
      remoteAddress: ""
    }),
    true
  )
  expect(preCanceled.status).toBe(500)

  const activeController = new AbortController()
  const entered = deferred<void>()
  let activeObserved: unknown = null
  const active = dispatchHTTPHostRequest(
    background(),
    async function activeCanceledHandler(handlerContext): Promise<void> {
      entered.resolve(undefined)
      const done = handlerContext.done()
      if (done !== null && !done.aborted) {
        await new Promise<void>(function wait(resolve): void {
          done.addEventListener("abort", function aborted(): void {
            resolve()
          })
        })
      }
      activeObserved = handlerContext.err()
    },
    Object.freeze({
      request: new Request("http://service.test/rpc", {
        method: "POST",
        signal: activeController.signal
      }),
      localAddress: "",
      remoteAddress: ""
    }),
    true
  )
  await entered.promise
  activeController.abort(new Error("external"))
  expect((await active).status).toBe(500)
  expect(activeObserved).toBe(canceled)
})

test("server transport info exposes only admitted HTTP observations", async () => {
  const response = await dispatchHTTPHostRequest(
    background(),
    async function inspect(handlerContext, socket): Promise<void> {
      const info = fromServerContext(handlerContext)
      expect(info).not.toBeNull()
      expect(info?.kind()).toBe("http")
      expect(info?.endpoint()).toBe("http://127.0.0.1:43123")
      expect(info?.operation()).toBe("orders/get")
      expect(info?.requestHeaders()["x-request"]).toEqual(["yes"])
      expect(info?.replyHeaders()).toEqual({})
      const request = await socket.recv(handlerContext)
      await socket.send(handlerContext, {
        header: { "X-Reply": "ok" },
        body: request.body
      })
      expect(info?.replyHeaders()["x-reply"]).toEqual(["ok"])
    },
    Object.freeze({
      request: new Request("http://service.test/rpc", {
        method: "POST",
        headers: {
          "Go-Like-Service": "orders",
          "Go-Like-Endpoint": "get",
          "X-Request": "yes"
        },
        body: "payload"
      }),
      localAddress: "",
      remoteAddress: ""
    }),
    true,
    null,
    "http://127.0.0.1:43123"
  )
  expect(response.headers.get("x-reply")).toBe("ok")

  const unreadableHeaders = new Request("http://service.test/rpc")
  Object.defineProperty(unreadableHeaders.headers, "entries", {
    configurable: true,
    value(): never {
      throw new Error("entries failed")
    }
  })
  const unreadableContext = withHTTPServerTransportInfo(
    background(),
    "",
    unreadableHeaders,
    function noResponse(): null {
      return null
    }
  )
  expect(fromServerContext(unreadableContext)?.requestHeaders()).toEqual({})

  const unreadableOperation = new Request("http://service.test/rpc")
  Object.defineProperty(unreadableOperation.headers, "get", {
    configurable: true,
    value(): never {
      throw new Error("get failed")
    }
  })
  expect(
    fromServerContext(
      withHTTPServerTransportInfo(background(), "", unreadableOperation, function noResponse() {
        return null
      })
    )?.operation()
  ).toBe("")

  const invalidContext = Object.freeze({})
  expect(
    Reflect.apply(withHTTPServerTransportInfo, undefined, [
      invalidContext,
      "",
      new Request("http://service.test/rpc"),
      function noResponse(): null {
        return null
      }
    ])
  ).toBe(invalidContext)
})

test("non-200 recv cancellation owns and cancels the bounded status reader", async () => {
  let canceledBodies = 0
  const response = new Response(
    new ReadableStream<Uint8Array>({
      /** Keeps the status body pending until its owning recv is canceled. */
      pull(): void {},
      /** Records cancellation of the owned status reader. */
      cancel(): void {
        canceledBodies += 1
      }
    }),
    { status: 503 }
  )
  const run = httpExecutor(function run(): Promise<Response> {
    return Promise.resolve(response)
  })
  const client = await newHTTPTransport(executor(run)).dial(background(), "localhost:8080")
  await client.send(background(), requestMessage())
  const [ctx, cancel] = withCancel(background())
  const receiving = client.recv(ctx)
  for (let attempt = 0; attempt < 10 && response.body?.locked !== true; attempt += 1) {
    await Promise.resolve()
  }
  expect(response.body?.locked).toBe(true)
  cancel()

  await expect(receiving).rejects.toBe(canceled)
  await Promise.resolve()
  expect(canceledBodies).toBe(1)
})

test("server operation cancellation and invalid response messages remain request-local", async () => {
  const bodyStarted = deferred<void>()
  let bodyCanceled = 0
  const request = new Request("http://service.test/rpc", {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      /** Keeps request body ownership pending for caller cancellation. */
      pull(): void {
        bodyStarted.resolve(undefined)
      },
      /** Records cancellation of the transport-owned request body. */
      cancel(): Promise<void> {
        bodyCanceled += 1
        return Promise.reject(new Error("reader cancel rejected"))
      }
    })
  })
  let observed: unknown = null
  const canceledResponse = await dispatchHTTPHostRequest(
    background(),
    async function cancelOperation(_handlerContext, socket): Promise<void> {
      const [operationContext, cancelOperationContext] = withCancel(background())
      const receiving = socket.recv(operationContext)
      await bodyStarted.promise
      cancelOperationContext()
      try {
        await receiving
      } catch (error) {
        observed = error
      }
    },
    Object.freeze({ request, localAddress: "", remoteAddress: "" }),
    true
  )
  expect(observed).toBe(canceled)
  expect(canceledResponse.status).toBe(500)
  expect(bodyCanceled).toBe(1)

  let sendFailure: unknown = null
  const invalidResponse = await dispatchHTTPHostRequest(
    background(),
    async function sendInvalid(ctx, socket): Promise<void> {
      try {
        await socket.send(ctx, Reflect.get({}, "missing"))
      } catch (error) {
        sendFailure = error
      }
    },
    Object.freeze({
      request: new Request("http://service.test/rpc", { method: "POST" }),
      localAddress: "",
      remoteAddress: ""
    }),
    true
  )
  expect(sendFailure).toMatchObject({ code: "GO_LIKE_TRANSPORT_PROTOCOL" })
  expect(invalidResponse.status).toBe(500)
})

test("server recv preserves Context identity when reader cancellation throws synchronously", async () => {
  const originalCancel = Object.getOwnPropertyDescriptor(
    ReadableStreamDefaultReader.prototype,
    "cancel"
  )
  const cancelFailure = new Error("reader cancel threw synchronously")
  let cancelCalls = 0
  let observed: unknown = null
  let settlement = "unobserved"
  try {
    Object.defineProperty(ReadableStreamDefaultReader.prototype, "cancel", {
      configurable: true,
      writable: true,
      /** Reproduces a hostile transport-owned Web Stream reader boundary. */
      value(): never {
        cancelCalls += 1
        throw cancelFailure
      }
    })
    const response = await dispatchHTTPHostRequest(
      background(),
      async function cancelOperation(_handlerContext, socket): Promise<void> {
        const [operationContext, cancelOperationContext] = withCancel(background())
        const receiving = socket.recv(operationContext)
        await Promise.resolve()
        cancelOperationContext()
        settlement = await Promise.race([
          receiving.then(
            function resolved(): string {
              return "resolved"
            },
            function rejected(error: unknown): string {
              observed = error
              return "rejected"
            }
          ),
          new Promise<string>(function expire(resolve): void {
            setTimeout(function timeout(): void {
              resolve("pending")
            }, 20)
          })
        ])
      },
      Object.freeze({
        request: new Request("http://service.test/rpc", {
          method: "POST",
          body: new ReadableStream<Uint8Array>({ pull(): void {} })
        }),
        localAddress: "",
        remoteAddress: ""
      }),
      true
    )
    expect(response.status).toBe(500)
  } finally {
    if (originalCancel === undefined) {
      Reflect.deleteProperty(ReadableStreamDefaultReader.prototype, "cancel")
    } else {
      Object.defineProperty(ReadableStreamDefaultReader.prototype, "cancel", originalCancel)
    }
  }
  expect(settlement).toBe("rejected")
  expect(observed).toBe(canceled)
  expect(cancelCalls).toBe(1)
})

test("server recv closes the initial cancellation race and cancels the owned reader", async () => {
  let errorReads = 0
  let bodyCanceled = 0
  const racingContext = Object.freeze({
    /** Reports no deadline for this controlled race. */
    deadline(): readonly [Date, boolean] {
      return Object.freeze([new Date(0), false])
    },
    /** Disables signal observation so the second error read is the linearization point. */
    done(): null {
      return null
    },
    /** Becomes canceled between public admission and the internal waiter. */
    err() {
      errorReads += 1
      return errorReads === 1 ? null : canceled
    },
    /** Carries no values in this controlled race. */
    value(): null {
      return null
    }
  })
  const request = new Request("http://localhost/rpc", {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      /** Keeps request consumption pending. */
      pull(): void {},
      /** Records cancellation of the transport-owned reader. */
      cancel(): void {
        bodyCanceled += 1
      }
    })
  })
  const response = await dispatchHTTPHostRequest(
    background(),
    async function race(_ctx, socket): Promise<void> {
      await expect(socket.recv(racingContext)).rejects.toBe(canceled)
      await socket.send(
        background(),
        Object.freeze({
          header: Object.freeze({}),
          body: new TextEncoder().encode("handled")
        })
      )
    },
    Object.freeze({ request, localAddress: "", remoteAddress: "" }),
    false
  )
  expect(response.status).toBe(200)
  expect(await response.text()).toBe("handled")
  expect(bodyCanceled).toBe(1)
})
