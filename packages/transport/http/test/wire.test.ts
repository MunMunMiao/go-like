import vm from "node:vm"

import { expect, test } from "bun:test"

import { background, canceled, withCancelCause } from "@go-like/context"
import { fromServerContext } from "@go-like/transport"
import {
  executor,
  maxMessageBytes,
  newHTTPTransport,
  type HTTPExecutor
} from "@go-like/transport-http"

import { limitResponse, readBoundedBody, replayableBody } from "../src/bounded-body"
import {
  assertHTTPContentLength,
  boundedHTTPBodyLength,
  contextError,
  newHTTPTransportUnexpectedExitError,
  normalizeHTTPError,
  snapshotHTTPBodyChunk
} from "../src/errors"
import { dispatchHTTPHostRequest } from "../src/socket"
import { withHTTPServerTransportInfo } from "../src/transport-info"

/** Completes a standard callable executor. */
function httpExecutor(run: () => Promise<Response>): HTTPExecutor {
  return Object.assign(run, {
    /** Leaves optional connection warming inert. */
    preconnect(): void {}
  })
}

test("content length and body snapshots preserve protocol failures", () => {
  expect(() =>
    assertHTTPContentLength(new Headers({ "content-length": "nope" }), 4, "bad length")
  ).toThrow(expect.objectContaining({ code: "GO_LIKE_TRANSPORT_PROTOCOL", message: "bad length" }))
  expect(() =>
    assertHTTPContentLength(new Headers({ "content-length": "5" }), 4, "bad length")
  ).toThrow(expect.objectContaining({ code: "GO_LIKE_TRANSPORT_PROTOCOL" }))
  expect(() => assertHTTPContentLength(new Headers(), 4, "bad length")).not.toThrow()
  expect(() => boundedHTTPBodyLength(3, 2, 4, "too big")).toThrow(
    expect.objectContaining({ code: "GO_LIKE_TRANSPORT_PROTOCOL", message: "too big" })
  )
  expect(boundedHTTPBodyLength(1, 2, 4, "too big")).toBe(3)
  expect(() => snapshotHTTPBodyChunk(null, "bad result")).toThrow(
    expect.objectContaining({ code: "GO_LIKE_TRANSPORT_PROTOCOL" })
  )
  expect(() => snapshotHTTPBodyChunk({ done: false, value: "nope" }, "bad result")).toThrow(
    expect.objectContaining({ code: "GO_LIKE_TRANSPORT_PROTOCOL" })
  )
  expect(snapshotHTTPBodyChunk({ done: true, value: undefined }, "bad result")).toBeNull()
  expect(snapshotHTTPBodyChunk({ done: false, value: new Uint8Array([1]) }, "bad result")).toEqual(
    new Uint8Array([1])
  )
  const marker = Object.freeze({ phase: "normalize" })
  expect(normalizeHTTPError(marker, "normalized")).toMatchObject({
    message: "normalized",
    cause: marker
  })
  expect(normalizeHTTPError(new Error("kept"), "normalized").message).toBe("kept")
  const unexpected = newHTTPTransportUnexpectedExitError("serve", "before-ready")
  expect(unexpected).toMatchObject({
    code: "GO_LIKE_HTTP_TRANSPORT_UNEXPECTED_EXIT",
    source: "serve",
    phase: "before-ready"
  })
  expect(contextError(background())).toBeNull()
})

test("body snapshot preserves getter and copy failures", () => {
  const getterFailure = new Error("getter failed")
  const result = new Proxy(Object.freeze({}), {
    /** Throws from the read-result observation boundary. */
    get(): never {
      throw getterFailure
    }
  })
  expect(() => snapshotHTTPBodyChunk(result, "bad result")).toThrow(
    expect.objectContaining({ code: "GO_LIKE_TRANSPORT_PROTOCOL", cause: getterFailure })
  )

  const descriptor = Object.getOwnPropertyDescriptor(Headers.prototype, "get")
  const headerFailure = new Error("Headers get failed")
  try {
    Object.defineProperty(Headers.prototype, "get", {
      configurable: true,
      writable: true,
      value(): never {
        throw headerFailure
      }
    })
    expect(() => assertHTTPContentLength(new Headers(), 3, "bad length")).toThrow(
      expect.objectContaining({ code: "GO_LIKE_TRANSPORT_PROTOCOL", cause: headerFailure })
    )
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(Headers.prototype, "get")
    else Object.defineProperty(Headers.prototype, "get", descriptor)
  }
})

