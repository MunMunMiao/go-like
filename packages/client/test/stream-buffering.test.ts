import { background } from "@go-like/context"
import { struct } from "@go-like/struct"
import { eventStreamContentType } from "@go-like/transport/sse"
import { expect, test } from "bun:test"

import { openServerStream } from "../src/stream"

const Item = struct.object({ n: struct.number() })
const encoder = new TextEncoder()
const endFrame = "event: end\ndata: {}\n\n"
const crlfEndFrame = "event: end\r\ndata: {}\r\n\r\n"

type Outcome = { readonly values: readonly number[]; readonly failure: unknown }

/** Encodes one JSON data event whose lines end with the given line break. */
function dataEvent(n: number, lineBreak = "\n"): string {
  return `data: {"n":${n}}${lineBreak}${lineBreak}`
}

/** Builds the message of the client-side size error. */
function limitMessage(actual: number, limit: number): string {
  return `SSE event is ${actual} bytes and exceeds the client receive limit of ${limit} bytes`
}

/** Builds the values a stream of count numbered events must deliver. */
function numbered(count: number): number[] {
  return Array.from({ length: count }, (_, n) => n)
}

/** Encodes each text as its own network chunk. */
function chunksOf(...texts: readonly string[]): Uint8Array[] {
  return texts.map((text) => encoder.encode(text))
}

/** Cuts bytes into consecutive independent chunks of at most size bytes. */
function slices(wire: Uint8Array, size: number): Uint8Array[] {
  const parts: Uint8Array[] = []
  for (let offset = 0; offset < wire.byteLength; offset += size) {
    parts.push(wire.slice(offset, offset + size))
  }
  return parts
}

/** Delivers each part as its own network chunk; reads() counts the reads the consumer issued. */
function chunked(parts: readonly Uint8Array[]): {
  readonly response: Response
  readonly reads: () => number
} {
  let reads = 0
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller): void {
        const part = parts[reads]
        reads += 1
        if (part === undefined) controller.close()
        else controller.enqueue(part)
      }
    },
    { highWaterMark: 0 }
  )
  return {
    response: new Response(body, {
      status: 200,
      headers: { "content-type": eventStreamContentType }
    }),
    reads(): number {
      return reads
    }
  }
}

/** Drains one response into the values it delivered and the error that ended it. */
async function drainResponse(response: Response, limit: number): Promise<Outcome> {
  const events = openServerStream(response, Item, limit, background())
  const values: number[] = []
  let failure: unknown = null
  try {
    for await (const event of events) values.push(event.n)
  } catch (error) {
    failure = error
  } finally {
    await events.close()
  }
  return { values, failure }
}

/** Drains parts that arrive as separate network chunks. */
function drain(parts: readonly Uint8Array[], limit = 1024): Promise<Outcome> {
  return drainResponse(chunked(parts).response, limit)
}

/** Lists every cut point where a two-chunk delivery does not decode to the expected values. */
async function brokenCuts(wire: Uint8Array, expected: readonly number[]): Promise<number[]> {
  const broken: number[] = []
  for (let cut = 1; cut < wire.byteLength; cut += 1) {
    const outcome = await drain([wire.slice(0, cut), wire.slice(cut)])
    if (outcome.failure !== null || outcome.values.join() !== expected.join()) broken.push(cut)
  }
  return broken
}

type SetCall = { readonly source: number; readonly target: number }

/** Runs work and records the source and target sizes of every Uint8Array set meanwhile. */
async function recordSets<T>(work: () => Promise<T>): Promise<{ calls: SetCall[]; result: T }> {
  const prototype = Object.getPrototypeOf(Uint8Array.prototype) as object
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "set")
  if (descriptor === undefined) throw new Error("typed array set is missing")
  const calls: SetCall[] = []
  Object.defineProperty(prototype, "set", {
    ...descriptor,
    value(this: Uint8Array, source: ArrayLike<number>, offset?: number): void {
      calls.push({ source: source.length, target: this.byteLength })
      Reflect.apply(descriptor.value, this, [source, offset])
    }
  })
  try {
    return { result: await work(), calls }
  } finally {
    Object.defineProperty(prototype, "set", descriptor)
  }
}

test("reassembles events delivered one byte per chunk", async () => {
  const wire = encoder.encode(
    dataEvent(1) + ": ping\r\n\r\n" + dataEvent(2, "\r\n") + dataEvent(3) + endFrame
  )
  expect(await drain(slices(wire, 1))).toEqual({ values: [1, 2, 3], failure: null })
})

test("finds a CRLF boundary that straddles two chunks", async () => {
  const wire = encoder.encode(dataEvent(1, "\r\n") + dataEvent(2, "\r\n") + crlfEndFrame)
  // Every cut is covered, including "\r|\n\r\n", "\r\n|\r\n", and "\r\n\r|\n".
  expect(await brokenCuts(wire, [1, 2])).toEqual([])

  const halves = chunksOf('data: {"n":1}\r\n', "\r\n" + crlfEndFrame)
  expect(await drain(halves)).toEqual({ values: [1], failure: null })
})

test("finds an LF boundary that straddles two chunks", async () => {
  const wire = encoder.encode(dataEvent(1) + dataEvent(2) + endFrame)
  expect(await brokenCuts(wire, [1, 2])).toEqual([])
})

test("finds a boundary that straddles four chunks", async () => {
  const split = chunksOf('data: {"n":1}\r', "\n", "\r", "\n", endFrame)
  expect(await drain(split)).toEqual({ values: [1], failure: null })
})

test("delivers many events that arrive in one chunk in order", async () => {
  const events = numbered(500).map((n) => dataEvent(n))
  expect(await drain(chunksOf(events.join("") + endFrame))).toEqual({
    values: numbered(500),
    failure: null
  })
})

