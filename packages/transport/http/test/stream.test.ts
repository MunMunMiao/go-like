import {
  afterFunc,
  background,
  canceled,
  deadlineExceeded,
  withCancelCause,
  withTimeout,
  type Context
} from "@go-like/context"
import { newClient, withEndpoint, withTransport, type Client } from "@go-like/client"
import {
  address,
  maxSendMessageBytes,
  newServer,
  streamKeepAlive,
  transport,
  type Server,
  type ServerOption
} from "@go-like/server"
import { struct } from "@go-like/struct"
import { endpoint, isServiceError, type ServerStream } from "@go-like/transport"
import { jsonContentType } from "@go-like/transport/json"
import {
  encodeSSEComment,
  encodeSSEEvent,
  encodeSSEJsonEvent,
  eventStreamContentType
} from "@go-like/transport/sse"
import { expect, test } from "bun:test"

import { maxMessageBytes } from "../src/index"
import { newNodeHTTPTransport } from "../src/node"
import type { Transport } from "@go-like/transport"

const noProxy = [process.env.NO_PROXY, process.env.no_proxy, "127.0.0.1", "localhost", "::1"]
  .filter(Boolean)
  .join(",")
process.env.NO_PROXY = noProxy
process.env.no_proxy = noProxy

const Item = struct.object({ n: struct.number() })
const BlobItem = struct.object({ blob: struct.string() })
const watch = endpoint("orders", "watch", Item, Item, true)
const ping = endpoint("orders", "ping", Item, Item)
const messy = endpoint("orders", "messy", Item, Item, true)
const cut = endpoint("orders", "cut", Item, Item, true)

