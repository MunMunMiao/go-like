import { expect, test } from "bun:test"

import { readBoundedBody } from "../src/bounded-body"

/** Reads a scripted request body through the unary bound. */
function readBody(chunks: readonly Uint8Array[], maximumBytes = 16): Promise<Uint8Array | null> {
  return readBoundedBody(
    new ReadableStream<Uint8Array>({
      start(controller): void {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      }
    }),
    new Headers(),
    maximumBytes,
    "bad length",
    "bad body"
  )
}

/** Counts the typed array set calls made while work runs. */
async function countSets(work: () => Promise<unknown>): Promise<number> {
  const prototype = Object.getPrototypeOf(Uint8Array.prototype) as object
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "set")
  if (descriptor === undefined) throw new Error("typed array set is missing")
  let calls = 0
  Object.defineProperty(prototype, "set", {
    ...descriptor,
    value(this: Uint8Array, ...args: unknown[]): unknown {
      calls += 1
      return Reflect.apply(descriptor.value, this, args)
    }
  })
  try {
    await work()
  } finally {
    Object.defineProperty(prototype, "set", descriptor)
  }
  return calls
}

test("readBoundedBody joins several chunks in arrival order", async () => {
  const bytes = await readBody([
    new Uint8Array([1, 2]),
    new Uint8Array([3]),
    new Uint8Array([4, 5])
  ])
  expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
})

test("readBoundedBody keeps an empty body as an empty array", async () => {
  expect(await readBody([])).toEqual(new Uint8Array(0))
  expect(await readBody([new Uint8Array(0)])).toEqual(new Uint8Array(0))
})

test("readBoundedBody accepts a lone chunk that exactly fills the limit", async () => {
  expect(await readBody([new Uint8Array([1, 2, 3, 4])], 4)).toEqual(new Uint8Array([1, 2, 3, 4]))
})

test("readBoundedBody returns a lone chunk without copying it again", async () => {
  const copies = await countSets(() => readBody([new Uint8Array([1, 2, 3])]))
  expect(copies).toBe(0)
})

test("readBoundedBody keeps a lone chunk detached from a reused producer buffer", async () => {
  const source = new Uint8Array([1, 2, 3])
  const bytes = await readBoundedBody(
    new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(source)
      },
      async pull(controller): Promise<void> {
        // The consumer has already taken the chunk by the time this timer fires.
        await new Promise<void>(function tick(resolve): void {
          setTimeout(resolve, 0)
        })
        source.fill(9)
        controller.close()
      }
    }),
    new Headers(),
    8,
    "bad length",
    "bad body"
  )
  expect(bytes).toEqual(new Uint8Array([1, 2, 3]))
  source.fill(7)
  expect(bytes).toEqual(new Uint8Array([1, 2, 3]))
  expect(bytes).not.toBe(source)
})
