import {
  background,
  canceled,
  deadlineExceeded,
  withCancelCause,
  withTimeout,
  type Context
} from "@go-like/context"
import { address, newServer, transport } from "@go-like/server"
import { struct } from "@go-like/struct"
import { endpoint, isServiceError, observeResponseBody } from "@go-like/transport"
import { eventStreamContentType } from "@go-like/transport/sse"
import { newMemoryTransport } from "@go-like/transport-memory"
import { expect, test } from "bun:test"

import { newClient, withEndpoint, withTransport } from "../src/index"
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

test("Q2-01 close cancels an unstarted response body", async () => {
  let cancels = 0
  const body = new ReadableStream<Uint8Array>({
    /** Queues a terminal frame without closing the source. */
    start(controller): void {
      controller.enqueue(encoder.encode("event: end\ndata: {}\n\n"))
    },
    /** Records caller cancellation of the unread body. */
    cancel(): void {
      cancels += 1
    }
  })
  const events = openServerStream(streamResponse(body), Item, 1024, background())
  await within(events.close(), 200, "unstarted close")
  expect(cancels).toBe(1)
  const values = []
  for await (const event of events) values.push(event)
  expect(values).toEqual([])
  await events[Symbol.asyncDispose]()
  expect(cancels).toBe(1)
})

test("Q2-01 close finishes while next is pending", async () => {
  let cancels = 0
  let release = function noop(): void {}
  const gate = new Promise<void>(function capture(resolve): void {
    release = resolve
  })
  const body = new ReadableStream<Uint8Array>({
    /** Stays open until the test releases it, then ends so cleanup cannot spin. */
    async pull(controller): Promise<void> {
      await gate
      controller.close()
    },
    /** Records cancellation of the locked reader. */
    cancel(): void {
      cancels += 1
    }
  })
  const events = openServerStream(streamResponse(body), Item, 1024, background())
  const next = events[Symbol.asyncIterator]().next()
  await Promise.resolve()
  try {
    await within(events.close(), 200, "pending close")
    expect(cancels).toBeGreaterThan(0)
  } finally {
    release()
    await next.catch(function ignore(): void {})
  }
})

test("Q2-01 close is idempotent after the stream has already ended", async () => {
  const events = openServerStream(
    streamResponse(encoder.encode("event: end\ndata: {}\n\n")),
    Item,
    1024,
    background()
  )
  const values = []
  for await (const event of events) values.push(event)
  expect(values).toEqual([])
  await within(events.close(), 200, "finished close")
  await within(events.close(), 200, "second close")
})

test("Q2-01 close still resolves when body cancellation rejects", async () => {
  let attempted = 0
  const body = new ReadableStream<Uint8Array>({
    /** Rejects cancellation so shutdown must swallow it. */
    cancel(): Promise<void> {
      attempted += 1
      return Promise.reject(new Error("cancel failed"))
    }
  })
  const events = openServerStream(streamResponse(body), Item, 1024, background())
  await within(events.close(), 200, "rejecting close")
  expect(attempted).toBe(1)
})

test("Q2-01 caller cancellation aborts an idle stream without another next", async () => {
  let cancels = 0
  let pulls = 0
  const body = new ReadableStream<Uint8Array>({
    /** Produces one business frame and then waits. */
    pull(controller): void {
      pulls += 1
      if (pulls === 1) controller.enqueue(encoder.encode('data: {"n":1}\n\n'))
    },
    /** Records cancellation while the iterator is suspended at yield. */
    cancel(): void {
      cancels += 1
    }
  })
  const [ctx, cancel] = withCancelCause(background())
  const events = openServerStream(streamResponse(body), Item, 1024, ctx)
  const first = await events[Symbol.asyncIterator]().next()
  expect(first).toEqual({ done: false, value: { n: 1 } })
  cancel(new Error("stop"))
  await pause(30)
  expect(cancels).toBeGreaterThan(0)
  await events.close()
})

