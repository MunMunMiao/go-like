import { expect, test } from "bun:test"

import { background, withValue, type Context } from "@go-like/context"

import { applyResponseObservers, type ResponseBodyEnd } from "../src/index"
import { observeCall } from "../src/provider"

interface Outcome {
  readonly end: ResponseBodyEnd | null
  readonly failure: unknown
}

interface Collector {
  readonly outcomes: Outcome[]
  readonly record: (end: ResponseBodyEnd | null, failure: unknown) => void
}

interface EventStream extends AsyncIterable<Uint8Array> {
  close(): Promise<void>
}

interface Route {
  readonly name: string
  /** Hands a Response back the way a callee taking this route does. */
  deliver(ctx: Context, response: Response): Response
}

const encoder = new TextEncoder()
const eventFrames = encoder.encode('data: {"n":1}\n\nevent: end\ndata: {}\n\n')
const eventHeaders = { "content-type": "text/event-stream" }

/** A callee either applies the context observers or returns the Response untouched. */
const routes: readonly Route[] = [
  {
    name: "context observer",
    deliver(ctx: Context, response: Response): Response {
      return applyResponseObservers(ctx, response)
    }
  },
  {
    name: "fallback wrap",
    deliver(_ctx: Context, response: Response): Response {
      return response
    }
  }
]

/** Collects observeCall outcomes in publication order. */
function collect(): Collector {
  const outcomes: Outcome[] = []
  return {
    outcomes,
    /** Stores one published outcome. */
    record(end: ResponseBodyEnd | null, failure: unknown): void {
      outcomes.push({ end, failure })
    }
  }
}

/** Runs observeCall with a callee that returns one Response through the given route. */
function callWith(
  route: Route,
  response: Response,
  seen: Collector,
  startedAt: number = performance.now()
): Promise<unknown> {
  return observeCall(
    background(),
    startedAt,
    async function invoke(ctx: Context): Promise<unknown> {
      return route.deliver(ctx, response)
    },
    seen.record
  )
}

/** Returns one unread event-stream Response that ends with a terminal frame. */
function eventResponse(): Response {
  return new Response(eventFrames, { headers: eventHeaders })
}

/** Builds the smallest server stream over an event-stream Response body. */
function serverStream(response: Response): EventStream {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error("missing body")
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) return
        yield chunk.value
      }
    },
    async close(): Promise<void> {
      await reader.cancel()
    }
  }
}

/** Reads a server stream to its end and returns the byte count. */
async function drain(stream: AsyncIterable<Uint8Array>): Promise<number> {
  let total = 0
  for await (const chunk of stream) total += chunk.byteLength
  return total
}

for (const route of routes) {
  test(`${route.name}: defers the record to the body end and forwards startedAt`, async () => {
    const seen = collect()
    const result = (await callWith(
      route,
      new Response("hello"),
      seen,
      performance.now() - 1000
    )) as Response
    expect(seen.outcomes).toHaveLength(0)
    expect(await result.text()).toBe("hello")
    expect(seen.outcomes).toHaveLength(1)
    expect(seen.outcomes[0]?.failure).toBeNull()
    expect(seen.outcomes[0]?.end).toMatchObject({
      reason: "end",
      cause: null,
      httpStatus: 200,
      stream: false,
      messageCount: 0,
      status: { kind: "success" }
    })
    expect(seen.outcomes[0]?.end?.handshakeMs).toBeGreaterThanOrEqual(1000)
    expect(seen.outcomes[0]?.end?.durationMs).toBeGreaterThanOrEqual(1000)
  })

  test(`${route.name}: publishes a canceled unread body`, async () => {
    const seen = collect()
    const reason = new Error("stop")
    const result = (await callWith(route, new Response("pending"), seen)) as Response
    expect(seen.outcomes).toHaveLength(0)
    await result.body?.cancel(reason)
    expect(seen.outcomes).toHaveLength(1)
    expect(seen.outcomes[0]?.failure).toBeNull()
    expect(seen.outcomes[0]?.end).toMatchObject({
      reason: "cancel",
      cause: reason,
      status: { kind: "canceled" }
    })
  })

  test(`${route.name}: publishes a body that fails while it is read`, async () => {
    const seen = collect()
    const failure = new Error("boom")
    const result = (await callWith(
      route,
      new Response(
        new ReadableStream<Uint8Array>({
          /** Fails the first read. */
          pull(controller): void {
            controller.error(failure)
          }
        })
      ),
      seen
    )) as Response
    await expect(result.text()).rejects.toBe(failure)
    expect(seen.outcomes).toHaveLength(1)
    expect(seen.outcomes[0]?.end).toMatchObject({
      reason: "error",
      cause: failure,
      status: { kind: "error" }
    })
  })

  test(`${route.name}: publishes a bodyless Response before the call returns`, async () => {
    const seen = collect()
    const response = new Response(null, { status: 204 })
    expect(await callWith(route, response, seen)).toBe(response)
    expect(seen.outcomes).toHaveLength(1)
    expect(seen.outcomes[0]?.failure).toBeNull()
    expect(seen.outcomes[0]?.end).toMatchObject({
      reason: "end",
      httpStatus: 204,
      status: { kind: "success" }
    })
  })

  test(`${route.name}: publishes an already-read Response before the call returns`, async () => {
    const seen = collect()
    const response = new Response("used", { status: 203 })
    expect(await response.text()).toBe("used")
    expect(await callWith(route, response, seen)).toBe(response)
    expect(seen.outcomes).toHaveLength(1)
    expect(seen.outcomes[0]?.end).toMatchObject({ reason: "end", httpStatus: 203 })
  })

  test(`${route.name}: releases the source once a terminal event is seen`, async () => {
    const seen = collect()
    let cancels = 0
    const result = (await callWith(
      route,
      new Response(
        new ReadableStream<Uint8Array>({
          /** Sends the terminal frames and leaves the producer open. */
          start(controller): void {
            controller.enqueue(eventFrames)
          },
          /** Counts release of the transport body. */
          cancel(): void {
            cancels += 1
          }
        }),
        { headers: eventHeaders }
      ),
      seen
    )) as Response
    const reader = result.body?.getReader()
    if (reader === undefined) throw new Error("missing body")
    expect(seen.outcomes).toHaveLength(0)
    await reader.read()
    expect(cancels).toBe(1)
    expect(seen.outcomes).toHaveLength(1)
    expect(seen.outcomes[0]?.end).toMatchObject({
      reason: "end",
      stream: true,
      messageCount: 1,
      status: { kind: "success" }
    })
  })
}

