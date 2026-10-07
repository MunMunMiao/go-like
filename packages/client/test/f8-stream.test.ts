import {
  background,
  canceled,
  deadlineExceeded,
  withCancelCause,
  type Context
} from "@go-like/context"
import { struct } from "@go-like/struct"
import { eventStreamContentType } from "@go-like/transport/sse"
import { expect, test } from "bun:test"

import { openServerStream } from "../src/stream"

const Item = struct.object({ n: struct.number() })

/** Builds one event-stream response. */
function streamResponse(body: BodyInit | null): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": eventStreamContentType }
  })
}

/** Fails when work does not settle inside the bound. */
async function within<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<T>(function expire(_resolve, reject): void {
        timer = setTimeout(function timedOut(): void {
          reject(new Error(`${label} exceeded ${ms}ms`))
        }, ms)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

test("Q6-04 iterator.return before next cancels the unread body", async () => {
  let cancels = 0
  const events = openServerStream(
    streamResponse(
      new ReadableStream<Uint8Array>({
        pull(): void {},
        cancel(): void {
          cancels += 1
        }
      })
    ),
    Item,
    1024,
    background()
  )
  const iterator = events[Symbol.asyncIterator]()
  await expect(within(iterator.return!(), 300, "unstarted return")).resolves.toEqual({
    done: true,
    value: undefined
  })
  expect(cancels).toBeGreaterThan(0)
  await events.close()
})

test("Q6-04 iterator.return settles a pending next and cancels the body", async () => {
  let cancels = 0
  const events = openServerStream(
    streamResponse(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode('data: {"n":1}\n\n'))
        },
        pull(): void {},
        cancel(): void {
          cancels += 1
        }
      })
    ),
    Item,
    1024,
    background()
  )
  const iterator = events[Symbol.asyncIterator]()
  expect(await iterator.next()).toEqual({ done: false, value: { n: 1 } })
  const pending = iterator.next()
  await within(iterator.return!(), 300, "pending return")
  await expect(within(pending, 300, "pending next")).resolves.toEqual({
    done: true,
    value: undefined
  })
  expect(cancels).toBeGreaterThan(0)
  await events.close()
})

test("Q6-06 a microtask cancel drops a buffered data frame and an end frame", async () => {
  const frames = {
    data: 'data: {"n":1}\n\ndata: {"n":2}\n\n',
    end: 'data: {"n":1}\n\nevent: end\ndata: {}\n\n'
  }
  for (const body of Object.values(frames)) {
    const [ctx, cancel] = withCancelCause(background())
    const events = openServerStream(streamResponse(body), Item, 1024, ctx)
    const iterator = events[Symbol.asyncIterator]()
    try {
      expect(await iterator.next()).toEqual({ done: false, value: { n: 1 } })
      const pending = iterator.next()
      queueMicrotask(function cancelCaller(): void {
        cancel(new Error("stop"))
      })
      await expect(within(pending, 300, "microtask cancel")).rejects.toBe(canceled)
    } finally {
      cancel(new Error("stop"))
      await events.close()
    }
  }
})

test("Q6-06 a microtask close finishes the pending next as done", async () => {
  const events = openServerStream(
    streamResponse('data: {"n":1}\n\ndata: {"n":2}\n\n'),
    Item,
    1024,
    background()
  )
  const iterator = events[Symbol.asyncIterator]()
  try {
    expect(await iterator.next()).toEqual({ done: false, value: { n: 1 } })
    const pending = iterator.next()
    queueMicrotask(function closeCaller(): void {
      void events.close()
    })
    await expect(within(pending, 300, "microtask close")).resolves.toEqual({
      done: true,
      value: undefined
    })
  } finally {
    await events.close()
  }
})

test("Q6-06 ctx failure after a decoded frame is dropped before the caller sees it", async () => {
  const [ctx, cancel] = withCancelCause(background())
  const events = openServerStream(
    streamResponse('data: {"n":1}\n\n'),
    struct.object({
      get n(): ReturnType<typeof struct.number> {
        queueMicrotask(function cancelCaller(): void {
          cancel(new Error("stop"))
        })
        return struct.number()
      }
    }),
    1024,
    ctx
  )
  const iterator = events[Symbol.asyncIterator]()
  try {
    await expect(within(iterator.next(), 300, "decoded cancel")).rejects.toBe(canceled)
  } finally {
    cancel(new Error("stop"))
    await events.close()
  }
})

test("Q6-06 an elapsed caller deadline wins over a server error frame", async () => {
  let expired = false
  const signal = new AbortController().signal
  const ctx: Context = Object.freeze({
    deadline(): readonly [Date, boolean] {
      return [new Date(Date.now() + (expired ? -5 : 60_000)), expired]
    },
    done(): AbortSignal {
      return signal
    },
    err(): null {
      return null
    },
    value(): null {
      return null
    }
  })
  const events = openServerStream(
    streamResponse(
      new ReadableStream<Uint8Array>({
        pull(controller): void {
          expired = true
          controller.enqueue(
            new TextEncoder().encode(
              'event: error\ndata: {"code":"deadline_exceeded","message":"context deadline exceeded","status":504,"metadata":{}}\n\n'
            )
          )
        }
      })
    ),
    Item,
    1024,
    ctx
  )
  const iterator = events[Symbol.asyncIterator]()
  try {
    await expect(within(iterator.next(), 300, "elapsed deadline")).rejects.toBe(deadlineExceeded)
  } finally {
    await events.close()
  }
})

test("Q6-06 a healthy stream still yields the buffered frame", async () => {
  const events = openServerStream(
    streamResponse('data: {"n":1}\n\ndata: {"n":2}\n\nevent: end\ndata: {}\n\n'),
    Item,
    1024,
    background()
  )
  const iterator = events[Symbol.asyncIterator]()
  try {
    expect(await iterator.next()).toEqual({ done: false, value: { n: 1 } })
    expect(await iterator.next()).toEqual({ done: false, value: { n: 2 } })
    expect(await iterator.next()).toEqual({ done: true, value: undefined })
  } finally {
    await events.close()
  }
})
