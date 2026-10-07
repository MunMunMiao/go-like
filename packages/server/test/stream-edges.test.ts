import { background, withCancelCause, withTimeout, type Context } from "@go-like/context"
import { struct } from "@go-like/struct"
import { endpoint, serviceError } from "@go-like/transport"
import { jsonContentType } from "@go-like/transport/json"
import { expect, test } from "bun:test"

import { maxSendMessageBytes, streamKeepAlive } from "../src/index"
import { typedStreamHandler } from "../src/stream"

const Item = struct.object({ n: struct.number() })
const watch = endpoint("orders", "watch", Item, Item, true)

/** Builds one JSON request the stream handler can decode. */
function request(body: unknown = { n: 1 }): Request {
  return new Request("http://127.0.0.1/orders/watch", {
    method: "POST",
    headers: { "content-type": jsonContentType },
    body: JSON.stringify(body)
  })
}

/** Waits without keeping the process alive. */
function delay(ms: number): Promise<void> {
  return new Promise(function settle(resolve): void {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** Wraps pull so enqueue and close report failure after performing the real operation. */
function installThrowingStreams(): () => void {
  const real = globalThis.ReadableStream
  globalThis.ReadableStream = class extends real<Uint8Array> {
    constructor(source: UnderlyingSource<Uint8Array>, strategy?: QueuingStrategy<Uint8Array>) {
      const pull = source.pull?.bind(source)
      const start = source.start?.bind(source)
      const cancel = source.cancel?.bind(source)
      const underlying: UnderlyingSource<Uint8Array> = {
        pull(controller) {
          const wrapped = new Proxy(controller, {
            get(target, property, receiver) {
              if (property === "enqueue") {
                return (chunk: Uint8Array): void => {
                  const copy = new ArrayBuffer(chunk.byteLength)
                  const bytes = new Uint8Array(copy)
                  bytes.set(chunk)
                  target.enqueue(bytes)
                  throw new TypeError("consumer left")
                }
              }
              if (property === "close") {
                return (): void => {
                  target.close()
                  throw new TypeError("already closed")
                }
              }
              const value: unknown = Reflect.get(target, property, receiver)
              return typeof value === "function" ? value.bind(target) : value
            }
          })
          return pull?.(wrapped)
        }
      }
      if (start !== undefined) underlying.start = start
      if (cancel !== undefined) underlying.cancel = cancel
      super(underlying, strategy)
    }
  } as typeof ReadableStream
  return function restore(): void {
    globalThis.ReadableStream = real
  }
}

test("rejects stream option values outside their integer ranges", () => {
  expect(() => streamKeepAlive(-1)).toThrow(RangeError)
  expect(() => streamKeepAlive(1.5)).toThrow(RangeError)
  expect(() => maxSendMessageBytes(0)).toThrow(RangeError)
  expect(() => maxSendMessageBytes(1.5)).toThrow(RangeError)
})

test("rethrows a ServiceError raised while reading the request body", async () => {
  const failure = serviceError("invalid_request", "nope", 400)
  const fake = {
    headers: { get: (): string => jsonContentType },
    arrayBuffer(): ArrayBuffer {
      throw failure
    }
  } as unknown as Request
  const handle = typedStreamHandler(
    watch,
    async function* (): AsyncGenerator<{ n: number }> {
      yield { n: 1 }
    },
    0,
    1024
  )
  await expect(handle(background(), fake)).rejects.toBe(failure)
})

test("sends an error event when next throws synchronously", async () => {
  const handle = typedStreamHandler(
    watch,
    () => ({
      [Symbol.asyncIterator](): AsyncIterator<never> {
        return {
          next(): Promise<IteratorResult<never>> {
            throw new Error("sync-next")
          }
        }
      }
    }),
    0,
    1024
  )
  const text = await (await handle(background(), request())).text()
  expect(text).toContain("event: error")
  expect(text).toContain("internal service error")
  expect(text).not.toContain("sync-next")
})

test("sends an error event when the handler returns a rejected promise", async () => {
  const handle = typedStreamHandler(watch, () => Promise.reject(new Error("later")), 0, 1024)
  const text = await (await handle(background(), request())).text()
  expect(text).toContain("event: error")
  expect(text).not.toContain("later")
})

test("sends an internal error when a yielded value cannot be encoded", async () => {
  const handle = typedStreamHandler(
    watch,
    async function* (): AsyncGenerator<never> {
      yield { nope: true } as never
    },
    0,
    1024
  )
  const text = await (await handle(background(), request())).text()
  expect(text).toContain('"code":"internal"')
  expect(text).not.toContain("nope")
})

test("ignores a synchronous iterator.return failure when the consumer cancels", async () => {
  const handle = typedStreamHandler(
    watch,
    () => ({
      [Symbol.asyncIterator](): AsyncIterator<{ n: number }> {
        return {
          next(): Promise<IteratorResult<{ n: number }>> {
            return Promise.resolve({ value: { n: 1 }, done: false })
          },
          return(): Promise<IteratorResult<{ n: number }>> {
            throw new Error("sync-return")
          }
        }
      }
    }),
    0,
    1024
  )
  const reader = (await handle(background(), request())).body?.getReader()
  if (reader === undefined) throw new Error("missing body")
  await reader.read()
  await reader.cancel()
})

test("emits deadline before the first pull when the context has already expired", async () => {
  const [ctx] = withTimeout(background(), 20)
  await delay(50)
  const handle = typedStreamHandler(
    watch,
    async function* (): AsyncGenerator<{ n: number }> {
      yield { n: 1 }
    },
    0,
    1024
  )
  const text = await (await handle(ctx, request())).text()
  expect(text).toContain("deadline_exceeded")
  expect(text).toContain('"status":504')
})

test("closes without an error event when the context is already canceled", async () => {
  const [ctx, cancel] = withCancelCause(background())
  cancel(new Error("stop"))
  const handle = typedStreamHandler(
    watch,
    async function* (): AsyncGenerator<{ n: number }> {
      yield { n: 1 }
    },
    0,
    1024
  )
  expect(await (await handle(ctx, request())).text()).toBe(":\n\n")
})

test("closes the body when the caller cancels while the generator is waiting", async () => {
  const [ctx, cancel] = withCancelCause(background())
  let release = (): void => {}
  let saw = "pending"
  const handle = typedStreamHandler(
    watch,
    async function* (streamCtx: Context): AsyncGenerator<{ n: number }> {
      try {
        yield { n: 1 }
        await new Promise<void>(function hang(resolve): void {
          release = (): void => {
            resolve()
          }
          queueMicrotask(function stop(): void {
            cancel(new Error("stop"))
          })
        })
        yield { n: 2 }
      } finally {
        saw = streamCtx.err() === null ? "open" : "canceled"
      }
    },
    0,
    1024
  )
  const reader = (await handle(ctx, request())).body?.getReader()
  if (reader === undefined) throw new Error("missing body")
  await reader.read()
  await reader.read()
  const done = await reader.read()
  expect(done.done).toBe(true)
  release()
  await delay(0)
  expect(saw).toBe("canceled")
})

test("finishes the generator when enqueue or close fails", async () => {
  const restore = installThrowingStreams()
  try {
    const handle = typedStreamHandler(
      watch,
      async function* (): AsyncGenerator<{ n: number }> {
        yield { n: 1 }
      },
      0,
      1024
    )
    const text = await (await handle(background(), request())).text()
    expect(text.startsWith(":\n\n")).toBe(true)
    expect(text).toContain('data: {"n":1}')

    const [ctx, cancel] = withCancelCause(background())
    cancel(new Error("stop"))
    const closed = typedStreamHandler(
      watch,
      async function* (): AsyncGenerator<{ n: number }> {
        yield { n: 1 }
      },
      0,
      1024
    )
    expect(await (await closed(ctx, request())).text()).toBe(":\n\n")
  } finally {
    restore()
  }
})