test("limitResponse fails a declared or streamed oversized body and reports completion", async () => {
  let finished = 0
  await expect(
    Promise.resolve().then(function check(): void {
      limitResponse(
        new Response(null, { status: 204, headers: { "content-length": "9" } }),
        4,
        function done(): void {
          finished += 1
        }
      )
    })
  ).rejects.toMatchObject({ code: "GO_LIKE_TRANSPORT_PROTOCOL" })
  expect(finished).toBe(1)

  const exact = limitResponse(new Response(null, { status: 204 }), 4, function done(): void {
    finished += 1
  })
  expect(exact.body).toBeNull()
  expect(finished).toBe(2)

  let canceled = 0
  const limited = limitResponse(
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller): void {
          controller.enqueue(new Uint8Array([1, 2, 3]))
        },
        cancel(): void {
          canceled += 1
        }
      })
    ),
    2,
    function done(): void {
      finished += 1
    }
  )
  await expect(limited.arrayBuffer()).rejects.toMatchObject({ code: "GO_LIKE_TRANSPORT_PROTOCOL" })
  expect(finished).toBe(3)
  expect(canceled).toBe(1)
  expect(new Uint8Array(replayableBody(new Uint8Array([4])))).toEqual(new Uint8Array([4]))
})

test("readBoundedBody rejects an invalid stream chunk and an oversized payload", async () => {
  await expect(
    readBoundedBody(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          Reflect.apply(controller.enqueue, controller, [new Error("chunk")])
          controller.close()
        }
      }),
      new Headers(),
      8,
      "bad length",
      "bad body"
    )
  ).rejects.toMatchObject({ code: "GO_LIKE_TRANSPORT_PROTOCOL", message: "bad body" })
  const bytes = await readBoundedBody(
    new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new Uint8Array([1]))
        controller.close()
      }
    }),
    new Headers(),
    8,
    "bad length",
    "bad body"
  )
  expect(bytes).toEqual(new Uint8Array([1]))
  expect(await readBoundedBody(null, new Headers(), 8, "bad length", "bad body")).toBeNull()
  const controller = new AbortController()
  const stop = new Error("stop")
  controller.abort(stop)
  let stopped = 0
  const aborted = await readBoundedBody(
    new ReadableStream<Uint8Array>({
      pull(): void {},
      cancel(): void {
        stopped += 1
      }
    }),
    new Headers(),
    8,
    "bad length",
    "bad body",
    controller.signal
  )
  expect(stopped).toBe(1)
  expect(aborted).toEqual(new Uint8Array())

  await expect(
    readBoundedBody(
      new ReadableStream<Uint8Array>({
        pull(): never {
          throw new Error("pull failed")
        }
      }),
      new Headers(),
      8,
      "bad length",
      "bad body"
    )
  ).rejects.toMatchObject({
    code: "GO_LIKE_TRANSPORT_PROTOCOL",
    message: "bad body",
    cause: { message: "pull failed" }
  })

  const stopping = new AbortController()
  let stopRejected = false
  const stopRead = readBoundedBody(
    new ReadableStream<Uint8Array>({
      pull(): void {},
      cancel(): Promise<void> {
        stopRejected = true
        return Promise.reject(new Error("stop failed"))
      }
    }),
    new Headers(),
    8,
    "bad length",
    "bad body",
    stopping.signal
  )
  stopping.abort(new Error("stop"))
  expect(await stopRead).toEqual(new Uint8Array())
  expect(stopRejected).toBe(true)

  const detached = new Uint8Array(new ArrayBuffer(4))
  structuredClone(detached, { transfer: [detached.buffer] })
  expect(() => snapshotHTTPBodyChunk({ done: false, value: detached }, "bad chunk")).toThrow(
    expect.objectContaining({ code: "GO_LIKE_TRANSPORT_PROTOCOL", message: "bad chunk" })
  )

  let lengthCancelRejected = false
  await expect(
    Promise.resolve().then(function oversized(): void {
      limitResponse(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(): void {},
            cancel(): Promise<void> {
              lengthCancelRejected = true
              return Promise.reject(new Error("length cancel failed"))
            }
          }),
          { status: 200, headers: { "content-length": "nope" } }
        ),
        4
      )
    })
  ).rejects.toMatchObject({ code: "GO_LIKE_TRANSPORT_PROTOCOL" })
  await Promise.resolve()
  expect(lengthCancelRejected).toBe(true)

  const untouched = limitResponse(new Response(null, { status: 204 }), 4)
  expect(untouched.status).toBe(204)
  const bodyAbort = new AbortController()
  let failCancelRejected = false
  limitResponse(
    new Response(
      new ReadableStream<Uint8Array>({
        pull(): void {},
        cancel(): Promise<void> {
          failCancelRejected = true
          return Promise.reject(new Error("fail cancel failed"))
        }
      })
    ),
    8,
    function finished(): void {},
    bodyAbort.signal
  )
  bodyAbort.abort(new Error("body aborted"))
  await Promise.resolve()
  expect(failCancelRejected).toBe(true)
})

