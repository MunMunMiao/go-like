import { getEventListeners } from "node:events"

import { background, canceled, withCancelCause, type Context } from "@go-like/context"
import { struct } from "@go-like/struct"
import { endpoint, isServiceError, type Transport } from "@go-like/transport"
import {
  encodeSSEComment,
  encodeSSEEvent,
  encodeSSEJsonEvent,
  eventStreamContentType
} from "@go-like/transport/sse"
import { expect, test } from "bun:test"

import { newClient, withEndpoint, withRetry, withTransport, type Client } from "../src/index"
import { openServerStream } from "../src/stream"

const Item = struct.object({ n: struct.number() })
const Empty = struct.object({})
const watch = endpoint("orders", "watch", Empty, Item, true)
const unary = endpoint("orders", "get", Empty, Item)

/** Joins encoded SSE frames into one response body. */
function frames(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const buffer = new ArrayBuffer(length)
  const bytes = new Uint8Array(buffer)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }
  return bytes
}

/** Builds one successful event-stream response. */
function streamResponse(body: Uint8Array<ArrayBuffer>): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": eventStreamContentType,
      "cache-control": "no-cache"
    }
  })
}

/** Dials a scripted Fetch transport and counts attempts. */
function scripted(
  handler: (request: Request) => Response | Promise<Response>,
  maxMessageBytes?: number
): { readonly transport: Transport; readonly attempts: () => number } {
  let attempts = 0
  const transport: Transport = {
    kind(): string {
      return "script"
    },
    init(): void {},
    options(): never {
      throw new Error("unused options")
    },
    async dial(): Promise<{ fetch: TransportClientFetch; close: () => Promise<void> }> {
      return {
        async fetch(_ctx: Context, request: Request): Promise<Response> {
          attempts += 1
          return await handler(request)
        },
        async close(): Promise<void> {}
      }
    },
    async listen(): Promise<never> {
      throw new Error("unused listen")
    },
    string(): string {
      return "script"
    },
    ...(maxMessageBytes === undefined
      ? {}
      : {
          /** Publishes the client receive ceiling the way HTTP transport does. */
          maxMessageBytes(): number {
            return maxMessageBytes
          }
        })
  }
  return {
    transport,
    attempts(): number {
      return attempts
    }
  }
}

type TransportClientFetch = (ctx: Context, request: Request) => Promise<Response>

/** Opens one direct client against the scripted transport. */
function direct(script: ReturnType<typeof scripted>): Client {
  return newClient(withTransport(script.transport), withEndpoint("http://127.0.0.1:9/"))
}

const happyBody = frames(
  encodeSSEComment(),
  encodeSSEEvent(JSON.stringify({ n: 1 })),
  encodeSSEComment("ping"),
  encodeSSEEvent(JSON.stringify({ n: 2 })),
  encodeSSEJsonEvent({}, "end")
)

test("awaits the handshake before yielding and ignores comments, id, and retry", async () => {
  const seen: Request[] = []
  const script = scripted((request) => {
    seen.push(request)
    const withIgnored = frames(
      encodeSSEComment(),
      new TextEncoder().encode("id: 9\nretry: 1000\n: ping\n\n"),
      new TextEncoder().encode("event: other\ndata: {}\n\n"),
      encodeSSEEvent(JSON.stringify({ n: 4 })),
      encodeSSEJsonEvent({}, "end")
    )
    return streamResponse(withIgnored)
  })
  const client = direct(script)
  const events = await client.stream(background(), watch, {})
  const values = []
  for await (const event of events) values.push(event)
  expect(values).toEqual([{ n: 4 }])
  expect(seen[0]?.headers.get("accept")).toBe(eventStreamContentType)
  expect(script.attempts()).toBe(1)
  await events.close()
})

test("rejects a stream endpoint on call and a unary endpoint on stream", async () => {
  const script = scripted(() => streamResponse(happyBody))
  const client = direct(script)
  await expect(client.call(background(), watch, {})).rejects.toThrow(
    "Client call does not accept a stream endpoint"
  )
  await expect(client.stream(background(), unary as never, {})).rejects.toThrow(
    "Client stream requires a stream endpoint"
  )
  expect(script.attempts()).toBe(0)
})

