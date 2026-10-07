import {
  background,
  canceled,
  deadlineExceeded,
  withCancelCause,
  withTimeout,
  type Context
} from "@go-like/context"
import { struct } from "@go-like/struct"
import { isServiceError } from "@go-like/transport"
import { eventStreamContentType } from "@go-like/transport/sse"
import { expect, test } from "bun:test"

import { openServerStream } from "../src/stream"

const Item = struct.object({ n: struct.number() })
const encoder = new TextEncoder()

/** Resolves after the given number of milliseconds. */
function pause(ms: number): Promise<void> {
  return new Promise(function wait(resolve): void {
    setTimeout(resolve, ms)
  })
}

/** Builds one event-stream response around a caller-supplied body. */
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

/** Waits until a caller Context has failed. */
async function untilFailed(ctx: Context): Promise<void> {
  const signal = ctx.done()
  if (signal === null || signal.aborted) return
  await new Promise<void>(function wait(resolve): void {
    signal.addEventListener(
      "abort",
      function aborted(): void {
        resolve()
      },
      { once: true }
    )
  })
}

test("Q5-04 a failed caller context drops buffered data, end, and error frames", async () => {
  const tails = {
    data: 'data: {"n":2}\n\n',
    end: "event: end\ndata: {}\n\n",
    error:
      'event: error\ndata: {"code":"deadline_exceeded","message":"wire deadline","status":504}\n\n'
  }
  for (const tail of ["data", "end", "error"] as const) {
    for (const trigger of ["cancel", "deadline"] as const) {
      const [ctx, cancel] =
        trigger === "deadline" ? withTimeout(background(), 40) : withCancelCause(background())
      const events = openServerStream(
        streamResponse(`data: {"n":1}\n\n${tails[tail]}`),
        Item,
        1024,
        ctx
      )
      const iterator = events[Symbol.asyncIterator]()
      try {
        expect(await within(iterator.next(), 500, `${tail} ${trigger} first`)).toEqual({
          done: false,
          value: { n: 1 }
        })
        if (trigger === "cancel") cancel(new Error("stop"))
        await untilFailed(ctx)
        await pause(0)
        const expected = trigger === "cancel" ? canceled : deadlineExceeded
        await expect(within(iterator.next(), 500, `${tail} ${trigger} buffered`)).rejects.toBe(
          expected
        )
        await expect(within(iterator.next(), 500, `${tail} ${trigger} later`)).rejects.toBe(
          expected
        )
      } finally {
        cancel(new Error("stop"))
        await events.close()
      }
    }
  }
})

test("Q5-04 cancellation before the first next still cancels the unread body", async () => {
  let cancels = 0
  const body = new ReadableStream<Uint8Array>({
    pull(): void {},
    cancel(): void {
      cancels += 1
    }
  })
  const [ctx, cancel] = withCancelCause(background())
  const events = openServerStream(streamResponse(body), Item, 1024, ctx)
  cancel(new Error("stop"))
  try {
    await untilFailed(ctx)
    await pause(0)
    await expect(events[Symbol.asyncIterator]().next()).rejects.toBe(canceled)
    expect(cancels).toBeGreaterThan(0)
  } finally {
    await events.close()
  }
})

test("Q5-04 a healthy error event is still a ServiceError", async () => {
  const events = openServerStream(
    streamResponse(
      'data: {"n":1}\n\nevent: error\ndata: {"code":"deadline_exceeded","message":"wire deadline","status":504}\n\n'
    ),
    Item,
    1024,
    background()
  )
  const iterator = events[Symbol.asyncIterator]()
  try {
    expect(await iterator.next()).toEqual({ done: false, value: { n: 1 } })
    const failure = await iterator.next().then(
      function unexpected(): unknown {
        return undefined
      },
      function rejected(error: unknown): unknown {
        return error
      }
    )
    expect(isServiceError(failure)).toBe(true)
    if (isServiceError(failure)) expect(failure.code).toBe("deadline_exceeded")
  } finally {
    await events.close()
  }
})

test("Q5-05 consumer close completes a pending next and later next calls as done", async () => {
  let release = function noop(): void {}
  const gate = new Promise<void>(function capture(resolve): void {
    release = resolve
  })
  const events = openServerStream(
    streamResponse(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(encoder.encode('data: {"n":1}\n\n'))
        },
        async pull(controller): Promise<void> {
          await gate
          controller.close()
        }
      })
    ),
    Item,
    1024,
    background()
  )
  const iterator = events[Symbol.asyncIterator]()
  try {
    expect(await iterator.next()).toEqual({ done: false, value: { n: 1 } })
    const pending = iterator.next()
    await pause(0)
    await within(events.close(), 500, "pending close")
    await expect(within(pending, 500, "pending next")).resolves.toEqual({
      done: true,
      value: undefined
    })
    await expect(within(iterator.next(), 500, "later next")).resolves.toEqual({
      done: true,
      value: undefined
    })
  } finally {
    release()
    await events.close()
  }
})

test("Q5-05 context failure stays the next result when close runs afterwards", async () => {
  let release = function noop(): void {}
  const gate = new Promise<void>(function capture(resolve): void {
    release = resolve
  })
  const [ctx, cancel] = withCancelCause(background())
  const events = openServerStream(
    streamResponse(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(encoder.encode('data: {"n":1}\n\n'))
        },
        async pull(): Promise<void> {
          await gate
        }
      })
    ),
    Item,
    1024,
    ctx
  )
  const iterator = events[Symbol.asyncIterator]()
  try {
    expect(await iterator.next()).toEqual({ done: false, value: { n: 1 } })
    const pending = iterator.next()
    await pause(0)
    cancel(new Error("stop"))
    await untilFailed(ctx)
    await within(events.close(), 500, "close after cancel")
    await expect(within(pending, 500, "pending after cancel")).rejects.toBe(canceled)
    await expect(within(iterator.next(), 500, "later after cancel")).rejects.toBe(canceled)
  } finally {
    release()
    cancel(new Error("stop"))
    await events.close()
  }
})

test("Q5-05 a real EOF without end is still truncation while the caller context is healthy", async () => {
  const events = openServerStream(
    streamResponse(encoder.encode('data: {"n":1}\n\n')),
    Item,
    1024,
    background()
  )
  const iterator = events[Symbol.asyncIterator]()
  try {
    expect(await iterator.next()).toEqual({ done: false, value: { n: 1 } })
    await expect(iterator.next()).rejects.toThrow("server stream ended before a terminal event")
  } finally {
    await events.close()
  }
})
