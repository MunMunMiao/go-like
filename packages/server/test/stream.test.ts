import {
  background,
  canceled,
  deadlineExceeded,
  withCancelCause,
  withTimeout,
  type Context
} from "@go-like/context"
import { newClient, withEndpoint, withTransport, type Client } from "@go-like/client"
import { struct } from "@go-like/struct"
import { endpoint, isServiceError, type ServerStream } from "@go-like/transport"
import {
  encodeSSEComment,
  encodeSSEEvent,
  encodeSSEJsonEvent,
  eventStreamContentType
} from "@go-like/transport/sse"
import { jsonContentType } from "@go-like/transport/json"
import { describe, expect, test } from "bun:test"
import { newMemoryTransport, type MemoryTransport } from "@go-like/transport-memory"

import {
  address,
  maxSendMessageBytes,
  newServer,
  streamKeepAlive,
  transport,
  type Server,
  type ServerOption
} from "../src/index"

const Item = struct.object({ n: struct.number() })
const BlobItem = struct.object({ blob: struct.string() })
const watch = endpoint("orders", "watch", Item, Item, true)
const ping = endpoint("orders", "ping", Item, Item)
const messy = endpoint("orders", "messy", Item, Item, true)
const cut = endpoint("orders", "cut", Item, Item, true)

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