test("throws a restored ServiceError from an error event and a protocol error when truncated", async () => {
  const failed = frames(
    encodeSSEComment(),
    encodeSSEJsonEvent(
      { code: "internal", message: "handler failed", status: 500, metadata: {} },
      "error"
    )
  )
  const truncated = frames(encodeSSEComment(), encodeSSEEvent(JSON.stringify({ n: 1 })))
  let mode: "error" | "truncated" = "error"
  const script = scripted(() => streamResponse(mode === "error" ? failed : truncated))
  const client = direct(script)
  const errored = await client.stream(background(), watch, {})
  await expect(
    (async () => {
      for await (const _event of errored) {
        // The terminal error arrives before a value.
      }
    })()
  ).rejects.toMatchObject({ code: "internal", status: 500, message: "handler failed" })

  mode = "truncated"
  const cut = await client.stream(background(), watch, {})
  await expect(
    (async () => {
      for await (const _event of cut) {
        // EOF before end or error is a protocol failure.
      }
    })()
  ).rejects.toThrow("server stream ended before a terminal event")
})

test("retries a failed dial and does not retry after response headers", async () => {
  let dials = 0
  const transport: Transport = {
    kind(): string {
      return "script"
    },
    init(): void {},
    options(): never {
      throw new Error("unused options")
    },
    async dial(): Promise<{ fetch: TransportClientFetch; close: () => Promise<void> }> {
      dials += 1
      if (dials === 1) throw new Error("dial failed")
      return {
        async fetch(): Promise<Response> {
          return new Response(
            JSON.stringify({ code: "not_found", message: "missing", metadata: {} }),
            {
              status: 404,
              headers: { "content-type": "application/json" }
            }
          )
        },
        async close(): Promise<void> {}
      }
    },
    async listen(): Promise<never> {
      throw new Error("unused listen")
    },
    string(): string {
      return "script"
    }
  }
  const client = newClient(
    withTransport(transport),
    withEndpoint("http://127.0.0.1:9/")
    // pool of zero so a second attempt dials again
  )
  const retry = withRetry({
    authorization: "idempotent",
    maxAttempts: 3,
    shouldRetry: () => true,
    backoff: () => 0
  })
  await expect(client.stream(background(), watch, {}, retry)).rejects.toMatchObject({
    code: "not_found",
    status: 404
  })
  expect(dials).toBe(2)
})

test("rejects an oversized event with the client receive ceiling", async () => {
  const payload = "x".repeat(80)
  const body = frames(encodeSSEComment(), encodeSSEEvent(JSON.stringify({ n: 1, extra: payload })))
  const script = scripted(() => streamResponse(body), 32)
  const client = direct(script)
  const events = await client.stream(background(), watch, {})
  await expect(
    (async () => {
      for await (const _event of events) {
        // The data frame is larger than the receive ceiling.
      }
    })()
  ).rejects.toMatchObject({
    code: "resource_exhausted",
    status: 429
  })
})

test("iterates a server stream once and close is idempotent before iteration", async () => {
  const response = streamResponse(
    frames(
      encodeSSEComment(),
      encodeSSEEvent(JSON.stringify({ n: 1 })),
      encodeSSEJsonEvent({}, "end")
    )
  )
  const events = openServerStream(response, Item, 1024, background())
  await events.close()
  await events.close()
  const values = []
  for await (const event of events) values.push(event)
  expect(values).toEqual([])
  expect(() => events[Symbol.asyncIterator]()).toThrow("server stream can only be iterated once")
})

test("stops reading when the caller context is canceled", async () => {
  const hanging = new Response(
    new ReadableStream<Uint8Array>({
      pull(): Promise<void> {
        return new Promise(() => {})
      }
    }),
    { status: 200, headers: { "content-type": eventStreamContentType } }
  )
  const [ctx, cancel] = withCancelCause(background())
  const events = openServerStream(hanging, Item, 1024, ctx)
  const pending = (async () => {
    for await (const _event of events) {
      // The body never produces a frame.
    }
  })()
  cancel(new Error("stop"))
  await expect(pending).rejects.toBe(canceled)
})

test("rejects an invalid error event as a protocol error", async () => {
  const body = frames(encodeSSEComment(), encodeSSEJsonEvent({ code: "nope" }, "error"))
  const events = openServerStream(streamResponse(body), Item, 1024, background())
  let failure: unknown
  try {
    for await (const _event of events) {
      // Invalid terminal payloads are not ServiceErrors.
    }
  } catch (error) {
    failure = error
  }
  expect(isServiceError(failure)).toBe(false)
  expect(failure).toMatchObject({ message: "server stream error event is invalid" })
})

test("rejects a non-positive event limit and a bodyless stream", async () => {
  expect(() => openServerStream(streamResponse(happyBody), Item, 0, background())).toThrow(
    RangeError
  )
  const events = openServerStream(new Response(null), Item, 32, background())
  await expect(
    (async () => {
      for await (const _event of events) {
        // A null body cannot carry a terminal event.
      }
    })()
  ).rejects.toThrow("server stream ended before a terminal event")
})