test("returns the Response the callee observed without wrapping it again", async () => {
  const seen = collect()
  let observed: Response | undefined
  const result = await observeCall(
    background(),
    performance.now(),
    async function invoke(ctx: Context): Promise<unknown> {
      observed = applyResponseObservers(ctx, new Response("once"))
      return observed
    },
    seen.record
  )
  expect(result).toBe(observed)
  expect(await (result as Response).text()).toBe("once")
  expect(seen.outcomes).toHaveLength(1)
})

test("wraps a Response the callee never observed", async () => {
  const seen = collect()
  const raw = new Response("raw")
  const result = await callWith(routes[1] as Route, raw, seen)
  expect(result).toBeInstanceOf(Response)
  expect(result).not.toBe(raw)
  expect(await (result as Response).text()).toBe("raw")
  expect(seen.outcomes).toHaveLength(1)
})

test("keeps the first terminal body event when the callee observes several Responses", async () => {
  const seen = collect()
  await observeCall(
    background(),
    performance.now(),
    async function invoke(ctx: Context): Promise<unknown> {
      const first = applyResponseObservers(ctx, new Response("a", { status: 200 }))
      const second = applyResponseObservers(ctx, new Response("b", { status: 202 }))
      await second.text()
      await first.text()
      return "done"
    },
    seen.record
  )
  expect(seen.outcomes).toHaveLength(1)
  expect(seen.outcomes[0]?.end?.httpStatus).toBe(202)
})

test("does not wrap a later Response after a terminal body event was recorded", async () => {
  const seen = collect()
  const later = new Response("later", { status: 201 })
  const result = await observeCall(
    background(),
    performance.now(),
    async function invoke(ctx: Context): Promise<unknown> {
      await applyResponseObservers(ctx, new Response("first")).text()
      return later
    },
    seen.record
  )
  expect(result).toBe(later)
  expect(seen.outcomes).toHaveLength(1)
  expect(seen.outcomes[0]?.end?.httpStatus).toBe(200)
  expect(await later.text()).toBe("later")
  expect(seen.outcomes).toHaveLength(1)
})

test("publishes a Response with no unread body at once, whatever the callee observed", async () => {
  const bodyless = new Response(null, { status: 204 })
  const consumed = new Response("read")
  await consumed.text()
  for (const returned of [bodyless, consumed]) {
    const seen = collect()
    const result = await observeCall(
      background(),
      performance.now(),
      async function invoke(ctx: Context): Promise<unknown> {
        applyResponseObservers(ctx, new Response("still open"))
        return returned
      },
      seen.record
    )
    expect(result).toBe(returned)
    expect(seen.outcomes).toEqual([{ end: null, failure: null }])
  }
})

const notStreams: ReadonlyArray<readonly [string, unknown]> = [
  ["a string", "plain"],
  ["a number", 42],
  ["null", null],
  ["undefined", undefined],
  ["an empty object", {}],
  ["an object with close only", { close(): void {} }],
  [
    "an object with an async iterator only",
    {
      [Symbol.asyncIterator]: (): AsyncIterator<never> => ({
        next: async () => ({ done: true, value: undefined })
      })
    }
  ],
  ["an object with non-function members", { [Symbol.asyncIterator]: 1, close: 1 }]
]

test.each(notStreams)("publishes %s at once and returns it unchanged", async (_name, value) => {
  const seen = collect()
  const result = await observeCall(
    background(),
    performance.now(),
    async function invoke(): Promise<unknown> {
      return value
    },
    seen.record
  )
  expect(result).toBe(value)
  expect(seen.outcomes).toEqual([{ end: null, failure: null }])
})