/** Waits without keeping the process alive. */
function delay(ms: number): Promise<void> {
  return new Promise(function settle(resolve): void {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** Reads one server stream to completion. */
async function collect(events: ServerStream<{ readonly n: number }>): Promise<number[]> {
  const values: number[] = []
  for await (const event of events) values.push(event.n)
  return values
}

interface Running {
  readonly memory: MemoryTransport
  readonly server: Server
  readonly conn: Client
  readonly location: string
  stop(): Promise<void>
}

let sequence = 0

/** Starts one memory server after the caller registers handlers. */
async function start(
  register: (server: Server, location: string, memory: MemoryTransport) => void,
  ...options: readonly ServerOption[]
): Promise<Running> {
  sequence += 1
  const location = `memory://stream-${sequence}`
  const memory = newMemoryTransport()
  const server = newServer(transport(memory), address(location), ...options)
  register(server, location, memory)
  const running = server.start(background())
  await server.endpoint(background())
  const conn = newClient(withTransport(memory), withEndpoint(location))
  return {
    memory,
    server,
    conn,
    location,
    async stop(): Promise<void> {
      await conn.close(background())
      await server.stop(background())
      await running
    }
  }
}

/** Posts one raw SSE request at the memory server. */
async function raw(
  memory: MemoryTransport,
  location: string,
  name: string,
  body = '{"n":1}',
  headers: Record<string, string> = {}
): Promise<Response> {
  const wire = await memory.dial(background(), location)
  const response = await wire.fetch(
    background(),
    new Request(new URL(`/orders/${name}`, location), {
      method: "POST",
      headers: {
        "content-type": jsonContentType,
        accept: eventStreamContentType,
        ...headers
      },
      body
    })
  )
  const source = response.body
  if (source === null) {
    await wire.close(background())
    return response
  }
  const reader = source.getReader()
  let closed = false
  /** Closes the dial after the raw body reaches a terminal state. */
  async function closeWire(): Promise<void> {
    if (closed) return
    closed = true
    await wire.close(background())
  }
  const stream = new ReadableStream<Uint8Array>({
    /** Forwards one chunk and releases the dial at EOF. */
    async pull(controller): Promise<void> {
      try {
        const chunk = await reader.read()
        if (chunk.done) {
          controller.close()
          await closeWire()
          return
        }
        controller.enqueue(chunk.value)
      } catch (error) {
        await closeWire()
        controller.error(error instanceof Error ? error : new Error("memory raw body failed"))
      }
    },
    /** Forwards consumer cancellation and releases the dial. */
    async cancel(reason): Promise<void> {
      await reader.cancel(reason)
      await closeWire()
    }
  })
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}

describe("memory server streams", () => {
  test("serves the initial comment, data, and end event", async () => {
    const running = await start((server) => {
      server.registerHandler(watch, async function* (): AsyncGenerator<{ n: number }> {
        yield { n: 1 }
        yield { n: 2 }
      })
    })
    try {
      const response = await raw(running.memory, running.location, "watch")
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe(eventStreamContentType)
      expect(response.headers.get("cache-control")).toBe("no-cache")
      const text = await response.text()
      expect(text.startsWith(":\n\n")).toBe(true)
      expect(text).toContain('data: {"n":1}\n\n')
      expect(text).toContain("event: end\n")
      expect(await collect(await running.conn.stream(background(), watch, { n: 1 }))).toEqual([
        1, 2
      ])
    } finally {
      await running.stop()
    }
  })

  test("ignores unknown events, id, and retry on the memory wire", async () => {
    const running = await start((server) => {
      server.registerHandler("orders", "messy", async () => {
        const body = frames(
          encodeSSEComment(),
          new TextEncoder().encode("id: 4\nretry: 1000\n: keep\n\n"),
          new TextEncoder().encode('event: other\ndata: {"n":9}\n\n'),
          encodeSSEEvent(JSON.stringify({ n: 4 })),
          encodeSSEJsonEvent({}, "end")
        )
        return new Response(body, {
          status: 200,
          headers: { "content-type": eventStreamContentType, "cache-control": "no-cache" }
        })
      })
    })
    try {
      expect(await collect(await running.conn.stream(background(), messy, { n: 1 }))).toEqual([4])
    } finally {
      await running.stop()
    }
  })

  test("returns a unary ServiceError when the handler throws before streaming", async () => {
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
      const response = await raw(running.memory, running.location, "watch")
      expect(response.headers.get("content-type")).toContain("application/json")
      expect(response.status).toBe(500)
      const body = await response.json()
      expect(body).toMatchObject({ code: "internal" })
      expect(JSON.stringify(body)).not.toContain("boom")
    } finally {
      await running.stop()
    }
  })

  test("sends an error event when the handler result is not an async iterable", async () => {
    const running = await start((server) => {
      server.registerHandler(watch, () => Promise.resolve({ n: 1 }) as never)
    })
    try {
      const events = await running.conn.stream(background(), watch, { n: 1 })
      const failure = await collect(events).then(
        () => null,
        (error: unknown) => error
      )
      expect(isServiceError(failure)).toBe(true)
      if (!isServiceError(failure)) return
      expect(failure).toMatchObject({
        code: "internal",
        status: 500,
        message: "internal service error"
      })
    } finally {
      await running.stop()
    }
  })

  test("sends an error event when next throws before the first message and mid-stream", async () => {
    let mode: "early" | "mid" = "early"
    const running = await start((server) => {
      server.registerHandler(watch, async function* (): AsyncGenerator<{ n: number }> {
        if (mode === "early") throw new Error("early")
        yield { n: 1 }
        throw new Error("mid")
      })
    })
    try {
      const early = await running.conn.stream(background(), watch, { n: 1 })
      await expect(collect(early)).rejects.toMatchObject({ code: "internal", status: 500 })
      mode = "mid"
      const values: number[] = []
      const mid = await running.conn.stream(background(), watch, { n: 1 })
      await expect(
        (async () => {
          for await (const event of mid) values.push(event.n)
        })()
      ).rejects.toMatchObject({ code: "internal", message: "internal service error" })
      expect(values).toEqual([1])
    } finally {
      await running.stop()
    }
  })

  test("reports truncation when the body ends without a terminal event", async () => {
    const running = await start((server) => {
      server.registerHandler("orders", "cut", async () => {
        return new Response(frames(encodeSSEComment(), encodeSSEEvent(JSON.stringify({ n: 1 }))), {
          status: 200,
          headers: { "content-type": eventStreamContentType }
        })
      })
    })
    try {
      const events = await running.conn.stream(background(), cut, { n: 1 })
      await expect(collect(events)).rejects.toThrow("server stream ended before a terminal event")
    } finally {
      await running.stop()
    }
  })

  test("runs the generator finally after break, close, and caller cancellation", async () => {
    const reasons: string[] = []
    const running = await start((server) => {
      server.registerHandler(watch, async function* (ctx: Context): AsyncGenerator<{ n: number }> {
        try {
          yield { n: 1 }
          yield { n: 2 }
        } finally {
          reasons.push(ctx.err() === null ? "open" : "canceled")
        }
      })
    })
    try {
      const broken = await running.conn.stream(background(), watch, { n: 1 })
      for await (const _event of broken) break
      const closed = await running.conn.stream(background(), watch, { n: 1 })
      const iterator = closed[Symbol.asyncIterator]()
      await iterator.next()
      await closed.close()
      await closed.close()
      const [caller, cancel] = withCancelCause(background())
      const stopped = await running.conn.stream(caller, watch, { n: 1 })
      const stopping = stopped[Symbol.asyncIterator]()
      await stopping.next()
      cancel(new Error("stop"))
      await expect(stopping.next()).rejects.toBe(canceled)
      expect(reasons).toEqual(["canceled", "canceled", "canceled"])
    } finally {
      await running.stop()
    }
  })

  test("keeps the request context usable for a downstream call during the stream", async () => {
    const running = await start((server, location, memory) => {
      server.registerHandler(ping, (_ctx: Context, request: { n: number }) => ({
        n: request.n + 1
      }))
      server.registerHandler(watch, async function* (ctx: Context): AsyncGenerator<{ n: number }> {
        const downstream = newClient(withTransport(memory), withEndpoint(location))
        try {
          const pong = await downstream.call(ctx, ping, { n: 1 })
          if (ctx.err() !== null) throw new Error("context canceled during the stream")
          yield pong
          yield { n: 3 }
        } finally {
          await downstream.close(background())
        }
      })
    })
    try {
      expect(await collect(await running.conn.stream(background(), watch, { n: 1 }))).toEqual([
        2, 3
      ])
    } finally {
      await running.stop()
    }
  })

  test("keeps memory production at most one message ahead of the consumer", async () => {
    let produced = 0
    let consumed = 0
    let ahead = 0
    const running = await start((server) => {
      server.registerHandler(watch, async function* (): AsyncGenerator<{ n: number }> {
        for (let n = 0; n < 6; n += 1) {
          produced += 1
          ahead = Math.max(ahead, produced - consumed)
          yield { n }
        }
      })
    })
    try {
      const events = await running.conn.stream(background(), watch, { n: 1 })
      const values: number[] = []
      for await (const event of events) {
        consumed += 1
        values.push(event.n)
        await delay(10)
      }
      expect(values).toEqual([0, 1, 2, 3, 4, 5])
      expect(ahead).toBeLessThanOrEqual(1)
    } finally {
      await running.stop()
    }
  })

  test("emits idle comments while the generator is quiet", async () => {
    const running = await start((server) => {
      server.registerHandler(watch, async function* (): AsyncGenerator<{ n: number }> {
        await delay(90)
        yield { n: 1 }
        await delay(90)
        yield { n: 2 }
      })
    }, streamKeepAlive(20))
    try {
      const response = await raw(running.memory, running.location, "watch")
      const text = await response.text()
      const comments = text.split("\n").filter((line) => line.startsWith(":")).length
      expect(comments).toBeGreaterThan(2)
      expect(text).toContain('data: {"n":1}')
      expect(text).toContain("event: end")
    } finally {
      await running.stop()
    }
  })

  test("does not emit idle comments when streamKeepAlive is zero", async () => {
    const running = await start((server) => {
      server.registerHandler(watch, async function* (): AsyncGenerator<{ n: number }> {
        await delay(50)
        yield { n: 1 }
      })
    }, streamKeepAlive(0))
    try {
      const response = await raw(running.memory, running.location, "watch")
      const text = await response.text()
      const comments = text.split("\n").filter((line) => line.startsWith(":")).length
      expect(comments).toBe(1)
      expect(text).toContain('data: {"n":1}')
      expect(text).toContain("event: end")
    } finally {
      await running.stop()
    }
  })

  test("ends a quiet stream with deadline_exceeded", async () => {
    const running = await start((server) => {
      server.registerHandler(watch, async function* (): AsyncGenerator<{ n: number }> {
        await delay(300)
        yield { n: 1 }
      })
    })
    try {
      const response = await raw(running.memory, running.location, "watch", '{"n":1}', {
        "Go-Like-Timeout-Ms": "40"
      })
      const text = await response.text()
      expect(text).toContain("event: error")
      expect(text).toContain('"code":"deadline_exceeded"')
      expect(text).toContain('"message":"context deadline exceeded"')
      expect(text).toContain('"status":504')
      const [caller] = withTimeout(background(), 40)
      const events = await running.conn.stream(caller, watch, { n: 1 })
      const failure = await collect(events).then(
        function unexpected(): unknown {
          return undefined
        },
        function rejected(error: unknown): unknown {
          return error
        }
      )
      // Server timeout is the remaining budget at send, so its error event can win while the caller timer is still pending.
      const serverDeadline = isServiceError(failure) && failure.code === "deadline_exceeded"
      expect(failure === deadlineExceeded || serverDeadline).toBe(true)
    } finally {
      await running.stop()
    }
  })

  test("rejects an oversized server event and an oversized client event", async () => {
    const serverLimited = await start((server) => {
      server.registerHandler(endpoint("orders", "watch", Item, BlobItem, true), async function* () {
        yield { blob: "a".repeat(64) }
      })
    }, maxSendMessageBytes(32))
    try {
      const events = await serverLimited.conn.stream(
        background(),
        endpoint("orders", "watch", Item, BlobItem, true),
        { n: 1 }
      )
      await expect(collectBlobs(events)).rejects.toMatchObject({
        code: "resource_exhausted",
        status: 429,
        message: expect.stringContaining("server send limit of 32 bytes")
      })
    } finally {
      await serverLimited.stop()
    }

    const clientLimited = await start(
      (server) => {
        server.registerHandler(
          endpoint("orders", "watch", Item, BlobItem, true),
          async function* () {
            yield { blob: "a".repeat(4 * 1024 * 1024 + 128) }
          }
        )
      },
      maxSendMessageBytes(8 * 1024 * 1024)
    )
    try {
      const events = await clientLimited.conn.stream(
        background(),
        endpoint("orders", "watch", Item, BlobItem, true),
        { n: 1 }
      )
      const failure = await collectBlobs(events).then(
        () => null,
        (error: unknown) => error
      )
      expect(isServiceError(failure)).toBe(true)
      if (!isServiceError(failure)) return
      expect(failure.code).toBe("resource_exhausted")
      expect(failure.status).toBe(429)
      expect(failure.message).toContain("client receive limit of 4194304 bytes")
    } finally {
      await clientLimited.stop()
    }
  })
})

/** Collects blob values from one stream. */
async function collectBlobs(events: ServerStream<{ readonly blob: string }>): Promise<string[]> {
  const values: string[] = []
  for await (const event of events) values.push(event.blob)
  return values
}