test("Q2-01 close cancels an unstarted or pending server stream", async () => {
  const schema = struct.object({ n: struct.number() })
  const watch = endpoint("review", "watch", schema, schema, true)
  const observations: {
    mode: string
    closeDone: boolean
    returned: number
    serverContextCanceled: boolean
  }[] = []
  for (const mode of ["unstarted", "pending"] as const) {
    const memory = newMemoryTransport()
    const location = `memory://close-${mode}`
    const server = newServer(transport(memory), address(location))
    let serverCtx: { err(): Error | null } | undefined
    let returned = 0
    let release = function releaseWait(_value: IteratorResult<{ n: number }>): void {}
    const waiting = new Promise<IteratorResult<{ n: number }>>(function capture(resolve): void {
      release = resolve
    })
    server.registerHandler(watch, function handle(ctx) {
      serverCtx = ctx
      return {
        [Symbol.asyncIterator](): AsyncIterator<{ n: number }> {
          return {
            /** Stays pending until the test releases the handler. */
            next(): Promise<IteratorResult<{ n: number }>> {
              return waiting
            },
            /** Records generator cleanup from consumer cancellation. */
            async return(): Promise<IteratorResult<{ n: number }>> {
              returned += 1
              return { done: true, value: undefined }
            }
          }
        }
      }
    })
    const running = server.start(background())
    await server.endpoint(background())
    const client = newClient(withTransport(memory), withEndpoint(location))
    try {
      const events = await client.stream(background(), watch, { n: 1 })
      const next =
        mode === "pending"
          ? events[Symbol.asyncIterator]().next()
          : Promise.resolve({ done: true, value: undefined })
      await pause(10)
      let closeDone = false
      const closing = events.close().then(function closed(): void {
        closeDone = true
      })
      const winner = await Promise.race([
        closing.then(function done(): "closed" {
          return "closed"
        }),
        pause(200).then(function hung(): "hung" {
          return "hung"
        })
      ])
      observations.push({
        mode,
        closeDone: winner === "closed" && closeDone,
        returned,
        serverContextCanceled: (serverCtx?.err() ?? null) !== null
      })
      release({ done: true, value: undefined })
      await next.catch(function ignore(): void {})
      await Promise.race([closing, pause(200)])
      await events[Symbol.asyncDispose]()
    } finally {
      release({ done: true, value: undefined })
      await client.close(background())
      await server.stop(background())
      await running
    }
  }
  expect(observations).toEqual([
    { mode: "unstarted", closeDone: true, returned: 1, serverContextCanceled: true },
    { mode: "pending", closeDone: true, returned: 1, serverContextCanceled: true }
  ])
})