test("keeps the unfinished tail of a chunk for the next one", async () => {
  const events = numbered(40).map((n) => dataEvent(n, n % 2 === 0 ? "\n" : "\r\n"))
  const wire = encoder.encode(events.join("") + endFrame)
  for (const size of [2, 3, 5, 7, 13, 64, 251, 4096]) {
    expect(await drain(slices(wire, size))).toEqual({ values: numbered(40), failure: null })
  }
})

test("scans the short events that follow a long event finished by a later chunk", async () => {
  const long = `data: {"n":1,"pad":"${"x".repeat(100)}"}\n\n`
  const wire = long + dataEvent(2) + dataEvent(3) + endFrame
  // The first chunk leaves a long unfinished event; the second ends it and adds short events.
  const halves = chunksOf(wire.slice(0, long.length - 2), wire.slice(long.length - 2))
  expect(await drain(halves)).toEqual({ values: [1, 2, 3], failure: null })
})

test("stops at the terminal event and never inspects the bytes after it", async () => {
  const tail = 'data: {"n":9}\n\n' + "x".repeat(200)
  expect(await drain(chunksOf(dataEvent(1) + endFrame + tail), 64)).toEqual({
    values: [1],
    failure: null
  })

  const errorFrame = 'event: error\ndata: {"code":"internal","message":"boom","status":500}\n\n'
  const failed = await drain(chunksOf(dataEvent(1) + errorFrame + tail), 96)
  expect(failed.values).toEqual([1])
  expect(failed.failure).toMatchObject({ code: "internal", status: 500, message: "boom" })
})

test("fails at the read that pushes an unfinished event past the limit", async () => {
  const event = encoder.encode(`data: {"n":1,"pad":"${"x".repeat(60)}"}\n\n`)
  const source = chunked(slices(event, 10))
  const outcome = await drainResponse(source.response, 32)
  expect(outcome.values).toEqual([])
  expect(outcome.failure).toMatchObject({
    code: "resource_exhausted",
    status: 429,
    message: limitMessage(40, 32)
  })
  // 10, 20, and 30 bytes fit; the fourth chunk makes 40.
  expect(source.reads()).toBe(4)
})

test("tolerates an unfinished event that exactly fills the limit", async () => {
  const fits = await drain(chunksOf("data: " + "x".repeat(26)), 32)
  // The next read reaches the end of the body before any size failure.
  expect(fits.failure).toMatchObject({ message: "server stream ended before a terminal event" })

  const over = await drain(chunksOf("data: " + "x".repeat(27)), 32)
  expect(over.failure).toMatchObject({
    code: "resource_exhausted",
    message: limitMessage(33, 32)
  })
})

test("counts the terminator toward the event limit", async () => {
  const head = `data: {"n":1,"pad":"${"x".repeat(10)}"}`
  const size = head.length + 2
  for (const parts of [chunksOf(head + "\n\n" + endFrame), chunksOf(head, "\n\n" + endFrame)]) {
    expect(await drain(parts, size)).toEqual({ values: [1], failure: null })
    const over = await drain(parts, size - 1)
    expect(over.values).toEqual([])
    expect(over.failure).toMatchObject({
      code: "resource_exhausted",
      message: limitMessage(size, size - 1)
    })
  }
})

test("delivers events before an oversized one and then fails", async () => {
  const small = dataEvent(1)
  const big = `data: {"n":2,"pad":"${"x".repeat(60)}"}\n\n`
  const complete = await drain(chunksOf(small + big), 32)
  expect(complete.values).toEqual([1])
  expect(complete.failure).toMatchObject({
    code: "resource_exhausted",
    message: limitMessage(big.length, 32)
  })

  const partial = await drain(chunksOf(small + big.slice(0, 40)), 32)
  expect(partial.values).toEqual([1])
  expect(partial.failure).toMatchObject({
    code: "resource_exhausted",
    message: limitMessage(40, 32)
  })
})

test("copies each received byte a bounded number of times", async () => {
  const total = 256 * 1024
  const event = encoder.encode(`data: {"n":1,"pad":"${"x".repeat(total)}"}\n\n${endFrame}`)
  const parts = slices(event, 512)
  const { calls, result } = await recordSets(() => drain(parts, 2 * total))
  expect(result).toEqual({ values: [1], failure: null })
  const copied = calls.reduce((sum, call) => sum + call.source, 0)
  expect(copied).toBeLessThan(4 * event.byteLength)
})

test("stops writing into the buffer of a large event once it is consumed", async () => {
  const total = 1024 * 1024
  const large = `data: {"n":1,"pad":"${"x".repeat(total)}"}\n\n`
  const parts = chunksOf(large, dataEvent(2), endFrame)
  const { calls, result } = await recordSets(() => drain(parts, 2 * total))
  expect(result).toEqual({ values: [1, 2], failure: null })
  // The small chunks that follow must not be written behind the megabyte that was consumed.
  const small = calls.filter((call) => call.source > 0 && call.source < 1024)
  expect(small.length).toBeGreaterThan(0)
  expect(Math.max(...small.map((call) => call.target))).toBeLessThan(1024)
})

test("scans each received byte for a boundary a bounded number of times", async () => {
  const total = 4 * 1024 * 1024
  const event = encoder.encode(`data: {"n":1,"pad":"${"x".repeat(total)}"}\n\n${endFrame}`)
  const parts = slices(event, 2048)
  const started = performance.now()
  const outcome = await drain(parts, 2 * total)
  const elapsed = performance.now() - started
  expect(outcome).toEqual({ values: [1], failure: null })
  // A linear pass takes about ten milliseconds; rescanning the buffer per chunk takes seconds.
  expect(elapsed).toBeLessThan(500)
})