test("Q3-02 detaches the caller abort listener when the stream body is null", async () => {
  const [ctx, cancel] = withCancelCause(background())
  const signal = ctx.done()
  if (signal === null) throw new Error("missing done signal")
  const before = getEventListeners(signal, "abort").length
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const events = openServerStream(new Response(null), Item, 32, ctx)
      await expect(
        (async () => {
          for await (const _event of events) {
            // A null body cannot carry a terminal event.
          }
        })()
      ).rejects.toThrow("server stream ended before a terminal event")
    }
    expect(getEventListeners(signal, "abort").length).toBe(before)
  } finally {
    cancel(null)
  }
})

test("close and asyncDispose release an unstarted stream", async () => {
  const events = openServerStream(streamResponse(happyBody), Item, 1024, background())
  await events.close()
  await events[Symbol.asyncDispose]()
})

test("parses CRLF frames and rejects a response that misses the struct", async () => {
  const crlf = frames(
    new TextEncoder().encode('data: {"n":3}\r\n\r\nevent: end\r\ndata: {}\r\n\r\n')
  )
  const events = openServerStream(streamResponse(crlf), Item, 1024, background())
  const values = []
  for await (const event of events) values.push(event.n)
  expect(values).toEqual([3])

  const mismatched = openServerStream(
    streamResponse(
      frames(encodeSSEEvent(JSON.stringify({ n: "x" })), encodeSSEJsonEvent({}, "end"))
    ),
    Item,
    1024,
    background()
  )
  await expect(
    (async () => {
      for await (const _event of mismatched) {
        // The struct rejects the payload before end.
      }
    })()
  ).rejects.toThrow("server stream message does not match the response struct")
})

test("rejects an error event whose payload is not an object", async () => {
  const events = openServerStream(
    streamResponse(frames(new TextEncoder().encode("event: error\ndata: []\n\n"))),
    Item,
    1024,
    background()
  )
  await expect(
    (async () => {
      for await (const _event of events) {
        // Arrays are not ServiceError objects.
      }
    })()
  ).rejects.toThrow("server stream error event is invalid")
})

test("surfaces a rejected socket read while the caller context is still open", async () => {
  const [ctx] = withCancelCause(background())
  const failing = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller): void {
        controller.error(new Error("read failed"))
      }
    }),
    { status: 200, headers: { "content-type": eventStreamContentType } }
  )
  const events = openServerStream(failing, Item, 1024, ctx)
  await expect(
    (async () => {
      for await (const _event of events) {
        // The socket fails before a frame.
      }
    })()
  ).rejects.toThrow("read failed")
})

test("cancels the reader when bytes after the terminal event fail", async () => {
  let sent = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller): void {
      if (!sent) {
        sent = true
        controller.enqueue(new TextEncoder().encode("event: end\ndata: {}\n\n"))
        return
      }
      controller.error(new Error("tail failed"))
    }
  })
  const events = openServerStream(
    new Response(body, { status: 200, headers: { "content-type": eventStreamContentType } }),
    Item,
    1024,
    background()
  )
  const values = []
  for await (const event of events) values.push(event)
  expect(values).toEqual([])
})

/** Reads one happy stream from a direct client. */
async function readHappy(client: Client): Promise<number[]> {
  const events = await client.stream(background(), watch, {})
  const values: number[] = []
  for await (const event of events) values.push(event.n)
  return values
}

test("uses the default receive limit when maxMessageBytes throws or is unusable", async () => {
  const broken = scripted(() => streamResponse(happyBody))
  Object.assign(broken.transport, {
    maxMessageBytes(): never {
      throw new Error("unavailable")
    }
  })
  expect(await readHappy(direct(broken))).toEqual([1, 2])

  const invalid = scripted(() => streamResponse(happyBody))
  Object.assign(invalid.transport, {
    maxMessageBytes(): number {
      return 0
    }
  })
  expect(await readHappy(direct(invalid))).toEqual([1, 2])
})

test("rejects a successful stream whose content type is not event-stream", async () => {
  const script = scripted(
    () =>
      new Response(happyBody, {
        status: 200,
        headers: { "content-type": "application/json" }
      })
  )
  await expect(direct(script).stream(background(), watch, {})).rejects.toThrow(
    "server stream response Content-Type must be text/event-stream"
  )
  expect(script.attempts()).toBe(1)
})
