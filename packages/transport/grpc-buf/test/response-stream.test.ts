import { PassThrough, Readable } from "node:stream"
import type { ClientHttp2Stream } from "node:http2"
import { expect, test } from "bun:test"

import { preserveCompletedResponse } from "../src/response-stream"

const premature = () =>
  Object.assign(new Error("Premature close"), { code: "ERR_STREAM_PREMATURE_CLOSE" })

function buffered(failure: unknown, resetCode = 0) {
  const source = new PassThrough()
  source.write(Buffer.from("remaining"))
  source.end()
  Object.defineProperty(source, "rstCode", { value: resetCode })
  source[Symbol.asyncIterator] = () => ({
    async next() {
      throw failure
    },
    [Symbol.asyncIterator]() {
      return this
    },
    async [Symbol.asyncDispose]() {
      source.destroy()
    }
  })
  return preserveCompletedResponse(source as unknown as ClientHttp2Stream)
}

async function text(stream: ClientHttp2Stream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks).toString("utf8")
}

for (const event of ["response", "trailers"] as const) {
  test(`retains unread bytes after a premature close following ${event} END_STREAM`, async () => {
    const stream = buffered(premature())
    stream.emit(event, {}, 5)
    expect(stream.readableLength).toBe(9)
    expect(await text(stream)).toBe("remaining")
    expect(stream.readableLength).toBe(0)
  })
}

for (const [name, flags, resetCode, error] of [
  ["missing END_STREAM", 4, 0, premature()],
  ["non-zero reset", 5, 8, premature()],
  ["network failure", 5, 0, Object.assign(new Error("connection reset"), { code: "ECONNRESET" })],
  ["non-Error failure", 5, 0, { code: "ERR_STREAM_PREMATURE_CLOSE" }]
] as const) {
  test(`preserves ${name} rather than accepting buffered bytes as a completed response`, async () => {
    const stream = buffered(error, resetCode)
    stream.emit("trailers", {}, flags)
    await expect(text(stream)).rejects.toBe(error)
    expect(stream.readableLength).toBe(9)
    stream.destroy()
  })
}

test("normal iteration and caller return retain native ownership", async () => {
  const complete = preserveCompletedResponse(
    Readable.from([Buffer.from("first"), Buffer.from("second")]) as ClientHttp2Stream
  )
  expect(await text(complete)).toBe("firstsecond")
  const source = Readable.from([Buffer.from("first"), Buffer.from("second")])
  const stream = preserveCompletedResponse(source as ClientHttp2Stream)
  const iterator = stream[Symbol.asyncIterator]()
  expect((await iterator.next()).value.toString()).toBe("first")
  expect(await iterator.return?.()).toEqual({ done: true, value: undefined })
  expect(source.destroyed).toBe(true)
})

test("caller throw is delegated to the native iterator without becoming recovery", async () => {
  const source = Readable.from([Buffer.from("first"), Buffer.from("second")])
  const stream = preserveCompletedResponse(source as ClientHttp2Stream)
  const iterator = stream[Symbol.asyncIterator]()
  await iterator.next()
  const reason = new Error("caller canceled")
  await expect(iterator.throw?.(reason)).rejects.toBe(reason)
  expect(source.destroyed).toBe(true)
})

test("a caller-thrown premature-close error after END_STREAM remains cancellation", async () => {
  const source = Readable.from([Buffer.from("first"), Buffer.from("second")])
  const stream = preserveCompletedResponse(source as ClientHttp2Stream)
  Object.defineProperty(stream, "rstCode", { value: 0 })
  stream.emit("trailers", {}, 5)
  const iterator = stream[Symbol.asyncIterator]()
  await iterator.next()
  const reason = premature()
  await expect(iterator.throw?.(reason)).rejects.toBe(reason)
  expect(source.destroyed).toBe(true)
})
