import { expect, test } from "bun:test"

import {
  createLineParser,
  createMessageParser,
  encodeSSEComment,
  encodeSSEEvent,
  encodeSSEJsonEvent,
  eventStreamContentType,
  readStreamBytes,
  SSEParserLimitError,
  type EventStreamMessage
} from "../src/sse/index"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Parses one SSE payload into protocol messages, ids, and retry values. */
async function parseEvents(
  source: string,
  options: { readonly lineLimit?: number; readonly messageLimit?: number } = {}
): Promise<{
  readonly ids: readonly string[]
  readonly messages: readonly EventStreamMessage[]
  readonly retries: readonly number[]
}> {
  const ids: string[] = []
  const retries: number[] = []
  const messages: EventStreamMessage[] = []
  const parseMessage = createMessageParser(
    function onId(id: string): void {
      ids.push(id)
    },
    function onRetry(retry: number): void {
      retries.push(retry)
    },
    function onMessage(message: EventStreamMessage): void {
      messages.push(message)
    },
    { maxBufferSize: options.messageLimit ?? 1024 }
  )
  const parseLine = createLineParser(parseMessage, { maxBufferSize: options.lineLimit ?? 1024 })
  await parseLine(encoder.encode(source))
  return { ids, messages, retries }
}

test("encodes comments, one-line events, and JSON events", () => {
  expect(eventStreamContentType).toBe("text/event-stream")
  expect(decoder.decode(encodeSSEComment())).toBe(":\n\n")
  expect(decoder.decode(encodeSSEComment("ping"))).toBe(":ping\n\n")
  expect(decoder.decode(encodeSSEEvent('{"type":"pending"}'))).toBe('data: {"type":"pending"}\n\n')
  expect(decoder.decode(encodeSSEJsonEvent({}, "end"))).toBe("event: end\ndata: {}\n\n")
  expect(() => encodeSSEComment("a\nb")).toThrow(TypeError)
  expect(() => encodeSSEEvent("a\nb")).toThrow(TypeError)
  expect(() => encodeSSEEvent("{}", "")).toThrow(TypeError)
  expect(() => encodeSSEEvent("{}", "end\n")).toThrow(TypeError)
})

test("parses business, end, and error events and ignores comments, ids, and retry", async () => {
  const parsed = await parseEvents(
    ':\n\ndata: {"type":"pending"}\n\n: ping\nid: 7\nretry: 15\n\n' +
      'event: end\ndata: {}\n\nevent: custom\ndata: {"n":1}\n\n' +
      'event: error\ndata: {"code":"internal"}\n\n'
  )
  expect(parsed.messages.map((message) => message.event)).toEqual(["", "end", "custom", "error"])
  expect(parsed.messages[0]?.data).toBe('{"type":"pending"}')
  expect(parsed.messages[1]?.data).toBe("{}")
  expect(parsed.ids).toEqual(["7"])
  expect(parsed.retries).toEqual([15])
})

test("joins data split across chunks and CRLF frames", async () => {
  const ids: string[] = []
  const messages: EventStreamMessage[] = []
  const parseMessage = createMessageParser(
    function onId(id: string): void {
      ids.push(id)
    },
    function onRetry(): void {},
    function onMessage(message: EventStreamMessage): void {
      messages.push(message)
    }
  )
  const parseLine = createLineParser(parseMessage)
  await parseLine(encoder.encode("data: hel"))
  await parseLine(encoder.encode("lo\r\n"))
  await parseLine(encoder.encode("data: world\r\n\r\n"))
  expect(messages).toEqual([{ id: "", event: "", data: "hello\nworld" }])
  expect(ids).toEqual([])
})

test("rejects an oversized line and an oversized data buffer", async () => {
  await expect(parseEvents(`${"x".repeat(20)}\n\n`, { lineLimit: 8 })).rejects.toBeInstanceOf(
    SSEParserLimitError
  )
  await expect(
    parseEvents(`data: ${"x".repeat(20)}\n\n`, { messageLimit: 8 })
  ).rejects.toBeInstanceOf(SSEParserLimitError)
  expect(() => createLineParser(function ignore(): void {}, { maxBufferSize: 0 })).toThrow(
    TypeError
  )
})

test("reads stream bytes and cancels the source when the consumer throws", async () => {
  const chunks = ["one", "two"].map((value) => encoder.encode(value))
  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    }
  })
  const seen: string[] = []
  await readStreamBytes(stream, function onChunk(chunk: Uint8Array): void {
    seen.push(decoder.decode(chunk))
  })
  expect(seen).toEqual(["one", "two"])

  let cancelReason: unknown = null
  const failing = new ReadableStream<Uint8Array>({
    pull(controller): void {
      controller.enqueue(encoder.encode("x"))
    },
    cancel(reason): void {
      cancelReason = reason
    }
  })
  const failure = new Error("parse failed")
  await expect(
    readStreamBytes(failing, function fail(): void {
      throw failure
    })
  ).rejects.toBe(failure)
  expect(cancelReason).toBe(failure)
  expect(failing.locked).toBe(false)
})

test("stops reading when the abort signal fires", async () => {
  const controller = new AbortController()
  const stream = new ReadableStream<Uint8Array>({
    pull(): Promise<void> {
      controller.abort(new Error("stopped"))
      return new Promise(function hang(): void {})
    }
  })
  await expect(
    readStreamBytes(stream, function ignore(): void {}, controller.signal)
  ).rejects.toThrow("stopped")
})

test("rejects an already aborted read and an unfinished oversized line", async () => {
  const controller = new AbortController()
  controller.abort(new Error("already"))
  const aborted = new ReadableStream<Uint8Array>({
    start(stream): void {
      stream.enqueue(encoder.encode("x"))
      stream.close()
    }
  })
  await expect(
    readStreamBytes(aborted, function ignore(): void {}, controller.signal)
  ).rejects.toThrow("already")

  const parseLine = createLineParser(function ignore(): void {}, { maxBufferSize: 4 })
  await expect(parseLine(encoder.encode("12345"))).rejects.toBeInstanceOf(SSEParserLimitError)
})

test("ignores a rejected read and a rejected source cancel", async () => {
  const broken = new ReadableStream<Uint8Array>({
    pull(controller): void {
      controller.error(new Error("read failed"))
    }
  })
  await expect(readStreamBytes(broken, function ignore(): void {})).rejects.toThrow("read failed")

  const cancelFailed = new ReadableStream<Uint8Array>({
    pull(controller): void {
      controller.enqueue(encoder.encode("x"))
    },
    cancel(): Promise<void> {
      return Promise.reject(new Error("cancel failed"))
    }
  })
  await expect(
    readStreamBytes(cancelFailed, function fail(): void {
      throw new Error("parse failed")
    })
  ).rejects.toThrow("parse failed")
})

test("keeps bytes that follow a complete line in the same chunk", async () => {
  const messages: string[] = []
  const parseMessage = createMessageParser(
    function ignoreId(): void {},
    function ignoreRetry(): void {},
    function onMessage(message: EventStreamMessage): void {
      messages.push(message.data)
    }
  )
  const parseLine = createLineParser(parseMessage)
  await parseLine(encoder.encode("data: hello\n\ndata: wor"))
  await parseLine(encoder.encode("ld\n\n"))
  expect(messages).toEqual(["hello", "world"])
})