test("Q2-05 a terminal SSE event ends iteration without waiting for EOF", async () => {
  for (const event of ["end", "error"] as const) {
    let cancels = 0
    let release = function noop(): void {}
    const gate = new Promise<void>(function capture(resolve): void {
      release = resolve
    })
    const data =
      event === "end"
        ? "{}"
        : JSON.stringify({ code: "internal", message: "expected", status: 500, metadata: {} })
    const body = new ReadableStream<Uint8Array>({
      /** Sends the terminal frame and then withholds EOF. */
      start(controller): void {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`))
      },
      /** Blocks a drain that waits for socket EOF, then ends so cleanup cannot spin. */
      async pull(controller): Promise<void> {
        await gate
        controller.close()
      },
      /** Records cancellation of the unread tail. */
      cancel(): void {
        cancels += 1
      }
    })
    const events = openServerStream(streamResponse(body), Item, 1024, background())
    const next = events[Symbol.asyncIterator]().next()
    let settled = false
    const result = next.then(
      function value(entry): unknown {
        settled = true
        return entry
      },
      function failure(error: unknown): unknown {
        settled = true
        return error
      }
    )
    await pause(40)
    try {
      expect(settled).toBe(true)
      expect(cancels).toBeGreaterThan(0)
      if (event === "end") expect(await result).toEqual({ done: true, value: undefined })
      else expect(isServiceError(await result)).toBe(true)
    } finally {
      release()
      await result.catch(function ignore(): void {})
      await events.close()
    }
  }
})

test("Q2-04 caller cancellation returns a suspended server generator", async () => {
  const schema = struct.object({ n: struct.number() })
  const watch = endpoint("review", "watch", schema, schema, true)
  const memory = newMemoryTransport()
  const server = newServer(transport(memory), address("memory://cancel-review"))
  let finalized = false
  let serverCtx: { err(): Error | null } | undefined
  server.registerHandler(watch, async function* handle(ctx) {
    serverCtx = ctx
    try {
      yield { n: 1 }
      yield { n: 2 }
    } finally {
      finalized = true
    }
  })
  const running = server.start(background())
  await server.endpoint(background())
  const client = newClient(withTransport(memory), withEndpoint("memory://cancel-review"))
  const [ctx, cancel] = withCancelCause(background())
  try {
    const events = await client.stream(ctx, watch, { n: 1 })
    const first = await events[Symbol.asyncIterator]().next()
    expect(first).toEqual({ done: false, value: { n: 1 } })
    cancel(new Error("user stop"))
    await pause(50)
    expect(finalized).toBe(true)
    expect(serverCtx?.err() ?? null).not.toBeNull()
    await events.close()
  } finally {
    await client.close(background())
    await server.stop(background())
    await running
  }
})

test("Q2-05 a terminal event settles the client stream and observer without EOF", async () => {
  const schema = struct.object({ n: struct.number() })
  const watch = endpoint("review", "watch", schema, schema, true)
  const observations: { event: string; settled: boolean; observedEnd: boolean }[] = []
  for (const event of ["end", "error"] as const) {
    const memory = newMemoryTransport()
    const location = `memory://terminal-${event}`
    const server = newServer(transport(memory), address(location))
    let control: ReadableStreamDefaultController<Uint8Array> | undefined
    let observedEnd = false
    const data =
      event === "end"
        ? "{}"
        : JSON.stringify({ code: "internal", message: "expected", status: 500, metadata: {} })
    server.registerHandler("review", "watch", function handle(): Response {
      const response = new Response(
        new ReadableStream<Uint8Array>(
          {
            /** Sends the terminal frame and then withholds EOF. */
            start(controller): void {
              control = controller
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`))
            }
          },
          { highWaterMark: 0 }
        ),
        { headers: { "content-type": eventStreamContentType } }
      )
      return observeResponseBody(response, function ended(): void {
        observedEnd = true
      })
    })
    const running = server.start(background())
    await server.endpoint(background())
    const client = newClient(withTransport(memory), withEndpoint(location))
    const [ctx, cancel] = withCancelCause(background())
    try {
      const events = await client.stream(ctx, watch, { n: 1 })
      let settled = false
      const result = events[Symbol.asyncIterator]()
        .next()
        .then(
          function value(entry): unknown {
            settled = true
            return entry
          },
          function failure(error: unknown): unknown {
            settled = true
            return error
          }
        )
      await pause(25)
      cancel(new Error("stop after terminal"))
      await pause(25)
      observations.push({ event, settled, observedEnd })
      if (control === undefined) throw new Error("source controller missing")
      control.close()
      await result
      await events.close()
    } finally {
      try {
        control?.close()
      } catch {
        // The source is already closed.
      }
      await client.close(background())
      await server.stop(background())
      await running
    }
  }
  expect(observations).toEqual([
    { event: "end", settled: true, observedEnd: true },
    { event: "error", settled: true, observedEnd: true }
  ])
})

/** Resolves when ctx ends, including a context that is already done. */
async function untilDone(ctx: Context): Promise<void> {
  const signal = ctx.done()
  if (signal === null) throw new Error("context has no done signal")
  if (signal.aborted) return
  await new Promise<void>(function wait(resolve): void {
    signal.addEventListener(
      "abort",
      function ended(): void {
        resolve()
      },
      { once: true }
    )
  })
}

/** Lets a queued caller-cancellation callback finish before the next assertion. */
async function afterCallerCallback(): Promise<void> {
  await untilMicrotasks()
  await pause(0)
}

/** Yields one turn so queued microtasks run. */
function untilMicrotasks(): Promise<void> {
  return new Promise(function wait(resolve): void {
    queueMicrotask(function flushed(): void {
      resolve()
    })
  })
}

test("Q4-05 an idle deadline before iteration rejects next", async () => {
  const body = new ReadableStream<Uint8Array>({
    /** Holds an unread error event so a normal read would not be DeadlineExceeded. */
    start(controller): void {
      controller.enqueue(
        encoder.encode(
          'event: error\ndata: {"code":"deadline_exceeded","message":"wire","status":504,"metadata":{}}\n\n'
        )
      )
    }
  })
  const [ctx, cancel] = withTimeout(background(), 40)
  const events = openServerStream(streamResponse(body), Item, 1024, ctx)
  try {
    await untilDone(ctx)
    await afterCallerCallback()
    expect(ctx.err()).toBe(deadlineExceeded)
    const result = await events[Symbol.asyncIterator]()
      .next()
      .then(
        function value(entry): IteratorResult<unknown> {
          return entry
        },
        function rejected(error: unknown): never {
          throw error
        }
      )
      .catch(function caught(error: unknown): unknown {
        return error
      })
    expect(result).toBe(deadlineExceeded)
  } finally {
    cancel()
    await events.close()
  }
})

test("Q4-05 an idle deadline between messages rejects the following next", async () => {
  const body = new ReadableStream<Uint8Array>({
    /** Publishes one business frame and then stays open. */
    start(controller): void {
      controller.enqueue(encoder.encode('data: {"n":1}\n\n'))
    }
  })
  const [ctx, cancel] = withTimeout(background(), 40)
  const events = openServerStream(streamResponse(body), Item, 1024, ctx)
  const iterator = events[Symbol.asyncIterator]()
  try {
    expect(await iterator.next()).toEqual({ done: false, value: { n: 1 } })
    await untilDone(ctx)
    await afterCallerCallback()
    expect(ctx.err()).toBe(deadlineExceeded)
    await expect(iterator.next()).rejects.toBe(deadlineExceeded)
  } finally {
    cancel()
    await events.close()
  }
})

test("Q4-05 caller cancellation before iteration rejects next with canceled", async () => {
  const body = new ReadableStream<Uint8Array>({
    /** Stays open so cancellation is the only terminal signal. */
    pull(): void {}
  })
  const [ctx, cancel] = withCancelCause(background())
  const events = openServerStream(streamResponse(body), Item, 1024, ctx)
  cancel(new Error("stop"))
  try {
    await untilDone(ctx)
    await afterCallerCallback()
    expect(ctx.err()).toBe(canceled)
    await expect(events[Symbol.asyncIterator]().next()).rejects.toBe(canceled)
  } finally {
    await events.close()
  }
})

test("Q4-05 caller cancellation between messages rejects the following next", async () => {
  const body = new ReadableStream<Uint8Array>({
    /** Publishes one business frame and then stays open. */
    start(controller): void {
      controller.enqueue(encoder.encode('data: {"n":1}\n\n'))
    }
  })
  const [ctx, cancel] = withCancelCause(background())
  const events = openServerStream(streamResponse(body), Item, 1024, ctx)
  const iterator = events[Symbol.asyncIterator]()
  try {
    expect(await iterator.next()).toEqual({ done: false, value: { n: 1 } })
    cancel(new Error("stop"))
    await untilDone(ctx)
    await afterCallerCallback()
    expect(ctx.err()).toBe(canceled)
    await expect(iterator.next()).rejects.toBe(canceled)
  } finally {
    await events.close()
  }
})