/** Waits without keeping the process alive. */
function delay(ms: number): Promise<void> {
  return new Promise(function settle(resolve): void {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** Joins encoded SSE frames. */
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

/** Reads numeric stream values. */
async function collect(events: ServerStream<{ readonly n: number }>): Promise<number[]> {
  const values: number[] = []
  for await (const event of events) values.push(event.n)
  return values
}

interface Running {
  readonly conn: Client
  readonly location: string
  readonly node: Transport
  stop(): Promise<void>
}

interface Bound {
  location: string
}

/** Starts one Node HTTP server on an ephemeral port. */
async function start(
  register: (server: Server, bound: Bound, node: Transport) => void,
  serverOptions: readonly ServerOption[] = [],
  clientLimit?: number
): Promise<Running> {
  const node =
    clientLimit === undefined
      ? newNodeHTTPTransport()
      : newNodeHTTPTransport(maxMessageBytes(clientLimit))
  const server = newServer(transport(node), address("127.0.0.1:0"), ...serverOptions)
  const bound: Bound = { location: "" }
  register(server, bound, node)
  const running = server.start(background())
  bound.location = await server.endpoint(background())
  const conn = newClient(withTransport(node), withEndpoint(bound.location))
  return {
    conn,
    location: bound.location,
    node,
    async stop(): Promise<void> {
      await conn.close(background())
      await server.stop(background())
      await running
    }
  }
}

test("serves an HTTP event stream with the initial comment and end event", async () => {
  const server = newServer(transport(newNodeHTTPTransport()), address("127.0.0.1:0"))
  server.registerHandler(watch, async function* (): AsyncGenerator<{ n: number }> {
    yield { n: 1 }
    yield { n: 2 }
  })
  const pending = server.start(background())
  const location = await server.endpoint(background())
  const conn = newClient(withTransport(newNodeHTTPTransport()), withEndpoint(location))
  try {
    const response = await fetch(new URL("/orders/watch", location), {
      method: "POST",
      headers: { "content-type": jsonContentType, accept: eventStreamContentType },
      body: JSON.stringify({ n: 1 })
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe(eventStreamContentType)
    expect(response.headers.get("cache-control")).toBe("no-cache")
    const text = await response.text()
    expect(text.startsWith(":\n\n")).toBe(true)
    expect(text).toContain('data: {"n":1}\n\n')
    expect(text).toContain("event: end\n")
    expect(await collect(await conn.stream(background(), watch, { n: 1 }))).toEqual([1, 2])
  } finally {
    await conn.close(background())
    await server.stop(background())
    await pending
  }
})

test("ignores unknown HTTP events, id, and retry", async () => {
  const running = await start((server) => {
    server.registerHandler("orders", "messy", async () => {
      return new Response(
        frames(
          encodeSSEComment(),
          new TextEncoder().encode("id: 3\nretry: 5\n: keep\n\n"),
          new TextEncoder().encode('event: other\ndata: {"n":9}\n\n'),
          encodeSSEEvent(JSON.stringify({ n: 4 })),
          encodeSSEJsonEvent({}, "end")
        ),
        {
          status: 200,
          headers: { "content-type": eventStreamContentType, "cache-control": "no-cache" }
        }
      )
    })
  })
  try {
    expect(await collect(await running.conn.stream(background(), messy, { n: 1 }))).toEqual([4])
  } finally {
    await running.stop()
  }
})

test("returns a unary HTTP ServiceError when the handler throws first", async () => {
  const running = await start((server) => {
    server.registerHandler(watch, () => {
      throw new Error("boom")
    })
  })
  try {
    await expect(running.conn.stream(background(), watch, { n: 1 })).rejects.toMatchObject({
      code: "internal",
      status: 500
    })
    const response = await fetch(new URL("/orders/watch", running.location), {
      method: "POST",
      headers: { "content-type": jsonContentType },
      body: JSON.stringify({ n: 1 })
    })
    expect(response.status).toBe(500)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(JSON.stringify(await response.json())).not.toContain("boom")
  } finally {
    await running.stop()
  }
})

test("sends HTTP error events for a non-iterable, an early next throw, and a mid-stream throw", async () => {
  let mode: "shape" | "early" | "mid" = "shape"
  const running = await start((server) => {
    server.registerHandler(watch, () => {
      if (mode === "shape") return Promise.resolve({ n: 1 }) as never
      return (async function* (): AsyncGenerator<{ n: number }> {
        if (mode === "early") throw new Error("early")
        yield { n: 7 }
        throw new Error("mid")
      })()
    })
  })
  try {
    const shaped = await running.conn.stream(background(), watch, { n: 1 })
    await expect(collect(shaped)).rejects.toMatchObject({
      code: "internal",
      message: "internal service error"
    })
    mode = "early"
    await expect(
      collect(await running.conn.stream(background(), watch, { n: 1 }))
    ).rejects.toMatchObject({
      code: "internal"
    })
    mode = "mid"
    const values: number[] = []
    const mid = await running.conn.stream(background(), watch, { n: 1 })
    await expect(
      (async () => {
        for await (const event of mid) values.push(event.n)
      })()
    ).rejects.toMatchObject({ code: "internal" })
    expect(values).toEqual([7])
  } finally {
    await running.stop()
  }
})

test("reports HTTP truncation and runs finally after break, close, and cancellation", async () => {
  const reasons: string[] = []
  const running = await start((server) => {
    server.registerHandler("orders", "cut", async () => {
      return new Response(frames(encodeSSEComment(), encodeSSEEvent(JSON.stringify({ n: 1 }))), {
        status: 200,
        headers: { "content-type": eventStreamContentType }
      })
    })
    server.registerHandler(watch, async function* (ctx: Context): AsyncGenerator<{ n: number }> {
      try {
        yield { n: 1 }
        await new Promise<void>(function untilCanceled(resolve): void {
          afterFunc(ctx, resolve)
        })
        yield { n: 2 }
      } finally {
        reasons.push(ctx.err() === null ? "open" : "canceled")
      }
    })
  })
  try {
    await expect(collect(await running.conn.stream(background(), cut, { n: 1 }))).rejects.toThrow(
      "server stream ended before a terminal event"
    )
    const broken = await running.conn.stream(background(), watch, { n: 1 })
    for await (const event of broken) {
      expect(event.n).toBe(1)
      break
    }
    const closed = await running.conn.stream(background(), watch, { n: 1 })
    const iterator = closed[Symbol.asyncIterator]()
    await iterator.next()
    await closed.close()
    const [caller, cancel] = withCancelCause(background())
    const stopped = await running.conn.stream(caller, watch, { n: 1 })
    const stopping = stopped[Symbol.asyncIterator]()
    await stopping.next()
    cancel(new Error("stop"))
    await expect(stopping.next()).rejects.toBe(canceled)
    const started = Date.now()
    while (reasons.length < 3 && Date.now() - started < 500) await delay(5)
    expect(reasons).toEqual(["canceled", "canceled", "canceled"])
  } finally {
    await running.stop()
  }
})

test("keeps the HTTP request context usable for a downstream call during the stream", async () => {
  const running = await start((server, bound, node) => {
    server.registerHandler(ping, (_ctx: Context, request: { n: number }) => ({ n: request.n + 1 }))
    server.registerHandler(watch, async function* (ctx: Context): AsyncGenerator<{ n: number }> {
      const downstream = newClient(withTransport(node), withEndpoint(bound.location))
      try {
        const pong = await downstream.call(ctx, ping, { n: 1 })
        if (ctx.err() !== null) throw new Error("context canceled during the stream")
        yield pong
        yield { n: 9 }
      } finally {
        await downstream.close(background())
      }
    })
  })
  try {
    expect(await collect(await running.conn.stream(background(), watch, { n: 1 }))).toEqual([2, 9])
  } finally {
    await running.stop()
  }
})

test("delivers a slow HTTP consumer every event in order", async () => {
  const running = await start((server) => {
    server.registerHandler(watch, async function* (): AsyncGenerator<{ n: number }> {
      for (let n = 0; n < 6; n += 1) yield { n }
    })
  })
  try {
    const events = await running.conn.stream(background(), watch, { n: 1 })
    const values: number[] = []
    for await (const event of events) {
      values.push(event.n)
      await delay(10)
    }
    expect(values).toEqual([0, 1, 2, 3, 4, 5])
  } finally {
    await running.stop()
  }
})

test("emits HTTP idle comments and a deadline error event", async () => {
  const quiet = await start(
    (server) => {
      server.registerHandler(watch, async function* (): AsyncGenerator<{ n: number }> {
        await delay(90)
        yield { n: 1 }
        await delay(90)
        yield { n: 2 }
      })
    },
    [streamKeepAlive(20)]
  )
  try {
    const response = await fetch(new URL("/orders/watch", quiet.location), {
      method: "POST",
      headers: { "content-type": jsonContentType, accept: eventStreamContentType },
      body: JSON.stringify({ n: 1 })
    })
    const text = await response.text()
    expect(text.split("\n").filter((line) => line.startsWith(":")).length).toBeGreaterThan(2)
    expect(text).toContain("event: end")
  } finally {
    await quiet.stop()
  }

  const limited = await start((server) => {
    server.registerHandler(watch, async function* (): AsyncGenerator<{ n: number }> {
      await delay(300)
      yield { n: 1 }
    })
  })
  try {
    const wire = await fetch(new URL("/orders/watch", limited.location), {
      method: "POST",
      headers: {
        "content-type": jsonContentType,
        accept: eventStreamContentType,
        "Go-Like-Timeout-Ms": "40"
      },
      body: JSON.stringify({ n: 1 })
    })
    const text = await wire.text()
    expect(text).toContain("event: error")
    expect(text).toContain('"code":"deadline_exceeded"')
    expect(text).toContain('"status":504')
    const [caller] = withTimeout(background(), 40)
    await expect(collect(await limited.conn.stream(caller, watch, { n: 1 }))).rejects.toBe(
      deadlineExceeded
    )
  } finally {
    await limited.stop()
  }
})

test("rejects oversized HTTP events on the server and on the client", async () => {
  const blob = endpoint("orders", "watch", Item, BlobItem, true)
  const serverLimited = await start(
    (server) => {
      server.registerHandler(blob, async function* () {
        yield { blob: "a".repeat(64) }
      })
    },
    [maxSendMessageBytes(32)]
  )
  try {
    await expect(
      (async () => {
        for await (const _event of await serverLimited.conn.stream(background(), blob, { n: 1 })) {
          // The server replaces the oversized event with an error event.
        }
      })()
    ).rejects.toMatchObject({
      code: "resource_exhausted",
      status: 429,
      message: expect.stringContaining("server send limit of 32 bytes")
    })
  } finally {
    await serverLimited.stop()
  }

  const clientLimited = await start(
    (server) => {
      server.registerHandler(blob, async function* () {
        yield { blob: "a".repeat(64) }
      })
    },
    [],
    48
  )
  try {
    const failure = await (async () => {
      try {
        for await (const _event of await clientLimited.conn.stream(background(), blob, { n: 1 })) {
          // The client receive ceiling is below the server send ceiling.
        }
        return null
      } catch (error) {
        return error
      }
    })()
    expect(isServiceError(failure)).toBe(true)
    if (!isServiceError(failure)) return
    expect(failure.code).toBe("resource_exhausted")
    expect(failure.status).toBe(429)
    expect(failure.message).toContain("client receive limit of 48 bytes")
  } finally {
    await clientLimited.stop()
  }
})