test("defers a server stream record to the end of its body", async () => {
  const seen = collect()
  const stream = (await observeCall(
    background(),
    performance.now(),
    async function invoke(ctx: Context): Promise<unknown> {
      return serverStream(applyResponseObservers(ctx, eventResponse()))
    },
    seen.record
  )) as EventStream
  expect(seen.outcomes).toHaveLength(0)
  expect(await drain(stream)).toBe(eventFrames.byteLength)
  expect(seen.outcomes).toHaveLength(1)
  expect(seen.outcomes[0]?.failure).toBeNull()
  expect(seen.outcomes[0]?.end).toMatchObject({
    reason: "end",
    stream: true,
    messageCount: 1,
    status: { kind: "success" }
  })
})

test("publishes a canceled outcome when a server stream is closed early", async () => {
  const seen = collect()
  const stream = (await observeCall(
    background(),
    performance.now(),
    async function invoke(ctx: Context): Promise<unknown> {
      return serverStream(applyResponseObservers(ctx, eventResponse()))
    },
    seen.record
  )) as EventStream
  expect(seen.outcomes).toHaveLength(0)
  await stream.close()
  expect(seen.outcomes).toHaveLength(1)
  expect(seen.outcomes[0]?.end).toMatchObject({ reason: "cancel", status: { kind: "canceled" } })
})

test("publishes a server stream whose body ended before the call returned", async () => {
  const seen = collect()
  await observeCall(
    background(),
    performance.now(),
    async function invoke(ctx: Context): Promise<unknown> {
      const stream = serverStream(applyResponseObservers(ctx, eventResponse()))
      await drain(stream)
      return stream
    },
    seen.record
  )
  expect(seen.outcomes).toHaveLength(1)
  expect(seen.outcomes[0]?.end).toMatchObject({ reason: "end", stream: true })
})

test("publishes the thrown value and rethrows it unchanged", async () => {
  const seen = collect()
  const failure = new Error("boom")
  await expect(
    observeCall(
      background(),
      performance.now(),
      async function invoke(): Promise<unknown> {
        throw failure
      },
      seen.record
    )
  ).rejects.toBe(failure)
  expect(seen.outcomes).toEqual([{ end: null, failure }])
})

test("publishes a synchronous throw from invoke", async () => {
  const seen = collect()
  const failure = new Error("sync")
  await expect(
    observeCall(
      background(),
      performance.now(),
      function invoke(): Promise<unknown> {
        throw failure
      },
      seen.record
    )
  ).rejects.toBe(failure)
  expect(seen.outcomes).toEqual([{ end: null, failure }])
})

test("hands the failure an earlier body end so the caller can prefer the failure", async () => {
  const seen = collect()
  const failure = new Error("late")
  await expect(
    observeCall(
      background(),
      performance.now(),
      async function invoke(ctx: Context): Promise<unknown> {
        applyResponseObservers(ctx, new Response(null, { status: 204 }))
        throw failure
      },
      seen.record
    )
  ).rejects.toBe(failure)
  expect(seen.outcomes).toHaveLength(1)
  expect(seen.outcomes[0]?.failure).toBe(failure)
  expect(seen.outcomes[0]?.end).toMatchObject({ reason: "end", httpStatus: 204 })
})

test("publishes once even when record throws", async () => {
  const failure = new Error("record failed")
  let calls = 0
  await expect(
    observeCall(
      background(),
      performance.now(),
      async function invoke(): Promise<unknown> {
        return "done"
      },
      function record(): void {
        calls += 1
        throw failure
      }
    )
  ).rejects.toBe(failure)
  expect(calls).toBe(1)
})

test("derives a child Context and leaves the caller's Context unobserved", async () => {
  const key = Symbol("call")
  const parent = withValue(background(), key, "kept")
  let child: Context | undefined
  await observeCall(
    parent,
    performance.now(),
    async function invoke(ctx: Context): Promise<unknown> {
      child = ctx
      return null
    },
    collect().record
  )
  expect(child).not.toBe(parent)
  expect(child?.value(key)).toBe("kept")
  const untouched = new Response("untouched")
  expect(applyResponseObservers(parent, untouched)).toBe(untouched)
})

test("lets nested layers each publish the same body end once", async () => {
  const outer = collect()
  const inner = collect()
  const result = (await observeCall(
    background(),
    performance.now(),
    function invokeOuter(outerCtx: Context): Promise<unknown> {
      return observeCall(
        outerCtx,
        performance.now(),
        async function invokeInner(innerCtx: Context): Promise<unknown> {
          return applyResponseObservers(innerCtx, new Response("nested"))
        },
        inner.record
      )
    },
    outer.record
  )) as Response
  expect(outer.outcomes).toHaveLength(0)
  expect(inner.outcomes).toHaveLength(0)
  expect(await result.text()).toBe("nested")
  expect(outer.outcomes).toHaveLength(1)
  expect(inner.outcomes).toHaveLength(1)
  expect(outer.outcomes[0]?.end).toMatchObject({ reason: "end", httpStatus: 200 })
  expect(inner.outcomes[0]?.end).toMatchObject({ reason: "end", httpStatus: 200 })
})