test("Q4-06 limitResponse preserves a cross-realm abort Error", async () => {
  const reason = vm.runInNewContext('new Error("cross realm stop")') as Error
  const isError = Object.getOwnPropertyDescriptor(Error, "isError")?.value as
    | ((value: unknown) => boolean)
    | undefined
  expect(typeof isError).toBe("function")
  expect(isError?.(reason)).toBe(true)
  expect(reason instanceof Error).toBe(false)
  const abort = new AbortController()
  const limited = limitResponse(
    new Response(new ReadableStream<Uint8Array>()),
    1024,
    function finished(): void {},
    abort.signal
  )
  const body = limited.body
  if (body === null) throw new Error("missing body")
  const pending = body.getReader().read()
  abort.abort(reason)
  await expect(pending).rejects.toBe(reason)
})

test("dispatch returns the handler Response and a secret-safe 500", async () => {
  const request = new Request("http://127.0.0.1/orders/get", {
    method: "POST",
    headers: { "X-Request": "yes" },
    body: "payload"
  })
  let same = false
  const response = await dispatchHTTPHostRequest(
    background(),
    function handle(ctx, incoming): Response {
      same = incoming === request
      const info = fromServerContext(ctx)
      expect(info?.kind()).toBe("http")
      expect(info?.endpoint()).toBe("http://127.0.0.1:9")
      expect(info?.operation()).toBe("orders/get")
      expect(info?.requestHeaders()["x-request"]).toEqual(["yes"])
      expect(info?.replyHeaders()).toEqual({})
      expect(info?.peerIdentity()).toBeNull()
      return new Response("ok", { status: 201, headers: { "X-Reply": "ok" } })
    },
    Object.freeze({
      request,
      localAddress: "",
      remoteAddress: "",
      peerIdentity: ""
    }),
    null,
    "http://127.0.0.1:9"
  )
  expect(same).toBe(true)
  expect(response.status).toBe(201)
  expect(await response.text()).toBe("ok")

  const secret = "credential-secret-value"
  const failed = await dispatchHTTPHostRequest(
    background(),
    function fail(): Response {
      throw new Error(secret)
    },
    Object.freeze({
      request: new Request("http://127.0.0.1/"),
      localAddress: "",
      remoteAddress: ""
    })
  )
  expect(failed.status).toBe(500)
  const text = await failed.text()
  expect(text).toBe("Internal Server Error")
  expect(text).not.toContain(secret)
})

test("server transport info keeps readable facts when header observation throws", () => {
  const request = new Request("http://service.test/healthz", { headers: { "X-Request": "yes" } })
  const response = new Response("ok", { headers: { "X-Reply": "1" } })
  const entries = Headers.prototype.entries
  Headers.prototype.entries = function failEntries(): never {
    throw new Error("entries failed")
  }
  let ctx = background()
  let observedRequestHeaders: unknown = null
  try {
    ctx = withHTTPServerTransportInfo(
      background(),
      "http://127.0.0.1:1",
      request,
      function current(): Response {
        return response
      },
      "spiffe://example/node"
    )
    // Request headers are projected on first observation, so the failure must happen then.
    observedRequestHeaders = fromServerContext(ctx)?.requestHeaders() ?? null
  } finally {
    Headers.prototype.entries = entries
  }
  const info = fromServerContext(ctx)
  expect(observedRequestHeaders).toEqual({})
  expect(info?.requestHeaders()).toEqual({})
  expect(info?.replyHeaders()["x-reply"]).toEqual(["1"])
  expect(info?.operation()).toBe("healthz")
  expect(info?.peerIdentity()).toBe("spiffe://example/node")

  const invalid = Object.freeze({})
  expect(
    withHTTPServerTransportInfo(
      invalid as never,
      "",
      new Request("http://service.test/"),
      function none(): null {
        return null
      },
      null
    )
  ).toBe(invalid as never)
})

test("a client response body cancellation follows the caller Context", async () => {
  let canceledBodies = 0
  const client = await newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              pull(): void {},
              cancel(): void {
                canceledBodies += 1
              }
            }),
            { status: 503 }
          )
        )
      })
    ),
    maxMessageBytes(8)
  ).dial(background(), "example.test:8080")
  const [ctx, cancel] = withCancelCause(background())
  const response = await client.fetch(
    ctx,
    new Request("http://example.test:8080/orders/Create", { method: "POST", body: "x" })
  )
  expect(response.status).toBe(503)
  cancel(canceled)
  await Promise.resolve()
  await Promise.resolve()
  expect(canceledBodies).toBe(1)
  await client.close(background())
})
